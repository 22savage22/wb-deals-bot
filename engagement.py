"""Engagement posts: polls, questions, fun facts — keep the channel alive."""
import random
import time

import config
import tg

POLLS = [
    {
        "question": "Какой стиль одежды тебе ближе?",
        "options": ["Кэжуал", "Спорт", "Классика", "Streetstyle"],
    },
    {
        "question": "Что важнее при выборе одежды?",
        "options": ["Цена", "Качество", "Бренд", "Стиль"],
    },
    {
        "question": "Как часто покупаешь одежду на WB?",
        "options": ["Каждую неделю", "Раз в месяц", "Раз в сезон", "Когда нужна скидка"],
    },
    {
        "question": "Какой цвет предпочитаешь?",
        "options": ["Чёрный", "Белый", "Пастельные", "Яркие"],
    },
    {
        "question": "Покупаешь обувь онлайн?",
        "options": ["Да, удобно", "Нет, боюсь не подойдёт", "Только кроссовки", "Зависит от скидки"],
    },
    {
        "question": "Что добавить в канал?",
        "options": ["Больше опросов", "Обзоры товаров", "Советы по стилю", "Всё и так ок"],
    },
    {
        "question": "Какая категория товаров тебе интересна?",
        "options": ["Одежда", "Обувь", "Дом и интерьер", "Аксессуары"],
    },
    {
        "question": "Сколько тратишь на одежду в месяц?",
        "options": ["До 3000₽", "3000-7000₽", "7000-15000₽", "Больше 15000₽"],
    },
    {
        "question": "Ловишь скидки на WB?",
        "options": ["Да, постоянно мониторю", "Иногда вижу", "Редко", "Подписан на канал — ловлю здесь"],
    },
    {
        "question": "Какой подарок бы выбрал(а)?",
        "options": ["Одежда", "Техника", "Книги", "Вкусняшки"],
    },
]

QUESTIONS = [
    "Кто сегодня заказывал что-то интересное? Делитесь впечатлениями!",
    "Какая вещь с WB тебя больше всего удивила качеством?",
    "Есть ли у тебя находки, которыми гордишься? Расскажи!",
    "Что бы ты хотел(а) видеть в канале чаще?",
    "Какой товар с WB оказался хуже, чем на фото?",
    "Твой лучший deal за последний месяц?",
    "Какой размер usually берёшь на WB — совпадает?",
    "Покупаешь ли одежду для подарков на WB?",
    "Какой бренд на WB тебя приятно удивил?",
    "Твой лайфхак при выборе одежды онлайн?",
]

FUN_FACTS = [
    "📊 Знаете ли вы? Средний чек заказа на Wildberries — около 2000₽. А какой у вас?",
    "🔥 Факт: На WB ежедневно появляется более 500 000 новых товаров. Мы находим лучшие!",
    "💡 Лайфхак: Проверяйте отзывы с фото — они показывают реальное качество товара.",
    "🎯 Статистика: 73% покупателей WB ищут товары со скидкой выше 50%. Вы тоже?",
    "🌟 Факт: Самые популярные категории на WB — одежда, обувь и электроника.",
    "📱 Совет: Скачайте приложение WB — там часто бывают эксклюзивные скидки.",
    "🏷️ Знаете ли вы? Цена на WB может меняться несколько раз в день. Ловите момент!",
    "🔍 Интересный факт: На WB можно найти товары дешевле, чем в магазинах в 2-3 раза.",
    "💪 Факт: Средний рейтинг товаров на WB — 4.5 из 5. Качество на высоте!",
    "🎁 Совет: Подарочные сертификаты WB — отличный вариант, если не знаете, что выбрать.",
]


def _last_engagement_ts(data):
    return float((data.get("meta") or {}).get("last_engagement_ts", 0) or 0)


def should_post_engagement(data, interval_hours=6):
    now = time.time()
    last = _last_engagement_ts(data)
    return now - last >= interval_hours * 3600


def post_engagement(data, token=None, chat_id=None):
    token = token or config.TG_BOT_TOKEN
    chat_id = chat_id or config.TG_CHAT_ID
    if not token or not chat_id:
        return False

    now = time.time()
    last = _last_engagement_ts(data)

    r = random.random()
    if r < 0.45:
        poll = random.choice(POLLS)
        ok = tg.send_poll(token, chat_id, poll["question"], poll["options"])
        kind = "poll"
    elif r < 0.75:
        msg = random.choice(QUESTIONS)
        ok = tg.send_message(token, chat_id, f"💬 <b>Вопрос дня</b>\n\n{msg}")
        kind = "question"
    else:
        msg = random.choice(FUN_FACTS)
        ok = tg.send_message(token, chat_id, msg)
        kind = "fun_fact"

    if ok:
        data.setdefault("meta", {})["last_engagement_ts"] = int(now)
        data.setdefault("meta", {})["last_engagement_kind"] = kind
        print(f"Engagement пост: {kind}")
    return ok
