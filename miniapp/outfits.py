"""Bounded, explainable outfit suggestions. No invented availability or fit."""
import time
from .catalog import OCCASIONS, SLOTS, safe_image, style


def build(products, anchor_id, budget, occasion="everyday", owned=(), exclude=(), now=None):
    if not isinstance(occasion, str) or occasion not in OCCASIONS:
        raise ValueError("Неизвестный повод")
    owned, exclude = set(owned), set(exclude)
    now = time.time() if now is None else now
    # Bounded catalog/beam search; descriptive signals are not visual styling.
    fresh = [p for p in products if p.get("enabled", True) and p["id"] not in exclude
             and 0 <= now - p["checked_at"] <= 48 * 3600 and safe_image(p.get("image")) and style(p)["eligible"]]
    signals = {p["id"]: style(p) for p in fresh}
    anchor = next((p for p in fresh if p["id"] == anchor_id), None)
    if anchor is None:
        raise ValueError("Для подбора нужна вещь с фото и ценой, проверенной за последние 48 часов")
    if anchor["slot"] == "other":
        raise ValueError("Выберите одежду, обувь или аксессуар для образа")
    budget = round(budget * 100)
    cost = lambda p: 0 if p["id"] in owned else round(p["price"] * 100)
    if cost(anchor) > budget:
        return []
    def compatible(items, p):
        b = signals[p["id"]]
        if occasion in ("office", "evening") and b["sport"]:
            return False
        if occasion == "evening" and b["sneakers"]:
            return False
        accents = set(b["color"])
        for a in items:
            s = signals[a["id"]]
            if a.get("audience", "unknown") != "unknown" and p.get("audience", "unknown") != "unknown" and a["audience"] != p["audience"]:
                return False
            if (s["formal"] and (b["sport"] or b["sneakers"])) or ((s["sport"] or s["sneakers"]) and b["formal"]) or (s["winter"] and b["summer"]) or (s["summer"] and b["winter"]):
                return False
            accents.update(s["color"])
        return len(accents) <= 1
    if not compatible([], anchor):
        return []
    audience = anchor.get("audience", "unknown")
    fresh = [p for p in fresh if p["id"] != anchor_id and
             (audience == "unknown" or p.get("audience") in (audience, "unknown"))]

    def rank(p):
        text = p["title"].lower()
        words = {"office": ("рубаш", "блуз", "лофер", "жакет", "брюк"),
                 "evening": ("плать", "серьг", "клатч", "туфл"),
                 "everyday": ("джинс", "футбол", "кроссов", "кед")}[occasion]
        return p["rating"] + sum(w in text for w in words) * 2

    def balanced(rows, quality, cheap, key, best=8, affordable=4):
        # Keep cheap paths even when many expensive products rank above them.
        result, seen = [], set()
        for row in sorted(rows, key=quality)[:best] + sorted(rows, key=cheap)[:affordable]:
            identity = key(row)
            if identity not in seen:
                seen.add(identity)
                result.append(row)
        return result

    by_slot = {s: balanced(
        [p for p in fresh if p['slot'] == s and cost(anchor) + cost(p) <= budget and compatible([anchor], p)],
        lambda p: (-rank(p), cost(p), p['id']), lambda p: (cost(p), -rank(p), p['id']), lambda p: p['id']) for s in SLOTS}
    patterns = [["dress", "shoes"], ["top", "bottom", "shoes"]]
    candidates = []
    for pattern in patterns:
        if anchor["slot"] in ("dress", "top", "bottom") and anchor["slot"] not in pattern:
            continue
        required = [s for s in pattern if s != anchor["slot"]]
        beam = [([anchor], cost(anchor))]
        for slot in required:
            following = [(items + [p], total + cost(p)) for items, total in beam
                         for p in by_slot[slot] if total + cost(p) <= budget and compatible(items, p)]
            if not following:
                beam = []
                break
            beam = balanced(following, lambda b: (-sum(rank(p) for p in b[0]), b[1]),
                            lambda b: (b[1], -sum(rank(p) for p in b[0])),
                            lambda b: tuple(p['id'] for p in b[0]), best=24, affordable=8)
        candidates.extend(beam)

    def quality(b):
        return (-sum(rank(p) for p in b[0]) / len(b[0]), b[1])

    def signature(b):
        return frozenset(p['id'] for p in b[0] if p['slot'] in ('dress', 'top', 'bottom', 'shoes') and p['id'] != anchor_id)

    selected, results = [], []
    while candidates and len(results) < 3:
        index = len(results)
        if index == 0:
            chosen = min(candidates, key=quality)
        elif index == 1:
            chosen = min(candidates, key=lambda b: (b[1], quality(b)))
        else:
            def variety(b):
                ids = signature(b)
                distance = min(len(ids ^ s) / max(1, len(ids | s)) for s in selected)
                return (-distance, quality(b))
            chosen = min(candidates, key=variety)
        selected.append(signature(chosen))
        candidates = [b for b in candidates if signature(b) not in selected]
        items, total = chosen
        # The budget option is a complete foundation without optional extras.
        if index != 1:
            for slot in ('bag', 'jewelry'):
                if any(p['slot'] == slot for p in items):
                    continue
                extra = next((p for p in by_slot[slot] if total + cost(p) <= budget and compatible(items, p)), None)
                if extra:
                    items = items + [extra]
                    total += cost(extra)
        label = 'Основной образ' if index == 0 else 'Экономнее' if index == 1 and total < round(results[0]['total'] * 100) else 'Другой вариант'
        notes = ["Полный комплект в пределах бюджета; цены проверены за последние 48 часов.", "Явные конфликты стиля, сезона и цветов отсеяны по описаниям."]
        if index == 1:
            notes.append('Без дополнительных аксессуаров: только основа образа и выбранная вещь.')
        if any(p['id'] in owned for p in items):
            notes.append('Вещи с отметкой «Уже есть» не входят в сумму новых покупок.')
        results.append({"items": items, "total": total / 100, "occasion": occasion, 'label': label,
                        "owned": [p["id"] for p in items if p["id"] in owned],
                        "notes": notes,
                        "disclaimer": "Коллаж реальных товаров, не виртуальная примерка. Оттенки, посадку и размеры проверьте в карточках."})
    return results
