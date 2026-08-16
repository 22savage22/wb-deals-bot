import logging
import subprocess
import sys
import time

import admin
import config
import gitutil
import log
import smart
import state
import tg

logger = logging.getLogger("wb.poller")

LIFETIME = 28 * 60
CYCLE = 15
COMMIT_EVERY = 300


def _pull():
    subprocess.run(["git", "pull", "--ff-only", "-q"], capture_output=True)


def commit_state(path, data):
    return gitutil.commit(
        path, lambda remote: state.merge(data, remote), "chore: update state"
    )


def commit_settings(path, settings):
    def merge(remote):
        if not isinstance(remote, dict):
            return settings
        if remote.get("mtime", 0) > settings.get("mtime", 0):
            return remote
        return settings

    return gitutil.commit(path, merge, "chore: update settings")


def _maybe_daily_digest(token, data):
    day = time.strftime("%Y-%m-%d")
    meta = data["meta"]
    if meta.get("digest_date") == day:
        return
    if meta.get("digest_date") and config.TG_ADMIN_ID:
        tg.send_message(token, config.TG_ADMIN_ID, smart.admin_digest(data))
    meta["digest_date"] = day


def _maybe_week_digest(token, data, settings):
    if not int(settings.get("weekly_digest", config.WEEKLY_DIGEST) or 0):
        return
    now = int(time.time())
    meta = data["meta"]
    if now - int(meta.get("week_digest_ts", 0) or 0) < 7 * 86400:
        return
    if not any(r.get("ts", 0) >= now - 7 * 86400 for r in data["recent"]):
        meta["week_digest_ts"] = now
        return
    text = smart.week_digest(data)
    if tg.send_message(token, config.TG_CHAT_ID, text):
        meta["week_digest_ts"] = now
        if config.TG_ADMIN_ID:
            tg.send_message(token, config.TG_ADMIN_ID, "📣 Итоги недели опубликованы в канал")


def main():
    log.setup()
    if not config.TG_BOT_TOKEN or not config.TG_ADMIN_ID:
        print("Задайте TG_BOT_TOKEN и TG_ADMIN_ID")
        sys.exit(1)
    settings = config.load_settings()
    config.apply(settings)
    data = state.load(config.STATE_FILE)
    tg.set_commands(config.TG_BOT_TOKEN)
    last_commit = 0.0
    start = time.time()
    while time.time() - start < LIFETIME - 180:
        _maybe_daily_digest(config.TG_BOT_TOKEN, data)
        _maybe_week_digest(config.TG_BOT_TOKEN, data, settings)
        now = time.time()
        if (
            settings.get("post_lock")
            and settings.get("post_now_ts")
            and now - float(settings["post_now_ts"]) > 3600
        ):
            settings.pop("post_now_ts", None)
            settings.pop("post_lock", None)
            config.save_settings(settings)
            commit_settings(config.SETTINGS_FILE, settings)
        events = admin.poll(config.TG_BOT_TOKEN, data)
        if events:
            try:
                changed = admin.handle_events(
                    config.TG_BOT_TOKEN, config.TG_ADMIN_ID, data, settings, events
                )
            except Exception as exc:
                state.record_error(data, f"Обработка команд упала: {exc}")
                logger.error("Обработка команд упала: %s", exc)
                changed = False
            if changed:
                config.save_settings(settings)
                commit_settings(config.SETTINGS_FILE, settings)
        if settings.get("post_now_ts") and not settings.get("post_lock"):
            settings["post_lock"] = 1
            config.save_settings(settings)
            try:
                import bot

                published = bot.run_posting(data, settings, notify=False)
                msg = f"🚀 Ручной запуск завершён: опубликовано <b>{published}</b>"
            except Exception as exc:
                state.record_error(data, f"Ручной запуск упал: {exc}")
                logger.error("Ручной запуск упал: %s", exc)
                msg = f"❌ Ручной запуск упал: {exc}"
            finally:
                settings.pop("post_now_ts", None)
                settings.pop("post_lock", None)
                settings["mtime"] = int(time.time())
                config.save_settings(settings)
                commit_settings(config.SETTINGS_FILE, settings)
            state.save(config.STATE_FILE, data)
            commit_state(config.STATE_FILE, data)
            if config.TG_ADMIN_ID:
                tg.send_message(config.TG_BOT_TOKEN, config.TG_ADMIN_ID, msg)
        if time.time() - last_commit > COMMIT_EVERY:
            _pull()
            state.save(config.STATE_FILE, data)
            commit_state(config.STATE_FILE, data)
            last_commit = time.time()
            logger.info("poller alive | posted: %d", len(data["posted"]))
        time.sleep(CYCLE)
    _pull()
    state.save(config.STATE_FILE, data)
    commit_state(config.STATE_FILE, data)
    print("Poller session finished; the next scheduled run will continue polling")


if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
