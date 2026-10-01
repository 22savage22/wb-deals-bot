"""Calendar and throttle regressions for the shared scheduling engine."""
import unittest
import copy
from contextlib import nullcontext
from unittest.mock import patch
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import scheduling


def stamp(text, zone="Europe/Moscow", fold=0):
    return int(datetime.fromisoformat(text).replace(tzinfo=ZoneInfo(zone), fold=fold).timestamp())


def settings(**changes):
    return {"schedule": {**scheduling.DEFAULTS, **changes}}


def posted(*times):
    return {"recent": [{"pid": str(i), "ts": ts} for i, ts in enumerate(times)], "meta": {}}


class SchedulingTests(unittest.TestCase):
    def test_legacy_default_runs_all_day_and_search_is_separate(self):
        now = stamp("2026-10-01T23:15:00")
        cfg = scheduling.normalize({"pause_until": 0, "queries": []})
        self.assertEqual(cfg["weekdays"], list(range(7)))
        self.assertFalse(cfg["quiet_enabled"])
        self.assertEqual(scheduling.next_posts({}, {}, now), [now + 600 * i for i in range(5)])
        self.assertEqual(scheduling.next_search(settings(paused=True), {}, now=now), now)

    def test_every_custom_interval_and_no_catch_up(self):
        now = stamp("2026-10-01T12:00:00")
        for minutes in (5, 10, 15, 20, 30, 45, 60, 120, 137, 10080):
            cfg = settings(post_interval_minutes=minutes)
            self.assertEqual(scheduling.next_posts(cfg, posted(now), now, 1), [now + minutes * 60])
            self.assertEqual(scheduling.next_posts(cfg, posted(now - 20000 * 60), now, 1), [now])

    def test_validation_is_strict_and_normalization_recovers(self):
        for change in ({"post_interval_minutes": 4}, {"post_interval_minutes": 5.5},
                       {"search_interval_minutes": 10081}, {"min_queue": 301},
                       {"timezone": "No/SuchZone"}, {"post_times": ["25:00"]},
                       {"weekdays": []}, {"weekdays": [True]}, {"enabled": "false"},
                       {"mode": "times", "post_times": []},
                       {"quiet_enabled": True, "quiet_start": "07:00", "quiet_end": "07:00"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                scheduling.validate(settings(**change))
        normalized = scheduling.normalize(settings(post_interval_minutes="oops", min_queue=0))
        self.assertEqual(normalized["post_interval_minutes"], 10)
        self.assertEqual(normalized["min_queue"], 100)
        validated = scheduling.validate(settings(mode="times", post_times=["12:00", "08:00", "12:00"]))
        self.assertEqual(validated["post_times"], ["08:00", "12:00"])

    def test_fixed_times_current_minute_grace_but_no_restart_backfill(self):
        cfg = settings(mode="times", post_times=["08:00", "10:30", "12:00"])
        at = stamp("2026-10-01T10:30:42")
        self.assertTrue(scheduling.post_due(cfg, {}, at))
        self.assertEqual(scheduling.next_posts(cfg, {}, at, 1), [at])
        after = stamp("2026-10-01T10:31:00")
        self.assertEqual(scheduling.next_posts(cfg, {}, after, 1), [stamp("2026-10-01T12:00:00")])
        self.assertFalse(scheduling.post_due(cfg, posted(at), at + 1))

    def test_fixed_times_allow_minimum_gap_inside_current_minute(self):
        cfg = settings(mode="times", post_times=["10:00", "10:05"])
        first = stamp("2026-10-01T10:00:45")
        self.assertFalse(scheduling.post_due(cfg, posted(first), stamp("2026-10-01T10:05:30")))
        self.assertTrue(scheduling.post_due(cfg, posted(first), stamp("2026-10-01T10:05:50")))

    def test_weekend_and_weekday_presets(self):
        friday = stamp("2026-10-02T23:59:00")
        weekends = settings(weekdays=[5, 6])
        self.assertEqual(scheduling.next_posts(weekends, {}, friday, 1), [stamp("2026-10-03T00:00:00")])
        saturday = stamp("2026-10-03T12:00:00")
        weekdays = settings(weekdays=[0, 1, 2, 3, 4])
        self.assertEqual(scheduling.next_posts(weekdays, {}, saturday, 1), [stamp("2026-10-05T00:00:00")])

    def test_overnight_quiet_hours_and_same_day_quiet(self):
        cfg = settings(quiet_enabled=True, quiet_start="23:30", quiet_end="07:30")
        for instant in ("2026-10-01T23:30:00", "2026-10-02T04:00:00"):
            self.assertEqual(scheduling.next_posts(cfg, {}, stamp(instant), 1), [stamp("2026-10-02T07:30:00")])
        self.assertTrue(scheduling.post_due(cfg, {}, stamp("2026-10-02T07:30:00")))
        cfg = settings(quiet_enabled=True, quiet_start="12:00", quiet_end="13:00")
        self.assertEqual(scheduling.next_posts(cfg, {}, stamp("2026-10-01T12:30:00"), 1), [stamp("2026-10-01T13:00:00")])

    def test_disabled_paused_and_legacy_pause(self):
        now = stamp("2026-10-01T12:00:00")
        self.assertEqual(scheduling.next_posts(settings(enabled=False), {}, now), [])
        self.assertEqual(scheduling.next_posts(settings(paused=True), {}, now), [])
        cfg = settings()
        cfg["pause_until"] = now + 3600
        self.assertEqual(scheduling.next_posts(cfg, {}, now, 1), [now + 3600])
        self.assertFalse(scheduling.post_due(cfg, {}, now))

    def test_hour_cap_and_minimum_gap(self):
        now = stamp("2026-10-01T12:00:00")
        cfg = settings(post_interval_minutes=5, max_posts_hour=2)
        hist = posted(now - 900, now - 300)
        self.assertEqual(scheduling.next_posts(cfg, hist, now, 1), [now - 900 + 3600])
        self.assertFalse(scheduling.post_due(cfg, hist, now))
        cfg = settings(post_interval_minutes=5, min_post_gap_minutes=15)
        self.assertEqual(scheduling.next_posts(cfg, posted(now - 30), now, 1), [now - 30 + 900])

    def test_daily_cap_is_local_day_and_preview_applies_caps(self):
        now = stamp("2026-10-01T23:50:00")
        cfg = settings(max_posts_day=2)
        hist = posted(stamp("2026-10-01T01:00:00"), stamp("2026-10-01T04:00:00"))
        self.assertEqual(scheduling.next_posts(cfg, hist, now, 1), [stamp("2026-10-02T00:00:00")])
        expected = [now, stamp("2026-10-02T00:00:00"), stamp("2026-10-02T00:10:00"), stamp("2026-10-03T00:00:00")]
        self.assertEqual(scheduling.next_posts(cfg, {}, now, 4), expected)

    def test_jitter_survives_restart_and_bounds_and_minimum_gap(self):
        now = stamp("2026-10-01T12:00:00")
        cfg = settings(natural_interval_enabled=True)
        history = posted(now)
        first = scheduling.next_posts(cfg, history, now, 1)[0]
        self.assertTrue(now + 8 * 60 <= first <= now + 12 * 60)
        self.assertEqual(scheduling.next_posts(dict(cfg), dict(history), now + 1, 1)[0], first)
        cfg = settings(natural_interval_enabled=True, post_interval_minutes=5)
        self.assertGreaterEqual(scheduling.next_posts(cfg, history, now, 1)[0], now + 300)

    def test_search_priority_throttles_attempts_and_ignores_posting_quiet(self):
        now = stamp("2026-10-01T23:45:00")
        cfg = settings(paused=True, quiet_enabled=True)
        data = {"meta": {"last_scan_attempt": now - 60, "last_scan_success": now - 3600}}
        self.assertEqual(scheduling.next_search(cfg, data, queue_size=99, now=now), now + 240)
        self.assertEqual(scheduling.next_search(cfg, data, queue_size=100, now=now), now + 1140)
        self.assertFalse(scheduling.search_due(cfg, data, 99, now))
        self.assertTrue(scheduling.search_due(cfg, data, 99, now + 240))
        self.assertIsNone(scheduling.next_search(settings(search_enabled=False), {}, 0, now))

    def test_dst_spring_nonexistent_time_is_skipped(self):
        cfg = settings(timezone="America/New_York", mode="times", post_times=["02:30"])
        now = stamp("2026-03-08T00:00:00", "America/New_York")
        self.assertEqual(scheduling.next_posts(cfg, {}, now, 1), [stamp("2026-03-09T02:30:00", "America/New_York")])

    def test_dst_fall_ambiguous_time_is_not_posted_twice(self):
        cfg = settings(timezone="America/New_York", mode="times", post_times=["01:30"])
        first = stamp("2026-11-01T01:30:00", "America/New_York", fold=0)
        second = stamp("2026-11-01T01:30:00", "America/New_York", fold=1)
        self.assertTrue(scheduling.post_due(cfg, {}, first))
        self.assertFalse(scheduling.post_due(cfg, posted(first), second))
        self.assertEqual(scheduling.next_posts(cfg, posted(first), second, 1), [stamp("2026-11-02T01:30:00", "America/New_York")])

    def test_server_timezone_does_not_change_local_schedule(self):
        cfg = settings(timezone="Asia/Tokyo", mode="times", post_times=["08:00"])
        now = int(datetime(2026, 10, 1, 22, 0, tzinfo=timezone.utc).timestamp())
        self.assertEqual(scheduling.next_posts(cfg, {}, now, 1), [stamp("2026-10-02T08:00:00", "Asia/Tokyo")])


class ScannerSchedulingTests(unittest.TestCase):
    def test_low_queue_can_keep_more_than_daily_topic_post_cap(self):
        import bot
        import config
        import scanner
        import state
        from test_bot import FakeWB, make_items
        queries = ["платье женское", "джинсы женские", "футболка мужская", "товары для дома"]
        starts = dict(zip(queries, (8000, 8010, 8020, 8030)))
        items = make_items(40, 8000)

        def search(query, page, subject=None):
            start = starts.get(query)
            return [items[i] for i in range(start, start + 10)] if start is not None and subject is None else []

        cfg = settings(min_queue=25)
        cfg["queries"] = queries
        data = state._empty()
        with patch.object(scanner.scheduler_client, "enabled", return_value=True), \
             patch.object(scanner, "wb", FakeWB), patch.object(bot, "wb", FakeWB), \
             patch.object(FakeWB, "items", items), patch.object(FakeWB, "cat_menu", []), \
             patch.object(FakeWB, "search", side_effect=search) as calls, \
             patch.object(scanner.time, "sleep"), \
             patch.object(config, "PAGES", 1), patch.object(config, "QUERIES_PER_RUN", 4), \
             patch.object(config, "CATS_PER_RUN", 1), patch.object(config, "MIN_RATING", 0):
            self.assertEqual(scanner.fill_queue(data, cfg, force_scan=True), 25)
            self.assertEqual(len(data["queue"]), 25)
            self.assertEqual(data["meta"]["last_scan_funnel"]["new"], 40)
            first_calls = calls.call_count
            retained = {d["id"] for d in data["queue"]}
            self.assertEqual(scanner.fill_queue(data, cfg, force_scan=True), 0)
            self.assertGreater(calls.call_count, first_calls)
            self.assertEqual(retained, {d["id"] for d in data["queue"]})
            self.assertEqual(data["meta"]["last_scan_funnel"]["new"], 0)

    def test_queue_capacity_retention_and_discovery_merge(self):
        import state
        now = int(__import__("time").time())
        raw = [{"id": i, "product": 100, "basic": 100, "queued_ts": now - 50 * 3600}
               for i in range(1, 351)]
        self.assertEqual(len(state._norm_queue(raw)), 300)
        raw[0]["queued_ts"] = now - 73 * 3600
        self.assertNotIn(1, {d["id"] for d in state._norm_queue(raw)})
        first = state._empty()
        second = state._empty()
        first["meta"] = {"last_scan_attempt": now, "last_scan_success": now - 100,
                         "last_scan_error": "source unavailable", "discovery_seen": {1: now - 10}}
        second["meta"] = {"last_scan_attempt": now - 300, "last_scan_success": now - 300,
                          "last_scan_error": "", "discovery_seen": {2: now - 20, 1: now - 5}}
        result = state.merge(first, second)["meta"]
        self.assertEqual(result["last_scan_error"], "source unavailable")
        self.assertEqual(result["last_scan_success"], now - 100)
        self.assertEqual(result["discovery_seen"], {1: now - 10, 2: now - 20})

    def test_busy_lease_or_consumed_manual_request_does_not_scan(self):
        import scanner
        import state
        cfg = settings()
        cfg["schedule_search_request"] = "manual-request"
        for owner in (None, "owner"):
            data = state._empty()
            with patch.object(scanner.scheduler_client, "enabled", return_value=True), \
                 patch.object(scanner.scheduler_client, "refresh"), \
                 patch.object(scanner.scheduler_client, "lease", return_value=nullcontext(owner)), \
                 patch.object(scanner.scheduler_client, "runtime", return_value={"ok": False}), \
                 patch.object(scanner.config, "load_settings", return_value=copy.deepcopy(cfg)), \
                 patch.object(scanner.config, "apply"), patch.object(scanner.state, "load", return_value=data), \
                 patch.object(scanner.deal_queue, "load", return_value=[]), \
                 patch.object(scanner, "fill_queue") as fill, patch.object(scanner, "_persist") as save:
                scanner.main()
                fill.assert_not_called()
                save.assert_not_called()


if __name__ == "__main__":
    unittest.main()
