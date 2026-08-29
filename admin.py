import html
import time

import config
import smart
import state
import tg
import wb

ACTIONS = {"l": "likes", "d": "dislikes", "b": "bought"}
MIN_GAP = 1800
MENU = "A:"
PAGE = 5

SETTABLE = {
    "min_discount": ("float", "пост публикуется, только если скидка не меньше этой"),
    "min_rating": ("float", "не постить товары с рейтингом ниже"),
    "max_price": ("float", "не постить дороже этой цены (0 = без лимита)"),
    "max_posts": ("int", "сколько постов публиковать за один запуск"),
    "pages": ("int", "сколько страниц поиска просматривать"),
    "queries_per_run": ("int", "по скольким запросам искать за запуск"),
    "cats_per_run": ("int", "сколько категорий WB проверять за запуск (самообучение)"),
    "repost_days": ("float", "через сколько дней повторять уже показанный товар"),
    "dest": ("int", "номер региона доставки Wildberries"),
    "queries": ("queries", "по каким запросам искать товары"),
    "link_template": ("template", "шаблон ссылки на товар, нужен {nm}"),
    "weekly_digest": ("int", "еженедельный итоговый пост в канал (1 — вкл, 0 — выкл)"),
    "blacklist": ("queries", "бренды или артикулы, которые никогда не постить (через запятую)"),
}

NAMES = {
    "min_discount": "Мин. скидка",
    "min_rating": "Мин. рейтинг",
    "max_price": "Макс. цена",
    "max_posts": "Постов за запуск",
    "pages": "Страниц поиска",
    "queries_per_run": "Запросов за запуск",
    "cats_per_run": "Категорий за запуск",
    "repost_days": "Повтор через",
    "dest": "Регион WB",
    "queries": "Запросы",
    "link_template": "Шаблон ссылки",
    "weekly_digest": "Итоги недели",
    "blacklist": "Чёрный список",
}

ICONS = {
    "min_discount": "💰",
    "min_rating": "⭐",
    "max_price": "💵",
    "max_posts": "📦",
    "pages": "📄",
    "queries_per_run": "🎯",
    "cats_per_run": "🗂",
    "repost_days": "🔁",
    "dest": "📍",
    "queries": "🔍",
    "link_template": "🔗",
    "weekly_digest": "📣",
    "blacklist": "🚫",
}

MAIN_KEYS = [
    "min_discount",
    "min_rating",
    "max_price",
    "max_posts",
    "queries_per_run",
    "repost_days",
    "pages",
    "queries",
]
ADV_KEYS = ["dest", "link_template", "weekly_digest", "blacklist", "cats_per_run"]

STEPS = {
    "min_discount": 5,
    "min_rating": 0.5,
    "max_price": 1000,
    "max_posts": 1,
    "pages": 1,
    "queries_per_run": 1,
    "repost_days": 1,
    "cats_per_run": 1,
}

PRESETS = {
    "min_discount": [("30", "30%"), ("40", "40%"), ("50", "50%"), ("60", "60%"), ("70", "70%")],
    "min_rating": [("0", "выкл"), ("3.5", "3,5"), ("4", "4"), ("4.5", "4,5")],
    "max_price": [("0", "без лимита"), ("3000", "3 000 ₽"), ("5000", "5 000 ₽"), ("10000", "10 000 ₽")],
    "max_posts": [("1", "1"), ("3", "3"), ("5", "5"), ("8", "8"), ("10", "10")],
    "pages": [("1", "1"), ("2", "2"), ("3", "3")],
    "queries_per_run": [("1", "1"), ("2", "2"), ("3", "3"), ("4", "4")],
    "cats_per_run": [("1", "1"), ("2", "2"), ("3", "3"), ("5", "5"), ("8", "8")],
    "repost_days": [("3", "3 дн."), ("7", "7 дн."), ("14", "14 дн."), ("30", "30 дн.")],
}

BOUNDS = {
    "min_discount": (0, 95),
    "min_rating": (0, 5),
    "max_price": (0, 500000),
    "max_posts": (1, 20),
    "pages": (1, 5),
    "queries_per_run": (1, 10),
    "repost_days": (0.5, 90),
    "cats_per_run": (1, 20),
    "weekly_digest": (0, 1),
}


def poll(token, data):
    offset = data["tg"].get("offset", 0)
    updates = tg.get_updates(token, offset)
    if not updates:
        return []
    new_offset = max(u["update_id"] for u in updates) + 1
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


def _feedback(token, data, cb):
    raw = str(cb.get("data", ""))
    if len(raw) < 2 or raw[0] not in ACTIONS:
        tg.answer_callback(token, cb.get("id", ""))
        return
    action = ACTIONS[raw[0]]
    try:
        pid = int(raw[1:])
    except ValueError:
        tg.answer_callback(token, cb.get("id", ""))
        return
    cb_id = cb.get("id", "")
    tg.answer_callback(token, cb_id, "✓")
    now = time.time()
    user_id = str(cb.get("from", {}).get("id"))
    fb = data["feedback"].get(pid)
    voters = (fb or {}).get("voters", {})
    if user_id and now - voters.get(user_id, 0) < MIN_GAP:
        return
    query, cat = _lookup(data, pid)
    if fb is None:
        fb = {"likes": 0, "dislikes": 0, "bought": 0, "ts": 0, "query": query, "cat": cat, "voters": {}}
    fb[action] += 1
    fb["ts"] = now
    if user_id:
        fb["voters"] = dict(voters)
        fb["voters"][user_id] = now
    data["feedback"][pid] = fb
    smart.record_feedback(data, query, cat, action)


def _reply(token, chat_id, *lines):
    tg.send_message(token, chat_id, "\n".join(str(x) for x in lines))


def handle_events(token, admin_id, data, settings, events):
    if not events:
        return False
    changed = False
    for kind, ev in events:
        if kind == "callback":
            user_id = ev.get("from", {}).get("id")
            raw = str(ev.get("data", ""))
            if admin_id and str(user_id) == str(admin_id) and raw.startswith(MENU):
                changed = _admin_callback(token, data, settings, ev) or changed
            else:
                _feedback(token, data, ev)
            continue
        chat_id = ev["chat"]["id"]
        user_id = ev.get("from", {}).get("id")
        if admin_id and str(user_id) == str(admin_id):
            changed = (
                _admin_message(token, chat_id, data, settings, ev.get("text", ""))
                or changed
            )
        elif ev.get("chat", {}).get("type") == "private":
            if not admin_id:
                _reply(
                    token,
                    chat_id,
                    "Это админ-бот канала @WBmarket22.",
                    f"Доступ только для владельца. Ваш ID: <code>{user_id}</code>",
                )
            else:
                _reply(token, chat_id, "У вас нет доступа к этому боту.")
    return changed


# ---------- helpers ----------

def _btn(text, data):
    return {"text": text, "callback_data": data}


def _link(pid):
    """Безопасная ссылка: кривой шаблон не должен уронить бота."""
    try:
        return config.LINK_TEMPLATE.format(nm=pid)
    except (KeyError, IndexError, ValueError):
        return f"https://www.wildberries.ru/catalog/{pid}/detail.aspx"


def _home_row():
    return [[_btn("🏠 Меню", MENU + "menu")]]


def _menu_markup(data, settings):
    return _menu_view(data, settings)[1]


def _ft(ts):
    return time.strftime("%d.%m %H:%M", time.localtime(ts))


def _left(sec):
    h, m = divmod(int(sec) // 60, 60)
    if h:
        return f"{h} ч {m:02d} мин"
    return f"{m} мин"


def _clean_pid(raw):
    digits = "".join(ch for ch in str(raw) if ch.isdigit())
    try:
        return int(digits) if digits else None
    except ValueError:
        return None


def _num(n):
    if n == int(n) and abs(n) >= 1000:
        return tg.fmt(int(n))
    return f"{n:g}"


def _clamp(key, v):
    lo, hi = BOUNDS.get(key, (None, None))
    if lo is not None and v < lo:
        return lo
    if hi is not None and v > hi:
        return hi
    return v


def _is_paused(settings):
    return settings.get("pause_until", 0) or 0


def _feedback_counts(data):
    likes = sum(fb.get("likes", 0) for fb in data["feedback"].values())
    dislikes = sum(fb.get("dislikes", 0) for fb in data["feedback"].values())
    bought = sum(fb.get("bought", 0) for fb in data["feedback"].values())
    return likes, dislikes, bought


def _render(token, chat_id, message_id, text, markup=None):
    if message_id:
        result = tg.edit_message_text(token, chat_id, message_id, text, markup)
        if result is True:
            return True
        if result is None:
            return False
    return tg.send_message(token, chat_id, text, markup=markup)


# ---------- views ----------

def _menu_view(data, settings):
    paused = _is_paused(settings)
    now = int(time.time())
    meta = data["meta"]
    if paused > now:
        state_line = f"⏸ <b>Пауза</b> до {_ft(paused)} · осталось {_left(paused - now)}"
        pause_lbl = "▶️ Снять"
        pause_cmd = MENU + "resume"
    else:
        state_line = "▶️ <b>Работает</b> — постинг по расписанию"
        pause_lbl = "⏸ Пауза"
        pause_cmd = MENU + "pause"
    lines = [
        "🎛 <b>Панель управления</b>",
        "",
        state_line,
    ]
    if meta.get("last_run"):
        lines.append(
            f"🕘 Посл. запуск: {_ft(meta['last_run'])} · постов: <b>{meta.get('last_posts', 0)}</b>"
        )
    total = meta.get("total_posts", 0)
    if total:
        today = meta.get("today_posts", 0)
        suffix = f" · сегодня <b>{today}</b>" if today else ""
        lines.append(f"📦 Всего публикаций: <b>{tg.fmt(total)}</b>{suffix}")
    likes, dislikes, bought = _feedback_counts(data)
    if likes or dislikes or bought:
        lines.append(f"💬 👍 {tg.fmt(likes)} · 👎 {tg.fmt(dislikes)} · 🛒 {tg.fmt(bought)}")
    lines.append("")
    lines.append("Канал: @WBmarket22")
    text = "\n".join(lines)
    queue_count = len(data.get("queue") or [])
    rows = [
        [
            _btn(f"📥 Найдено: {queue_count}", MENU + "queue"),
            _btn("📤 Опубликовать", MENU + "queue:bulk:1"),
        ],
        [
            _btn("📊 Статус", MENU + "status"),
            _btn("🕓 Посты", MENU + "last:0"),
        ],
        [
            _btn("🧠 Найти ещё", MENU + "postnow"),
            _btn("📦 По артикулу", MENU + "manual"),
        ],
        [
            _btn("⚙️ Настройки", MENU + "cfg"),
            _btn(pause_lbl, pause_cmd),
        ],
        [
            _btn("📈 Статистика", MENU + "stats:q:0"),
            _btn("❓ Помощь", MENU + "help"),
        ],
    ]
    return text, rows


def _queue_view(data):
    queue = list(data.get("queue") or [])
    if not queue:
        return (
            "📥 <b>Найденные товары</b>\n\n"
            "Очередь пока пуста. Сканер наполнит её автоматически.\n"
            "Можно запустить поиск вручную кнопкой ниже.",
            [
                [_btn("🧠 Найти товары", MENU + "postnow")],
                [_btn("🔄 Обновить", MENU + "queue")],
                _home_row()[0],
            ],
        )

    shown = queue[:5]
    lines = [
        "📥 <b>Найденные товары</b>",
        "",
        f"Готово к публикации: <b>{len(queue)}</b>",
        "Умный отбор уже проверил скидку, рейтинг и дубли.",
        "",
    ]
    markup = [
        [
            _btn("📤 1 пост", MENU + "queue:bulk:1"),
            _btn("📤📤 3 поста", MENU + "queue:bulk:3"),
            _btn("🚀 5 постов", MENU + "queue:bulk:5"),
        ]
    ]
    for i, deal in enumerate(shown, 1):
        title = html.escape(str(deal.get("title") or "Товар"))
        if len(title) > 54:
            title = title[:51] + "..."
        lines.append(
            f"{i}. 🔥 <b>{int(deal.get('discount', 0))}%</b> · "
            f"<b>{tg.fmt(int(deal.get('product', 0)))} ₽</b> · "
            f"⭐ {deal.get('rating', 0):g}"
        )
        lines.append(f"   {title}")
        lines.append(f"   <code>{deal.get('id')}</code>")
        lines.append("")
        markup.append(
            [
                _btn(f"👁 №{i}", MENU + f"preview:post:{deal.get('id')}"),
                _btn(f"📤 Опубликовать №{i}", MENU + f"queue:post:{deal.get('id')}"),
            ]
        )
    lines.append("👁 — посмотреть пост перед публикацией.")
    lines.append("Кнопки сверху публикуют товары подряд без подтверждений.")
    markup.append([_btn("🔄 Обновить", MENU + "queue")])
    markup.append(_home_row()[0])
    return "\n".join(lines).rstrip(), markup


def _status_view(data, settings):
    now = int(time.time())
    paused = _is_paused(settings)
    meta = data["meta"]
    rows = ["📊 <b>Состояние бота</b>", ""]
    if paused > now:
        rows.append(f"⏸ Пауза до <b>{_ft(paused)}</b> · осталось {_left(paused - now)}")
    else:
        rows.append("▶️ <b>Работает</b> — постинг по расписанию")
    if meta.get("last_run"):
        age = now - int(meta["last_run"])
        rows.append(
            f"🕘 Последний запуск: {_ft(meta['last_run'])} · постов <b>{meta.get('last_posts', 0)}</b>"
        )
        if age > 8 * 3600:
            rows.append(f"🔴 Автопостинг молчит уже <b>{_left(age)}</b> — проверь Actions")
        queries = meta.get("last_queries")
        if queries:
            rows.append("🔍 Запросы: " + ", ".join(str(q) for q in queries))
        funnel = meta.get("last_funnel") or {}
        if funnel:
            rows.append(
                "🧪 Воронка: "
                f"найдено <b>{int(funnel.get('found', 0))}</b> · "
                f"строго <b>{int(funnel.get('strict', 0))}</b> · "
                f"резерв <b>{int(funnel.get('fallback', 0))}</b> · "
                f"отобрано <b>{int(funnel.get('selected', 0))}</b>"
            )
        http = meta.get("wb_http") or {}
        if http:
            rows.append(
                "🌐 WB API: "
                f"успешно <b>{int(http.get('ok', 0))}</b> · "
                f"лимит <b>{int(http.get('rate_limited', 0))}</b> · "
                f"HTTP/сеть <b>{int(http.get('http_error', 0)) + int(http.get('network_error', 0))}</b>"
            )
    else:
        rows.append("🕘 Запусков ещё не было")
    total = meta.get("total_posts", 0)
    if total:
        rows.append(f"📦 Всего опубликовано: <b>{tg.fmt(total)}</b> · сегодня: <b>{meta.get('today_posts', 0)}</b>")
    likes, dislikes, bought = _feedback_counts(data)
    rows.append(
        f"💬 Обратная связь: 👍 <b>{tg.fmt(likes)}</b> · 👎 <b>{tg.fmt(dislikes)}</b> · 🛒 <b>{tg.fmt(bought)}</b>"
    )
    rows.append(f"📥 Артикулов в памяти: <b>{tg.fmt(len(data['posted']))}</b>")
    queue = data.get("queue") or []
    qtarget = max(1, config.QUEUE_TARGET)
    qicon = "🟢" if len(queue) >= min(15, qtarget) else ("🟡" if queue else "🔴")
    rows.append(f"{qicon} Готовых товаров в очереди: <b>{len(queue)}/{qtarget}</b>")
    if meta.get("last_scan"):
        rows.append(
            f"🔎 Последнее наполнение: {_ft(meta['last_scan'])} · "
            f"добавлено <b>{int(meta.get('last_scan_added', 0))}</b>"
        )
    active, trials = smart.learned_counts(data)
    if active or trials:
        rows.append(
            f"🧠 Самообучение: запросов в ротации <b>{active}</b> · на испытании <b>{trials}</b>"
        )
    n_cats = len(data.get("cats") or {})
    rows.append(f"🗂 Категорий WB в ротации: <b>{tg.fmt(n_cats)}</b>")
    chat = config.TG_CHAT_ID or "не задан"
    rows.append(f"🆔 Чат: <code>{chat}</code> · Админ: <code>{config.TG_ADMIN_ID or 'не задан'}</code>")
    text = "\n".join(rows)
    markup = [
        [
            _btn("🔄 Обновить", MENU + "status"),
            _btn("🕓 Посты", MENU + "last:0"),
            _btn("📈 Статистика", MENU + "stats:q:0"),
        ],
        [pause_btn(settings), _btn("⚠️ Ошибки", MENU + "errors")],
        _home_row()[0],
    ]
    return text, markup


def _errors_view(data):
    errors = (data.get("meta") or {}).get("errors") or []
    rows = ["⚠️ <b>Журнал ошибок</b>", ""]
    if not errors:
        rows.append("Ошибок нет — всё работает. ✨")
    else:
        for e in errors[-10:]:
            if not isinstance(e, dict):
                continue
            rows.append(
                f"<b>{_ft(e.get('ts', 0))}</b> — "
                f"{html.escape(str(e.get('msg', ''))[:150])}"
            )
        rows += ["", f"Всего в журнале: <b>{len(errors)}</b>"]
    return "\n".join(rows), _home_row()


def pause_btn(settings):
    now = int(time.time())
    if _is_paused(settings) > now:
        return _btn("▶️ Снять паузу", MENU + "resume")
    return _btn("⏸ Пауза", MENU + "pause")


def _last_view(data, page=0, size=PAGE):
    recent = data["recent"]
    if not recent:
        return "🕓 <b>Последние посты</b>\n\nПока ничего не опубликовано.", _home_row()
    total = max(1, -(-len(recent) // size))
    page = min(max(page, 0), total - 1)
    items = recent[page * size:(page + 1) * size]
    rows = [
        f"🕓 <b>Последние посты</b> · стр {page + 1} из {total}",
        "",
    ]
    for i, r in enumerate(items, page * size + 1):
        fb = data["feedback"].get(r["pid"])
        likes = (fb or {}).get("likes", 0)
        bought = (fb or {}).get("bought", 0)
        title = html.escape(str(r.get("title", "")))
        if len(title) > 46:
            title = title[:43] + "..."
        query = html.escape(str(r.get("query", "-")))
        link = r.get("link", "")
        rows.append(
            f"{i}. 🔥 <b>{r.get('discount', '?')}%</b> · {tg.fmt(r.get('price', 0))} ₽ · 👍 {likes} · 🛒 {bought} · <i>{query}</i>"
        )
        rows.append(f"   {title}")
        if link:
            rows.append(f'   <a href="{link}">открыть товар</a>')
        rows.append("")
    rows.append("🗑 — забыть артикул, можно публиковать снова")
    markup = []
    nav = []
    if page > 0:
        nav.append(_btn("⬅️", MENU + f"last:{page - 1}"))
    nav.append(_btn("🔄", MENU + f"last:{page}"))
    if page + 1 < total:
        nav.append(_btn("➡️", MENU + f"last:{page + 1}"))
    markup.append(nav)
    markup.append(
        [_btn(f"🗑 {r['pid']}", MENU + f"forget:{page}:{r['pid']}") for r in items]
    )
    markup.append(_home_row()[0])
    return "\n".join(rows).rstrip(), markup


def _bar(score_value):
    v = max(0.0, min(1.0, score_value / 1.2))
    filled = int(round(v * 10))
    return "█" * filled + "░" * (10 - filled)


def _stat_line(key, s):
    posts = s.get("posts", 0)
    likes = s.get("likes", 0)
    dislikes = s.get("dislikes", 0)
    bought = s.get("bought", 0)
    sc = smart.score(s)
    return "\n".join(
        [
            f"🔹 <b>{html.escape(str(key))}</b> — скор <b>{sc:.2f}</b>",
            f"   {_bar(sc)}",
            f"   постов {posts:.0f} · 👍 {likes:.0f} · 👎 {dislikes:.0f} · 🛒 {bought:.0f}",
        ]
    )


def _stats_view(data, tab="q", page=0):
    table = data["query_stats"] if tab == "q" else data["cat_stats"]
    label = "Запросы" if tab == "q" else "Категории"
    icon = "🔍" if tab == "q" else "🏷"
    items = sorted(table.items(), key=lambda kv: smart.score(kv[1]), reverse=True)
    total = max(1, -(-len(items) // PAGE))
    page = min(max(page, 0), total - 1)
    chunk = items[page * PAGE:(page + 1) * PAGE]
    rows = [
        "📈 <b>Обучение бота</b> — что нравится подписчикам",
        "",
        f"{icon} {label} · стр {page + 1} из {total}",
        "",
    ]
    if not chunk:
        rows.append("Пока нет данных — бот ещё учится.")
    for key, s in chunk:
        rows.append(_stat_line(key, s))
    rows += ["", "Скор растёт от 👍 и 🛒, падает от 👎."]
    markup = [
        [_btn("🔍 Запросы", MENU + "stats:q:0"), _btn("🏷 Категории", MENU + "stats:c:0")],
    ]
    nav = []
    if page > 0:
        nav.append(_btn("⬅️", MENU + f"stats:{tab}:{page - 1}"))
    nav.append(_btn("🔄", MENU + f"stats:{tab}:{page}"))
    if page + 1 < total:
        nav.append(_btn("➡️", MENU + f"stats:{tab}:{page + 1}"))
    markup.append(nav)
    markup.append(_home_row()[0])
    return "\n".join(rows).rstrip(), markup


def _current(settings, key):
    if settings.get(key) is not None:
        return settings[key]
    fallback = {
        "min_discount": config.MIN_DISCOUNT,
        "min_rating": config.MIN_RATING,
        "max_price": config.MAX_PRICE,
        "max_posts": config.MAX_POSTS,
        "pages": config.PAGES,
        "queries_per_run": config.QUERIES_PER_RUN,
        "cats_per_run": config.CATS_PER_RUN,
        "repost_days": config.REPOST_DAYS,
        "dest": config.DEST,
        "queries": config.QUERIES or config.DEFAULT_QUERIES,
        "link_template": config.LINK_TEMPLATE,
        "weekly_digest": config.WEEKLY_DIGEST,
        "blacklist": config.BLACKLIST,
    }
    return fallback[key]


def _human(key, value):
    if key == "queries" and isinstance(value, list):
        return ", ".join(str(q) for q in value)
    if key == "blacklist" and isinstance(value, list):
        return ", ".join(str(q) for q in value) or "пусто"
    if key == "min_discount":
        return f"{value:g}%"
    if key == "min_rating":
        return f"{value:g}"
    if key == "max_price":
        return "без лимита" if not value else f"{tg.fmt(int(value))} ₽"
    if key == "repost_days":
        return f"{value:g} дн."
    if key == "dest":
        return tg.fmt(int(value))
    if key in ("max_posts", "pages", "queries_per_run", "cats_per_run"):
        return f"{value:g}"
    if key == "weekly_digest":
        return "вкл" if value else "выкл"
    return str(value)


def _fmt_value(key, value):
    return _human(key, value)


def _cfg_text(data, settings):
    rows = ["⚙️ <b>Настройки</b>", ""]
    for key in MAIN_KEYS:
        rows.append(f"{ICONS[key]} <b>{NAMES[key]}</b>: {_human(key, _current(settings, key))}")
    rows.append("")
    for key in ADV_KEYS:
        rows.append(
            f"{ICONS[key]} <b>{NAMES[key]}</b>: <code>{_human(key, _current(settings, key))}</code>"
        )
    rows += ["", "Нажми кнопку, чтобы изменить — печатать ничего не нужно."]
    return "\n".join(rows)


def _cfg_markup(settings):
    pairs = [
        (a, b, MENU + ("queries" if b == "queries" else "editor:" + b))
        for a, b in zip(MAIN_KEYS[::2], MAIN_KEYS[1::2])
    ]
    rows = [
        [
            _btn(f"{ICONS[a]} {NAMES[a]}", MENU + "editor:" + a),
            _btn(f"{ICONS[b]} {NAMES[b]}", cmd_b),
        ]
        for a, b, cmd_b in pairs
    ]
    rows.append([_btn("🔧 Продвинутые", MENU + "adv")])
    rows.append(_home_row()[0])
    return rows


def _editor_view(settings, key):
    text = "\n".join(
        [
            f"{ICONS[key]} <b>{NAMES[key]}</b>",
            "",
            f"Сейчас: <b>{_human(key, _current(settings, key))}</b>",
            "",
            SETTABLE[key][1],
            "",
            "Кнопки меняют значение или введи своё вручную.",
        ]
    )
    rows = []
    presets = PRESETS.get(key)
    if presets:
        rows.append(
            [_btn(label, f"{MENU}preset:{key}:{val}") for val, label in presets]
        )
    step = STEPS.get(key)
    if step:
        label = _num(step)
        rows.append(
            [
                _btn(f"➖ {label}", f"{MENU}step:{key}:{-step}"),
                _btn(f"➕ {label}", f"{MENU}step:{key}:{step}"),
            ]
        )
    rows.append([_btn("✍️ Ввести своё значение", MENU + f"custom:{key}")])
    rows.append([_btn("✅ Готово", MENU + "cfg")])
    rows.append(_home_row()[0])
    return text, rows


def _adv_text(settings):
    rows = ["🔧 <b>Продвинутые настройки</b>", ""]
    for key in ADV_KEYS:
        rows.append(f"{ICONS[key]} <b>{NAMES[key]}</b>: <code>{_human(key, _current(settings, key))}</code>")
        rows.append(f"      <i>{SETTABLE[key][1]}</i>")
    rows += ["", "Нажми кнопку и отправь новое значение сообщением."]
    return "\n".join(rows)


def _adv_markup():
    return [
        [
            _btn(f"{ICONS['dest']} {NAMES['dest']}", MENU + "advset:dest"),
            _btn(f"{ICONS['link_template']} {NAMES['link_template']}", MENU + "advset:link_template"),
        ],
        [
            _btn(f"{ICONS['weekly_digest']} {NAMES['weekly_digest']}", MENU + "advset:weekly_digest"),
            _btn(f"{ICONS['blacklist']} {NAMES['blacklist']}", MENU + "advset:blacklist"),
        ],
        [_btn(f"{ICONS['cats_per_run']} {NAMES['cats_per_run']}", MENU + "advset:cats_per_run")],
        [_btn("⬅️ К настройкам", MENU + "cfg")],
        _home_row()[0],
    ]


def _queries_view(data, settings):
    queries = _current(settings, "queries")
    if isinstance(queries, str):
        queries = [q.strip() for q in queries.split(",") if q.strip()]
    rows = ["🔍 <b>Запросы поиска</b>", "", f"В списке: <b>{len(queries)}</b>"]
    for i, q in enumerate(queries, 1):
        rows.append(f"{i}. {html.escape(str(q))}")
    rows += ["", "⬆️⬇️ — порядок · ✏️ — изменить · 🗑 — удалить"]
    markup = [[_btn("➕ Добавить запрос", MENU + "addq")]]
    for i, q in enumerate(queries):
        short = str(q)
        if len(short) > 16:
            short = short[:13] + "..."
        btns = []
        if i > 0:
            btns.append(_btn("⬆️", MENU + f"q:mv:{i}:up"))
        if i < len(queries) - 1:
            btns.append(_btn("⬇️", MENU + f"q:mv:{i}:down"))
        btns.append(_btn(f"✏️ {short}", MENU + f"q:ed:{i}"))
        btns.append(_btn(f"🗑 {short}", MENU + f"delq:{i}"))
        markup.append(btns)
    markup.append([_btn("⬅️ К настройкам", MENU + "cfg")])
    markup.append(_home_row()[0])
    return "\n".join(rows), markup


def _pause_view(data, settings):
    now = int(time.time())
    paused = _is_paused(settings)
    rows = ["⏸ <b>Пауза постинга</b>", ""]
    if paused > now:
        rows.append(f"Сейчас: пауза до <b>{_ft(paused)}</b> · осталось {_left(paused - now)}")
        rows.append("")
    rows.append("На сколько приостановить публикацию?")
    markup = [
        [
            _btn("1 ч", MENU + "pause:1"),
            _btn("2 ч", MENU + "pause:2"),
            _btn("6 ч", MENU + "pause:6"),
        ],
        [
            _btn("12 ч", MENU + "pause:12"),
            _btn("24 ч", MENU + "pause:24"),
            _btn("✍️ Своё время", MENU + "pcustom"),
        ],
    ]
    if paused > now:
        markup.append([_btn("▶️ Возобновить", MENU + "resume")])
    markup.append(_home_row()[0])
    return "\n".join(rows), markup


def _postnow_view(settings):
    text = "\n".join(
        [
            "🚀 <b>Разовый запуск</b>",
            "",
            "Бот найдёт свежие скидки и опубликует их в канал прямо сейчас.",
            "",
            f"📦 Постов за запуск: <b>{_human('max_posts', _current(settings, 'max_posts'))}</b>",
            f"🎯 Запросов: {_human('queries_per_run', _current(settings, 'queries_per_run'))} · "
            f"📄 Страниц: {_human('pages', _current(settings, 'pages'))}",
            "",
            "Запустить?",
        ]
    )
    rows = [
        [_btn("✅ Запустить", MENU + "postnow:yes")],
        _home_row()[0],
    ]
    return text, rows


def _wipe_view(data):
    n = len(data["posted"])
    text = "\n".join(
        [
            "🗑 <b>Сброс памяти артикулов</b>",
            "",
            f"Сейчас в памяти <b>{tg.fmt(n)}</b> артикулов.",
            "После сброса все они снова доступны для публикации.",
            "Статистика по запросам не пострадает.",
        ]
    )
    markup = [
        [_btn("✅ Да, стереть всё", MENU + "wipe:yes")],
        _home_row()[0],
    ]
    return text, markup


def _help_view():
    text = "\n".join(
        [
            "❓ <b>Помощь</b>",
            "",
            "🛠 <b>Что умеет бот:</b>",
            "📥 Найдено — готовая очередь после умного отбора",
            "📤 Опубликовать — моментально отправить следующий товар в канал",
            "   В очереди можно выпустить 1, 3 или 5 постов подряд",
            "📊 Статус — состояние, запуски, счётчики",
            "🕓 Посты — что опубликовано; 🗑 забывает артикул",
            "📈 Статистика — запросы и категории, которым радуются подписчики",
            "   👍/👎 подписчики жмут прямо в постах: любимое постим чаще,"
            "   категории с перевесом 👎 уходят из ротации",
            "⚙️ Настройки — фильтры скидок, лимиты, запросы",
            "⏸ Пауза — приостановить постинг на время",
            "🚀 Пост сейчас — разовый запуск поиска",
            "📦 По артикулу — опубликовать конкретный товар с подтверждением",
            "🔍 Превью — что бот найдёт прямо сейчас; 📦 = предпросмотр поста",
            "🗂 Ротация: одна категория — один пост за запуск,"
            "   после поста категория отдыхает 12 часов",
            "🧠 Самообучение: сам пробует новые запросы, оставляет те,"
            "   что нравятся подписчикам, и списывает пустые",
            "📉 Падение цены: уже показанный товар репостится, если подешевел ещё на 15%+",
            "🚫 Чёрный список: бренды и артикулы, которые никогда не постим",
            "⚠️ Журнал ошибок — в статусе бота, если что-то сломалось",
            "",
            "⌨️ Есть и команды: /status /last /stats /cfg /set /pause /resume /post /preview",
            "",
            "Почти всё управляется кнопками — печатать нужно только значения.",
        ]
    )
    return text, _home_row()


def _preview_deals(data, settings, limit=10):
    pool = settings.get("queries") or config.QUERIES or config.DEFAULT_QUERIES
    if isinstance(pool, str):
        pool = [q.strip() for q in pool.split(",") if q.strip()]
    queries = smart.pick_queries(
        pool, data["query_stats"], min(config.QUERIES_PER_RUN, len(pool))
    )
    deals = []
    for q in queries:
        items = wb.search(q, 1)
        if not items:
            continue
        ids = [it.get("id") for it in items[:20] if it.get("id")]
        for card in wb.cards(ids):
            d = wb.deal(card)
            if d:
                deals.append(d)
        if len(deals) >= limit:
            break
    deals.sort(key=lambda d: (d["discount"], d["benefit"]), reverse=True)
    return deals[:limit]


def _preview_view(data, settings, limit=10):
    deals = _preview_deals(data, settings, limit)
    if not deals:
        text = "\n".join(
            [
                "🔍 <b>Превью поиска</b>",
                "",
                "С текущими фильтрами ничего не нашлось.",
                "Попробуй изменить настройки: ⚙️ Настройки.",
            ]
        )
        return text, _home_row()
    rows = [
        "🔍 <b>Что найдёт бот прямо сейчас</b>",
        "",
        f"Топ {len(deals)} предложений:",
        "",
    ]
    for i, d in enumerate(deals, 1):
        title = html.escape(d["title"])
        if len(title) > 50:
            title = title[:47] + "..."
        link = _link(d["id"])
        rows.append(
            f"{i}. 🔥 <b>{d['discount']}%</b> · {tg.fmt(d['product'])} ₽ <s>{tg.fmt(d['basic'])}</s>"
            f" · ⭐ {d['rating']} · <i>{html.escape(str(d['category']))}</i>"
        )
        rows.append(f"   {title}")
        rows.append(
            f'   <a href="{link}">открыть</a> · <code>{d["id"]}</code>'
        )
        rows.append("")
    rows.append("🗂 Посты распределяются по <b>всем категориям по очереди</b>: "
                "одна категория — один пост за раз.")
    rows.append("👍/👎 подписчиков решают: перевес 👎 убирает категорию из ротации.")
    rows.append("Кнопки 📦 — предпросмотр поста и подтверждение публикации.")
    markup = []
    for i in range(0, len(deals), 2):
        row = []
        for d in deals[i:i + 2]:
            row.append(_btn(f"📦 Пост {d['id']}", MENU + "preview:post:" + str(d["id"])))
        markup.append(row)
    markup.append(_home_row()[0])
    return "\n".join(rows).rstrip(), markup


# ---------- actions ----------

def _to_number(text, kind):
    t = str(text).strip().replace(" ", "").replace(",", ".")
    if kind == "int":
        return int(float(t))
    return float(t)


def _apply_setting(settings, key, value):
    spec = SETTABLE.get(key)
    if not spec:
        return False, f"Неизвестный ключ: <b>{key}</b>"
    kind = spec[0]
    try:
        if kind in ("float", "int"):
            settings[key] = _clamp(key, _to_number(value, kind))
        elif kind == "queries":
            parsed = [q.strip() for q in str(value).split(",") if q.strip()]
            if not parsed:
                return False, "Список запросов пуст"
            settings[key] = parsed
        elif kind == "template":
            if "{nm}" not in value:
                return False, "Шаблон должен содержать {nm}"
            try:
                value.format(nm=1)
            except (KeyError, IndexError, ValueError):
                return False, "Шаблон содержит недопустимые фигурные скобки"
            settings[key] = value
    except (ValueError, TypeError):
        return False, f"Некорректное значение для <b>{NAMES[key]}</b>"
    settings["mtime"] = int(time.time())
    config.apply(settings)
    return True, f"✅ Установлено: <b>{NAMES[key]}</b> = <code>{_fmt_value(key, settings[key])}</code>"


def _prompt_set(token, chat_id, message_id, data, settings, key, cb_id):
    current = _fmt_value(key, _current(settings, key))
    text = "\n".join(
        [
            f"✏️ {ICONS[key]} <b>{NAMES[key]}</b> — {SETTABLE[key][1]}",
            "",
            f"Текущее: <code>{current}</code>",
            "",
            "Отправь новое значение сообщением:",
        ]
    )
    data.setdefault("admin_ui", {})["pending"] = "setting:" + key
    _render(token, chat_id, message_id, text, [[_btn("❌ Отмена", MENU + "cancel")]])
    tg.answer_callback(token, cb_id, "Введи значение…")


def _set_pause(settings, hours):
    settings["pause_until"] = int(time.time()) + int(hours * 3600)
    settings["mtime"] = int(time.time())


def _start_review(token, chat_id, cb_id, pid):
    cards = wb.cards([pid])
    if not cards:
        if cb_id:
            tg.answer_callback(token, cb_id, "❌ Артикул не найден")
        tg.send_message(token, chat_id, f"❌ Артикул <code>{pid}</code> не найден на WB.", markup=_home_row())
        return
    deal = wb.raw_deal(cards[0])
    if not deal or not deal.get("id"):
        if cb_id:
            tg.answer_callback(token, cb_id, "❌ Не удалось получить карточку")
        return
    images = wb.photos(pid)
    if not images:
        if cb_id:
            tg.answer_callback(token, cb_id, "⚠️ Нет фото")
        tg.send_message(
            token,
            chat_id,
            f"⚠️ Не удалось скачать фото артикула <code>{pid}</code>.",
            markup=_home_row(),
        )
        return
    if cb_id:
        tg.answer_callback(token, cb_id, "📸 Предпросмотр готов")
    caption = tg.caption(deal, pid) + "\n\n⚠️ <b>Это предпросмотр.</b> В канал ещё не отправлено."
    markup = [
        [_btn("✅ Опубликовать в канал", MENU + "manual:publish:" + str(pid))],
        [_btn("❌ Отмена", MENU + "manual:cancel")],
    ]
    if len(images) > 1:
        tg.send_album(token, chat_id, images, caption, markup=markup)
    else:
        tg.send_photo(token, chat_id, images[0], caption, markup=markup)


def _do_publish(token, data, chat_id, cb_id, pid, announce=True):
    now = int(time.time())
    if pid in data["posted"] and now - data["posted"][pid] < 1800:
        if cb_id:
            tg.answer_callback(token, cb_id, "⏳ Уже публиковали недавно — подожди")
        return False
    cards = wb.cards([pid])
    if not cards:
        if cb_id:
            tg.answer_callback(token, cb_id, "❌ Артикул не найден")
        return False
    deal = wb.raw_deal(cards[0])
    images = wb.photos(pid)
    if not images or not deal or not deal.get("id"):
        state.record_error(data, f"Не удалось подготовить пост {pid}")
        if cb_id:
            tg.answer_callback(token, cb_id, "❌ Не удалось подготовить пост")
        return False
    link = _link(pid)
    caption = tg.caption(deal, pid)
    if len(images) > 1:
        ok = tg.send_album(token, config.TG_CHAT_ID, images, caption, link, pid)
    else:
        ok = tg.send_photo(token, config.TG_CHAT_ID, images[0], caption, link, pid)
    if not ok:
        state.record_error(data, f"Ошибка отправки в канал {pid}")
        if cb_id:
            tg.answer_callback(token, cb_id, "❌ Ошибка отправки в канал")
        return False
    data["posted"][pid] = now
    key = smart.norm_title(deal["title"])
    if key:
        data.setdefault("titles", {})[key] = now
    data.setdefault("prices", {})[pid] = {
        "price": deal["product"],
        "basic": deal["basic"],
        "ts": now,
    }
    data["recent"].append(
        {
            "pid": pid,
            "title": deal["title"],
            "discount": deal["discount"],
            "price": deal["product"],
            "rating": deal["rating"],
            "link": link,
            "query": None,
            "cat": deal["category"],
            "ts": now,
        }
    )
    data["recent"] = sorted(
        data["recent"], key=lambda r: r["ts"], reverse=True
    )[:60]
    smart.record_post(data, None, deal["category"])
    state.bump_meta(data, 1)
    data["queue"] = [item for item in (data.get("queue") or []) if item.get("id") != pid]
    if cb_id:
        tg.answer_callback(token, cb_id, f"✅ Опубликовано #{pid}")
    if not announce:
        return True
    title = html.escape(deal["title"])
    if len(title) > 60:
        title = title[:57] + "..."
    tg.send_message(
        token,
        chat_id,
        "\n".join(
            [
                "✅ <b>Опубликовано в канал</b>",
                "",
                f"🔥 <b>{deal['discount']}%</b> · {tg.fmt(deal['product'])} ₽ <s>{tg.fmt(deal['basic'])} ₽</s>",
                f"{title}",
                "",
                f"Артикул: <code>{pid}</code>",
            ]
        ),
        markup=[
            [_btn("🕓 Посты", MENU + "last:0"), _btn("🏠 Меню", MENU + "menu")]
        ],
    )
    return True


def _publish_from_queue(token, data, chat_id, count):
    count = max(1, min(int(count), 5))
    candidates = list(data.get("queue") or [])
    published = []
    for item in candidates:
        if len(published) >= count:
            break
        pid = _clean_pid(item.get("id"))
        if pid and _do_publish(token, data, chat_id, "", pid, announce=False):
            published.append(pid)
    return published


def _admin_callback(token, data, settings, cb):
    raw = str(cb.get("data", ""))
    cmd = raw[len(MENU):]
    chat_id = cb.get("message", {}).get("chat", {}).get("id")
    msg_id = cb.get("message", {}).get("message_id")
    if not chat_id:
        return False
    cb_id = cb.get("id", "")
    changed = False

    if cmd in ("menu", "start"):
        text, markup = _menu_view(data, settings)
        _render(token, chat_id, msg_id, text, markup)
        tg.answer_callback(token, cb_id)
    elif cmd == "status":
        text, markup = _status_view(data, settings)
        ok = _render(token, chat_id, msg_id, text, markup)
        tg.answer_callback(token, cb_id, "" if ok is not False else "Актуально")
    elif cmd == "queue":
        text, markup = _queue_view(data)
        _render(token, chat_id, msg_id, text, markup)
        tg.answer_callback(token, cb_id)
    elif cmd.startswith("queue:post:"):
        pid = _clean_pid(cmd.split(":", 2)[2])
        tg.answer_callback(token, cb_id, "📤 Публикую…")
        ok = bool(pid and _do_publish(token, data, chat_id, "", pid, announce=False))
        changed = ok or changed
        text, markup = _queue_view(data)
        if ok:
            text = f"✅ <b>Пост опубликован</b> · <code>{pid}</code>\n\n" + text
        else:
            text = "❌ <b>Не удалось опубликовать товар</b>\n\n" + text
        _render(token, chat_id, msg_id, text, markup)
    elif cmd.startswith("queue:bulk:"):
        try:
            count = int(cmd.rsplit(":", 1)[1])
        except (ValueError, IndexError):
            count = 1
        tg.answer_callback(token, cb_id, f"📤 Публикую до {min(max(count, 1), 5)} постов…")
        published = _publish_from_queue(token, data, chat_id, count)
        changed = bool(published) or changed
        text, markup = _queue_view(data)
        if published:
            ids = ", ".join(str(pid) for pid in published)
            text = f"✅ <b>Опубликовано: {len(published)}</b> · <code>{ids}</code>\n\n" + text
        else:
            text = "❌ <b>Ничего не опубликовано</b>\n\n" + text
        _render(token, chat_id, msg_id, text, markup)
    elif cmd == "errors":
        text, markup = _errors_view(data)
        _render(token, chat_id, msg_id, text, markup)
        tg.answer_callback(token, cb_id)
    elif cmd.startswith("last:"):
        try:
            page = int(cmd.split(":", 1)[1])
        except (IndexError, ValueError):
            page = 0
        text, markup = _last_view(data, page)
        _render(token, chat_id, msg_id, text, markup)
        tg.answer_callback(token, cb_id)
    elif cmd.startswith("stats:"):
        parts = cmd.split(":")
        tab = parts[1] if len(parts) > 1 and parts[1] in ("q", "c") else "q"
        try:
            page = int(parts[2])
        except (IndexError, ValueError):
            page = 0
        text, markup = _stats_view(data, tab, page)
        _render(token, chat_id, msg_id, text, markup)
        tg.answer_callback(token, cb_id)
    elif cmd == "cfg":
        _render(token, chat_id, msg_id, _cfg_text(data, settings), _cfg_markup(settings))
        tg.answer_callback(token, cb_id)
    elif cmd == "adv":
        _render(token, chat_id, msg_id, _adv_text(settings), _adv_markup())
        tg.answer_callback(token, cb_id)
    elif cmd.startswith("advset:"):
        key = cmd.split(":", 1)[1]
        if key in ADV_KEYS:
            _prompt_set(token, chat_id, msg_id, data, settings, key, cb_id)
    elif cmd.startswith("editor:"):
        key = cmd.split(":", 1)[1]
        if key == "queries":
            text, markup = _queries_view(data, settings)
            _render(token, chat_id, msg_id, text, markup)
            tg.answer_callback(token, cb_id)
        elif key in STEPS:
            text, markup = _editor_view(settings, key)
            _render(token, chat_id, msg_id, text, markup)
            tg.answer_callback(token, cb_id)
    elif cmd.startswith("custom:"):
        key = cmd.split(":", 1)[1]
        if key in SETTABLE:
            _prompt_set(token, chat_id, msg_id, data, settings, key, cb_id)
    elif cmd.startswith("step:"):
        parts = cmd.split(":")
        if len(parts) == 3 and parts[1] in STEPS:
            try:
                delta = float(parts[2])
            except ValueError:
                delta = 0.0
            cur = _current(settings, parts[1])
            try:
                base = float(cur)
            except (TypeError, ValueError):
                base = 0.0
            ok, msg = _apply_setting(settings, parts[1], str(base + delta))
            changed = ok or changed
            text, markup = _editor_view(settings, parts[1])
            _render(token, chat_id, msg_id, text, markup)
            tg.answer_callback(
                token, cb_id, f"{ICONS[parts[1]]} {_human(parts[1], _current(settings, parts[1]))}"
            )
    elif cmd.startswith("preset:"):
        parts = cmd.split(":", 2)
        if len(parts) == 3 and parts[1] in STEPS:
            ok, msg = _apply_setting(settings, parts[1], parts[2])
            changed = ok or changed
            text, markup = _editor_view(settings, parts[1])
            _render(token, chat_id, msg_id, text, markup)
            tg.answer_callback(
                token, cb_id, f"{ICONS[parts[1]]} {_human(parts[1], _current(settings, parts[1]))}"
            )
    elif cmd == "queries":
        text, markup = _queries_view(data, settings)
        _render(token, chat_id, msg_id, text, markup)
        tg.answer_callback(token, cb_id)
    elif cmd == "addq":
        data.setdefault("admin_ui", {})["pending"] = "add_query"
        text = "\n".join(
            [
                "✏️ <b>Новый запрос</b>",
                "",
                "Напиши слово или фразу, например: чайник",
            ]
        )
        _render(token, chat_id, msg_id, text, [[_btn("❌ Отмена", MENU + "cancel")]])
        tg.answer_callback(token, cb_id, "Напиши запрос…")
    elif cmd.startswith("q:mv:"):
        parts = cmd.split(":")
        try:
            idx, direction = int(parts[2]), parts[3]
        except (IndexError, ValueError):
            idx, direction = None, None
        queries = list(_current(settings, "queries"))
        if idx is not None and direction in ("up", "down") and 0 <= idx < len(queries):
            new_idx = idx - 1 if direction == "up" else idx + 1
            if 0 <= new_idx < len(queries):
                queries[idx], queries[new_idx] = queries[new_idx], queries[idx]
                _apply_setting(settings, "queries", ",".join(queries))
                changed = True
                text, markup = _queries_view(data, settings)
                _render(token, chat_id, msg_id, text, markup)
                tg.answer_callback(token, cb_id, "↕️ Порядок обновлён")
            else:
                tg.answer_callback(token, cb_id, "Уже на краю списка")
        else:
            tg.answer_callback(token, cb_id, "Не получилось")
    elif cmd.startswith("q:ed:"):
        parts2 = cmd.split(":")
        try:
            idx = int(parts2[2])
        except (ValueError, IndexError):
            idx = None
        queries = _current(settings, "queries")
        if idx is None or not (0 <= idx < len(queries)):
            tg.answer_callback(token, cb_id, "Запрос уже удалён")
            return changed
        data.setdefault("admin_ui", {})["pending"] = f"edit_query:{idx}"
        text = "\n".join(
            [
                f"✏️ <b>Изменить запрос №{idx + 1}</b>",
                "",
                f"Сейчас: <code>{html.escape(str(queries[idx]))}</code>",
                "",
                "Напиши новый текст запроса:",
            ]
        )
        _render(token, chat_id, msg_id, text, [[_btn("❌ Отмена", MENU + "cancel")]])
        tg.answer_callback(token, cb_id, "Напиши новый текст…")
    elif cmd.startswith("delq:"):
        try:
            idx = int(cmd.split(":", 1)[1])
        except (IndexError, ValueError):
            idx = None
        queries = list(_current(settings, "queries"))
        if idx is not None and 0 <= idx < len(queries):
            removed = queries.pop(idx)
            _apply_setting(settings, "queries", ",".join(queries))
            changed = True
            text, markup = _queries_view(data, settings)
            _render(token, chat_id, msg_id, text, markup)
            tg.answer_callback(token, cb_id, f"❌ Удалено: {removed}")
        else:
            tg.answer_callback(token, cb_id, "Не получилось удалить")
    elif cmd == "pause":
        text, markup = _pause_view(data, settings)
        _render(token, chat_id, msg_id, text, markup)
        tg.answer_callback(token, cb_id)
    elif cmd == "pcustom":
        data.setdefault("admin_ui", {})["pending"] = "pause_hrs"
        text = "\n".join(
            [
                "⏸ <b>Своё время паузы</b>",
                "",
                "Сколько часов приостановить постинг?",
                "Например: <code>0.5</code> (30 мин) или <code>36</code> (полтора дня).",
            ]
        )
        _render(token, chat_id, msg_id, text, [[_btn("❌ Отмена", MENU + "cancel")]])
        tg.answer_callback(token, cb_id, "Сколько часов?")
    elif cmd.startswith("pause:"):
        try:
            hours = float(cmd.split(":", 1)[1])
        except (IndexError, ValueError):
            hours = 6.0
        _set_pause(settings, hours)
        changed = True
        text, markup = _status_view(data, settings)
        _render(token, chat_id, msg_id, text, markup)
        tg.answer_callback(token, cb_id, f"⏸ Пауза на {hours:g} ч")
    elif cmd == "resume":
        settings.pop("pause_until", None)
        settings["mtime"] = int(time.time())
        changed = True
        text, markup = _menu_view(data, settings)
        _render(token, chat_id, msg_id, text, markup)
        tg.answer_callback(token, cb_id, "▶️ Постинг возобновлён")
    elif cmd == "postnow":
        text, markup = _postnow_view(settings)
        _render(token, chat_id, msg_id, text, markup)
        tg.answer_callback(token, cb_id)
    elif cmd == "postnow:yes":
        if settings.get("post_lock"):
            tg.answer_callback(token, cb_id, "🔄 Уже выполняется, подожди")
        else:
            settings["post_now_ts"] = int(time.time())
            settings["mtime"] = int(time.time())
            changed = True
            text, markup = _menu_view(data, settings)
            _render(token, chat_id, msg_id, text, markup)
            tg.answer_callback(token, cb_id, "🚀 Запускаю публикацию…")
    elif cmd == "manual":
        data.setdefault("admin_ui", {})["pending"] = "manual_post"
        text = "\n".join(
            [
                "📦 <b>Публикация по артикулу</b>",
                "",
                "Отправь артикул цифрами, например: <code>1262712</code>",
                "Сначала покажем предпросмотр — публикация только после твоего подтверждения.",
            ]
        )
        _render(token, chat_id, msg_id, text, [[_btn("❌ Отмена", MENU + "cancel")]])
        tg.answer_callback(token, cb_id, "Введи артикул…")
    elif cmd.startswith("manual:publish:"):
        parts = cmd.split(":")
        pid = _clean_pid(parts[2] if len(parts) > 2 else "")
        if pid is not None:
            changed = _do_publish(token, data, chat_id, cb_id, pid) or changed
        else:
            tg.answer_callback(token, cb_id, "❌ Неверный артикул")
    elif cmd == "manual:cancel":
        tg.answer_callback(token, cb_id, "❌ Отменено")
    elif cmd.startswith("preview:post:"):
        pid = _clean_pid(cmd.split(":", 2)[2] if len(cmd.split(":")) > 2 else "")
        if pid is not None:
            _start_review(token, chat_id, cb_id, pid)
        else:
            tg.answer_callback(token, cb_id, "❌ Неверный артикул")
    elif cmd == "preview":
        tg.answer_callback(token, cb_id, "🔍 Ищу…")
        tg.send_message(token, chat_id, "🔍 Ищу лучшие скидки — несколько секунд…")
        text, markup = _preview_view(data, settings)
        tg.send_message(token, chat_id, text, markup=markup)
    elif cmd == "wipe":
        text, markup = _wipe_view(data)
        _render(token, chat_id, msg_id, text, markup)
        tg.answer_callback(token, cb_id)
    elif cmd == "wipe:yes":
        n = len(data["posted"])
        data["posted"].clear()
        text, markup = _menu_view(data, settings)
        _render(token, chat_id, msg_id, text, markup)
        tg.answer_callback(token, cb_id, f"🧹 Память очищена ({tg.fmt(n)})")
    elif cmd.startswith("forget:"):
        parts = cmd.split(":")
        pid = _clean_pid(parts[-1]) if parts else None
        try:
            page = int(parts[1])
        except (IndexError, ValueError):
            page = 0
        if pid is not None and data["posted"].pop(pid, None):
            text, markup = _last_view(data, page)
            _render(token, chat_id, msg_id, text, markup)
            tg.answer_callback(token, cb_id, f"🗑 {pid} забыт — снова доступен")
        else:
            text, markup = _last_view(data, page)
            _render(token, chat_id, msg_id, text, markup)
            tg.answer_callback(token, cb_id, "Уже не в памяти")
    elif cmd == "help":
        text, markup = _help_view()
        _render(token, chat_id, msg_id, text, markup)
        tg.answer_callback(token, cb_id)
    elif cmd == "cancel":
        data.setdefault("admin_ui", {}).pop("pending", None)
        text, markup = _menu_view(data, settings)
        _render(token, chat_id, msg_id, text, markup)
        tg.answer_callback(token, cb_id)
    return changed


def _admin_message(token, chat_id, data, settings, text):
    parts = text.split() if text else []
    ui = data.get("admin_ui") or {}
    pending = ui.get("pending")
    if pending:
        low = (text or "").strip().lower()
        if low in ("/cancel", "отмена", "отменить", "стоп"):
            ui.pop("pending", None)
            tg.send_message(token, chat_id, "❌ Отменено")
            menu_text, markup = _menu_view(data, settings)
            tg.send_message(token, chat_id, menu_text, markup=markup)
            return False
        if not text:
            return False
        if pending == "add_query":
            query = " ".join(parts).strip(" .,")
            if not query:
                tg.send_message(token, chat_id, "❌ Пустой запрос. Напиши слово или фразу.")
                return False
            ui.pop("pending", None)
            queries = list(_current(settings, "queries"))
            if query in queries:
                tg.send_message(token, chat_id, f"⚡ «{html.escape(query)}» уже в списке.")
                return False
            queries.append(query)
            _apply_setting(settings, "queries", ",".join(queries))
            text_view, markup = _queries_view(data, settings)
            tg.send_message(
                token,
                chat_id,
                f"✅ Добавлено: <b>{html.escape(query)}</b>\n\n{text_view}",
                markup=markup,
            )
            return True
        if pending.startswith("edit_query:"):
            try:
                idx = int(pending.split(":", 1)[1])
            except ValueError:
                idx = None
            label = " ".join(parts).strip(" .,")
            if not label:
                tg.send_message(token, chat_id, "❌ Пустой запрос. Напиши слово или фразу.")
                return False
            queries = list(_current(settings, "queries"))
            if idx is None or not (0 <= idx < len(queries)):
                ui.pop("pending", None)
                tg.send_message(token, chat_id, "❌ Запрос изменился — открой список заново.")
                return False
            if label in queries:
                tg.send_message(token, chat_id, f"⚡ «{html.escape(label)}» уже в списке.")
                return False
            queries[idx] = label
            ui.pop("pending", None)
            _apply_setting(settings, "queries", ",".join(queries))
            text_view, markup = _queries_view(data, settings)
            tg.send_message(
                token,
                chat_id,
                f"✅ Изменено: <b>{html.escape(label)}</b>\n\n{text_view}",
                markup=markup,
            )
            return True
        if pending == "manual_post":
            pid = _clean_pid(text)
            if not pid:
                tg.send_message(
                    token, chat_id, "❌ Артикул — это цифры. Попробуй ещё раз."
                )
                return False
            ui.pop("pending", None)
            tg.send_message(token, chat_id, f"🔄 Ищу карточку <code>{pid}</code>…")
            _start_review(token, chat_id, None, pid)
            return False
        if pending == "pause_hrs":
            try:
                hours = float(text.strip().replace(",", "."))
            except ValueError:
                tg.send_message(token, chat_id, "❌ Это не число часов. Например: 3 или 0.5")
                return False
            hours = min(max(hours, 0.1), 168)
            ui.pop("pending", None)
            _set_pause(settings, hours)
            until = _ft(settings["pause_until"])
            tg.send_message(
                token,
                chat_id,
                f"⏸ Пауза на <b>{hours:g} ч</b> — до {until}",
                markup=_menu_markup(data, settings),
            )
            return True
        if pending.startswith("setting:"):
            key = pending.split(":", 1)[1]
            ok, msg = _apply_setting(settings, key, " ".join(parts))
            if not ok:
                tg.send_message(
                    token,
                    chat_id,
                    f"❌ {msg}\n\nОтправь значение ещё раз или нажми «Отмена».",
                )
                return False
            ui.pop("pending", None)
            tg.send_message(
                token,
                chat_id,
                msg + "\n\n" + _cfg_text(data, settings),
                markup=_cfg_markup(settings),
            )
            return True
    cmd = parts[0].lower() if parts else "/help"
    if cmd in ("/start", "/help", "/menu"):
        menu_text, markup = _menu_view(data, settings)
        tg.send_message(token, chat_id, menu_text, markup=markup)
    elif cmd == "/status":
        text, markup = _status_view(data, settings)
        tg.send_message(token, chat_id, text, markup=markup)
    elif cmd == "/last":
        n = 5
        if len(parts) > 1:
            try:
                n = max(1, min(int(parts[1]), 20))
            except ValueError:
                pass
        text, markup = _last_view(data, 0, n)
        tg.send_message(token, chat_id, text, markup=markup)
    elif cmd == "/stats":
        text, markup = _stats_view(data, "q", 0)
        tg.send_message(token, chat_id, text, markup=markup)
    elif cmd == "/cfg":
        tg.send_message(token, chat_id, _cfg_text(data, settings), markup=_cfg_markup(settings))
    elif cmd == "/set":
        if len(parts) < 3:
            keys = ", ".join(SETTABLE)
            tg.send_message(
                token,
                chat_id,
                "\n".join(
                    [
                        "Формат: /set ключ значение",
                        "",
                        f"Доступно: <code>{keys}</code>",
                    ]
                ),
                markup=_home_row(),
            )
            return False
        key = parts[1].lower()
        if key not in SETTABLE:
            tg.send_message(token, chat_id, f"❓ Неизвестный ключ: <b>{key}</b>", markup=_home_row())
            return False
        ok, msg = _apply_setting(settings, key, " ".join(parts[2:]))
        tg.send_message(token, chat_id, msg, markup=_home_row())
        return ok
    elif cmd == "/pause":
        hours = 6
        if len(parts) > 1:
            try:
                hours = max(1, min(int(parts[1]), 168))
            except ValueError:
                pass
        _set_pause(settings, hours)
        tg.send_message(token, chat_id, f"⏸ Пауза на {hours} ч", markup=_home_row())
        return True
    elif cmd == "/resume":
        settings.pop("pause_until", None)
        settings["mtime"] = int(time.time())
        tg.send_message(token, chat_id, "▶️ Постинг возобновлён", markup=_home_row())
        return True
    elif cmd == "/post":
        if len(parts) < 2:
            tg.send_message(token, chat_id, "Формат: /post 1262712", markup=_home_row())
            return False
        pid = _clean_pid(parts[1])
        if not pid:
            tg.send_message(token, chat_id, "❌ Артикул — это цифры.", markup=_home_row())
            return False
        tg.send_message(token, chat_id, f"🔄 Ищу карточку <code>{pid}</code>…")
        _start_review(token, chat_id, None, pid)
        return False
    elif cmd == "/preview":
        tg.send_message(token, chat_id, "🔍 Ищу лучшие скидки…")
        text, markup = _preview_view(data, settings)
        tg.send_message(token, chat_id, text, markup=markup)
    else:
        if text.startswith("/"):
            tg.send_message(
                token,
                chat_id,
                "❓ Неизвестная команда.\n/help — список команд",
                markup=_home_row(),
            )
        else:
            tg.send_message(
                token,
                chat_id,
                "\n".join(
                    [
                        "Привет! Я админ-бот канала @WBmarket22. 🤖",
                        "Публикую скидки Wildberries, учусь на реакциях подписчиков и слушаюсь тебя.",
                        "",
                        "/help — панель управления",
                    ]
                ),
                markup=_home_row(),
            )
    return False
