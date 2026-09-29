"""Read-only, bounded GitHub-runner smoke test of the production WB source."""

import os

import requests

import wb


def main():
    if not os.environ.get("WB_SOURCE_KEY"):
        raise RuntimeError("WB_SOURCE_KEY is unavailable to the runner")

    response = requests.get(
        "https://wb-finds-miniapp.valeramyakishev000.workers.dev/api/catalog",
        timeout=(5, 15),
    )
    response.raise_for_status()
    known = {int(item["id"]) for item in response.json()["products"]}

    found = {}
    for query in ("платье женское", "плед"):
        for item in wb.search(query, 1):
            if item.get("id"):
                found[int(item["id"])] = item
    new_ids = [pid for pid in found if pid not in known]
    cards = wb.cards(new_ids[:20])
    valid = [
        card for card in cards
        if card.get("id") in new_ids and card.get("name")
        and card.get("pics") and wb._has_price(card)
    ]
    health = wb.health_snapshot()
    print("FOUND_FROM_SOURCE", len(found), flush=True)
    print("ALREADY_KNOWN", len(found) - len(new_ids), flush=True)
    print("NEW_PRODUCTS", len(new_ids), flush=True)
    print("VALID_CARDS", len(valid), flush=True)
    print("NEW_IDS", ",".join(str(card["id"]) for card in valid[:5]), flush=True)
    print("WORKER_OK", health["worker_ok"], "DIRECT_OK", health["direct_ok"], flush=True)
    if len(new_ids) < 20 or len(valid) < 5 or health["worker_ok"] < 3:
        raise RuntimeError("New, priced WB cards were not proven from this GitHub runner")


if __name__ == "__main__":
    main()
