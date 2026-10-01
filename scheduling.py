"""Durable-settings scheduling; all returned timestamps are UTC epoch seconds.

The engine is pure: previews and execution use the same settings and successful
post journal, and calculating a schedule never consumes a slot or clears a queue.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULTS = {
    "enabled": True, "paused": False, "mode": "interval",
    "post_interval_minutes": 10, "post_times": [], "weekdays": list(range(7)),
    "quiet_enabled": False, "quiet_start": "23:00", "quiet_end": "07:00",
    "search_enabled": True, "search_interval_minutes": 20, "min_queue": 100,
    "natural_interval_enabled": False, "jitter_minutes": 2,
    "timezone": "Europe/Moscow", "min_post_gap_minutes": 5,
    "max_posts_hour": 12, "max_posts_day": 144,
}
_BOOLEANS = {"enabled", "paused", "quiet_enabled", "search_enabled", "natural_interval_enabled"}
_RANGES = {
    "post_interval_minutes": (5, 10080), "search_interval_minutes": (5, 10080),
    "min_queue": (1, 300), "jitter_minutes": (0, 120),
    "min_post_gap_minutes": (5, 1440), "max_posts_hour": (1, 12),
    "max_posts_day": (1, 288),
}
_CLOCK = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


def _raw(value):
    if not isinstance(value, dict):
        raise ValueError("schedule must be an object")
    if "schedule" in value:
        value = value["schedule"]
        if not isinstance(value, dict):
            raise ValueError("schedule must be an object")
    return value


def _field(key, value):
    if key in _BOOLEANS:
        if not isinstance(value, bool):
            raise ValueError(f"{key}: expected boolean")
    elif key in _RANGES:
        lo, hi = _RANGES[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or int(value) != value or not lo <= value <= hi:
            raise ValueError(f"{key}: expected integer {lo}..{hi}")
        value = int(value)
    elif key == "mode":
        if value not in ("interval", "times"):
            raise ValueError("mode: expected interval or times")
    elif key == "timezone":
        if not isinstance(value, str):
            raise ValueError("timezone: expected IANA timezone")
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("timezone: unknown IANA timezone") from None
    elif key in ("quiet_start", "quiet_end"):
        if not isinstance(value, str) or not _CLOCK.fullmatch(value):
            raise ValueError(f"{key}: expected HH:MM")
    elif key == "post_times":
        if not isinstance(value, list) or len(value) > 24 or any(not isinstance(t, str) or not _CLOCK.fullmatch(t) for t in value):
            raise ValueError("post_times: expected at most 24 HH:MM times")
        value = sorted(set(value))
    elif key == "weekdays":
        if not isinstance(value, list) or not value or any(isinstance(d, bool) or not isinstance(d, int) or not 0 <= d <= 6 for d in value):
            raise ValueError("weekdays: select days 0..6 (Monday..Sunday)")
        value = sorted(set(value))
    return list(value) if isinstance(value, list) else value


def validate(settings_or_schedule):
    """Validate an admin update and return a complete canonical config."""
    raw = _raw(settings_or_schedule)
    unknown = set(raw) - set(DEFAULTS)
    # A complete settings object with no schedule is a legacy default config.
    if "schedule" not in settings_or_schedule and unknown and not set(raw).intersection(DEFAULTS):
        raw = {}
    elif unknown:
        raise ValueError("unknown schedule fields: " + ", ".join(sorted(unknown)))
    result = {k: _field(k, raw.get(k, v)) for k, v in DEFAULTS.items()}
    if result["quiet_enabled"] and result["quiet_start"] == result["quiet_end"]:
        raise ValueError("quiet hours must leave time for posting")
    if result["mode"] == "times" and not result["post_times"]:
        raise ValueError("post_times: add at least one time")
    if result["natural_interval_enabled"] and result["jitter_minutes"] >= result["post_interval_minutes"]:
        raise ValueError("jitter_minutes must be smaller than the posting interval")
    return result


def normalize(settings_or_schedule):
    """Read old or partially invalid persisted settings without stopping workers."""
    try:
        raw = _raw(settings_or_schedule)
    except ValueError:
        raw = {}
    result = {}
    for key, default in DEFAULTS.items():
        try:
            result[key] = _field(key, raw.get(key, default))
        except ValueError:
            result[key] = _field(key, default)
    if result["quiet_start"] == result["quiet_end"]:
        result["quiet_enabled"] = False
    if result["natural_interval_enabled"] and result["jitter_minutes"] >= result["post_interval_minutes"]:
        result["jitter_minutes"] = min(2, result["post_interval_minutes"] - 1)
    return result


def _epoch(value):
    try:
        number = float(value or 0)
        return int(number) if math.isfinite(number) and number > 0 else 0
    except (TypeError, ValueError, OverflowError):
        return 0


def _history(data):
    # recent is the durable journal of successful sends, not attempts.
    return sorted(_epoch(r.get("ts")) for r in (data.get("recent") or []) if isinstance(r, dict) and _epoch(r.get("ts")))


def _allowed(epoch, config, zone):
    local = datetime.fromtimestamp(epoch, zone)
    if local.weekday() not in config["weekdays"]:
        return False
    if not config["quiet_enabled"]:
        return True
    clock = local.strftime("%H:%M")
    start, end = config["quiet_start"], config["quiet_end"]
    return not (start <= clock < end if start < end else clock >= start or clock < end)


def _next_allowed(epoch, config, zone):
    candidate = int(epoch)
    # Iterate UTC minutes so DST jumps cannot create invalid local timestamps.
    for _ in range(8 * 24 * 60 + 1):
        if _allowed(candidate, config, zone):
            return candidate
        candidate = (candidate // 60 + 1) * 60
    return None


def _wall_slot(day, clock, zone):
    hour, minute = map(int, clock.split(":"))
    naive = datetime(day.year, day.month, day.day, hour, minute)
    options = []
    for fold in (0, 1):
        aware = naive.replace(tzinfo=zone, fold=fold)
        epoch = int(aware.timestamp())
        if datetime.fromtimestamp(epoch, zone).replace(tzinfo=None) == naive:
            options.append(epoch)
    # Ambiguous local time is scheduled once, on its first occurrence.
    return min(options) if options else None


def _jitter(config, last, identity):
    if not config["natural_interval_enabled"] or not last:
        return 0
    fields = {key: config[key] for key in sorted(config)}
    payload = json.dumps([last, identity, fields], sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(payload.encode()).digest()
    radius = config["jitter_minutes"] * 60
    return int.from_bytes(digest[:8], "big") % (2 * radius + 1) - radius if radius else 0


def _cap_floor(candidate, history, config, zone):
    if history:
        candidate = max(candidate, history[-1] + config["min_post_gap_minutes"] * 60)
    for _ in range(32):
        old = candidate
        hour = [ts for ts in history if candidate - 3600 < ts <= candidate]
        if len(hour) >= config["max_posts_hour"]:
            candidate = max(candidate, hour[-config["max_posts_hour"]] + 3600)
        day = datetime.fromtimestamp(candidate, zone).date()
        daily = [ts for ts in history if ts <= candidate and datetime.fromtimestamp(ts, zone).date() == day]
        if len(daily) >= config["max_posts_day"]:
            tomorrow = day + timedelta(days=1)
            # Midnight is normally valid; next_allowed handles unusual DST zones.
            candidate = int(datetime(tomorrow.year, tomorrow.month, tomorrow.day, tzinfo=zone).timestamp())
        if candidate == old:
            return candidate
    return candidate


def next_posts(settings, data, now=None, count=5):
    """Return up to count slots; no interval catch-up burst or missed-time backfill."""
    config = normalize(settings)
    if not config["enabled"] or config["paused"]:
        return []
    zone = ZoneInfo(config["timezone"])
    current = int(time.time() if now is None else now)
    pause = _epoch(settings.get("pause_until")) if isinstance(settings, dict) else 0
    floor = max(current, pause)
    history = _history(data)
    identity = next((r.get("pid", r.get("nmId", "")) for r in reversed(data.get("recent") or []) if isinstance(r, dict) and _epoch(r.get("ts")) == (history[-1] if history else 0)), "")
    slots = []
    for index in range(max(0, min(int(count), 100))):
        if config["mode"] == "interval":
            last = history[-1] if history else 0
            interval = max(config["min_post_gap_minutes"] * 60, config["post_interval_minutes"] * 60 + _jitter(config, last, identity if not index else "preview"))
            candidate = max(floor, last + interval) if last else floor
            for _ in range(32):
                candidate = _cap_floor(candidate, history, config, zone)
                allowed = _next_allowed(candidate, config, zone)
                if allowed is None:
                    return slots
                if allowed == candidate:
                    break
                candidate = allowed
            else:
                return slots
        else:
            # Grace is only the current minute. Never backfill earlier times.
            earliest = floor // 60 * 60 if not index and floor == current else floor
            start_day = datetime.fromtimestamp(earliest, zone).date()
            candidate = None
            for day_offset in range(15):
                day = start_day + timedelta(days=day_offset)
                if day.weekday() not in config["weekdays"]:
                    continue
                for clock in config["post_times"]:
                    slot = _wall_slot(day, clock, zone)
                    if slot is not None and slot >= earliest and _allowed(slot, config, zone):
                        send_at = _cap_floor(max(slot, floor), history, config, zone)
                        if send_at < slot + 60:
                            candidate = send_at
                            break
                if candidate is not None:
                    break
            if candidate is None:
                return slots
        slots.append(candidate)
        history.append(candidate)
        history.sort()
        floor = candidate + 1
    return slots


def next_search(settings, data, queue_size=None, now=None):
    """Posting pause/weekdays/quiet hours never pause independent discovery."""
    config = normalize(settings)
    if not config["search_enabled"]:
        return None
    current = int(time.time() if now is None else now)
    meta = data.get("meta") or {}
    last = max(_epoch(meta.get(key)) for key in ("last_scan_attempt", "last_scan_success", "last_scan"))
    last = max(last, _epoch(data.get("last_scan_attempt")), _epoch(data.get("last_scan_success")))
    interval = config["search_interval_minutes"] * 60
    if queue_size is not None and queue_size < config["min_queue"]:
        interval = 5 * 60
    return max(current, last + interval) if last else current


def post_due(settings, data, now=None):
    current = int(time.time() if now is None else now)
    slots = next_posts(settings, data, now=current, count=1)
    return bool(slots and slots[0] <= current)


def search_due(settings, data, queue_size=None, now=None):
    current = int(time.time() if now is None else now)
    slot = next_search(settings, data, queue_size=queue_size, now=current)
    return slot is not None and slot <= current
