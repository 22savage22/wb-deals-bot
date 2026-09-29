"""Validate one newly discovered queued item and preview it to the admin only."""

import os

import requests

import bot
import config
import deal_queue
import tg
import wb


def main():
    token = os.environ.get("TG_BOT_TOKEN", "")
    admin = os.environ.get("TG_ADMIN_ID", "")
    channel = os.environ.get("TG_CHAT_ID", "")
    if not token or not admin or not channel or admin == channel:
        raise RuntimeError("A distinct private admin chat is required for safe preview")
    if not os.environ.get("WB_SOURCE_KEY"):
        raise RuntimeError("WB_SOURCE_KEY is unavailable")

    config.apply(config.load_settings())
    queue = deal_queue.load(config.QUEUE_FILE)
    response = requests.get(
        "https://wb-finds-miniapp.valeramyakishev000.workers.dev/api/catalog",
        timeout=(5, 15),
    )
    response.raise_for_status()
    known = {int(item["id"]) for item in response.json()["products"]}
    fresh = [item for item in queue if int(item["id"]) not in known]
    print("QUEUE_SIZE", len(queue), "NEW_QUEUED", len(fresh), flush=True)
    if not fresh:
        raise RuntimeError("No item newly discovered beyond the existing catalog")

    for item in fresh[:3]:
        pid = int(item["id"])
        cards = wb.cards([pid])
        deal, reason = wb.evaluate(cards[0], min_discount=0) if cards else (None, "missing")
        if not deal:
            print("PREVIEW_SKIP", pid, reason, flush=True)
            continue
        images = wb.photos(pid, limit=2)
        if len(images) < 2:
            print("PREVIEW_SKIP", pid, "no_photos", flush=True)
            continue
        caption = tg.caption(deal, pid) + "\n\n⚠️ <b>Тестовый предпросмотр. В канал не отправлено.</b>"
        if not tg.send_photo(token, admin, images[0], caption, bot._link(pid), pid):
            raise RuntimeError("Telegram did not accept the private preview: " + tg.last_error())
        print("SAFE_PREVIEW", pid, "PRICE", deal["product"],
              "PHOTOS", len(images), "TELEGRAM_ADMIN SUCCESS", flush=True)
        return
    raise RuntimeError("No newly discovered queued item was ready for posting")


if __name__ == "__main__":
    main()
