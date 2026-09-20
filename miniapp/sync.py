"""Upload whitelisted product fields. No tokens, voters or bot state are sent."""
import json
import os
from pathlib import Path
from urllib.parse import urlparse

import requests
from .catalog import normalize


def public_products(state, queue):
    products = {}
    for item in list(state.get("recent") or []) + list(queue or []):
        try:
            p = normalize(item)
        except (ValueError, TypeError, AttributeError, OverflowError):
            continue
        old = products.get(p["id"])
        if old is None or p["checked_at"] > old["checked_at"]:
            products[p["id"]] = p
    return sorted(products.values(), key=lambda p: p["checked_at"], reverse=True)[:1000]


def upload(products):
    url = os.environ.get("MINIAPP_API_URL", "").rstrip("/")
    key = os.environ.get("MINIAPP_SYNC_KEY", "")
    if not url or not key:
        print("Mini App sync disabled: configure MINIAPP_API_URL and MINIAPP_SYNC_KEY after deployment")
        return
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.query or parsed.fragment or len(key) < 32:
        raise SystemExit("Mini App sync configuration is invalid")
    try:
        # Keep each request within the free D1 query budget.
        for offset in range(0, len(products), 40):
            response = requests.post(url + "/api/sync", json={"products": products[offset:offset + 40]},
                                     headers={"Authorization": "Bearer " + key}, timeout=(5, 20), allow_redirects=False)
            if response.status_code != 200:
                raise SystemExit(f"Mini App catalog sync failed: HTTP {response.status_code}")
    except requests.RequestException:
        raise SystemExit("Mini App catalog sync failed: connection error") from None
    print(f"Mini App catalog synced: {len(products)} products")


def main():
    if not os.getenv("MINIAPP_API_URL") or not os.getenv("MINIAPP_SYNC_KEY"):
        print("Mini App not configured; catalog sync skipped")
        return
    data = json.loads(Path("state.json").read_text(encoding="utf-8"))
    queue = json.loads(Path("queue.json").read_text(encoding="utf-8"))
    upload(public_products(data, queue))


if __name__ == "__main__":
    main()
