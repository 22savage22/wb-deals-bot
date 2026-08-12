import html
import json

import requests

URL = "https://api.telegram.org/bot{token}/sendPhoto"


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


def send_photo(token, chat_id, photo, text, link):
    payload = {
        "chat_id": chat_id,
        "caption": text,
        "parse_mode": "HTML",
        "reply_markup": json.dumps(
            {"inline_keyboard": [[{"text": "Купить", "url": link}]]}
        ),
    }
    resp = requests.post(
        URL.format(token=token),
        data=payload,
        files={"photo": ("photo.jpg", photo, "image/jpeg")},
        timeout=90,
    )
    return resp.ok
