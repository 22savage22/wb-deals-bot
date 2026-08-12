import subprocess
import sys
import time

import admin
import config
import gitutil
import state

LIFETIME = 6 * 3600
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


def main():
    settings = config.load_settings()
    config.apply(settings)
    data = state.load(config.STATE_FILE)
    last_commit = 0.0
    start = time.time()
    while time.time() - start < LIFETIME - 180:
        events = admin.poll(config.TG_BOT_TOKEN, data)
        if events:
            changed = admin.handle_events(
                config.TG_BOT_TOKEN, config.TG_ADMIN_ID, data, settings, events
            )
            if changed:
                config.save_settings(settings)
                commit_settings(config.SETTINGS_FILE, settings)
        if time.time() - last_commit > COMMIT_EVERY:
            _pull()
            state.save(config.STATE_FILE, data)
            commit_state(config.STATE_FILE, data)
            last_commit = time.time()
            print("poller alive | posted:", len(data["posted"]))
        time.sleep(CYCLE)
    _pull()
    state.save(config.STATE_FILE, data)
    commit_state(config.STATE_FILE, data)
    print("Poller session finished, respawn step will start new one")


if __name__ == "__main__":
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()