import html
import json

import requests

API = "https://api.telegram.org/bot{token}/{method}"


def fmt(n):
    return f"{n:,}".replace(",", " ")


def caption(deal):
    title = html.escape(deal["title"])
    if len(title) > 100:
        title = title[:97] + "..."
    lines = [
        f"СКИДКА <b>{deal['discount']}%</b>",
        "",
        f"<b>{title}</b>",
        "",
        f"Цена: <b>{fmt(deal['product'])}</b> руб  <s>{fmt(deal['basic'])} руб</s>",
        f"Выгода: {fmt(deal['benefit'])} руб",
        f"Рейтинг: {deal['rating']} | Отзывов: {deal['feedbacks']}",
    ]
    if deal["brand"]:
        lines.append(f"Бренд: {html.escape(deal['brand'])}")
    lines.append("")
    lines.append("#вайлдберриз #скидки #выгодно #wb")
    return "\n".join(lines)


def send_photo(token, chat_id, photo, text, link, pid):
    payload = {
        "chat_id": chat_id,
        "caption": text,
        "parse_mode": "HTML",
        "reply_markup": json.dumps(
            {
                "inline_keyboard": [
                    [{"text": "Купить", "url": link}],
                    [
                        {"text": "👍", "callback_data": f"l{pid}"},
                        {"text": "👎", "callback_data": f"d{pid}"},
                        {"text": "🛒 Купил", "callback_data": f"b{pid}"},
                    ],
                ]
            }
        ),
    }
    resp = requests.post(
        API.format(token=token, method="sendPhoto"),
        data=payload,
        files={"photo": ("photo.jpg", photo, "image/jpeg")},
        timeout=90,
    )
    return resp.ok


def send_message(token, chat_id, text):
    try:
        resp = requests.post(
            API.format(token=token, method="sendMessage"),
            data={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
            timeout=20,
        )
        return resp.ok
    except requests.RequestException:
        return False


def get_updates(token, offset, timeout=3):
    try:
        resp = requests.get(
            API.format(token=token, method="getUpdates"),
            params={
                "timeout": timeout,
                "offset": offset,
                "allowed_updates": json.dumps(["callback_query", "message"]),
            },
            timeout=25,
        )
        if resp.ok:
            return resp.json().get("result") or []
    except requests.RequestException:
        pass
    return []


def answer_callback(token, callback_id, text=""):
    try:
        requests.post(
            API.format(token=token, method="answerCallbackQuery"),
            data={"callback_query_id": callback_id, "text": text},
            timeout=15,
        )
    except requests.RequestException:
        pass