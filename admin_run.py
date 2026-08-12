import sys
import time

import admin
import bot
import config
import state


def main():
    settings = config.load_settings()
    config.apply(settings)
    data = state.load(config.STATE_FILE)
    changed = False

    events = admin.poll(config.TG_BOT_TOKEN, data)
    if events:
        changed = admin.handle_events(
            config.TG_BOT_TOKEN, config.TG_ADMIN_ID, data, settings, events
        )
        if changed:
            config.save_settings(settings)

    state.save(config.STATE_FILE, data)
    bot.commit_state(config.STATE_FILE, data)
    if changed:
        bot.commit_settings(config.SETTINGS_FILE, settings)

    print("Обновления обработаны:", len(events), "| state:", len(data["posted"]))


if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()