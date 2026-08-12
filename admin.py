import time

import config
import smart
import tg

ACTIONS = {"l": "likes", "d": "dislikes", "b": "bought"}
MIN_GAP = 1800

SETTABLE = {
    "min_discount": ("float", "мин. скидка %"),
    "min_rating": ("float", "мин. рейтинг"),
    "max_price": ("float", "макс. цена"),
    "max_posts": ("int", "постов за запуск"),
    "pages": ("int", "страниц поиска"),
    "queries": ("queries", "запросы через запятую"),
    "link_template": ("template", "шаблон ссылки с {nm}"),
}


def poll(token, data):
    offset = data["tg"].get("offset", 0)
    updates = tg.get_updates(token, offset)
    if not updates:
        return []
    new_offset = max(u["update_id"] for u in updates) + 1
    tg.get_updates(token, new_offset, timeout=0)
    data["tg"]["offset"] = new_offset
    events = []
    for u in updates:
        if "callback_query" in u:
            events.append(("callback", u["callback_query"]))
        elif "message" in u:
            msg = u["message"]
            if msg.get("chat", {}).get("type") == "private":
                events.append(("message", msg))
    return events


def _lookup(data, pid):
    for r in data["recent"]:
        if r.get("pid") == pid:
            return r.get("query"), r.get("cat")
    fb = data["feedback"].get(pid)
    if fb:
        return fb.get("query"), fb.get("cat")
    return None, None


def _callback(token, data, cb):
    raw = str(cb.get("data", ""))
    if len(raw) < 2 or raw[0] not in ACTIONS:
        return
    action = ACTIONS[raw[0]]
    try:
        pid = int(raw[1:])
    except ValueError:
        return
    now = time.time()
    fb = data["feedback"].get(pid)
    if fb and now - fb.get("ts", 0) < MIN_GAP:
        return
    query, cat = _lookup(data, pid)
    if fb is None:
        fb = {"likes": 0, "dislikes": 0, "bought": 0, "ts": 0, "query": query, "cat": cat}
    fb[action] += 1
    fb["ts"] = now
    data["feedback"][pid] = fb
    smart.record_feedback(data, query, cat, action)
    text = {"likes": "Учтено 👍", "dislikes": "Поняли 👎", "bought": "Круто! 🛒"}[action]
    tg.answer_callback(token, cb.get("id", ""), text)


def _reply(token, chat_id, *lines):
    tg.send_message(token, chat_id, "\n".join(str(x) for x in lines))


def handle_events(token, admin_id, data, settings, events):
    if not events:
        return False
    changed = False
    for kind, ev in events:
        if kind == "callback":
            _callback(token, data, ev)
            continue
        chat_id = ev["chat"]["id"]
        user_id = ev.get("from", {}).get("id")
        if admin_id and str(user_id) == str(admin_id):
            changed = (
                _command(token, chat_id, data, settings, ev.get("text", ""))
                or changed
            )
        else:
            _reply(
                token,
                chat_id,
                "Это админ-бот канала @WBmarket22.",
                f"Доступ только для владельца. Ваш ID: <code>{user_id}</code>",
            )
    return changed


def _command(token, chat_id, data, settings, text):
    parts = text.split()
    cmd = parts[0].lower() if parts else "/help"
    if cmd in ("/start", "/help"):
        _reply(token, chat_id, *_help())
    elif cmd == "/status":
        _reply(token, chat_id, *_status(data, settings))
    elif cmd == "/last":
        n = 5
        if len(parts) > 1:
            try:
                n = int(parts[1])
            except ValueError:
                pass
        _reply(token, chat_id, *_last(data, n))
    elif cmd == "/stats":
        _reply(token, chat_id, smart.summary(data["query_stats"], data["cat_stats"]))
    elif cmd == "/cfg":
        _reply(token, chat_id, *_cfg(settings))
    elif cmd == "/set":
        return _set(token, chat_id, settings, parts)
    elif cmd == "/pause":
        hours = 6
        if len(parts) > 1:
            try:
                hours = int(parts[1])
            except ValueError:
                pass
        settings["pause_until"] = int(time.time()) + hours * 3600
        settings["mtime"] = int(time.time())
        _reply(token, chat_id, f"Постинг на паузе на {hours} ч")
        return True
    elif cmd == "/resume":
        settings.pop("pause_until", None)
        settings["mtime"] = int(time.time())
        _reply(token, chat_id, "Постинг возобновлён")
        return True
    else:
        _reply(token, chat_id, "Неизвестная команда. /help — список команд")
    return False


def _help():
    return (
        "Команды админки:",
        "",
        "/status — состояние бота",
        "/last N — последние посты (по умолчанию 5)",
        "/stats — что нравится подписчикам",
        "/cfg — текущие настройки",
        "/set min_discount 45 — изменить настройку",
        "/set queries телефон,наушники",
        "/set link_template https://...{nm}...",
        "/pause 12 — пауза на 12 часов",
        "/resume — возобновить",
    )


def _status(data, settings):
    now = int(time.time())
    paused = settings.get("pause_until", 0) or 0
    rows = ["<b>Статус бота</b>", ""]
    if paused > now:
        rows.append(
            f"⏸ Пауза до {time.strftime('%d.%m %H:%M', time.localtime(paused))}"
        )
    else:
        rows.append("▶ Работает (постинг каждый час)")
    meta = data["meta"]
    if meta.get("last_run"):
        rows.append(
            f"Последний запуск: {time.strftime('%d.%m %H:%M', time.localtime(meta['last_run']))} "
            f"(опубликовано {meta.get('last_posts', 0)})"
        )
    else:
        rows.append("Последний запуск: ещё не было")
    likes = sum(fb["likes"] for fb in data["feedback"].values())
    dislikes = sum(fb["dislikes"] for fb in data["feedback"].values())
    bought = sum(fb["bought"] for fb in data["feedback"].values())
    rows += [
        f"В памяти артикулов: {len(data['posted'])}",
        f"Обратная связь: 👍 {likes} | 👎 {dislikes} | 🛒 {bought}",
    ]
    return rows


def _last(data, n):
    if not data["recent"]:
        return ("Постов пока нет",)
    rows = [f"<b>Последние посты ({min(n, len(data['recent']))}):</b>", ""]
    for r in data["recent"][:n]:
        fb = data["feedback"].get(r["pid"])
        likes = fb["likes"] if fb else 0
        name = r.get("title", "")[:40]
        rows.append(
            f"{r.get('discount', '?')}% | {r.get('price', '?')} ₽ | "
            f"👍 {likes} | {r.get('query', '-')}\n{name}\n{r.get('link', '')}"
        )
    return rows


def _cfg(settings):
    rows = [
        "<b>Настройки</b>",
        "",
        f"min_discount: {config.MIN_DISCOUNT}",
        f"min_rating: {config.MIN_RATING}",
        f"max_price: {config.MAX_PRICE or 'нет'}",
        f"max_posts: {config.MAX_POSTS}",
        f"pages: {config.PAGES}",
        f"queries: {', '.join(config.QUERIES or config.DEFAULT_QUERIES)}",
        f"link_template: {config.LINK_TEMPLATE}",
    ]
    return rows


def _set(token, chat_id, settings, parts):
    if len(parts) < 3:
        _reply(
            token,
            chat_id,
            "Формат: /set ключ значение",
            "Доступно: " + ", ".join(SETTABLE),
        )
        return False
    key = parts[1].lower()
    value = " ".join(parts[2:])
    spec = SETTABLE.get(key)
    if not spec:
        _reply(token, chat_id, f"Неизвестный ключ: {key}")
        return False
    kind = spec[0]
    try:
        if kind == "float":
            settings[key] = float(value)
        elif kind == "int":
            settings[key] = int(value)
        elif kind == "queries":
            settings[key] = [q.strip() for q in value.split(",") if q.strip()]
        elif kind == "template":
            if "{nm}" not in value:
                _reply(token, chat_id, "Шаблон должен содержать {nm}")
                return False
            settings[key] = value
    except ValueError:
        _reply(token, chat_id, f"Некорректное значение для {key}")
        return False
    settings["mtime"] = int(time.time())
    _reply(token, chat_id, f"Установлено: {key} = {settings[key]}")
    return True