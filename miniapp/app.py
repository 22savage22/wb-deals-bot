"""Run with gunicorn 'miniapp.app:create_app()'. Secrets stay on the server."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import time
from urllib.parse import parse_qsl

from flask import Flask, abort, g, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException

from .catalog import normalize, SLOTS, OCCASIONS
from .outfits import build


def telegram_user(raw, token, now=None):
    if not token or not raw or len(raw) > 12000:
        raise ValueError("Откройте приложение через Telegram")
    pairs = parse_qsl(raw, keep_blank_values=True, strict_parsing=True)
    fields = dict(pairs)
    if len(fields) != len(pairs):
        raise ValueError("Некорректная подпись")
    supplied = fields.pop("hash", "")
    check = "\n".join(f"{key}={fields[key]}" for key in sorted(fields))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(supplied, expected):
        raise ValueError("Откройте приложение заново через Telegram")
    age = (time.time() if now is None else now) - int(fields.get("auth_date", 0))
    if not -30 <= age <= 3600:
        raise ValueError("Сессия истекла. Откройте приложение заново")
    user = json.loads(fields.get("user", "{}"))
    if not isinstance(user, dict) or type(user.get("id")) is not int or not 0 < user["id"] < 2**53:
        raise ValueError("Не удалось определить пользователя")
    return user["id"]


def create_app(test_config=None):
    app = Flask(__name__, static_folder="static", static_url_path="/static")
    app.config.update(
        DATABASE=os.environ.get("MINIAPP_DB", "miniapp-data/app.sqlite3"),
        BOT_TOKEN=os.environ.get("MINIAPP_BOT_TOKEN", ""),
        SYNC_KEY=os.environ.get("MINIAPP_SYNC_KEY", ""),
        ADMIN_ID=os.environ.get("MINIAPP_ADMIN_ID", ""),
        BOT_USERNAME=os.environ.get("MINIAPP_BOT_USERNAME", ""),
        MAX_CONTENT_LENGTH=2 * 1024 * 1024,
    )
    if test_config:
        app.config.update(test_config)
    Path(app.config["DATABASE"]).parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(app.config["DATABASE"]) as db:
        db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY, data TEXT NOT NULL, overrides TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE IF NOT EXISTS saved (
                user_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
                folder TEXT NOT NULL DEFAULT 'Себе', owned INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL, PRIMARY KEY(user_id, product_id));
            CREATE TABLE IF NOT EXISTS preferences (
                user_id INTEGER PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS outfits (
                id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
                data TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)

    def db():
        if "db" not in g:
            g.db = sqlite3.connect(app.config["DATABASE"], timeout=10)
            g.db.row_factory = sqlite3.Row
        return g.db

    @app.teardown_appcontext
    def close_db(error):
        connection = g.pop("db", None)
        if connection is not None:
            connection.close()

    def catalog():
        return [dict(json.loads(r["data"]), **json.loads(r["overrides"])) for r in db().execute("SELECT data, overrides FROM products ORDER BY json_extract(data, '$.checked_at') DESC LIMIT 3000")]

    def payload():
        value = request.get_json(silent=True)
        if not isinstance(value, dict):
            abort(400, "Нужен JSON-объект")
        return value

    def admin():
        if str(g.user_id) != str(app.config["ADMIN_ID"]):
            abort(403, "Доступ только владельцу")

    @app.before_request
    def authenticate():
        if request.path.startswith("/api/") and request.path not in ("/api/catalog", "/api/sync", "/api/health"):
            try:
                g.user_id = telegram_user(request.headers.get("X-Telegram-Init-Data", ""), app.config["BOT_TOKEN"])
            except (ValueError, TypeError, KeyError):
                abort(401, "Откройте приложение заново через Telegram")

    @app.after_request
    def security_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; "
            "img-src 'self' https://*.wbbasket.ru; connect-src 'self'; "
            "object-src 'none'; base-uri 'none'; form-action 'self'; "
            "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org"
        )
        response.headers["Cache-Control"] = "no-store" if request.path.startswith("/api/") else "no-cache"
        return response

    @app.errorhandler(HTTPException)
    def http_error(error):
        return jsonify(error=error.description), error.code

    @app.errorhandler(ValueError)
    def invalid(error):
        return jsonify(error=str(error)[:200]), 400

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/api/health")
    def health():
        db().execute("SELECT 1")
        return jsonify(ok=True, configured=bool(app.config["BOT_TOKEN"] and len(app.config["SYNC_KEY"]) >= 32))

    @app.get("/api/catalog")
    def get_catalog():
        products = [p for p in catalog() if p.get("enabled", True)]
        row = db().execute("SELECT value FROM metadata WHERE key='synced_at'").fetchone()
        return jsonify(products=products, slots=SLOTS, occasions=OCCASIONS,
                       synced_at=int(row[0]) if row else 0, bot_username=app.config["BOT_USERNAME"])

    @app.post("/api/sync")
    def sync():
        key = app.config["SYNC_KEY"]
        if len(key) < 32 or not hmac.compare_digest(request.headers.get("Authorization", ""), "Bearer " + key):
            abort(403, "Нет доступа")
        rows = payload().get("products")
        if not isinstance(rows, list) or len(rows) > 1000:
            abort(400, "Некорректный каталог")
        try:
            cleaned = [normalize(p) for p in rows if isinstance(p, dict)]
        except (ValueError, TypeError, OverflowError):
            abort(400, "Некорректные поля товара")
        with db():
            for product in cleaned:
                existing = db().execute("SELECT data FROM products WHERE id=?", (product["id"],)).fetchone()
                if existing:
                    old = json.loads(existing[0])
                    if old["checked_at"] > product["checked_at"]:
                        continue
                    product["image"] = product["image"] or old.get("image", "")
                db().execute("INSERT INTO products(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                             (product["id"], json.dumps(product, ensure_ascii=False)))
            db().execute("INSERT OR REPLACE INTO metadata VALUES ('synced_at',?)", (str(int(time.time())),))
        return jsonify(imported=len(cleaned))

    @app.get("/api/me")
    def me():
        row = db().execute("SELECT data FROM preferences WHERE user_id=?", (g.user_id,)).fetchone()
        saved = [dict(r) for r in db().execute("SELECT product_id,folder,owned FROM saved WHERE user_id=? ORDER BY created_at DESC", (g.user_id,))]
        outfits = [dict(id=r["id"], **json.loads(r["data"])) for r in db().execute("SELECT id,data FROM outfits WHERE user_id=? ORDER BY id DESC LIMIT 50", (g.user_id,))]
        private_ids = {s["product_id"] for s in saved}
        private_ids.update(pid for o in outfits for pid in o["ids"])
        private_products = []
        for pid in private_ids:
            item = db().execute("SELECT data,overrides FROM products WHERE id=?", (pid,)).fetchone()
            if item:
                private_products.append(dict(json.loads(item[0]), **json.loads(item[1])))
        return jsonify(saved=saved, outfits=outfits, products=private_products, preferences=json.loads(row[0]) if row else {},
                       plan="free", is_admin=str(g.user_id) == str(app.config["ADMIN_ID"]))

    @app.put("/api/preferences")
    def preferences():
        data = payload()
        budget = data.get("budget", 5000)
        if type(budget) is not int or not 100 <= budget <= 100000:
            abort(400, "Бюджет: от 100 до 100 000 ₽")
        occasion = data.get("occasion", "everyday")
        if not isinstance(occasion, str) or occasion not in OCCASIONS:
            abort(400, "Неизвестный повод")
        clean = {"budget": budget, "occasion": occasion}
        with db():
            db().execute("INSERT OR REPLACE INTO preferences VALUES (?,?)", (g.user_id, json.dumps(clean)))
        return jsonify(ok=True)

    @app.put("/api/saved/<int:pid>")
    def save_product(pid):
        data = payload()
        folder = str(data.get("folder", "Себе")).strip()
        owned = data.get("owned", False)
        if not 1 <= len(folder) <= 40 or type(owned) is not bool:
            abort(400, "Некорректная папка или отметка покупки")
        if not db().execute("SELECT 1 FROM products WHERE id=?", (pid,)).fetchone():
            abort(404, "Товар пока не добавлен в каталог")
        count = db().execute("SELECT count(*) FROM saved WHERE user_id=?", (g.user_id,)).fetchone()[0]
        exists = db().execute("SELECT 1 FROM saved WHERE user_id=? AND product_id=?", (g.user_id, pid)).fetchone()
        if count >= 1000 and not exists:
            abort(400, "Сохранено 1000 вещей. Удалите ненужные, чтобы добавить новую")
        with db():
            db().execute("INSERT INTO saved VALUES (?,?,?,?,?) ON CONFLICT(user_id,product_id) DO UPDATE SET folder=excluded.folder, owned=excluded.owned",
                         (g.user_id, pid, folder, int(owned), int(time.time())))
        return jsonify(ok=True)

    @app.delete("/api/saved/<int:pid>")
    def remove_product(pid):
        with db():
            db().execute("DELETE FROM saved WHERE user_id=? AND product_id=?", (g.user_id, pid))
        return jsonify(ok=True)

    @app.post("/api/outfits")
    def suggest():
        data = payload()
        anchor, budget = data.get("anchor"), data.get("budget")
        excluded = data.get("exclude", [])
        if type(anchor) is not int or type(budget) is not int or not 100 <= budget <= 100000:
            abort(400, "Выберите вещь и бюджет от 100 до 100 000 ₽")
        if not isinstance(excluded, list) or len(excluded) > 100 or any(type(x) is not int for x in excluded):
            abort(400, "Некорректный список замен")
        owned = [r[0] for r in db().execute("SELECT product_id FROM saved WHERE user_id=? AND owned=1", (g.user_id,))]
        results = build(catalog(), anchor, budget, data.get("occasion", "everyday"), owned, excluded)
        return jsonify(outfits=results, message="" if results else "Пока мало свежих вещей для полного образа в этом бюджете. Попробуйте другую вещь или увеличьте бюджет.")

    @app.post("/api/outfits/saved")
    def save_outfit():
        data = payload()
        ids = data.get("ids")
        if not isinstance(ids, list) or not 2 <= len(ids) <= 8 or any(type(x) is not int for x in ids) or len(set(ids)) != len(ids):
            abort(400, "Некорректный образ")
        products = {p["id"]: p for p in catalog()}
        if any(pid not in products for pid in ids):
            abort(400, "Товар больше не доступен")
        title = str(data.get("title", "Мой образ")).strip()[:80] or "Мой образ"
        with db():
            db().execute("INSERT INTO outfits(user_id,data,created_at) VALUES (?,?,?)", (g.user_id, json.dumps({"title": title, "ids": ids}), int(time.time())))
            db().execute("DELETE FROM outfits WHERE user_id=? AND id NOT IN (SELECT id FROM outfits WHERE user_id=? ORDER BY id DESC LIMIT 50)", (g.user_id, g.user_id))
        return jsonify(ok=True)

    @app.delete("/api/outfits/saved/<int:oid>")
    def delete_outfit(oid):
        with db():
            db().execute("DELETE FROM outfits WHERE id=? AND user_id=?", (oid, g.user_id))
        return jsonify(ok=True)

    @app.put("/api/admin/products/<int:pid>")
    def edit_product(pid):
        admin()
        data = payload()
        slot, audience, enabled = data.get("slot"), data.get("audience"), data.get("enabled", True)
        if not isinstance(slot, str) or slot not in SLOTS or audience not in ("women", "men", "unknown") or type(enabled) is not bool:
            abort(400, "Некорректные настройки товара")
        with db():
            changed = db().execute("UPDATE products SET overrides=? WHERE id=?", (json.dumps({"slot": slot, "audience": audience, "enabled": enabled}), pid)).rowcount
        if not changed:
            abort(404)
        return jsonify(ok=True)

    @app.get("/api/admin/products")
    def admin_products():
        admin()
        return jsonify(products=catalog())

    @app.delete("/api/me")
    def delete_account():
        with db():
            for table in ("saved", "outfits", "preferences"):
                db().execute(f"DELETE FROM {table} WHERE user_id=?", (g.user_id,))
        return jsonify(ok=True)

    return app


if __name__ == "__main__":
    create_app().run(host="127.0.0.1", port=8080, debug=False)
