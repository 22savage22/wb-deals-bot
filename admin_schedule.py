"""Telegram schedule controls. Callbacks only edit settings; workers do the work."""

import html
import time
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


PREFIX = "A:schedule:"
DAY_NAMES = ("Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс")
LABELS = {
    "post_interval_minutes": "Интервал публикаций, мин",
    "search_interval_minutes": "Интервал поиска, мин",
    "min_queue": "Минимум товаров в очереди",
    "quiet_start": "Начало тихих часов",
    "quiet_end": "Конец тихих часов",
    "timezone": "Часовой пояс",
    "jitter_minutes": "Случайный сдвиг, мин",
    "min_post_gap_minutes": "Минимум между постами, мин",
    "max_posts_hour": "Лимит постов в час",
    "max_posts_day": "Лимит постов в день",
}
NUMERIC = {
    "post_interval_minutes", "search_interval_minutes", "min_queue",
    "jitter_minutes", "min_post_gap_minutes", "max_posts_hour", "max_posts_day",
}
TOGGLES = {"enabled", "paused", "search_enabled", "quiet_enabled", "natural_interval_enabled"}
PRESETS = {
    "post_interval_minutes": (10, 15, 30, 60),
    "search_interval_minutes": (10, 20, 30, 60),
    "min_queue": (100, 200, 300),
    "jitter_minutes": (1, 2, 5),
    "min_post_gap_minutes": (5, 10, 15),
    "max_posts_hour": (3, 6, 12),
    "max_posts_day": (24, 72, 144),
}


def _engine():
    import scheduling
    return scheduling


def _schedule(settings):
    return _engine().normalize(settings)


def _btn(text, command):
    return {"text": text, "callback_data": PREFIX + command}


def _rows(buttons, width=3):
    return [buttons[i:i + width] for i in range(0, len(buttons), width)]


def _back():
    return [_btn("← Расписание", "menu")]


def _touch(settings):
    settings["mtime"] = int(time.time())
    settings["schedule_version"] = time.time_ns()


def _save(settings, schedule):
    # Validate the complete candidate before changing the live configuration.
    settings["schedule"] = _engine().validate(schedule)
    _touch(settings)


def _error(exc):
    text = str(exc)
    if "expected integer " in text:
        key, bounds = text.split(": expected integer ", 1)
        return f"{LABELS.get(key, key)}: допустимо целое число {bounds.replace('..', '–')}."
    if "timezone:" in text:
        return "Неизвестный часовой пояс. Пример: Europe/Moscow или Asia/Yekaterinburg."
    if "quiet hours" in text:
        return "Начало и конец тихих часов должны различаться."
    if "jitter_minutes must" in text:
        return "Случайный сдвиг должен быть меньше интервала публикаций."
    if "post_times:" in text:
        return "Добавьте от 1 до 24 времён в формате ЧЧ:ММ."
    return text[:300]


def _tz(name):
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        # Windows may not have system tzdata; Moscow has a stable UTC+3 offset.
        return timezone(timedelta(hours=3)) if name == "Europe/Moscow" else timezone.utc


def _stamp(value, schedule):
    if value in (None, "", 0):
        return "—"
    try:
        if isinstance(value, datetime):
            stamp = value
        elif isinstance(value, (float, int)):
            stamp = datetime.fromtimestamp(value, timezone.utc)
        else:
            stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        return stamp.astimezone(_tz(schedule["timezone"])).strftime("%d.%m %H:%M")
    except (ValueError, TypeError, OverflowError, OSError):
        return "—"


def view(data, settings):
    schedule = _schedule(settings)
    status = (data.get("meta") or {}).get("scheduler_status") or {}
    queue_size = status.get("queue_size", len(data.get("queue") or []))
    # Fresh previews must reflect edits immediately, before the worker heartbeat.
    slots = _engine().next_posts(settings, data, count=5)
    next_search = _engine().next_search(settings, data, queue_size=queue_size)
    state = "выключено" if not schedule["enabled"] else ("пауза" if schedule["paused"] else "включено")
    mode = (f"каждые {schedule['post_interval_minutes']} мин" if schedule["mode"] == "interval"
            else "по заданным часам")
    days = ", ".join(DAY_NAMES[n] for n in schedule["weekdays"])
    lines = [
        "🗓 <b>Расписание</b>", "",
        f"Публикации: <b>{state}</b> · {mode}",
        f"Дни: {days} · {html.escape(schedule['timezone'])}",
        (f"Тихие часы: {schedule['quiet_start']}–{schedule['quiet_end']}" if schedule["quiet_enabled"]
         else "Тихие часы: выключены"),
        (f"Поиск: каждые {schedule['search_interval_minutes']} мин" if schedule["search_enabled"]
         else "Поиск: выключен"),
        f"Очередь: <b>{queue_size}</b> · целевой минимум {schedule['min_queue']}",
        f"Новых сегодня: <b>{status.get('new_today', 0)}</b> · постов: <b>{status.get('posted_today', 0)}</b>",
        f"Последний пост: {_stamp(status.get('last_post'), schedule)}",
        f"Успешный поиск: {_stamp(status.get('last_scan_success'), schedule)}",
        f"Следующий поиск: {_stamp(next_search, schedule)}",
        f"Связь с планировщиком: {_stamp(status.get('heartbeat'), schedule)}",
        "", "<b>Следующие 5 публикаций:</b>",
    ]
    lines += [f"{i}. {_stamp(slot, schedule)}" for i, slot in enumerate((slots or [])[:5], 1)]
    if not slots:
        lines.append("Нет активных слотов; проверьте режим, паузу и дни.")
    if status.get("post_running", status.get("posting_running")):
        lines.append("📤 Публикация выполняется")
    if status.get("scan_running", status.get("search_running")):
        lines.append("🔎 Поиск выполняется")
    for keys, label in ((("error", "post_error"), "Публикация"),
                        (("last_scan_error", "search_error"), "Поиск")):
        error = next((status.get(key) for key in keys if status.get(key)), None)
        if error:
            lines.append(f"⚠️ {label}: {html.escape(str(error)[:240])}")
    rows = [
        [_btn("🔄 Обновить", "menu"), _btn("⏱ Интервал", "edit:post_interval_minutes")],
        [_btn("🕓 Режим", "mode"), _btn("📅 Дни", "weekdays")],
        [_btn("🌙 Тихие часы", "quiet"), _btn("🔎 Поиск", "search")],
        [_btn("⚙️ Лимиты", "limits"), _btn("🌍 Часовой пояс", "edit:timezone")],
        [_btn("▶ Возобновить" if schedule["paused"] else "⏸ Пауза", "toggle:paused"),
         _btn("Выкл. постинг" if schedule["enabled"] else "Вкл. постинг", "toggle:enabled")],
        [_btn("📤 Пост сейчас", "post_now"), _btn("🔍 Искать сейчас", "search_now")],
        [{"text": "🏠 Меню", "callback_data": "A:menu"}],
    ]
    return "\n".join(lines), rows


def _editor(key, settings):
    schedule = _schedule(settings)
    current = schedule[key]
    text = f"✏️ <b>{LABELS[key]}</b>\n\nСейчас: <b>{html.escape(str(current))}</b>"
    rows = _rows([_btn(str(n), f"set:{key}:{n}") for n in PRESETS.get(key, ())])
    if key == "timezone":
        rows = [[_btn("Москва", "set:timezone:Europe/Moscow"),
                 _btn("Екатеринбург", "set:timezone:Asia/Yekaterinburg")],
                [_btn("Новосибирск", "set:timezone:Asia/Novosibirsk")]]
    rows += [[_btn("✏️ Своё значение", f"custom:{key}")], _back()]
    return text, rows


def _times(settings):
    schedule = _schedule(settings)
    lines = ["🕓 <b>Часы публикаций</b>", "", "Время задаётся в часовом поясе расписания."]
    rows = []
    for index, slot in enumerate(schedule["post_times"]):
        lines.append(f"{index + 1}. {slot}")
        rows.append([_btn(f"✏️ {slot}", f"time_edit:{index}"), _btn("🗑 Удалить", f"time_del:{index}")])
    if not schedule["post_times"]:
        lines.append("Пока нет заданных часов. Добавьте хотя бы одно время.")
    rows += [[_btn("＋ Добавить", "time_add")], _back()]
    return "\n".join(lines), rows


def _weekdays(settings):
    schedule = _schedule(settings)
    buttons = [_btn(("✓ " if i in schedule["weekdays"] else "") + name, f"day:{i}")
               for i, name in enumerate(DAY_NAMES)]
    rows = _rows(buttons)
    rows += [[_btn("Все дни", "days:all"), _btn("Будни", "days:work"), _btn("Выходные", "days:weekend")], _back()]
    return "📅 <b>Дни публикаций</b>\n\nНажмите день, чтобы включить или выключить его.", rows


def _quiet(settings):
    schedule = _schedule(settings)
    state = "включены" if schedule["quiet_enabled"] else "выключены"
    return (f"🌙 <b>Тихие часы</b>\n\nСейчас {state}: {schedule['quiet_start']}–{schedule['quiet_end']}\n"
            "В этот период автоматические посты не выходят; поиск продолжается.", [
                [_btn("Выключить" if schedule["quiet_enabled"] else "Включить", "toggle:quiet_enabled")],
                [_btn("Начало", "custom:quiet_start"), _btn("Конец", "custom:quiet_end")], _back()])


def _search(settings):
    schedule = _schedule(settings)
    return (f"🔎 <b>Поиск новых товаров</b>\n\nИнтервал: {schedule['search_interval_minutes']} мин\n"
            f"Минимум очереди: {schedule['min_queue']}\nПоиск работает отдельно от публикации.", [
                [_btn("Выключить" if schedule["search_enabled"] else "Включить", "toggle:search_enabled")],
                [_btn("Интервал", "edit:search_interval_minutes"), _btn("Резерв", "edit:min_queue")],
                [_btn("🔍 Искать сейчас", "search_now")], _back()])


def _limits(settings):
    schedule = _schedule(settings)
    return ("⚙️ <b>Лимиты и естественный интервал</b>\n\n"
            f"Между постами: не меньше {schedule['min_post_gap_minutes']} мин\n"
            f"Лимиты: {schedule['max_posts_hour']} в час, {schedule['max_posts_day']} в день\n"
            f"Случайный сдвиг: ±{schedule['jitter_minutes']} мин", [
                [_btn("Миним. пауза", "edit:min_post_gap_minutes"), _btn("Постов/час", "edit:max_posts_hour")],
                [_btn("Постов/день", "edit:max_posts_day"), _btn("Сдвиг", "edit:jitter_minutes")],
                [_btn("Сдвиг: вкл" if schedule["natural_interval_enabled"] else "Сдвиг: выкл",
                      "toggle:natural_interval_enabled")], _back()])


def _prompt(data, key):
    data.setdefault("admin_ui", {})["pending"] = "schedule:" + key
    if key.startswith("time_"):
        label, example = "Время публикации", "09:30"
    else:
        label = LABELS[key]
        examples = {"timezone": "Europe/Moscow", "quiet_start": "23:00", "quiet_end": "07:00",
                    "min_queue": "100", "max_posts_hour": "6", "min_post_gap_minutes": "5",
                    "max_posts_day": "144", "jitter_minutes": "2"}
        example = examples.get(key, "20")
    return f"✏️ <b>{label}</b>\n\nОтправьте значение, например <code>{example}</code>.", [[_btn("Отмена", "cancel")]]


def _value(key, raw):
    text = str(raw).strip()
    if key in NUMERIC:
        if not text.isdecimal():
            raise ValueError("Введите целое неотрицательное число.")
        return int(text)
    if key in ("quiet_start", "quiet_end") or key.startswith("time_"):
        # No silent coercion: 24:00 or 9:5 should never change the live schedule.
        if len(text) != 5 or text[2] != ":" or not text[:2].isdigit() or not text[3:].isdigit():
            raise ValueError("Время должно быть в формате ЧЧ:ММ, например 09:30.")
        if int(text[:2]) > 23 or int(text[3:]) > 59:
            raise ValueError("Допустимое время: 00:00–23:59.")
        return text
    return text


def _set_value(settings, key, raw):
    schedule = _schedule(settings)
    value = _value(key, raw)
    if key == "time_add":
        if value in schedule["post_times"]:
            raise ValueError("Это время уже добавлено.")
        schedule["post_times"] = sorted(schedule["post_times"] + [value])
    elif key.startswith("time_edit:"):
        index = int(key.split(":", 1)[1])
        slots = list(schedule["post_times"])
        if not 0 <= index < len(slots):
            raise ValueError("Список времени изменился. Откройте его заново.")
        if value in slots and slots[index] != value:
            raise ValueError("Это время уже добавлено.")
        slots[index] = value
        schedule["post_times"] = sorted(slots)
    elif key in LABELS:
        schedule[key] = value
    else:
        raise ValueError("Неизвестная настройка.")
    _save(settings, schedule)


def callback(command, data, settings):
    """Return (text, markup, settings_changed), with no Telegram/WB requests."""
    cmd = command.removeprefix("schedule:")
    ui = data.setdefault("admin_ui", {})
    if str(ui.get("pending") or "").startswith("schedule:"):
        ui.pop("pending", None)
    changed = False
    confirmation = ""
    try:
        if cmd == "cancel":
            data.setdefault("admin_ui", {}).pop("pending", None)
            confirmation = "Отменено."
        elif cmd in ("post_now", "search_now"):
            name = "schedule_post_request" if cmd == "post_now" else "schedule_search_request"
            settings[name] = str(uuid.uuid4())
            _touch(settings)
            changed = True
            confirmation = "✅ Заявка принята. Планировщик выполнит её с учётом лимитов и обновит статус."
        elif cmd.startswith("toggle:"):
            key = cmd.split(":", 1)[1]
            if key not in TOGGLES:
                raise ValueError("Неизвестный переключатель.")
            schedule = _schedule(settings)
            schedule[key] = not schedule[key]
            _save(settings, schedule)
            if key == "paused" and not schedule[key]:
                settings.pop("pause_until", None)
            changed = True
            confirmation = "✅ Настройка сохранена."
        elif cmd.startswith("mode:"):
            mode = cmd.split(":", 1)[1]
            if mode not in ("interval", "times"):
                raise ValueError("Неизвестный режим.")
            schedule = _schedule(settings)
            if mode == "times" and not schedule["post_times"]:
                text, markup = _times(settings)
                return "Сначала добавьте время публикаций.\n\n" + text, markup, False
            schedule["mode"] = mode
            _save(settings, schedule)
            changed = True
            confirmation = "✅ Режим сохранён."
        elif cmd.startswith("day:") or cmd.startswith("days:"):
            schedule = _schedule(settings)
            if cmd.startswith("day:"):
                day = int(cmd.split(":", 1)[1])
                if day not in range(7):
                    raise ValueError("День недели вне диапазона.")
                days = set(schedule["weekdays"])
                days.remove(day) if day in days else days.add(day)
                if not days:
                    raise ValueError("Оставьте хотя бы один день публикаций.")
                schedule["weekdays"] = sorted(days)
            else:
                choices = {"all": list(range(7)), "work": list(range(5)), "weekend": [5, 6]}
                schedule["weekdays"] = choices[cmd.split(":", 1)[1]]
            _save(settings, schedule)
            text, markup = _weekdays(settings)
            return "✅ Дни сохранены.\n\n" + text, markup, True
        elif cmd.startswith("set:"):
            _, key, raw = cmd.split(":", 2)
            _set_value(settings, key, raw)
            text, markup = _editor(key, settings)
            return "✅ Сохранено.\n\n" + text, markup, True
        elif cmd.startswith("time_del:"):
            schedule = _schedule(settings)
            index = int(cmd.split(":", 1)[1])
            if not 0 <= index < len(schedule["post_times"]):
                raise ValueError("Время уже удалено.")
            if schedule["mode"] == "times" and len(schedule["post_times"]) == 1:
                raise ValueError("Оставьте один слот или сначала включите интервальный режим.")
            schedule["post_times"] = schedule["post_times"][:index] + schedule["post_times"][index + 1:]
            _save(settings, schedule)
            text, markup = _times(settings)
            return "✅ Время удалено.\n\n" + text, markup, True
        elif cmd.startswith("custom:"):
            key = cmd.split(":", 1)[1]
            if key not in LABELS:
                raise ValueError("Неизвестная настройка.")
            text, markup = _prompt(data, key)
            return text, markup, False
        elif cmd == "time_add" or cmd.startswith("time_edit:"):
            text, markup = _prompt(data, cmd)
            return text, markup, False
        elif cmd.startswith("edit:"):
            text, markup = _editor(cmd.split(":", 1)[1], settings)
            return text, markup, False
        elif cmd == "mode":
            schedule = _schedule(settings)
            return "🕓 <b>Режим публикаций</b>\n\nВыберите интервалы или конкретные часы.", [
                [_btn("✓ Интервал" if schedule["mode"] == "interval" else "Интервал", "mode:interval"),
                 _btn("✓ По часам" if schedule["mode"] == "times" else "По часам", "mode:times")],
                [_btn("Часы публикаций", "times")], _back()], False
        elif cmd in ("times", "weekdays", "quiet", "search", "limits"):
            text, markup = {"times": _times, "weekdays": _weekdays, "quiet": _quiet,
                            "search": _search, "limits": _limits}[cmd](settings)
            return text, markup, False
        elif cmd != "menu":
            raise ValueError("Кнопка устарела. Откройте расписание заново.")
    except (ValueError, KeyError, TypeError, IndexError) as exc:
        return "❌ " + html.escape(_error(exc)), [_back()], False
    text, markup = view(data, settings)
    return (confirmation + "\n\n" if confirmation else "") + text, markup, changed


def message(text, data, settings):
    """Consume a schedule text prompt; invalid input preserves configuration."""
    ui = data.setdefault("admin_ui", {})
    pending = ui.get("pending") or ""
    if not pending.startswith("schedule:"):
        return None
    key = pending.removeprefix("schedule:")
    try:
        _set_value(settings, key, text)
    except (ValueError, KeyError, TypeError, IndexError) as exc:
        return ("❌ " + html.escape(_error(exc)) + "\nОтправьте значение ещё раз или отмените.",
                [[_btn("Отмена", "cancel")]], False)
    ui.pop("pending", None)
    rendered, markup = _times(settings) if key.startswith("time_") else view(data, settings)
    return "✅ Сохранено.\n\n" + rendered, markup, True
