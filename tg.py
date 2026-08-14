import html
import json
import re

import requests

API = "https://api.telegram.org/bot{token}/{method}"

OPENERS = [
    ("🔥", "Горячая скидка!"),
    ("⚡", "Скидка дня!"),
    ("🚨", "Не пропусти!"),
    ("🎁", "Находка для тебя!"),
    ("💥", "Ударная цена!"),
    ("🍀", "Лови удачу в цене!"),
    ("✨", "Сегодня дешевле!"),
    ("💰", "Экономия зафиксирована!"),
]

PRICE_WORDS = ["Цена", "Сейчас", "Всего", "Итого"]

FOOTERS = [
    "🔔 Подписывайся, чтобы не пропускать находки!",
    "🔥 Делитесь с друзьями — пусть и они ловят скидки!",
    "💜 Каждый день выгодные цены — оставайтесь с нами!",
    "🚀 Новые скидки каждый час — не пропустите!",
    "📣 Репост друзьям — лучшие находки забирают первыми!",
]

BAD_TAGS = {"другое", "разное", "прочее", ""}

STOP_TAGS = {
    "для", "скидка", "скидки", "товар", "новый", "новая", "новое", "новые",
    "большой", "большая", "большие", "набор", "комплект", "цена", "купить",
    "детей", "ребенка", "ребёнка", "дома", "всего", "выгодно", "акция",
    "хит", "бестселлер", "оригинал", "качественный", "красивый",
}


def _title_tags(title):
    words = re.findall(r"[A-Za-zА-Яа-яЁё0-9]{3,20}", str(title or "").lower())
    out = []
    for w in words:
        if w in STOP_TAGS or w in out:
            continue
        out.append(w)
        if len(out) >= 2:
            break
    return out


def fmt(n):
    return f"{n:,}".replace(",", " ")


def _pick(pid, values):
    h = 0
    for ch in str(pid):
        h = (h * 33 + ord(ch)) & 0x7FFFFFFF
    return values[h % len(values)]


def _tag(text):
    words = re.findall(r"[A-Za-zА-Яа-яЁё0-9]+", str(text or ""))
    if not words:
        return ""
    tag = "".join(words[:2]).lower()
    if tag in BAD_TAGS:
        return ""
    return " #" + tag


def caption(deal, pid=None):
    title = html.escape(deal["title"])
    if len(title) > 100:
        title = title[:97] + "..."
    pid = pid or deal.get("id") or 0
    emoji, opener = _pick(pid, OPENERS)
    price_word = _pick(pid, PRICE_WORDS)
    lines = [
        f"{emoji} <b>{opener}</b>",
        "",
        f"<b>{title}</b>",
        "",
        f"{price_word}: <b>{fmt(deal['product'])}</b> руб  <s>{fmt(deal['basic'])} руб</s>",
        f"🔥 -{deal['discount']}% · выгода {fmt(deal['benefit'])} руб",
        f"Рейтинг: {deal['rating']} | Отзывов: {deal['feedbacks']}",
    ]
    if deal["brand"]:
        lines.append(f"Бренд: {html.escape(deal['brand'])}")
    lines.append("")
    tags = "#вайлдберриз #скидки #wb"
    tags += _tag(deal["category"])
    if deal["brand"]:
        tags += _tag(deal["brand"])
    for w in _title_tags(deal["title"]):
        tags += " #" + w
    lines.append(tags)
    lines.append(_pick(pid, FOOTERS))
    return "\n".join(lines)


def _kb(markup):
    if isinstance(markup, dict):
        return markup
    return {"inline_keyboard": markup}


def send_photo(token, chat_id, photo, text, link=None, pid=None, markup=None):
    payload = {
        "chat_id": chat_id,
        "caption": text,
        "parse_mode": "HTML",
    }
    if markup is not None:
        payload["reply_markup"] = json.dumps(_kb(markup))
    elif link and pid:
        payload["reply_markup"] = json.dumps(
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
        )
    resp = requests.post(
        API.format(token=token, method="sendPhoto"),
        data=payload,
        files={"photo": ("photo.jpg", photo, "image/jpeg")},
        timeout=90,
    )
    return resp.ok


def send_message(token, chat_id, text, markup=None):
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    if markup is not None:
        payload["reply_markup"] = json.dumps(_kb(markup))
    try:
        resp = requests.post(
            API.format(token=token, method="sendMessage"),
            data=payload,
            timeout=20,
        )
        return resp.ok
    except requests.RequestException:
        return False


def edit_message_text(token, chat_id, message_id, text, markup=None):
    payload = {
        "chat_id": chat_id,
        "message_id": message_id,
        "text": text,
        "parse_mode": "HTML",
    }
    if markup is not None:
        payload["reply_markup"] = json.dumps(_kb(markup))
    try:
        resp = requests.post(
            API.format(token=token, method="editMessageText"),
            data=payload,
            timeout=20,
        )
        if resp.ok:
            return True
        try:
            description = resp.json().get("description", "")
        except (ValueError, AttributeError):
            description = ""
        if "message is not modified" in description:
            return None
        return False
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


COMMANDS = [
    ("help", "Панель управления"),
    ("status", "Состояние бота"),
    ("last", "Последние посты"),
    ("stats", "Что нравится подписчикам"),
    ("cfg", "Текущие настройки"),
    ("set", "Изменить настройку"),
    ("pause", "Пауза постинга"),
    ("resume", "Возобновить постинг"),
    ("post", "Пост по артикулу"),
    ("preview", "Превью поиска"),
]


def set_commands(token):
    try:
        requests.post(
            API.format(token=token, method="setMyCommands"),
            data={
                "commands": json.dumps(
                    [{"command": c, "description": d} for c, d in COMMANDS]
                )
            },
            timeout=20,
        )
    except requests.RequestException:
        pass