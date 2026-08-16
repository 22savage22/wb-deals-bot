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
    ("👀", "Вот это уже интересно"),
    ("🛍", "Нашлась достойная цена"),
    ("📌", "Можно сохранить в подборку"),
]

PRICE_WORDS = ["Цена", "Сейчас", "Всего", "Итого"]

FOOTERS = [
    "🔔 Подписывайся, чтобы не пропускать находки!",
    "🔥 Делитесь с друзьями — пусть и они ловят скидки!",
    "💜 Каждый день выгодные цены — оставайтесь с нами!",
    "🚀 Новые скидки каждый час — не пропустите!",
    "📣 Репост друзьям — лучшие находки забирают первыми!",
    "💜 Проверяй цену перед заказом: на WB она может меняться.",
    "👀 Забирай в избранное, если вещь пригодится позже.",
    "📌 Здесь только отобранные находки — без бесконечной ленты товаров.",
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


def _insight(deal, pid):
    rating = float(deal.get("rating", 0) or 0)
    feedbacks = int(deal.get("feedbacks", 0) or 0)
    benefit = int(deal.get("benefit", 0) or 0)
    variants = []
    if rating >= 4.7 and feedbacks >= 100:
        variants.append(f"💬 Сильный сигнал: рейтинг {rating:g} при {fmt(feedbacks)} отзывах.")
    if benefit >= 3000:
        variants.append(f"🧮 Разница с базовой ценой — {fmt(benefit)} руб.")
    if deal.get("selection_mode") == "smart_fallback":
        variants.append("🔎 Не рекордная скидка, зато карточка прошла проверку рейтинга и отзывов.")
    variants += [
        "💡 Сравни цену и комплектацию перед заказом — у размеров и вариантов они отличаются.",
        "👌 Выглядит достойно для короткого списка, а не для бесконечного скролла.",
        "📦 Проверь продавца и свежие отзывы — это займёт минуту и спасёт от случайной покупки.",
    ]
    return _pick(str(pid) + "insight", variants)


def caption(deal, pid=None):
    title = html.escape(deal["title"])
    if len(title) > 100:
        title = title[:97] + "..."
    pid = pid or deal.get("id") or 0
    tags = "#вайлдберриз #скидки #wb"
    tags += _tag(deal["category"])
    if deal["brand"]:
        tags += _tag(deal["brand"])
    for w in _title_tags(deal["title"]):
        tags += " #" + w
    footer = _pick(pid, FOOTERS)
    insight = _insight(deal, pid)
    if deal.get("price_drop"):
        last_price = deal.get("last_price") or deal["basic"]
        lines = [
            "📉 <b>Цена упала ещё ниже!</b>",
            "",
            f"<b>{title}</b>",
            "",
            f"Было: <s>{fmt(last_price)}</s> руб → Стало: <b>{fmt(deal['product'])}</b> руб",
            f"🔥 -{deal['discount']}% · выгода {fmt(deal['benefit'])} руб",
            f"Рейтинг: {deal['rating']} | Отзывов: {deal['feedbacks']}",
            insight,
        ]
        if deal["brand"]:
            lines.append(f"Бренд: {html.escape(deal['brand'])}")
        lines += ["", tags, footer]
        return "\n".join(lines)
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
        insight,
    ]
    if deal["brand"]:
        lines.append(f"Бренд: {html.escape(deal['brand'])}")
    lines.append("")
    lines.append(tags)
    lines.append(footer)
    return "\n".join(lines)


def _kb(markup):
    if isinstance(markup, dict):
        return markup
    return {"inline_keyboard": markup}


def _buttons(link, pid):
    return {
        "inline_keyboard": [
            [{"text": "Купить", "url": link}],
            [
                {"text": "👍", "callback_data": f"l{pid}"},
                {"text": "👎", "callback_data": f"d{pid}"},
                {"text": "🛒 Купил", "callback_data": f"b{pid}"},
            ],
        ]
    }


def send_photo(token, chat_id, photo, text, link=None, pid=None, markup=None):
    payload = {
        "chat_id": chat_id,
        "caption": text,
        "parse_mode": "HTML",
    }
    if markup is not None:
        payload["reply_markup"] = json.dumps(_kb(markup))
    elif link and pid:
        payload["reply_markup"] = json.dumps(_buttons(link, pid))
    try:
        resp = requests.post(
            API.format(token=token, method="sendPhoto"),
            data=payload,
            files={"photo": ("photo.jpg", photo, "image/jpeg")},
            timeout=90,
        )
        return resp.ok
    except requests.RequestException:
        return False


def send_album(token, chat_id, photos, text, link=None, pid=None, markup=None):
    media = []
    for i, p in enumerate(photos):
        item = {"type": "photo", "media": f"attach://p{i}.jpg"}
        if i == 0:
            item["caption"] = text
            item["parse_mode"] = "HTML"
            if markup is not None:
                item["reply_markup"] = _kb(markup)
            elif link and pid:
                item["reply_markup"] = _buttons(link, pid)
        media.append(item)
    payload = {"chat_id": chat_id, "media": json.dumps(media)}
    files = {f"p{i}.jpg": (f"p{i}.jpg", p, "image/jpeg") for i, p in enumerate(photos)}
    try:
        resp = requests.post(
            API.format(token=token, method="sendMediaGroup"),
            data=payload,
            files=files,
            timeout=90,
        )
        return resp.ok
    except requests.RequestException:
        return False


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
            try:
                return resp.json().get("result") or []
            except ValueError:
                pass
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
