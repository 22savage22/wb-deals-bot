"""Deploy the dedicated WB data egress; keep both credentials out of files/logs.

The Cloudflare deployment token is read from the one-shot localhost form.
A new random request key is written only to Cloudflare and GitHub Secrets.
Existing Workers, Mini App bindings and Telegram settings are never touched.
"""

import json
from pathlib import Path
import secrets
import subprocess
import sys
import time

import requests


ACCOUNT = "a4f7cbd9ad379d4b18087b99e9839205"
REPO = "22savage22/wb-deals-bot"
NAME = "wb-product-source"
API = "https://api.cloudflare.com/client/v4"
SOURCE = Path(__file__).resolve().parent / "cloudflare" / "wb_source.mjs"


def cloudflare(token, method, path, **kwargs):
    response = requests.request(method, API + path,
                                headers={"Authorization": "Bearer " + token},
                                timeout=30, **kwargs)
    try:
        payload = response.json()
    except ValueError:
        raise RuntimeError(f"Cloudflare HTTP {response.status_code}") from None
    if not response.ok or payload.get("success") is False:
        codes = [error.get("code") for error in payload.get("errors", [])]
        raise RuntimeError(f"Cloudflare HTTP {response.status_code}, codes={codes}")
    return payload.get("result")


def main(nonce):
    form = requests.get("http://127.0.0.1:8769/credential",
                        headers={"X-Setup-Nonce": nonce}, timeout=5)
    form.raise_for_status()
    token = form.json().get("token")
    if not token:
        raise RuntimeError("Cloudflare token missing from RAM handoff")
    result = cloudflare(token, "GET", "/user/tokens/verify")
    if result.get("status") != "active":
        raise RuntimeError("Cloudflare token is not active")
    print("CLOUDFLARE_AUTH OK", flush=True)

    base = f"/accounts/{ACCOUNT}/workers/scripts/{NAME}"
    preflight = requests.get(API + base,
                             headers={"Authorization": "Bearer " + token}, timeout=20)
    if preflight.status_code != 404:
        raise RuntimeError(f"Existing Worker will not be overwritten: HTTP {preflight.status_code}")
    key = secrets.token_urlsafe(36)
    created = False
    committed = False
    try:
        metadata = {"main_module": "wb_source.mjs", "compatibility_date": "2026-09-01"}
        cloudflare(token, "PUT", base, files={
            "metadata": ("metadata.json", json.dumps(metadata), "application/json"),
            "wb_source.mjs": ("wb_source.mjs", SOURCE.read_bytes(),
                              "application/javascript+module"),
        })
        created = True
        cloudflare(token, "PUT", base + "/secrets",
                   json={"name": "WB_SOURCE_KEY", "text": key, "type": "secret_text"})
        cloudflare(token, "POST", base + "/subdomain",
                   json={"enabled": True, "previews_enabled": False})
        subdomain = cloudflare(token, "GET", f"/accounts/{ACCOUNT}/workers/subdomain")["subdomain"]
        url = f"https://{NAME}.{subdomain}.workers.dev"
        unauthorized = None
        for attempt in range(5):
            unauthorized = requests.get(url + "/search?query=dress", timeout=20)
            if unauthorized.status_code != 404:
                break
            if attempt < 4:
                time.sleep(3)
        if unauthorized.status_code != 401:
            raise RuntimeError(f"Unauthenticated Worker request returned {unauthorized.status_code}")
        headers = {"Authorization": "Bearer " + key}
        response = None
        for attempt in range(5):
            response = requests.get(url + "/search",
                                    params={"query": "платье женское", "page": 1,
                                            "dest": -1257786, "curr": "rub",
                                            "resultset": "catalog", "spp": 30},
                                    headers=headers, timeout=30)
            if response.status_code != 404:
                break
            if attempt < 4:
                time.sleep(3)
        if response.status_code != 200:
            raise RuntimeError(f"Worker search HTTP {response.status_code}")
        products = (response.json().get("data") or {}).get("products") or response.json().get("products") or []
        if not products:
            raise RuntimeError("Worker returned no WB products")
        nm = int(products[0]["id"])
        card = requests.get(url + "/cards",
                            params={"nm": nm, "appType": 1, "dest": -1257786,
                                    "curr": "rub", "spp": 30}, headers=headers,
                            timeout=30)
        if card.status_code != 200 or not card.json().get("products"):
            raise RuntimeError(f"Worker card HTTP {card.status_code}")
        print("WORKER_SEARCH OK", "RESULTS", len(products), "SAMPLE_NMID", nm,
              "WORKER_CARD OK", flush=True)
        saved = subprocess.run(["gh", "secret", "set", "WB_SOURCE_KEY", "--repo", REPO],
                               input=key + "\n", text=True, capture_output=True)
        if saved.returncode:
            raise RuntimeError("GitHub secret setup failed; Worker will be removed")
        committed = True
        print("GITHUB_SECRET WB_SOURCE_KEY SET", flush=True)
        print("WORKER_URL", url, flush=True)
    finally:
        if created and not committed:
            try:
                cloudflare(token, "DELETE", base)
                print("INCOMPLETE_WORKER_REMOVED", flush=True)
            except Exception:
                print("INCOMPLETE_WORKER_CLEANUP_FAILED", NAME, flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m miniapp.deploy_wb_source <local-form-nonce>")
    main(sys.argv[1])
