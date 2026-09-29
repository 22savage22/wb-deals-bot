"""Bounded, read-only source check for a GitHub Actions runner.

Run only on a manual Tests workflow dispatch.  No credentials or response bodies
are printed: the probe exists to distinguish a usable product feed from a
successful HTTP request to metadata-only or login-gated endpoints.
"""

import time

import requests


SOURCES = {
    "wb_search_women": (
        "https://search.wb.ru/exactmatch/ru/common/v9/search",
        {"query": "платье женское", "page": 1, "dest": -1257786, "curr": "rub"},
    ),
    "wb_search_home": (
        "https://search.wb.ru/exactmatch/ru/common/v9/search",
        {"query": "плед", "page": 1, "dest": -1257786, "curr": "rub"},
    ),
    "wb_cards": (
        "https://card.wb.ru/cards/v4/detail",
        {"nm": 321789200, "dest": -1257786, "curr": "rub"},
    ),
    "wb_public_page": (
        "https://www.wildberries.ru/catalog/321789200/detail.aspx",
        None,
    ),
    "wb_menu_metadata_only": (
        "https://static-basket-01.wbbasket.ru/vol0/data/main-menu-ru-ru-v3.json",
        None,
    ),
    "takprodam_product_auth_gate": (
        "https://api.takprodam.ru/v2/publisher/product/",
        {"limit": 1},
    ),
}


def main():
    session = requests.Session()
    for round_no in (1, 2):
        for name, (url, params) in SOURCES.items():
            started = time.monotonic()
            try:
                response = session.get(url, params=params, timeout=8)
                elapsed = round((time.monotonic() - started) * 1000)
                products = []
                fields = ""
                if response.ok and "json" in response.headers.get("content-type", ""):
                    try:
                        payload = response.json()
                        if isinstance(payload, dict):
                            products = ((payload.get("data") or {}).get("products")
                                        if isinstance(payload.get("data"), dict) else None)
                            products = products or payload.get("products") or []
                        if products and isinstance(products[0], dict):
                            fields = ",".join(sorted(products[0].keys())[:20])
                    except ValueError:
                        pass
                print(f"SOURCE_PROBE round={round_no} provider={name} "
                      f"status={response.status_code} products={len(products)} "
                      f"latency_ms={elapsed} fields={fields}", flush=True)
            except requests.RequestException as exc:
                print(f"SOURCE_PROBE round={round_no} provider={name} "
                      f"status=NETWORK_ERROR error={type(exc).__name__}", flush=True)
        if round_no == 1:
            time.sleep(2)


if __name__ == "__main__":
    main()
