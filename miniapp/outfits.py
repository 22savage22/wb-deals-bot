"""Bounded, explainable outfit suggestions. No invented availability or fit."""
import time
from .catalog import OCCASIONS, SLOTS


def build(products, anchor_id, budget, occasion="everyday", owned=(), exclude=(), now=None):
    if not isinstance(occasion, str) or occasion not in OCCASIONS:
        raise ValueError("Неизвестный повод")
    owned, exclude = set(owned), set(exclude)
    now = time.time() if now is None else now
    # ponytail: bounded catalog/beam search; curated style metadata can improve matching later.
    fresh = [p for p in products if p.get("enabled", True) and p["id"] not in exclude
             and 0 <= now - p["checked_at"] <= 48 * 3600]
    anchor = next((p for p in fresh if p["id"] == anchor_id), None)
    if anchor is None:
        raise ValueError("Цена этой вещи устарела или товар недоступен для подбора")
    if anchor["slot"] == "other":
        raise ValueError("Выберите одежду, обувь или аксессуар для образа")
    cost = lambda p: 0 if p["id"] in owned else p["price"]
    if cost(anchor) > budget:
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

    by_slot = {s: sorted((p for p in fresh if p["slot"] == s), key=lambda p: (-rank(p), cost(p), p["id"]))[:18] for s in SLOTS}
    patterns = [["dress", "shoes"], ["top", "bottom", "shoes"]]
    candidates = []
    for pattern in patterns:
        if anchor["slot"] in ("dress", "top", "bottom") and anchor["slot"] not in pattern:
            continue
        required = [s for s in pattern if s != anchor["slot"]]
        beam = [([anchor], cost(anchor))]
        for slot in required:
            following = [(items + [p], total + cost(p)) for items, total in beam
                         for p in by_slot[slot] if total + cost(p) <= budget]
            if not following:
                beam = []
                break
            beam = sorted(following, key=lambda b: (-sum(rank(p) for p in b[0]), b[1]))[:80]
        for items, total in beam:
            for slot in ("bag", "jewelry"):
                if any(p["slot"] == slot for p in items):
                    continue
                extra = next((p for p in by_slot[slot] if total + cost(p) <= budget), None)
                if extra:
                    items = items + [extra]
                    total += cost(extra)
            candidates.append((items, total))
    candidates.sort(key=lambda b: (-sum(rank(p) for p in b[0]) / len(b[0]), b[1]))
    results, signatures = [], set()
    for items, total in candidates:
        # Different clothes/shoes, not three copies with only different earrings.
        signature = tuple(sorted(p["id"] for p in items if p["slot"] in ("dress", "top", "bottom", "shoes")))
        if signature in signatures:
            continue
        signatures.add(signature)
        results.append({"items": items, "total": round(total, 2), "occasion": occasion,
                        "owned": [p["id"] for p in items if p["id"] in owned]})
        if len(results) == 3:
            break
    return results
