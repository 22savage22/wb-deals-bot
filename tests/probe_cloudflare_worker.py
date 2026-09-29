"""One-shot, disposable Cloudflare egress probe; never stores credentials.

The existing mini-app Worker and its bindings are not touched. The probe script
is created under a unique name, queried once, then deleted in ``finally``.
"""

import json
import secrets
import sys
import time
from pathlib import Path

import requests


ACCOUNT = "a4f7cbd9ad379d4b18087b99e9839205"
API = "https://api.cloudflare.com/client/v4"
SCRIPT = r"""
const queries = [
  ['women', 'платье женское'],
  ['home', 'плед для дома'],
];
const headers = {Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'ru-RU,ru;q=0.9'};
async function fetchJson(url) {
  try {
    const r = await fetch(url, {headers, redirect: 'manual',
      signal: AbortSignal.timeout(8000)});
    if (r.status !== 200) return {status: r.status, products: []};
    const data = await r.json();
    return {status: r.status, products: data?.data?.products ?? data?.products ?? []};
  } catch (e) {
    return {status: 'NETWORK_ERROR', products: [], error: String(e?.name ?? 'Error')};
  }
}
function small(p) {
  const price = (p.sizes ?? []).map(s => s.price).find(x => x?.product);
  return {id: p.id, title: p.name ?? '', brand: p.brand ?? '',
    price: price?.product ?? p.salePriceU ?? 0,
    basic: price?.basic ?? p.priceU ?? 0,
    rating: p.reviewRating ?? p.rating ?? 0,
    feedbacks: p.feedbacks ?? p.nmFeedbacks ?? 0,
    pics: p.pics ?? 0};
}
export default {
  async fetch(request) {
    if (new URL(request.url).pathname !== '/probe')
      return new Response('Not found', {status: 404});
    const results = [];
    for (const [label, query] of queries) {
      const url = new URL('https://search.wb.ru/exactmatch/ru/common/v9/search');
      for (const [k, v] of Object.entries({query, page: '1', dest: '-1257786',
        curr: 'rub', resultset: 'catalog', spp: '30'})) url.searchParams.set(k, v);
      const result = await fetchJson(url.toString());
      results.push({source: label, status: result.status,
        count: result.products.length,
        products: result.products.slice(0, 100).map(small)});
      if (result.status === 403) break;
    }
    const card = await fetchJson('https://card.wb.ru/cards/v4/detail?appType=1&nm=982915020&dest=-1257786&curr=rub&spp=30');
    results.push({source: 'new_card', status: card.status,
      count: card.products.length, products: card.products.slice(0, 1).map(small)});
    return new Response(JSON.stringify({results}), {headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'}});
  }
};
"""


def cf(token, method, path, **kwargs):
    response = requests.request(method, API + path,
                                headers={"Authorization": "Bearer " + token},
                                timeout=30, **kwargs)
    try:
        body = response.json()
    except ValueError:
        raise RuntimeError(f"Cloudflare HTTP {response.status_code}") from None
    if not response.ok or body.get("success") is False:
        codes = [item.get("code") for item in body.get("errors", [])]
        raise RuntimeError(f"Cloudflare HTTP {response.status_code}, codes={codes}")
    return body.get("result")


def main(nonce):
    handoff = requests.get("http://127.0.0.1:8769/credential",
                           headers={"X-Setup-Nonce": nonce}, timeout=5)
    handoff.raise_for_status()
    token = handoff.json().get("token")
    if not token:
        raise RuntimeError("Temporary Cloudflare token not entered")
    verified = cf(token, "GET", "/user/tokens/verify")
    print("CLOUDFLARE_TOKEN_STATUS", verified.get("status"), flush=True)
    if verified.get("status") != "active":
        raise RuntimeError("Temporary Cloudflare token is not active")

    name = "wb-source-probe-" + secrets.token_hex(5)
    base = f"/accounts/{ACCOUNT}/workers/scripts/{name}"
    # Never overwrite a pre-existing Worker, and never touch the production app.
    preflight = requests.get(API + base,
                             headers={"Authorization": "Bearer " + token}, timeout=20)
    if preflight.status_code != 404:
        raise RuntimeError(f"Probe name preflight returned HTTP {preflight.status_code}")
    created = False
    try:
        metadata = {"main_module": "probe.mjs", "compatibility_date": "2026-09-01"}
        cf(token, "PUT", base, files={
            "metadata": ("metadata.json", json.dumps(metadata), "application/json"),
            "probe.mjs": ("probe.mjs", SCRIPT.encode(), "application/javascript+module"),
        })
        created = True
        print("WORKER_DEPLOY accepted", flush=True)
        cf(token, "POST", base + "/subdomain",
           json={"enabled": True, "previews_enabled": False})
        route = cf(token, "GET", base + "/subdomain")
        print("WORKER_ROUTE_ENABLED", route.get("enabled"), flush=True)
        subdomain = cf(token, "GET", f"/accounts/{ACCOUNT}/workers/subdomain")["subdomain"]
        url = f"https://{name}.{subdomain}.workers.dev/probe"
        # The workers.dev route may need a few seconds after successful API upload.
        # This is a small, bounded readiness check, not a retry loop around WB 403.
        for attempt in range(5):
            response = requests.get(url, timeout=35)
            print("WORKER_HTTP", response.status_code, "ATTEMPT", attempt + 1,
                  flush=True)
            if response.status_code != 404 or response.text.strip() == "Not found":
                break
            if attempt < 4:
                time.sleep(3)
        response.raise_for_status()
        results = response.json()["results"]
        for result in results:
            print("SOURCE", result["source"], "HTTP", result["status"],
                  "SEARCH_RESULTS", result["count"], flush=True)
            for item in result["products"][:5]:
                print("SAMPLE", json.dumps(item, ensure_ascii=True), flush=True)
        catalog = requests.get(
            "https://wb-finds-miniapp.valeramyakishev000.workers.dev/api/catalog",
            timeout=20).json()
        known = {int(p["id"]) for p in catalog.get("products", [])}
        found = {int(p["id"]): p for row in results if row["source"] != "new_card"
                 for p in row["products"] if p.get("id")}
        new = [p for nm, p in found.items() if nm not in known]
        valid = [p for p in new if p.get("title") and p.get("price", 0) > 0
                 and p.get("pics", 0) > 0]
        print("FOUND_FROM_SOURCE", len(found), "ALREADY_KNOWN",
              sum(nm in known for nm in found), "NEW_PRODUCTS", len(new),
              "VALID_BASIC", len(valid), flush=True)
        print("NEW_IDS", [p["id"] for p in valid[:20]], flush=True)
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from wb import _basket_host
        for product in valid[:3]:
            nm = int(product["id"])
            host = _basket_host(nm)
            photo_status = None
            card_status = None
            if host:
                vol, part = nm // 100000, nm // 1000
                base = f"https://basket-{host}.wbbasket.ru/vol{vol}/part{part}/{nm}"
                card_status = requests.get(base + "/info/ru/card.json", timeout=10).status_code
                photo_status = requests.get(base + "/images/big/1.webp", timeout=10).status_code
            print("NEW_PRODUCT_CHECK", json.dumps({"nmId": nm,
                "title": product["title"], "price_rub": product["price"] / 100,
                "card_http": card_status, "photo_http": photo_status,
                "url": f"https://www.wildberries.ru/catalog/{nm}/detail.aspx"},
                ensure_ascii=True), flush=True)
        return results
    finally:
        if created:
            try:
                cf(token, "DELETE", base)
                print("TEST_WORKER_REMOVED", name, flush=True)
            except Exception as exc:
                print("TEST_WORKER_CLEANUP_ERROR", name, type(exc).__name__, flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python tests/probe_cloudflare_worker.py <local-form-nonce>")
    main(sys.argv[1])
