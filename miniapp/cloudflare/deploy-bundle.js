var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// miniapp/cloudflare/auth.mjs
var encoder = new TextEncoder();
async function hmac(key, message) {
  const imported = await crypto.subtle.importKey("raw", typeof key === "string" ? encoder.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(message)));
}
__name(hmac, "hmac");
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
__name(equal, "equal");
async function telegramUser(raw, token, now = Date.now() / 1e3) {
  if (!token || !raw || raw.length > 12e3) throw new Error("Telegram authentication required");
  const pairs = [...new URLSearchParams(raw)], fields = new Map(pairs);
  if (fields.size !== pairs.length) throw new Error("Duplicate fields");
  const supplied = fields.get("hash") || "";
  fields.delete("hash");
  if (!/^[a-f0-9]{64}$/.test(supplied)) throw new Error("Invalid hash");
  const check = [...fields].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac("WebAppData", token), digest = await hmac(secret, check);
  const expected = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  if (!equal(expected, supplied)) throw new Error("Invalid signature");
  const date = Number(fields.get("auth_date"));
  if (!Number.isSafeInteger(date) || date <= 0 || now - date < -30 || now - date > 3600) throw new Error("Expired session");
  const user = JSON.parse(fields.get("user") || "{}");
  if (!user || typeof user !== "object" || !Number.isSafeInteger(user.id) || user.id <= 0) throw new Error("Invalid user");
  return user.id;
}
__name(telegramUser, "telegramUser");

// miniapp/cloudflare/domain.mjs
var SLOTS = { dress: "\u041F\u043B\u0430\u0442\u044C\u0435", top: "\u0412\u0435\u0440\u0445", bottom: "\u041D\u0438\u0437", shoes: "\u041E\u0431\u0443\u0432\u044C", bag: "\u0421\u0443\u043C\u043A\u0430", jewelry: "\u0423\u043A\u0440\u0430\u0448\u0435\u043D\u0438\u044F", belt: "\u0420\u0435\u043C\u0435\u043D\u044C", hat: "\u0413\u043E\u043B\u043E\u0432\u043D\u043E\u0439 \u0443\u0431\u043E\u0440", outer: "\u0412\u0435\u0440\u0445\u043D\u044F\u044F \u043E\u0434\u0435\u0436\u0434\u0430", other: "\u0414\u0440\u0443\u0433\u043E\u0435" };
var OCCASIONS = { everyday: "\u041D\u0430 \u043A\u0430\u0436\u0434\u044B\u0439 \u0434\u0435\u043D\u044C", office: "\u0412 \u043E\u0444\u0438\u0441", evening: "\u041D\u0430 \u0432\u0435\u0447\u0435\u0440" };
var MARKERS = { belt: ["\u0440\u0435\u043C\u0435\u043D\u044C", "\u0440\u0435\u043C\u043D\u0438", "\u043F\u043E\u044F\u0441"], dress: ["\u043F\u043B\u0430\u0442\u044C", "\u0441\u0430\u0440\u0430\u0444\u0430\u043D"], outer: ["\u043A\u0443\u0440\u0442\u043A", "\u043F\u0430\u043B\u044C\u0442\u043E", "\u043F\u0443\u0445\u043E\u0432\u0438\u043A", "\u0442\u0440\u0435\u043D\u0447", "\u043F\u043B\u0430\u0449"], bottom: ["\u044E\u0431\u043A", "\u0434\u0436\u0438\u043D\u0441", "\u0431\u0440\u044E\u043A", "\u0448\u043E\u0440\u0442", "\u043B\u0435\u0433\u0433\u0438\u043D"], shoes: ["\u043A\u0440\u043E\u0441\u0441\u043E\u0432", "\u043A\u0435\u0434", "\u0442\u0443\u0444\u043B", "\u0431\u043E\u0442\u0438\u043D", "\u0441\u0430\u043F\u043E\u0433", "\u043B\u043E\u0444\u0435\u0440", "\u0431\u043E\u0441\u043E\u043D\u043E\u0436", "\u0431\u0430\u043B\u0435\u0442\u043A"], bag: ["\u0441\u0443\u043C\u043A", "\u0440\u044E\u043A\u0437\u0430\u043A", "\u043A\u043B\u0430\u0442\u0447"], jewelry: ["\u0441\u0435\u0440\u044C\u0433", "\u0443\u043A\u0440\u0430\u0448\u0435\u043D", "\u043A\u043E\u043B\u044C\u0446", "\u0431\u0440\u0430\u0441\u043B", "\u043E\u0436\u0435\u0440\u0435\u043B", "\u043A\u0443\u043B\u043E\u043D", "\u043A\u043E\u043B\u044C\u0435", "\u0447\u043E\u043A\u0435\u0440", "\u0446\u0435\u043F\u043E\u0447", "\u0431\u0440\u043E\u0448\u044C", "\u043F\u043E\u0434\u0432\u0435\u0441\u043A"], hat: ["\u043A\u0435\u043F\u043A", "\u0448\u0430\u043F\u043A", "\u0448\u043B\u044F\u043F", "\u043F\u0430\u043D\u0430\u043C", "\u0431\u0435\u0439\u0441\u0431\u043E\u043B"], top: ["\u0444\u0443\u0442\u0431\u043E\u043B", "\u0431\u043B\u0443\u0437", "\u0440\u0443\u0431\u0430\u0448", "\u0442\u043E\u043F", "\u0441\u0432\u0438\u0442\u0435\u0440", "\u043A\u0430\u0440\u0434\u0438\u0433\u0430\u043D", "\u0434\u0436\u0435\u043C\u043F\u0435\u0440", "\u0445\u0443\u0434\u0438", "\u043A\u043E\u0444\u0442", "\u0436\u0430\u043A\u0435\u0442", "\u0441\u0432\u0438\u0442\u0448\u043E\u0442"] };
var integer = /* @__PURE__ */ __name((x) => Number.isSafeInteger(x) && x > 0, "integer");
var UNSUITABLE = /детск|девоч|мальчик|малыш|кукл|игруш|постель|подуш|штор|ковр|коврик|чехол|для мебели|для дома|домашн|пижам|ночнуш|бель[её]|бюстгальтер|трус|купаль|плавк|карнавал|косплей|костюмирован|униформ|спецодеж|медицин/;
function style(p) {
  const text2 = (p.title + " " + (p.category || "")).toLowerCase();
  const colors = [["neutral", /черн|чёрн|бел[аыо]|беж|сер[аыо]|молоч|кремов|коричнев|темно-син|тёмно-син/], ["red", /красн|бордов/], ["pink", /розов/], ["blue", /голуб|син[ияе]/], ["green", /зел[её]н|изумруд/], ["yellow", /ж[её]лт|оранж/], ["purple", /фиолет|сирен/]];
  return { eligible: !UNSUITABLE.test(text2), sport: /спортив|бегов|фитнес|трениров|леггин|худи|свитшот/.test(text2), sneakers: /кроссов|кеды/.test(text2), formal: /вечерн|коктейл|торжеств|атлас|пайет|смокинг/.test(text2), summer: /летн|босонож|сандал|шорт|сарафан/.test(text2), winter: /зимн|утеплен|утеплён|пухов|мехов/.test(text2), color: colors.filter(([, re]) => re.test(text2)).map(([c]) => c).filter((c) => c !== "neutral") };
}
__name(style, "style");
function compatible(items, p, signals, occasion) {
  const b = signals.get(p.id);
  if ((occasion === "office" || occasion === "evening") && b.sport) return false;
  if (occasion === "evening" && b.sneakers) return false;
  const accents = new Set(b.color);
  for (const a of items) {
    const s = signals.get(a.id);
    if (a.audience !== "unknown" && p.audience !== "unknown" && a.audience !== p.audience) return false;
    if (s.formal && (b.sport || b.sneakers) || (s.sport || s.sneakers) && b.formal || s.winter && b.summer || s.summer && b.winter) return false;
    for (const c of s.color) accents.add(c);
  }
  return accents.size <= 1;
}
__name(compatible, "compatible");
function safeImage(value) {
  if (typeof value !== "string" || value.length > 1e3) return "";
  try {
    const u = new URL(value);
    return u.protocol === "https:" && /^basket-\d{2,3}\.wbbasket\.ru$/.test(u.hostname) && !u.username && !u.password && !u.port ? u.href : "";
  } catch {
    return "";
  }
}
__name(safeImage, "safeImage");
function normalize(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0442\u043E\u0432\u0430\u0440");
  const id = Number(raw.id || raw.pid), price = Number(raw.price || raw.product);
  const title = String(raw.title || "").trim().slice(0, 200), category = String(raw.category || raw.cat || raw.query || "").slice(0, 100);
  if (!integer(id) || id >= 1e12 || !Number.isFinite(price) || price <= 0 || price > 1e7 || !title) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0442\u043E\u0432\u0430\u0440");
  const detect = /* @__PURE__ */ __name((text3) => Object.entries(MARKERS).find(([, markers]) => markers.some((m) => text3.toLowerCase().includes(m)))?.[0], "detect");
  const text2 = (title + " " + category).toLowerCase(), rating = Number(raw.rating || 0), checked = Number(raw.checked_at || raw.ts || raw.queued_ts || 0);
  if (!Number.isSafeInteger(checked) || checked < 0) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u0430\u044F \u0434\u0430\u0442\u0430 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438");
  return { id, title, price: Math.round(price * 100) / 100, category, image: safeImage(raw.image), slot: UNSUITABLE.test(text2) ? "other" : detect(category) || detect(title) || "other", audience: text2.includes("\u043C\u0443\u0436\u0441\u043A") && !text2.includes("\u0436\u0435\u043D\u0441\u043A") ? "men" : text2.includes("\u0436\u0435\u043D\u0441\u043A") ? "women" : "unknown", rating: Number.isFinite(rating) ? Math.min(5, Math.max(0, rating)) : 0, checked_at: checked, url: `https://www.wildberries.ru/catalog/${id}/detail.aspx` };
}
__name(normalize, "normalize");
function balanced(rows, quality, cheap, key, best = 8, affordable = 4) {
  const seen = /* @__PURE__ */ new Set();
  return [...rows.toSorted(quality).slice(0, best), ...rows.toSorted(cheap).slice(0, affordable)].filter((row) => {
    const id = key(row);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
__name(balanced, "balanced");
function build(products, anchorId, budget, occasion = "everyday", ownedIds = [], excludedIds = [], now = Date.now() / 1e3) {
  if (!Object.hasOwn(OCCASIONS, occasion)) throw new Error("\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u043F\u043E\u0432\u043E\u0434");
  const owned = new Set(ownedIds), excluded = new Set(excludedIds);
  const signals = /* @__PURE__ */ new Map();
  const fresh = products.filter((p) => {
    if (p.enabled === false || excluded.has(p.id) || now - p.checked_at < 0 || now - p.checked_at > 172800 || !safeImage(p.image)) return false;
    const s = style(p);
    signals.set(p.id, s);
    return s.eligible;
  });
  const anchor = fresh.find((p) => p.id === anchorId);
  if (!anchor) throw new Error("\u0414\u043B\u044F \u043F\u043E\u0434\u0431\u043E\u0440\u0430 \u043D\u0443\u0436\u043D\u0430 \u0432\u0435\u0449\u044C \u0441 \u0444\u043E\u0442\u043E \u0438 \u0446\u0435\u043D\u043E\u0439, \u043F\u0440\u043E\u0432\u0435\u0440\u0435\u043D\u043D\u043E\u0439 \u0437\u0430 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0435 48 \u0447\u0430\u0441\u043E\u0432");
  if (anchor.slot === "other") throw new Error("\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043E\u0434\u0435\u0436\u0434\u0443, \u043E\u0431\u0443\u0432\u044C \u0438\u043B\u0438 \u0430\u043A\u0441\u0435\u0441\u0441\u0443\u0430\u0440 \u0434\u043B\u044F \u043E\u0431\u0440\u0430\u0437\u0430");
  const cost = /* @__PURE__ */ __name((p) => owned.has(p.id) ? 0 : Math.round(p.price * 100), "cost"), ceiling = budget * 100;
  if (cost(anchor) > ceiling) return [];
  if (!compatible([], anchor, signals, occasion)) return [];
  const words = { office: ["\u0440\u0443\u0431\u0430\u0448", "\u0431\u043B\u0443\u0437", "\u043B\u043E\u0444\u0435\u0440", "\u0436\u0430\u043A\u0435\u0442", "\u0431\u0440\u044E\u043A"], evening: ["\u043F\u043B\u0430\u0442\u044C", "\u0441\u0435\u0440\u044C\u0433", "\u043A\u043B\u0430\u0442\u0447", "\u0442\u0443\u0444\u043B"], everyday: ["\u0434\u0436\u0438\u043D\u0441", "\u0444\u0443\u0442\u0431\u043E\u043B", "\u043A\u0440\u043E\u0441\u0441\u043E\u0432", "\u043A\u0435\u0434"] }[occasion];
  const scores = new Map(fresh.map((p) => [p.id, p.rating + 2 * words.filter((w) => p.title.toLowerCase().includes(w)).length]));
  const score = /* @__PURE__ */ __name((p) => scores.get(p.id), "score"), bySlot = Object.fromEntries(Object.keys(SLOTS).map((s) => [s, []]));
  for (const p of fresh) if (p.id !== anchorId && cost(anchor) + cost(p) <= ceiling && compatible([anchor], p, signals, occasion)) bySlot[p.slot]?.push(p);
  for (const slot of Object.keys(bySlot)) bySlot[slot] = balanced(bySlot[slot], (a, b) => score(b) - score(a) || cost(a) - cost(b) || a.id - b.id, (a, b) => cost(a) - cost(b) || score(b) - score(a) || a.id - b.id, (p) => p.id);
  let candidates = [];
  for (const pattern2 of [["dress", "shoes"], ["top", "bottom", "shoes"]]) {
    if (["dress", "top", "bottom"].includes(anchor.slot) && !pattern2.includes(anchor.slot)) continue;
    let beam = [{ items: [anchor], total: cost(anchor), score: score(anchor) }];
    for (const slot of pattern2.filter((s) => s !== anchor.slot)) {
      const next = [];
      for (const b of beam) for (const p of bySlot[slot]) if (b.total + cost(p) <= ceiling && compatible(b.items, p, signals, occasion)) next.push({ items: [...b.items, p], total: b.total + cost(p), score: b.score + score(p) });
      beam = balanced(next, (a, b) => b.score - a.score || a.total - b.total, (a, b) => a.total - b.total || b.score - a.score, (b) => b.items.map((p) => p.id).join(","), 24, 8);
    }
    candidates.push(...beam);
  }
  const quality = /* @__PURE__ */ __name((a, b) => b.score / b.items.length - a.score / a.items.length || a.total - b.total, "quality");
  const core = /* @__PURE__ */ __name((b) => b.items.filter((p) => p.id !== anchorId && ["dress", "top", "bottom", "shoes"].includes(p.slot)).map((p) => p.id).sort((a, b2) => a - b2), "core");
  const selected = [], result = [];
  while (candidates.length && result.length < 3) {
    const index = result.length;
    const distance = /* @__PURE__ */ __name((b2) => {
      const ids = new Set(core(b2));
      return Math.min(...selected.map((s) => {
        const union = /* @__PURE__ */ new Set([...ids, ...s]);
        let shared = 0;
        for (const id of ids) if (s.includes(id)) shared++;
        return (union.size - shared) / Math.max(1, union.size);
      }));
    }, "distance");
    candidates.sort(index === 0 ? quality : index === 1 ? (a, b2) => a.total - b2.total || quality(a, b2) : (a, b2) => distance(b2) - distance(a) || quality(a, b2));
    let b = candidates[0];
    selected.push(core(b));
    const signature = core(b).join(",");
    candidates = candidates.filter((c) => core(c).join(",") !== signature);
    if (index !== 1) for (const slot of ["bag", "jewelry"]) {
      if (b.items.some((p) => p.slot === slot)) continue;
      const extra = bySlot[slot].find((p) => b.total + cost(p) <= ceiling && compatible(b.items, p, signals, occasion));
      if (extra) b = { items: [...b.items, extra], total: b.total + cost(extra), score: b.score + score(extra) };
    }
    const label = index === 0 ? "\u041E\u0441\u043D\u043E\u0432\u043D\u043E\u0439 \u043E\u0431\u0440\u0430\u0437" : index === 1 && b.total < Math.round(result[0].total * 100) ? "\u042D\u043A\u043E\u043D\u043E\u043C\u043D\u0435\u0435" : "\u0414\u0440\u0443\u0433\u043E\u0439 \u0432\u0430\u0440\u0438\u0430\u043D\u0442";
    const notes = ["\u041F\u043E\u043B\u043D\u044B\u0439 \u043A\u043E\u043C\u043F\u043B\u0435\u043A\u0442 \u0432 \u043F\u0440\u0435\u0434\u0435\u043B\u0430\u0445 \u0431\u044E\u0434\u0436\u0435\u0442\u0430; \u0446\u0435\u043D\u044B \u043F\u0440\u043E\u0432\u0435\u0440\u0435\u043D\u044B \u0437\u0430 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0435 48 \u0447\u0430\u0441\u043E\u0432.", "\u042F\u0432\u043D\u044B\u0435 \u043A\u043E\u043D\u0444\u043B\u0438\u043A\u0442\u044B \u0441\u0442\u0438\u043B\u044F, \u0441\u0435\u0437\u043E\u043D\u0430 \u0438 \u0446\u0432\u0435\u0442\u043E\u0432 \u043E\u0442\u0441\u0435\u044F\u043D\u044B \u043F\u043E \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u044F\u043C."];
    if (index === 1) notes.push("\u0411\u0435\u0437 \u0434\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0445 \u0430\u043A\u0441\u0435\u0441\u0441\u0443\u0430\u0440\u043E\u0432: \u0442\u043E\u043B\u044C\u043A\u043E \u043E\u0441\u043D\u043E\u0432\u0430 \u043E\u0431\u0440\u0430\u0437\u0430 \u0438 \u0432\u044B\u0431\u0440\u0430\u043D\u043D\u0430\u044F \u0432\u0435\u0449\u044C.");
    if (b.items.some((p) => owned.has(p.id))) notes.push("\u0412\u0435\u0449\u0438 \u0441 \u043E\u0442\u043C\u0435\u0442\u043A\u043E\u0439 \xAB\u0423\u0436\u0435 \u0435\u0441\u0442\u044C\xBB \u043D\u0435 \u0432\u0445\u043E\u0434\u044F\u0442 \u0432 \u0441\u0443\u043C\u043C\u0443 \u043D\u043E\u0432\u044B\u0445 \u043F\u043E\u043A\u0443\u043F\u043E\u043A.");
    result.push({ items: b.items, total: b.total / 100, occasion, label, owned: b.items.filter((p) => owned.has(p.id)).map((p) => p.id), notes, disclaimer: "\u041A\u043E\u043B\u043B\u0430\u0436 \u0440\u0435\u0430\u043B\u044C\u043D\u044B\u0445 \u0442\u043E\u0432\u0430\u0440\u043E\u0432, \u043D\u0435 \u0432\u0438\u0440\u0442\u0443\u0430\u043B\u044C\u043D\u0430\u044F \u043F\u0440\u0438\u043C\u0435\u0440\u043A\u0430. \u041E\u0442\u0442\u0435\u043D\u043A\u0438, \u043F\u043E\u0441\u0430\u0434\u043A\u0443 \u0438 \u0440\u0430\u0437\u043C\u0435\u0440\u044B \u043F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0432 \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0430\u0445." });
  }
  return result;
}
__name(build, "build");

// miniapp/cloudflare/scheduler_api.mjs
var DEFAULT_SCHEDULE = Object.freeze({ enabled: true, paused: false, mode: "interval", post_interval_minutes: 10, post_times: [], weekdays: [0, 1, 2, 3, 4, 5, 6], quiet_enabled: false, quiet_start: "23:00", quiet_end: "07:00", search_enabled: true, search_interval_minutes: 20, min_queue: 100, natural_interval_enabled: false, jitter_minutes: 2, timezone: "Europe/Moscow", min_post_gap_minutes: 5, max_posts_hour: 12, max_posts_day: 144 });
var time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
var seconds = /* @__PURE__ */ __name(() => Math.floor(Date.now() / 1e3), "seconds");
var object = /* @__PURE__ */ __name((x) => x && typeof x === "object" && !Array.isArray(x), "object");
var validZones = /* @__PURE__ */ new Set();
function validateSchedule(input) {
  if (!object(input)) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u043E\u0435 \u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435");
  const s = { ...DEFAULT_SCHEDULE, ...input };
  for (const k of ["enabled", "paused", "quiet_enabled", "search_enabled", "natural_interval_enabled"]) if (typeof s[k] !== "boolean") throw new Error("\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0430\u0442\u0435\u043B\u044C");
  if (!["interval", "times"].includes(s.mode)) throw new Error("\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C \u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u044F");
  for (const k of ["post_interval_minutes", "search_interval_minutes"]) if (!Number.isInteger(s[k]) || s[k] < 5 || s[k] > 10080) throw new Error("\u0418\u043D\u0442\u0435\u0440\u0432\u0430\u043B: \u043E\u0442 5 \u0434\u043E 10080 \u043C\u0438\u043D\u0443\u0442");
  for (const [k, min, max] of [["min_queue", 1, 300], ["jitter_minutes", 0, 120], ["min_post_gap_minutes", 5, 1440], ["max_posts_hour", 1, 12], ["max_posts_day", 1, 288]]) if (!Number.isInteger(s[k]) || s[k] < min || s[k] > max) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u043B\u0438\u043C\u0438\u0442: " + k);
  if (!Array.isArray(s.post_times) || s.post_times.length > 24 || !s.post_times.every((x) => typeof x === "string" && time.test(x))) throw new Error("\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u0434\u043E 24 \u0442\u043E\u0447\u043D\u044B\u0445 \u0432\u0440\u0435\u043C\u0451\u043D HH:MM");
  s.post_times = [...new Set(s.post_times)].sort();
  if (s.mode === "times" && !s.post_times.length) throw new Error("\u0414\u043E\u0431\u0430\u0432\u044C\u0442\u0435 \u0432\u0440\u0435\u043C\u044F \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438");
  if (!Array.isArray(s.weekdays) || !s.weekdays.length || !s.weekdays.every((x) => Number.isInteger(x) && x >= 0 && x <= 6)) throw new Error("\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0434\u043D\u0438 \u043D\u0435\u0434\u0435\u043B\u0438");
  s.weekdays = [...new Set(s.weekdays)].sort();
  if (!time.test(s.quiet_start) || !time.test(s.quiet_end) || s.quiet_enabled && s.quiet_start === s.quiet_end) throw new Error("\u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0447\u0430\u0441\u044B \u0442\u0438\u0448\u0438\u043D\u044B");
  if (typeof s.timezone !== "string" || s.timezone.length > 80) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0447\u0430\u0441\u043E\u0432\u043E\u0439 \u043F\u043E\u044F\u0441");
  if (!validZones.has(s.timezone)) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: s.timezone }).format();
      validZones.add(s.timezone);
    } catch {
      throw new Error("\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u0447\u0430\u0441\u043E\u0432\u043E\u0439 \u043F\u043E\u044F\u0441");
    }
  }
  return Object.fromEntries(Object.keys(DEFAULT_SCHEDULE).map((k) => [k, s[k]]));
}
__name(validateSchedule, "validateSchedule");
var schemas = [
  "CREATE TABLE IF NOT EXISTS scheduler_inventory (pid INTEGER PRIMARY KEY,data TEXT NOT NULL,topic TEXT NOT NULL,title_key TEXT NOT NULL,queued_at INTEGER NOT NULL,checked_at INTEGER NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'ready',retry_at INTEGER NOT NULL DEFAULT 0)",
  "CREATE INDEX IF NOT EXISTS scheduler_inventory_ready ON scheduler_inventory(state,retry_at,expires)",
  "CREATE TABLE IF NOT EXISTS scheduler_policy (id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS scheduler_deliveries (pid INTEGER NOT NULL,ts INTEGER NOT NULL,message_id INTEGER,topic TEXT NOT NULL,title_key TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(pid,ts))",
  "CREATE TABLE IF NOT EXISTS scheduler_config (id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL,revision INTEGER NOT NULL,post_request TEXT,search_request TEXT,status TEXT NOT NULL DEFAULT '{}')",
  "CREATE TABLE IF NOT EXISTS scheduler_leases (kind TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS scheduler_claims (pid INTEGER PRIMARY KEY,owner TEXT NOT NULL,ts INTEGER NOT NULL,status TEXT NOT NULL,request_id TEXT)",
  "CREATE TABLE IF NOT EXISTS scheduler_posts (pid INTEGER NOT NULL,ts INTEGER NOT NULL,PRIMARY KEY(pid,ts))",
  "CREATE TABLE IF NOT EXISTS scheduler_requests (kind TEXT NOT NULL,request_id TEXT NOT NULL,ts INTEGER NOT NULL,PRIMARY KEY(kind,request_id))",
  "CREATE TABLE IF NOT EXISTS scheduler_actions (request_id TEXT PRIMARY KEY,ts INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS scheduler_runtime (id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS scheduler_posts_time ON scheduler_posts(ts)"
];
var initialized = /* @__PURE__ */ new WeakMap();
async function ensureScheduler(env) {
  if (initialized.has(env.DB)) return initialized.get(env.DB);
  const pending = initialize(env);
  initialized.set(env.DB, pending);
  try {
    await pending;
  } catch (e) {
    initialized.delete(env.DB);
    throw e;
  }
}
__name(ensureScheduler, "ensureScheduler");
async function initialize(env) {
  const q2 = /* @__PURE__ */ __name((sql, ...args) => env.DB.prepare(sql).bind(...args), "q");
  await env.DB.batch(schemas.map((sql) => q2(sql)));
  await env.DB.batch([q2("INSERT OR IGNORE INTO scheduler_config(id,data,revision) VALUES(1,?,1)", JSON.stringify(DEFAULT_SCHEDULE)), q2("INSERT OR IGNORE INTO scheduler_runtime(id,data) VALUES(1,'{}')")]);
}
__name(initialize, "initialize");
var dayFormatters = /* @__PURE__ */ new Map();
function dayAt(ts, zone) {
  if (!dayFormatters.has(zone)) dayFormatters.set(zone, new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }));
  return dayFormatters.get(zone).format(new Date(ts * 1e3));
}
__name(dayAt, "dayAt");
function dayStart(ts, zone) {
  const day = dayAt(ts, zone);
  let lo = ts - 9e4, hi = ts;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dayAt(mid, zone) === day) hi = mid;
    else lo = mid;
  }
  return hi;
}
__name(dayStart, "dayStart");
var text = /* @__PURE__ */ __name((v, max = 120) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\r\n]/.test(v) ? v : null, "text");
var safeError = /* @__PURE__ */ __name((v) => typeof v === "string" ? v.replace(/https?:\/\/\S+|(?:bearer|token|secret|password|authorization)\s*[:=]?\s*\S+/gi, "[\u0441\u043A\u0440\u044B\u0442\u043E]").slice(0, 180) : "", "safeError");
var number = /* @__PURE__ */ __name((v) => Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0, "number");
function sanitizedStatus(input) {
  const result = { heartbeat: seconds() };
  for (const k of ["last_post", "last_scan_attempt", "last_scan_success", "queue_size", "new_today", "posted_today", "posts_hour", "next_post", "next_search", "revision"]) if (Number.isFinite(input[k])) result[k] = number(input[k]);
  for (const k of ["post_running", "scan_running"]) if (typeof input[k] === "boolean") result[k] = input[k];
  for (const k of ["last_scan_error", "error"]) if (input[k]) result[k] = safeError(input[k]);
  if (Array.isArray(input.next_posts)) result.next_posts = input.next_posts.filter(Number.isFinite).slice(0, 5).map(number);
  return result;
}
__name(sanitizedStatus, "sanitizedStatus");
async function schedulerRoute(request, env, { payload: payload2, fail: fail2, json: json2, admin = false } = {}) {
  const path = new URL(request.url).pathname, method = request.method;
  if (!path.startsWith("/api/scheduler/") && !path.startsWith("/api/admin/schedule")) return null;
  const q2 = /* @__PURE__ */ __name((sql, ...args) => env.DB.prepare(sql).bind(...args), "q"), all = /* @__PURE__ */ __name(async (sql, ...args) => (await q2(sql, ...args).all()).results, "all");
  await ensureScheduler(env);
  const config = /* @__PURE__ */ __name(async () => {
    const row = await q2("SELECT * FROM scheduler_config WHERE id=1").first();
    const status2 = JSON.parse(row.status), heartbeat = Math.max(status2.heartbeat || 0, status2.clock_heartbeat || 0);
    return { schedule: JSON.parse(row.data), revision: row.revision, post_request: row.post_request, search_request: row.search_request, status: { ...status2, heartbeat_stale: !heartbeat || seconds() - heartbeat > 180 } };
  }, "config");
  const save = /* @__PURE__ */ __name(async (data2) => {
    let schedule;
    try {
      schedule = validateSchedule(data2.schedule);
    } catch (e) {
      fail2(400, e.message);
    }
    if (!Number.isInteger(data2.revision)) fail2(400, "\u041D\u0443\u0436\u043D\u0430 \u0432\u0435\u0440\u0441\u0438\u044F \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043A");
    const revision = Math.max(Date.now(), data2.revision + 1);
    const r = await q2("UPDATE scheduler_config SET data=?,revision=? WHERE id=1 AND revision=?", JSON.stringify(schedule), revision, data2.revision).run();
    if (!r.meta.changes) fail2(409, "\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u0443\u0436\u0435 \u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0438\u0441\u044C. \u041E\u0431\u043D\u043E\u0432\u0438\u0442\u0435 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443");
    return config();
  }, "save");
  if ((path === "/api/scheduler/config" || path === "/api/admin/schedule") && method === "GET") return json2(await config());
  if ((path === "/api/scheduler/config" || path === "/api/admin/schedule") && method === "PUT") return json2(await save(await payload2(request)));
  if ((path === "/api/admin/schedule/action" && admin || path === "/api/scheduler/action") && method === "POST") {
    const data2 = await payload2(request), action = data2.action;
    if (["post_now", "search_now"].includes(action)) {
      const key = action === "post_now" ? "post_request" : "search_request", id = data2.request_id ?? crypto.randomUUID();
      if (!text(id)) fail2(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441");
      await env.DB.batch([q2(`UPDATE scheduler_config SET ${key}=? WHERE id=1 AND NOT EXISTS(SELECT 1 FROM scheduler_actions WHERE request_id=?)`, id, id), q2("INSERT OR IGNORE INTO scheduler_actions(request_id,ts) VALUES(?,?)", id, seconds())]);
      return json2(await config());
    }
    if (["pause", "resume"].includes(action)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await config();
        try {
          return json2(await save({ schedule: { ...current.schedule, paused: action === "pause" }, revision: current.revision }));
        } catch (e) {
          if (e.status !== 409 || attempt === 2) throw e;
        }
      }
    }
    fail2(400, "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u043E\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435");
  }
  if (path === "/api/scheduler/status" && method === "PUT") {
    const data2 = await payload2(request), status2 = sanitizedStatus(data2);
    status2.error = safeError(data2.error);
    status2.last_scan_error = safeError(data2.last_scan_error);
    await q2("UPDATE scheduler_config SET status=json_patch(status,?) WHERE id=1", JSON.stringify(status2)).run();
    return json2({ ok: true });
  }
  if (path !== "/api/scheduler/runtime" || method !== "POST") fail2(405, "\u041C\u0435\u0442\u043E\u0434 \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044F");
  const data = await payload2(request), now = seconds(), kind = data.kind, owner = text(data.owner);
  const runtime2 = /* @__PURE__ */ __name(async () => JSON.parse((await q2("SELECT data FROM scheduler_runtime WHERE id=1").first()).data), "runtime");
  const updateRuntime = /* @__PURE__ */ __name(async (value) => q2("UPDATE scheduler_runtime SET data=? WHERE id=1", JSON.stringify(value)).run(), "updateRuntime");
  if (data.op === "snapshot") {
    const [stored, posts, leases, consumed] = await Promise.all([runtime2(), all("SELECT pid,ts FROM scheduler_posts WHERE ts>? ORDER BY ts", now - 14 * 86400), all("SELECT kind,expires FROM scheduler_leases WHERE expires>?", now), all("SELECT kind,request_id FROM scheduler_requests ORDER BY ts DESC LIMIT 200")]);
    return json2({ ...stored, last_post: posts.at(-1)?.ts || 0, posts, scan_running: leases.some((x) => x.kind === "search"), post_running: leases.some((x) => x.kind === "post"), consumed_requests: consumed });
  }
  if (["acquire", "renew", "release"].includes(data.op)) {
    if (!["post", "search"].includes(kind) || !owner) fail2(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u0430\u044F \u0430\u0440\u0435\u043D\u0434\u0430");
    if (data.op === "release") {
      await q2("DELETE FROM scheduler_leases WHERE kind=? AND owner=?", kind, owner).run();
      return json2({ ok: true });
    }
    const ttl = data.ttl ?? 300;
    if (!Number.isInteger(ttl) || ttl < 5 || ttl > 1800) fail2(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u043E\u0435 \u0432\u0440\u0435\u043C\u044F \u0430\u0440\u0435\u043D\u0434\u044B");
    const result = data.op === "acquire" ? await q2(`INSERT INTO scheduler_leases(kind,owner,expires) VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE scheduler_leases.expires<=?`, kind, owner, now + ttl, now).run() : await q2("UPDATE scheduler_leases SET expires=? WHERE kind=? AND owner=? AND expires>?", now + ttl, kind, owner, now).run();
    return json2({ ok: !!result.meta.changes, ...!result.meta.changes ? { reason: "lock_busy" } : {} });
  }
  if (data.op === "consume") {
    if (!["post", "search"].includes(kind) || !text(data.request_id) || !owner) fail2(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441");
    const field = kind === "post" ? "post_request" : "search_request";
    const results = await env.DB.batch([
      q2(`INSERT OR IGNORE INTO scheduler_requests(kind,request_id,ts) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM scheduler_leases WHERE kind=? AND owner=? AND expires>?)`, kind, data.request_id, now, kind, owner, now),
      q2(`UPDATE scheduler_config SET ${field}=NULL WHERE id=1 AND ${field}=? AND EXISTS(SELECT 1 FROM scheduler_requests WHERE kind=? AND request_id=?)`, data.request_id, kind, data.request_id)
    ]);
    const changed = !!results[0].meta.changes;
    return json2({ ok: changed, ...!changed ? { reason: "consumed_or_no_lease" } : {} });
  }
  if (data.op === "claim") {
    if (!owner || !Number.isInteger(data.product_id) || data.product_id <= 0) fail2(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0442\u043E\u0432\u0430\u0440");
    const schedule = (await config()).schedule;
    if (!text(data.request_id) && (!schedule.enabled || schedule.paused)) return json2({ ok: false, reason: "posting_paused" });
    const gap = Math.max(data.min_gap_minutes ?? schedule.min_post_gap_minutes, schedule.min_post_gap_minutes), hour = Math.min(data.max_hour ?? schedule.max_posts_hour, schedule.max_posts_hour), day = Math.min(data.max_day ?? schedule.max_posts_day, schedule.max_posts_day), repost = data.repost_days ?? 7, zone = schedule.timezone;
    if (!Number.isInteger(gap) || gap < 5 || gap > 1440 || !Number.isInteger(hour) || hour < 1 || hour > 12 || !Number.isInteger(day) || day < 1 || day > 288 || !Number.isInteger(repost) || repost < 7 || repost > 365) fail2(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0435 \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u044F \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438");
    let start;
    try {
      start = dayStart(now, zone);
    } catch {
      fail2(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0447\u0430\u0441\u043E\u0432\u043E\u0439 \u043F\u043E\u044F\u0441");
    }
    const r = await q2(`INSERT INTO scheduler_claims(pid,owner,ts,status,request_id) SELECT ?,?,?,'pending',? WHERE EXISTS(SELECT 1 FROM scheduler_leases WHERE kind='post' AND owner=? AND expires>?) AND NOT EXISTS(SELECT 1 FROM scheduler_posts WHERE ts>?) AND (SELECT count(*) FROM scheduler_claims WHERE ts>?)<? AND (SELECT count(*) FROM scheduler_claims WHERE ts>=?)<? AND NOT EXISTS(SELECT 1 FROM scheduler_claims WHERE status IN ('pending','error') AND ts>?) ON CONFLICT(pid) DO UPDATE SET owner=excluded.owner,ts=excluded.ts,status='pending',request_id=excluded.request_id WHERE scheduler_claims.ts<?`, data.product_id, owner, now, text(data.request_id), owner, now, now - gap * 60, now - 3600, hour, start, day, now - gap * 60, now - repost * 86400).run();
    return json2({ ok: !!r.meta.changes, ...!r.meta.changes ? { reason: "duplicate_or_limit_or_no_lease" } : {} });
  }
  if (data.op === "complete") {
    if (!owner || !Number.isInteger(data.product_id) || typeof data.success !== "boolean") fail2(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442");
    const status2 = data.success ? "success" : "error";
    await env.DB.batch([q2(`INSERT OR IGNORE INTO scheduler_posts(pid,ts) SELECT pid,? FROM scheduler_claims WHERE pid=? AND owner=? AND status='pending' AND ?=1`, now, data.product_id, owner, data.success ? 1 : 0), q2("UPDATE scheduler_claims SET status=? WHERE pid=? AND owner=? AND status='pending'", status2, data.product_id, owner)]);
    return json2({ ok: true });
  }
  if (data.op === "scan_complete") {
    if (!owner || !await q2("SELECT 1 FROM scheduler_leases WHERE kind='search' AND owner=? AND expires>?", owner, now).first()) return json2({ ok: false, reason: "no_lease" });
    const stored = await runtime2(), zone = (await config()).schedule.timezone, today = dayAt(now, zone);
    const error = safeError(data.error);
    await updateRuntime({ ...stored, last_scan_attempt: now, ...!error ? { last_scan_success: now } : {}, last_scan_error: error, new_day: today, new_today: (stored.new_day === today ? number(stored.new_today) : 0) + number(data.new), queue_size: number(data.queue_size), last_scan_found: number(data.found), last_scan_added: number(data.added) });
    await env.DB.batch([q2("DELETE FROM scheduler_posts WHERE ts<?", now - 14 * 86400), q2("DELETE FROM scheduler_claims WHERE ts<?", now - 14 * 86400), q2("DELETE FROM scheduler_requests WHERE ts<?", now - 14 * 86400), q2("DELETE FROM scheduler_actions WHERE ts<?", now - 14 * 86400)]);
    return json2({ ok: true });
  }
  fail2(400, "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043E\u043F\u0435\u0440\u0430\u0446\u0438\u044F");
}
__name(schedulerRoute, "schedulerRoute");

// miniapp/cloudflare/cron_driver.mjs
var active = /* @__PURE__ */ new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
var workflows = { post: "post-once.yml", search: "scanner.yml" };
var formatters = /* @__PURE__ */ new Map();
function local(now, zone) {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
  const p = Object.fromEntries(formatters.get(zone).formatToParts(new Date(now * 1e3)).map((x) => [x.type, x.value]));
  return { weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday), clock: p.hour + ":" + p.minute };
}
__name(local, "local");
function dueJobs(row, now) {
  const s = validateSchedule(JSON.parse(row.data)), status2 = JSON.parse(row.status || "{}");
  const result = [], manualPost = Boolean(row.post_request), manualSearch = Boolean(row.search_request);
  const lastScan = Number(status2.last_scan_attempt || status2.last_scan_success || 0);
  const searchInterval = Number(status2.queue_size || 0) < s.min_queue ? 300 : s.search_interval_minutes * 60;
  if ((manualSearch || s.search_enabled && now >= lastScan + searchInterval) && !status2.scan_running) result.push("search");
  const lastPost = Number(status2.last_post || 0), wall = local(now, s.timezone);
  const quiet = s.quiet_enabled && (s.quiet_start < s.quiet_end ? s.quiet_start <= wall.clock && wall.clock < s.quiet_end : wall.clock >= s.quiet_start || wall.clock < s.quiet_end);
  const allowed = s.enabled && !s.paused && s.weekdays.includes(wall.weekday) && !quiet;
  const fresh = now - Number(status2.heartbeat || 0) < 180;
  const caps = fresh && (Number(status2.posts_hour || 0) >= s.max_posts_hour || Number(status2.posted_today || 0) >= s.max_posts_day);
  const gap = now >= lastPost + s.min_post_gap_minutes * 60;
  const sameRevision = Number(status2.revision) === Number(row.revision) && !status2.next_slot_stale;
  const next = Number(status2.next_post || 0);
  const automatic = sameRevision && next > 0 ? now >= next : s.mode === "times" ? s.post_times.includes(wall.clock) : now >= lastPost + Math.max(s.min_post_gap_minutes * 60, (s.post_interval_minutes - (s.natural_interval_enabled ? s.jitter_minutes : 0)) * 60);
  if (gap && !caps && !status2.post_running && (manualPost || allowed && automatic) && (manualPost || Number(status2.queue_size || 0) > 0)) result.push("post");
  return result;
}
__name(dueJobs, "dueJobs");
async function github(env, path, body, fetcher) {
  const response = await fetcher("https://api.github.com/repos/22savage22/wb-deals-bot" + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + env.GITHUB_DISPATCH_TOKEN, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "WB-Cloudflare-clock", "X-GitHub-Api-Version": "2022-11-28" },
    ...body ? { body: JSON.stringify(body) } : {},
    signal: AbortSignal.timeout(12e3)
  });
  if (!response.ok) throw new Error("GitHub HTTP " + response.status);
  return body ? {} : response.json();
}
__name(github, "github");
async function scheduledTick(env, scheduledTime = Date.now(), fetcher = fetch) {
  if (env.SCHEDULER_DRIVER !== "cloudflare") return { enabled: false };
  await ensureScheduler(env);
  const q2 = /* @__PURE__ */ __name((sql, ...args) => env.DB.prepare(sql).bind(...args), "q"), now = Math.floor(scheduledTime / 1e3);
  await q2("UPDATE scheduler_config SET status=json_set(status,'$.clock_heartbeat',?,'$.clock_driver','cloudflare') WHERE id=1", now).run();
  if (!env.GITHUB_DISPATCH_TOKEN) {
    await q2("UPDATE scheduler_config SET status=json_set(status,'$.clock_error','Missing GitHub dispatch secret') WHERE id=1").run();
    return { enabled: true, error: "missing_dispatch_secret" };
  }
  const row = await q2("SELECT * FROM scheduler_config WHERE id=1").first(), results = {};
  const [runtimeRow, lastPostRow, leases] = await Promise.all([
    q2("SELECT data FROM scheduler_runtime WHERE id=1").first(),
    q2("SELECT MAX(ts) AS last_post FROM scheduler_posts").first(),
    q2("SELECT kind FROM scheduler_leases WHERE kind IN ('post','search') AND expires>?", now).all()
  ]);
  const status2 = JSON.parse(row.status), runtime2 = JSON.parse(runtimeRow.data);
  const lastPost = Math.max(Number(status2.last_post || 0), Number(lastPostRow.last_post || 0));
  row.status = JSON.stringify({
    ...status2,
    ...Number(runtime2.last_scan_attempt || 0) > Number(status2.last_scan_attempt || 0) ? runtime2 : {},
    last_post: lastPost,
    next_slot_stale: lastPost !== Number(status2.last_post || 0),
    scan_running: leases.results.some((x) => x.kind === "search"),
    post_running: leases.results.some((x) => x.kind === "post")
  });
  for (const kind of dueJobs(row, now)) {
    const owner = crypto.randomUUID(), key = "clock_" + kind;
    const lock = await q2("INSERT INTO scheduler_leases(kind,owner,expires) VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE scheduler_leases.expires<=?", key, owner, now + 300, now).run();
    if (!lock.meta.changes) {
      results[kind] = "cooldown";
      continue;
    }
    try {
      const file = workflows[kind];
      const runs = await github(env, "/actions/workflows/" + file + "/runs?per_page=100", null, fetcher);
      if (!Array.isArray(runs.workflow_runs)) throw new Error("Invalid GitHub run response");
      if (runs.workflow_runs.some((r) => active.has(r.status))) {
        results[kind] = "already_running";
        continue;
      }
      await github(env, "/actions/workflows/" + file + "/dispatches", { ref: "main" }, fetcher);
      results[kind] = "accepted";
      await q2("UPDATE scheduler_config SET status=json_set(status,'$.clock_error','','$.last_" + kind + "_dispatch',?) WHERE id=1", now).run();
      console.log("CLOUDFLARE_DISPATCH", kind, "ACCEPTED");
    } catch (error) {
      const safe = /^GitHub HTTP \d{3}$/.test(error.message) ? error.message : "Dispatch temporarily unavailable";
      results[kind] = "error";
      await q2("UPDATE scheduler_config SET status=json_set(status,'$.clock_error',?) WHERE id=1", safe).run();
      if (/HTTP (401|403)/.test(safe)) await q2("UPDATE scheduler_leases SET expires=? WHERE kind=? AND owner=?", now + 21600, key, owner).run();
      console.log("CLOUDFLARE_DISPATCH", kind, safe);
    }
  }
  return { enabled: true, results };
}
__name(scheduledTick, "scheduledTick");

// miniapp/cloudflare/native_scheduler.mjs
var q = /* @__PURE__ */ __name((env, sql, ...args) => env.DB.prepare(sql).bind(...args), "q");
var sec = /* @__PURE__ */ __name(() => Math.floor(Date.now() / 1e3), "sec");
var topic = /* @__PURE__ */ __name((p) => String(p.query || p.category || p.cat || "").trim().toLowerCase(), "topic");
var titleKey = /* @__PURE__ */ __name((p) => String(p.title || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""), "titleKey");
var escape = /* @__PURE__ */ __name((s) => String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]), "escape");
var pattern = ["bags", "men", "women", "women", "neutral", "belts", "women", "men", "women", "women", "caps", "men", "women", "women", "neutral", "jewelry", "women", "men", "women", "women"];
var women = /женск|плать|юбк|блуз|сумк|космет|макияж|серьг|кольц|туфл|колгот|леггин|бюстг|купальник/;
var accessories = { bags: /сумк|рюкзак|клатч|кошел/, belts: /ремн|реме|пояс/, caps: /кепк|бейсбол|панам|шляп/, jewelry: /украшен|серьг|кольц|брасл|цепоч|ожерел|кулон|брош/ };
function groups(p) {
  const text2 = [p.title, p.query, p.category].join(" ").toLowerCase(), audience = text2.includes("\u0436\u0435\u043D\u0441\u043A") ? "women" : text2.includes("\u043C\u0443\u0436\u0441\u043A") ? "men" : women.test(text2) ? "women" : "neutral", accessory = Object.keys(accessories).find((k) => accessories[k].test(text2));
  return { audience, accessory };
}
__name(groups, "groups");
var formatters2 = /* @__PURE__ */ new Map();
function postingWindow(schedule, now = sec()) {
  const s = validateSchedule(schedule), key = s.timezone;
  if (!formatters2.has(key)) formatters2.set(key, new Intl.DateTimeFormat("en-GB", { timeZone: key, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
  const p = Object.fromEntries(formatters2.get(key).formatToParts(new Date(now * 1e3)).map((x) => [x.type, x.value]));
  const clock = p.hour + ":" + p.minute, weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday);
  const quiet = s.quiet_enabled && (s.quiet_start < s.quiet_end ? s.quiet_start <= clock && clock < s.quiet_end : clock >= s.quiet_start || clock < s.quiet_end);
  return { allowed: s.enabled && !s.paused && s.weekdays.includes(weekday) && !quiet, clock, date: p.year + "-" + p.month + "-" + p.day, timezone: key, quiet };
}
__name(postingWindow, "postingWindow");
function postDue(s, last, now) {
  if (!postingWindow(s, now).allowed || now < last + s.min_post_gap_minutes * 60) return false;
  if (s.mode === "times") {
    const wall = postingWindow(s, now).clock;
    const previous = postingWindow(s, last || now - 86400), current = postingWindow(s, now);
    return s.post_times.some((t) => t <= wall && (previous.date !== current.date || previous.clock < t));
  }
  const jitter = s.natural_interval_enabled ? (last % Math.max(1, 2 * s.jitter_minutes + 1) - s.jitter_minutes) * 60 : 0;
  return now >= last + Math.max(s.min_post_gap_minutes * 60, s.post_interval_minutes * 60 + jitter);
}
__name(postDue, "postDue");
function choose(rows, recent, total = 0) {
  const counts = /* @__PURE__ */ new Map();
  for (const p of recent) counts.set(p.topic, (counts.get(p.topic) || 0) + 1);
  const eligible = rows.filter((p) => (counts.get(p.topic) || 0) < 8 && !recent.some((r) => r.title_key === p.title_key));
  const target = pattern[total % pattern.length], fallback = { women: ["women", "neutral", "men"], men: ["men", "women", "neutral"], neutral: ["neutral", "women", "men"] }[target] || [target, "women", "neutral", "men"];
  for (const group of [...fallback, "any"]) {
    const matches = eligible.filter((row) => {
      const p = groups(JSON.parse(row.data));
      return group === "any" || (Object.hasOwn(accessories, group) ? p.accessory === group && p.audience === "women" : !p.accessory && p.audience === group);
    });
    if (matches.length) return matches.find((p) => p.topic !== recent.at(-1)?.topic) || matches[0];
  }
  return null;
}
__name(choose, "choose");
async function runtime(env, body) {
  const request = new Request("https://internal/api/scheduler/runtime", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await schedulerRoute(request, env, { payload: /* @__PURE__ */ __name((r) => r.json(), "payload"), json: Response.json, fail: /* @__PURE__ */ __name((status2, message) => {
    throw new Error("Scheduler validation " + status2);
  }, "fail") });
  return result.json();
}
__name(runtime, "runtime");
async function status(env, patch) {
  await q(env, "UPDATE scheduler_config SET status=json_patch(status,?) WHERE id=1", JSON.stringify(patch)).run();
}
__name(status, "status");
async function source(url, fetcher) {
  const r = await fetcher(url, { headers: { Accept: "application/json", "Accept-Language": "ru-RU,ru;q=0.9" }, redirect: "manual", signal: AbortSignal.timeout(1e4) });
  if (!r.ok) throw new Error("WB HTTP " + r.status);
  return r.json();
}
__name(source, "source");
var common = { appType: "1", curr: "rub", dest: "-1257786", spp: "30", lang: "ru" };
function wbURL(kind, params = {}) {
  const url = new URL(kind === "search" ? "https://search.wb.ru/exactmatch/ru/common/v9/search" : "https://card.wb.ru/cards/v4/detail");
  url.search = new URLSearchParams({ ...common, ...params }).toString();
  return url.href;
}
__name(wbURL, "wbURL");
function cardDeal(card, policy = {}) {
  const prices = (card?.sizes || []).map((s) => s.price).filter((p2) => p2?.product > 0 && p2?.basic >= p2.product);
  if (!card?.id || !card.name || !prices.length) return null;
  const stock = (card.sizes || []).filter((s) => s.qty != null);
  if (stock.length && !stock.some((s) => s.qty > 0)) return null;
  const best = prices.reduce((a, b) => a.product < b.product ? a : b), price = Math.floor(best.product / 100), rating = Number(card.reviewRating || card.rating || 0);
  const p = { id: Number(card.id), title: String(card.name).slice(0, 200), brand: String(card.brand || "").slice(0, 100), product: price, basic: price, discount: 0, selection_mode: "good_price", rating, feedbacks: Number(card.feedbacks || card.nmFeedbacks || 0), category: String(card.subjectName || card.subject || "\u0434\u0440\u0443\u0433\u043E\u0435") };
  const text2 = (p.title + " " + p.category).toLowerCase();
  if (price <= 0 || policy.max_price && price > policy.max_price || rating < Number(policy.min_rating ?? 4.3) || p.feedbacks < Number(policy.min_feedbacks ?? 20)) return null;
  if ((policy.blocked_words || []).some((w) => text2.includes(String(w).toLowerCase()))) return null;
  if ((policy.blacklist || []).some((w) => String(w) === String(p.id) || p.brand.toLowerCase().includes(String(w).toLowerCase()))) return null;
  return p;
}
__name(cardDeal, "cardDeal");
async function imageFor(env, p, fetcher) {
  const stored = await q(env, "SELECT data FROM products WHERE id=?", p.id).first();
  const known = safeImage(p.image) || safeImage(stored ? JSON.parse(stored.data).image : "");
  const urls = known ? [known] : [];
  const start = Math.max(1, Number(p.photo_probe || 1)), vol = Math.floor(p.id / 1e5), part = Math.floor(p.id / 1e3);
  for (let host = start; host < Math.min(start + 6, 51); host++) urls.push(`https://basket-${String(host).padStart(2, "0")}.wbbasket.ru/vol${vol}/part${part}/${p.id}/images/big/1.webp`);
  for (const url of urls) {
    try {
      const r = await fetcher(url, { signal: AbortSignal.timeout(3e3) });
      const okay = r.ok && r.headers.get("content-type")?.startsWith("image/");
      await r.body?.cancel();
      if (okay) return { image: url };
    } catch {
    }
  }
  return { image: "", photo_probe: start + 6 > 50 ? 1 : start + 6 };
}
__name(imageFor, "imageFor");
async function readState(env) {
  const [row, ready, recent] = await Promise.all([
    q(env, `SELECT c.*,(SELECT data FROM scheduler_policy WHERE id=1) AS policy,
      (SELECT MAX(ts) FROM scheduler_posts) AS last_post,
      (SELECT COUNT(*) FROM scheduler_inventory WHERE state='ready' AND expires>?) AS queue_size FROM scheduler_config c WHERE id=1`, sec()).first(),
    q(env, "SELECT * FROM scheduler_inventory WHERE state='ready' AND expires>? AND retry_at<=? ORDER BY queued_at,pid LIMIT 300", sec(), sec()).all(),
    q(env, "SELECT * FROM scheduler_deliveries WHERE ts>? ORDER BY ts", sec() - 86400).all()
  ]);
  return { row, s: validateSchedule(JSON.parse(row.data)), policy: JSON.parse(row.policy || "{}"), last: Number(row.last_post || 0), count: row.queue_size, ready: ready.results, recent: recent.results };
}
__name(readState, "readState");
async function bootstrap(env, data) {
  await ensureScheduler(env);
  if (!Array.isArray(data.queue) || data.queue.length > 300 || !data.policy || !Array.isArray(data.posts) || data.posts.length > 3e3) throw new Error("Invalid bootstrap");
  const raw = data.policy, policy = { chat_id: String(raw.chat_id || ""), queries: (raw.queries || []).filter((x) => typeof x === "string" && x.length <= 100).slice(0, 100), max_price: Number(raw.max_price || 0), min_rating: Number(raw.min_rating ?? 4.3), min_feedbacks: Number(raw.min_feedbacks ?? 20), blacklist: (raw.blacklist || []).map(String).slice(0, 200), blocked_words: (raw.blocked_words || []).map(String).slice(0, 200), disabled_topics: (raw.disabled_topics || []).map((x) => String(x).toLowerCase()).slice(0, 200), total_posts: Number(raw.total_posts || 0) };
  if (!/^(?:-?\d{5,20}|@[a-zA-Z0-9_]{5,})$/.test(policy.chat_id) || !policy.queries.length || !Number.isFinite(policy.max_price) || policy.max_price < 0) throw new Error("Invalid channel policy");
  const now = sec(), counts = /* @__PURE__ */ new Map(), queue = data.queue.filter((p) => {
    try {
      normalize(p);
    } catch {
      return false;
    }
    const t = topic(p);
    if ((counts.get(t) || 0) >= 8) return false;
    counts.set(t, (counts.get(t) || 0) + 1);
    return true;
  });
  const posts = data.posts.filter((p) => Number.isSafeInteger(p.pid) && p.pid > 0 && Number.isSafeInteger(p.ts) && p.ts > now - 14 * 86400 && p.ts <= now);
  await env.DB.batch([
    q(env, "INSERT OR REPLACE INTO scheduler_policy(id,data) VALUES(1,?)", JSON.stringify(policy)),
    q(env, "INSERT OR IGNORE INTO scheduler_posts(pid,ts) SELECT json_extract(value,'$.pid'),json_extract(value,'$.ts') FROM json_each(?)", JSON.stringify(posts)),
    q(env, `INSERT OR IGNORE INTO scheduler_inventory(pid,data,topic,title_key,queued_at,checked_at,expires)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.data'),json_extract(value,'$.topic'),json_extract(value,'$.title_key'),?,0,?
      FROM json_each(?) WHERE NOT EXISTS(SELECT 1 FROM scheduler_posts WHERE pid=json_extract(value,'$.id') AND ts>?)`, now, now + 72 * 3600, JSON.stringify(queue.map((p) => ({ id: p.id, data: JSON.stringify(p), topic: topic(p), title_key: titleKey(p) }))), now - 7 * 86400),
    q(env, `INSERT OR IGNORE INTO scheduler_deliveries(pid,ts,topic,title_key,data)
      SELECT json_extract(value,'$.pid'),json_extract(value,'$.ts'),json_extract(value,'$.topic'),json_extract(value,'$.title_key'),json_extract(value,'$.data') FROM json_each(?)`, JSON.stringify(posts.map((p) => ({ ...p, topic: topic(p), title_key: titleKey(p), data: JSON.stringify(p) }))))
  ]);
  await status(env, { bootstrap_at: now, native_configured: true });
  return { ok: true, queue_size: (await readState(env)).count };
}
__name(bootstrap, "bootstrap");
async function publish(env, state, fetcher) {
  const owner = crypto.randomUUID(), lock = await runtime(env, { op: "acquire", kind: "post", owner, ttl: 120 });
  if (!lock.ok) return { result: "lock_busy" };
  try {
    const latest = await q(env, "SELECT data,(SELECT MAX(ts) FROM scheduler_posts) AS last_post FROM scheduler_config WHERE id=1").first();
    let current = { ...state, s: validateSchedule(JSON.parse(latest.data)), last: Number(latest.last_post || 0), ready: [...state.ready] };
    if (!postDue(current.s, current.last, sec())) return { result: "not_due" };
    if (!env.TG_BOT_TOKEN || !current.policy.chat_id) throw new Error("Missing Telegram runtime secret");
    const manual = current.row.post_request;
    if (manual) await runtime(env, { op: "consume", kind: "post", owner, request_id: manual });
    for (let attempt = 0; attempt < 1; attempt++) {
      const item = choose(current.ready, current.recent, current.policy.total_posts + current.recent.length);
      if (!item) return { result: "no_eligible_product" };
      current.ready = current.ready.filter((p) => p.pid !== item.pid);
      const saved = JSON.parse(item.data), now = sec();
      let card, unavailable = false;
      await status(env, { last_post_attempt: now, selected_product: item.pid });
      try {
        const response = await source(wbURL("cards", { nm: String(item.pid) }), fetcher);
        card = (response.products || response.data?.products || []).find((p) => p.id === item.pid);
      } catch {
        unavailable = true;
        if (now - item.checked_at <= 6 * 3600 && saved.image) {
          card = null;
        } else {
          await q(env, "UPDATE scheduler_inventory SET retry_at=? WHERE pid=?", now + 300, item.pid).run();
          continue;
        }
      }
      let deal = card ? cardDeal(card, current.policy) : unavailable && now - item.checked_at <= 6 * 3600 ? saved : null;
      if (!deal || deal.product > saved.product * 1.1) {
        await q(env, "UPDATE scheduler_inventory SET state='rejected' WHERE pid=?", item.pid).run();
        continue;
      }
      deal = { ...deal, query: saved.query || "", image: saved.image || "", photo_probe: saved.photo_probe || 1 };
      const photo = await imageFor(env, deal, fetcher);
      deal = { ...deal, ...photo };
      if (!deal.image) {
        await q(env, "UPDATE scheduler_inventory SET data=?,retry_at=? WHERE pid=?", JSON.stringify(deal), now + 60, item.pid).run();
        continue;
      }
      await q(env, "UPDATE scheduler_inventory SET data=?,checked_at=? WHERE pid=?", JSON.stringify(deal), now, item.pid).run();
      const latest2 = await q(env, "SELECT data,(SELECT MAX(ts) FROM scheduler_posts) AS last_post FROM scheduler_config WHERE id=1").first();
      current.s = validateSchedule(JSON.parse(latest2.data));
      current.last = Number(latest2.last_post || 0);
      if (!postDue(current.s, current.last, sec())) return { result: "not_due" };
      const claim = await runtime(env, { op: "claim", owner, product_id: item.pid });
      if (!claim.ok) return { result: claim.reason };
      const caption = `\u2728 <b>${escape(deal.title)}</b>

\u{1F4B0} \u0421\u0435\u0439\u0447\u0430\u0441: <b>${deal.product} \u20BD</b>
\u2B50 ${deal.rating} \xB7 ${deal.feedbacks} \u043E\u0442\u0437\u044B\u0432\u043E\u0432
${escape(deal.brand)}

\u0426\u0435\u043D\u0430 \u043F\u0440\u043E\u0432\u0435\u0440\u0435\u043D\u0430 \u043F\u0435\u0440\u0435\u0434 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0435\u0439. \u041D\u0430 WB \u043E\u043D\u0430 \u043C\u043E\u0436\u0435\u0442 \u043C\u0435\u043D\u044F\u0442\u044C\u0441\u044F.`, url = `https://www.wildberries.ru/catalog/${deal.id}/detail.aspx`;
      const reply_markup = { inline_keyboard: [[{ text: "\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u043D\u0430 WB", url }], [{ text: "\u{1F44D} 0", callback_data: "l" + deal.id }, { text: "\u{1F44E} 0", callback_data: "d" + deal.id }], [{ text: "\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u{1F4CC}", url: `https://t.me/${env.MINIAPP_BOT_USERNAME || "WbPodborr_bot"}?start=save_${deal.id}` }]] };
      let result;
      try {
        const r = await fetcher(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendPhoto`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: current.policy.chat_id, photo: deal.image, caption, parse_mode: "HTML", reply_markup }), signal: AbortSignal.timeout(15e3) });
        result = await r.json();
      } catch {
        await runtime(env, { op: "complete", owner, product_id: item.pid, success: false });
        await q(env, "UPDATE scheduler_inventory SET state='uncertain' WHERE pid=?", item.pid).run();
        throw new Error("Telegram send outcome unknown; automatic duplicate retry suppressed");
      }
      if (!result.ok) {
        await runtime(env, { op: "complete", owner, product_id: item.pid, success: false });
        await q(env, "UPDATE scheduler_inventory SET retry_at=? WHERE pid=?", sec() + Math.max(300, Number(result.parameters?.retry_after || 0)), item.pid).run();
        throw new Error("Telegram rejected publication");
      }
      const message_id = result.result?.message_id;
      if (!Number.isInteger(message_id)) throw new Error("Telegram receipt missing");
      await runtime(env, { op: "complete", owner, product_id: item.pid, success: true });
      const sent = sec();
      await env.DB.batch([
        q(env, "UPDATE scheduler_inventory SET state='posted' WHERE pid=?", item.pid),
        q(env, "INSERT OR IGNORE INTO scheduler_deliveries(pid,ts,message_id,topic,title_key,data) VALUES(?,?,?,?,?,?)", item.pid, sent, message_id, item.topic, item.title_key, JSON.stringify(deal)),
        q(env, "INSERT INTO products(id,data,checked_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,checked_at=excluded.checked_at", deal.id, JSON.stringify(normalize({ ...deal, checked_at: sent })), sent)
      ]);
      await status(env, { last_post_success: sent, last_post: sent, last_message_id: message_id, last_error: "", error: "", next_post: sent + current.s.post_interval_minutes * 60 });
      console.log("SELECTED_PRODUCT", item.pid, "TELEGRAM_SEND SUCCESS message_id", message_id);
      return { result: "success", product_id: item.pid, message_id };
    }
    return { result: "invalid_candidates" };
  } finally {
    await runtime(env, { op: "release", kind: "post", owner });
  }
}
__name(publish, "publish");
async function search(env, state, fetcher) {
  if (!state.policy.queries?.length) return { result: "not_configured" };
  const owner = crypto.randomUUID();
  if (!(await runtime(env, { op: "acquire", kind: "search", owner, ttl: 90 })).ok) return { result: "lock_busy" };
  try {
    const now = sec(), old = JSON.parse(state.row.status || "{}"), cursor = Number(old.search_cursor || 0), queries = state.policy.queries;
    let offset = 0;
    while (offset < queries.length) {
      const t = queries[(cursor + offset) % queries.length].toLowerCase();
      if (!state.policy.disabled_topics?.includes(t) && state.recent.filter((r) => r.topic === t).length < 8) break;
      offset++;
    }
    await status(env, { last_scan_attempt: now, search_cursor: cursor + offset + 1 });
    if (offset === queries.length) return { result: "daily_topics_at_cap" };
    const query = queries[(cursor + offset) % queries.length];
    if (state.row.search_request) await runtime(env, { op: "consume", kind: "search", owner, request_id: state.row.search_request });
    let response;
    try {
      response = await source(wbURL("search", { query, page: String(1 + Math.floor(cursor / state.policy.queries.length) % 5), sort: cursor % 2 ? "popular" : "newly", resultset: "catalog" }), fetcher);
    } catch {
      response = await source(wbURL("search", { query, page: "1", sort: "popular", dest: "123585633", resultset: "catalog" }), fetcher);
    }
    const found = response.products || response.data?.products || [], counts = /* @__PURE__ */ new Map();
    const existing = (await q(env, "SELECT topic,COUNT(*) AS n FROM scheduler_inventory WHERE state='ready' AND expires>? GROUP BY topic", now).all()).results;
    for (const r of existing) counts.set(r.topic, r.n);
    const valid = [];
    for (const card of found) {
      const p = cardDeal(card, state.policy);
      if (!p) continue;
      p.query = query;
      const t = topic(p);
      if (state.policy.disabled_topics?.includes(t) || (counts.get(t) || 0) >= 8) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
      valid.push(p);
      if (valid.length >= 8) break;
    }
    const records = valid.map((p) => ({ id: p.id, data: JSON.stringify(p), topic: topic(p), title_key: titleKey(p) }));
    const inserted = await q(env, `INSERT OR IGNORE INTO scheduler_inventory(pid,data,topic,title_key,queued_at,checked_at,expires)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.data'),json_extract(value,'$.topic'),json_extract(value,'$.title_key'),?,0,? FROM json_each(?)
      WHERE NOT EXISTS(SELECT 1 FROM scheduler_posts WHERE pid=json_extract(value,'$.id'))
      AND NOT EXISTS(SELECT 1 FROM products WHERE id=json_extract(value,'$.id'))
      AND NOT EXISTS(SELECT 1 FROM scheduler_inventory WHERE title_key=json_extract(value,'$.title_key'))
      AND (SELECT COUNT(*) FROM scheduler_inventory WHERE state='ready' AND expires>?)<?`, now, now + 72 * 3600, JSON.stringify(records), now, state.s.min_queue).run();
    await status(env, { last_search_success: now, last_scan_success: now, last_scan_error: "", last_scan_found: found.length, last_scan_added: inserted.meta.changes, next_search: now + state.s.search_interval_minutes * 60 });
    console.log("SOURCE WB SEARCH_RESULTS", found.length, "VALID_PRODUCTS", valid.length, "ADDED_TO_QUEUE", inserted.meta.changes);
    return { result: "success", found: found.length, added: inserted.meta.changes };
  } finally {
    await runtime(env, { op: "release", kind: "search", owner });
  }
}
__name(search, "search");
async function nativeTick(env, scheduledTime = Date.now(), fetcher = fetch) {
  await ensureScheduler(env);
  const now = sec(), results = {};
  await status(env, { last_scheduler_tick: now, clock_heartbeat: now, heartbeat: now, clock_driver: "cloudflare-native", cron_active: true });
  try {
    await q(env, "DELETE FROM scheduler_leases WHERE expires<=?", now).run();
    await q(env, "UPDATE scheduler_inventory SET state='expired' WHERE state IN ('ready','cooldown') AND expires<=?", now).run();
    await q(env, "UPDATE scheduler_inventory SET state='ready' WHERE state='cooldown' AND retry_at<=? AND expires>?", now, now).run();
    await q(env, `UPDATE scheduler_inventory SET state='cooldown',retry_at=COALESCE((SELECT MIN(ts)+86401 FROM scheduler_deliveries d WHERE d.topic=scheduler_inventory.topic AND ts>?),?)
      WHERE state='ready' AND (SELECT COUNT(*) FROM scheduler_deliveries d WHERE d.topic=scheduler_inventory.topic AND ts>?)>=8`, now - 86400, now + 3600, now - 86400).run();
    let state = await readState(env), previous = JSON.parse(state.row.status || "{}"), wall = postingWindow(state.s, now);
    const overdue = wall.allowed && state.count > 0 && now - state.last > Math.max(1800, state.s.post_interval_minutes * 180);
    await status(env, { queue_size: state.count, posting_allowed: wall.allowed, current_local_time: wall.clock, active_timezone: wall.timezone, watchdog_overdue: overdue, native_credentials_ok: Boolean(env.TG_BOT_TOKEN && state.policy.chat_id) });
    if (postDue(state.s, state.last, now)) try {
      results.post = await publish(env, state, fetcher);
      if (["no_eligible_product", "invalid_candidates"].includes(results.post.result)) await status(env, { last_error: "\u041D\u0435\u0442 \u0433\u043E\u0442\u043E\u0432\u043E\u0433\u043E \u043F\u043E\u0434\u0445\u043E\u0434\u044F\u0449\u0435\u0433\u043E \u0442\u043E\u0432\u0430\u0440\u0430; \u043F\u043E\u0438\u0441\u043A \u043F\u043E\u043F\u043E\u043B\u043D\u044F\u0435\u0442 \u043E\u0447\u0435\u0440\u0435\u0434\u044C", error: "\u041D\u0435\u0442 \u0433\u043E\u0442\u043E\u0432\u043E\u0433\u043E \u043F\u043E\u0434\u0445\u043E\u0434\u044F\u0449\u0435\u0433\u043E \u0442\u043E\u0432\u0430\u0440\u0430; \u043F\u043E\u0438\u0441\u043A \u043F\u043E\u043F\u043E\u043B\u043D\u044F\u0435\u0442 \u043E\u0447\u0435\u0440\u0435\u0434\u044C" });
    } catch (error) {
      const safe = /^Missing Telegram/.test(error.message) ? "Missing Telegram runtime secret" : error.message.startsWith("Telegram send outcome") ? "Telegram delivery outcome unknown" : "Publication failed; next Cron will retry";
      await status(env, { last_error: safe, error: safe });
      results.post = { result: "error" };
    }
    state = await readState(env);
    const noEligible = !choose(state.ready, state.recent, state.policy.total_posts + state.recent.length), interval = state.count < state.s.min_queue || noEligible ? 60 : state.s.search_interval_minutes * 60;
    if (results.post?.result !== "success" && (state.row.search_request || state.s.search_enabled && now >= Number(previous.last_scan_attempt || 0) + interval)) try {
      results.search = await search(env, state, fetcher);
    } catch {
      await status(env, { last_scan_error: "WB search unavailable; ready queue retained" });
      results.search = { result: "error" };
    }
    const count = await q(env, "SELECT COUNT(*) AS n FROM scheduler_inventory WHERE state='ready' AND expires>?", sec()).first();
    await status(env, { queue_size: count.n, next_post: state.last + state.s.post_interval_minutes * 60, post_running: false, scan_running: false });
    console.log("SCHEDULER_TICK OK QUEUE_SIZE", count.n, JSON.stringify(results));
    return { enabled: true, results, queue_size: count.n };
  } catch {
    await status(env, { last_error: "Scheduler execution failed; next Cron continues", error: "Scheduler execution failed; next Cron continues" });
    return { enabled: true, error: "scheduler_error" };
  }
}
__name(nativeTick, "nativeTick");
async function checkAutopost(env, fetcher = fetch) {
  await ensureScheduler(env);
  const state = await readState(env), now = sec(), window = postingWindow(state.s, now), item = choose(state.ready, state.recent, state.policy.total_posts + state.recent.length), status2 = JSON.parse(state.row.status || "{}");
  const result = { ok: true, dry_run: true, telegram_posts_created: 0, cron: env.SCHEDULER_DRIVER === "cloudflare-native", last_scheduler_tick: status2.last_scheduler_tick || 0, heartbeat_stale: now - Number(status2.last_scheduler_tick || 0) > 180, queue_size: state.count, eligible_products: state.ready.filter((p) => state.recent.filter((r) => r.topic === p.topic).length < 8).length, next_product: item?.pid || null, posting_allowed: window.allowed, timezone: window.timezone, current_local_time: window.clock, quiet_hours: state.s.quiet_enabled ? state.s.quiet_start + "\u2013" + state.s.quiet_end : "OFF", telegram_configured: Boolean(env.TG_BOT_TOKEN && state.policy.chat_id), last_post: state.last, last_message_id: status2.last_message_id || null };
  if (result.telegram_configured) try {
    const r = await fetcher(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(5e3) });
    result.telegram_auth = (await r.json()).ok === true;
  } catch {
    result.telegram_auth = false;
  }
  if (item) try {
    const cards = await source(wbURL("cards", { nm: String(item.pid) }), fetcher);
    const card = (cards.products || cards.data?.products || []).find((c) => c.id === item.pid), deal = cardDeal(card, state.policy);
    result.live_card = Boolean(deal);
    if (deal) {
      result.title = deal.title;
      result.price = deal.product;
      result.url = `https://www.wildberries.ru/catalog/${deal.id}/detail.aspx`;
      result.image = (await imageFor(env, { ...deal, ...JSON.parse(item.data) }, fetcher)).image;
    }
  } catch {
    result.live_card = false;
  }
  result.ok = result.cron && !result.heartbeat_stale && result.telegram_configured && result.telegram_auth && result.queue_size > 0 && result.live_card && Boolean(result.image);
  return result;
}
__name(checkAutopost, "checkAutopost");

// miniapp/cloudflare/worker.mjs
var HttpError = class extends Error {
  static {
    __name(this, "HttpError");
  }
  constructor(status2, message) {
    super(message);
    this.status = status2;
  }
};
var fail = /* @__PURE__ */ __name((status2, message) => {
  throw new HttpError(status2, message);
}, "fail");
var json = /* @__PURE__ */ __name((data, status2 = 200) => Response.json(data, { status: status2 }), "json");
var second = /* @__PURE__ */ __name(() => Math.floor(Date.now() / 1e3), "second");
var product = /* @__PURE__ */ __name((row) => ({ ...JSON.parse(row.data), ...JSON.parse(row.overrides) }), "product");
var headers = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' https://*.wbbasket.ru; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org"
};
async function payload(request, max = 32768) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) fail(400, "\u041D\u0443\u0436\u0435\u043D JSON-\u043E\u0431\u044A\u0435\u043A\u0442");
  if (Number(request.headers.get("content-length") || 0) > max) fail(413, "\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0439 \u0437\u0430\u043F\u0440\u043E\u0441");
  const reader = request.body?.getReader();
  if (!reader) fail(400, "\u041D\u0443\u0436\u0435\u043D JSON-\u043E\u0431\u044A\u0435\u043A\u0442");
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > max) {
      await reader.cancel();
      fail(413, "\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0439 \u0437\u0430\u043F\u0440\u043E\u0441");
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    buffer.set(c, offset);
    offset += c.length;
  }
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) fail(400, "\u041D\u0443\u0436\u0435\u043D JSON-\u043E\u0431\u044A\u0435\u043A\u0442");
  return data;
}
__name(payload, "payload");
async function route(request, env, ctx) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (path === "/telegram/webhook" && method === "POST") {
    const secret = env.MINIAPP_WEBHOOK_SECRET || "";
    if (secret.length < 32 || !equal(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), secret)) fail(403, "\u041D\u0435\u0442 \u0434\u043E\u0441\u0442\u0443\u043F\u0430");
    const update = await payload(request), message = update.message;
    if (message?.chat?.type === "private" && integer(message.chat.id) && typeof message.text === "string") {
      const command = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+((?:save|look)_\d{1,12}))?\s*$/.exec(message.text);
      if (command) {
        const app = new URL("/", url.origin);
        if (command[1]) app.searchParams.set("tgWebAppStartParam", command[1]);
        const send = fetch(`https://api.telegram.org/bot${env.MINIAPP_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: message.chat.id, text: "\u0414\u043E\u0431\u0440\u043E \u043F\u043E\u0436\u0430\u043B\u043E\u0432\u0430\u0442\u044C \u0432 \xAB\u041D\u0430\u0445\u043E\u0434\u043A\u0438\xBB! \u0421\u043E\u0445\u0440\u0430\u043D\u044F\u0439\u0442\u0435 \u043F\u043E\u043D\u0440\u0430\u0432\u0438\u0432\u0448\u0438\u0435\u0441\u044F \u0432\u0435\u0449\u0438 \u0438 \u0441\u043E\u0431\u0438\u0440\u0430\u0439\u0442\u0435 \u043E\u0431\u0440\u0430\u0437\u044B \u0432 \u0441\u0432\u043E\u0451\u043C \u0431\u044E\u0434\u0436\u0435\u0442\u0435.", reply_markup: { inline_keyboard: [[{ text: "\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u043D\u0430\u0445\u043E\u0434\u043A\u0438 \u2728", web_app: { url: app.href } }]] } }) }).then((r) => {
          if (!r.ok) throw new Error("Telegram delivery failed");
        });
        ctx.waitUntil(send.catch(() => {
        }));
      }
    }
    return json({ ok: true });
  }
  if (!path.startsWith("/api/")) {
    if (!["GET", "HEAD"].includes(method)) fail(405, "\u041C\u0435\u0442\u043E\u0434 \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044F");
    if (!["/", "/index.html", "/static/app.js", "/static/app.css"].includes(path)) fail(404, "\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E");
    const assetURL = new URL(url);
    assetURL.pathname = path === "/" ? "/index.html" : path;
    return env.ASSETS.fetch(new Request(assetURL, request));
  }
  const prepare = /* @__PURE__ */ __name((sql, ...args) => env.DB.prepare(sql).bind(...args), "prepare");
  if (path.startsWith("/api/scheduler/")) {
    const key = env.MINIAPP_SYNC_KEY || "";
    if (key.length < 32 || !equal(request.headers.get("Authorization"), "Bearer " + key)) fail(403, "\u041D\u0435\u0442 \u0434\u043E\u0441\u0442\u0443\u043F\u0430");
    if (path === "/api/scheduler/bootstrap" && method === "POST") {
      try {
        return json(await bootstrap(env, await payload(request, 2 * 1024 * 1024)));
      } catch {
        fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 \u043F\u0435\u0440\u0435\u043D\u043E\u0441\u0430");
      }
    }
    if (path === "/api/scheduler/check" && method === "GET") return json(await checkAutopost(env));
    if (path === "/api/scheduler/tick" && method === "POST") {
      if (env.SCHEDULER_DRIVER !== "cloudflare-native") fail(409, "\u041F\u0440\u044F\u043C\u043E\u0439 scheduler \u0435\u0449\u0451 \u043D\u0435 \u0432\u043A\u043B\u044E\u0447\u0451\u043D");
      return json(await nativeTick(env));
    }
    return schedulerRoute(request, env, { payload, fail, json });
  }
  const all = /* @__PURE__ */ __name(async (sql, ...args) => (await prepare(sql, ...args).all()).results, "all");
  const catalog = /* @__PURE__ */ __name(async () => (await all("SELECT data,overrides FROM products ORDER BY checked_at DESC LIMIT 3000")).map(product), "catalog");
  let uid;
  if (!["/api/catalog", "/api/sync", "/api/health"].includes(path)) {
    try {
      uid = await telegramUser(request.headers.get("X-Telegram-Init-Data"), env.MINIAPP_BOT_TOKEN);
    } catch {
      fail(401, "\u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u0437\u0430\u043D\u043E\u0432\u043E \u0447\u0435\u0440\u0435\u0437 Telegram");
    }
    if (env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({ key: String(uid) })).success) fail(429, "\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u043D\u043E\u0433\u043E \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432. \u041F\u043E\u0434\u043E\u0436\u0434\u0438\u0442\u0435 \u043C\u0438\u043D\u0443\u0442\u0443.");
  }
  const admin = /* @__PURE__ */ __name(() => {
    if (!env.MINIAPP_ADMIN_ID || String(uid) !== String(env.MINIAPP_ADMIN_ID)) fail(403, "\u0414\u043E\u0441\u0442\u0443\u043F \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0443");
  }, "admin");
  if (path.startsWith("/api/admin/schedule")) {
    admin();
    if (path === "/api/admin/schedule/check" && method === "GET") return json(await checkAutopost(env));
    return schedulerRoute(request, env, { payload, fail, json, admin: true });
  }
  if (path === "/api/health" && method === "GET") {
    await prepare("SELECT 1").first();
    return json({ ok: true, configured: Boolean(env.MINIAPP_BOT_TOKEN && env.MINIAPP_SYNC_KEY?.length >= 32) });
  }
  if (path === "/api/catalog" && method === "GET") {
    const [products, meta] = await Promise.all([catalog(), prepare("SELECT value FROM metadata WHERE key='synced_at'").first()]);
    return json({ products: products.filter((p) => p.enabled !== false), slots: SLOTS, occasions: OCCASIONS, synced_at: Number(meta?.value || 0), bot_username: env.MINIAPP_BOT_USERNAME || "" });
  }
  if (path === "/api/sync" && method === "POST") {
    const key = env.MINIAPP_SYNC_KEY || "";
    if (key.length < 32 || !equal(request.headers.get("Authorization"), "Bearer " + key)) fail(403, "\u041D\u0435\u0442 \u0434\u043E\u0441\u0442\u0443\u043F\u0430");
    const data = await payload(request, 2 * 1024 * 1024);
    if (!Array.isArray(data.products) || data.products.length > 1e3) fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u043A\u0430\u0442\u0430\u043B\u043E\u0433");
    let cleaned;
    try {
      cleaned = data.products.map(normalize);
    } catch {
      fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0435 \u043F\u043E\u043B\u044F \u0442\u043E\u0432\u0430\u0440\u0430");
    }
    await env.DB.batch([
      prepare(`INSERT INTO products(id,data,checked_at)
        SELECT json_extract(value,'$.id'),value,json_extract(value,'$.checked_at') FROM json_each(?) WHERE true
        ON CONFLICT(id) DO UPDATE SET data=CASE WHEN json_extract(excluded.data,'$.image')=''
          THEN json_set(excluded.data,'$.image',COALESCE(json_extract(products.data,'$.image'),'')) ELSE excluded.data END,
        checked_at=excluded.checked_at WHERE excluded.checked_at>=products.checked_at AND
          products.data<>CASE WHEN json_extract(excluded.data,'$.image')=''
          THEN json_set(excluded.data,'$.image',COALESCE(json_extract(products.data,'$.image'),'')) ELSE excluded.data END`, JSON.stringify(cleaned)),
      prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('synced_at',?)", String(second()))
    ]);
    return json({ imported: cleaned.length });
  }
  if (path === "/api/me" && method === "GET") {
    const [pref, saved, rows, privateRows] = await Promise.all([
      prepare("SELECT data FROM preferences WHERE user_id=?", uid).first(),
      all("SELECT product_id,folder,owned FROM saved WHERE user_id=? ORDER BY created_at DESC", uid),
      all("SELECT id,data FROM outfits WHERE user_id=? ORDER BY id DESC LIMIT 50", uid),
      all(`SELECT data,overrides FROM products WHERE id IN (
        SELECT product_id FROM saved WHERE user_id=? UNION
        SELECT CAST(j.value AS INTEGER) FROM outfits o,json_each(o.data,'$.ids') j WHERE o.user_id=?)`, uid, uid)
    ]);
    return json({ saved, outfits: rows.map((r) => ({ id: r.id, ...JSON.parse(r.data) })), products: privateRows.map(product), preferences: pref ? JSON.parse(pref.data) : {}, plan: "free", is_admin: Boolean(env.MINIAPP_ADMIN_ID) && String(uid) === String(env.MINIAPP_ADMIN_ID) });
  }
  if (path === "/api/me" && method === "DELETE") {
    await env.DB.batch(["saved", "outfits", "preferences"].map((table) => prepare(`DELETE FROM ${table} WHERE user_id=?`, uid)));
    return json({ ok: true });
  }
  if (path === "/api/preferences" && method === "PUT") {
    const data = await payload(request), budget = data.budget ?? 5e3, occasion = data.occasion ?? "everyday";
    if (!integer(budget) || budget < 100 || budget > 1e5) fail(400, "\u0411\u044E\u0434\u0436\u0435\u0442: \u043E\u0442 100 \u0434\u043E 100 000 \u20BD");
    if (typeof occasion !== "string" || !Object.hasOwn(OCCASIONS, occasion)) fail(400, "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u043F\u043E\u0432\u043E\u0434");
    await prepare("INSERT OR REPLACE INTO preferences(user_id,data) VALUES (?,?)", uid, JSON.stringify({ budget, occasion })).run();
    return json({ ok: true });
  }
  let match;
  if ((match = /^\/api\/saved\/(\d+)$/.exec(path)) && ["PUT", "DELETE"].includes(method)) {
    const pid = Number(match[1]);
    if (!integer(pid)) fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0442\u043E\u0432\u0430\u0440");
    if (method === "DELETE") {
      await prepare("DELETE FROM saved WHERE user_id=? AND product_id=?", uid, pid).run();
      return json({ ok: true });
    }
    const data = await payload(request), folder = typeof (data.folder ?? "\u0421\u0435\u0431\u0435") === "string" ? (data.folder ?? "\u0421\u0435\u0431\u0435").trim() : "", owned = data.owned ?? false;
    if (!folder || folder.length > 40 || typeof owned !== "boolean") fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u0430\u044F \u043F\u0430\u043F\u043A\u0430 \u0438\u043B\u0438 \u043E\u0442\u043C\u0435\u0442\u043A\u0430 \u043F\u043E\u043A\u0443\u043F\u043A\u0438");
    if (!await prepare("SELECT 1 FROM products WHERE id=?", pid).first()) fail(404, "\u0422\u043E\u0432\u0430\u0440 \u043F\u043E\u043A\u0430 \u043D\u0435 \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D \u0432 \u043A\u0430\u0442\u0430\u043B\u043E\u0433");
    const result = await prepare(`INSERT INTO saved(user_id,product_id,folder,owned,created_at)
      SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM saved WHERE user_id=?)<1000
        OR EXISTS(SELECT 1 FROM saved WHERE user_id=? AND product_id=?)
      ON CONFLICT(user_id,product_id) DO UPDATE SET folder=excluded.folder,owned=excluded.owned`, uid, pid, folder, owned ? 1 : 0, second(), uid, uid, pid).run();
    if (!result.meta.changes) fail(400, "\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E 1000 \u0432\u0435\u0449\u0435\u0439. \u0423\u0434\u0430\u043B\u0438\u0442\u0435 \u043D\u0435\u043D\u0443\u0436\u043D\u044B\u0435, \u0447\u0442\u043E\u0431\u044B \u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u043D\u043E\u0432\u0443\u044E");
    return json({ ok: true });
  }
  if (path === "/api/outfits" && method === "POST") {
    const data = await payload(request), { anchor, budget } = data, excluded = data.exclude ?? [];
    if (!integer(anchor) || !integer(budget) || budget < 100 || budget > 1e5) fail(400, "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0432\u0435\u0449\u044C \u0438 \u0431\u044E\u0434\u0436\u0435\u0442 \u043E\u0442 100 \u0434\u043E 100 000 \u20BD");
    if (!Array.isArray(excluded) || excluded.length > 100 || !excluded.every(integer)) fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0441\u043F\u0438\u0441\u043E\u043A \u0437\u0430\u043C\u0435\u043D");
    const [products, owned] = await Promise.all([catalog(), all("SELECT product_id FROM saved WHERE user_id=? AND owned=1", uid)]);
    let outfits;
    try {
      outfits = build(products, anchor, budget, data.occasion ?? "everyday", owned.map((r) => r.product_id), excluded);
    } catch (e) {
      fail(400, e.message);
    }
    return json({ outfits, message: outfits.length ? "" : "\u041F\u043E\u043A\u0430 \u043C\u0430\u043B\u043E \u0441\u0432\u0435\u0436\u0438\u0445 \u0432\u0435\u0449\u0435\u0439 \u0434\u043B\u044F \u043F\u043E\u043B\u043D\u043E\u0433\u043E \u043E\u0431\u0440\u0430\u0437\u0430 \u0432 \u044D\u0442\u043E\u043C \u0431\u044E\u0434\u0436\u0435\u0442\u0435. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0434\u0440\u0443\u0433\u0443\u044E \u0432\u0435\u0449\u044C \u0438\u043B\u0438 \u0443\u0432\u0435\u043B\u0438\u0447\u044C\u0442\u0435 \u0431\u044E\u0434\u0436\u0435\u0442." });
  }
  if (path === "/api/outfits/saved" && method === "POST") {
    const data = await payload(request), ids = data.ids;
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 8 || !ids.every(integer) || new Set(ids).size !== ids.length) fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u043E\u0431\u0440\u0430\u0437");
    const count = await prepare("SELECT count(*) AS n FROM products WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)).first();
    if (count.n !== ids.length) fail(400, "\u0422\u043E\u0432\u0430\u0440 \u0431\u043E\u043B\u044C\u0448\u0435 \u043D\u0435 \u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D");
    const title = String(data.title ?? "\u041C\u043E\u0439 \u043E\u0431\u0440\u0430\u0437").trim().slice(0, 80) || "\u041C\u043E\u0439 \u043E\u0431\u0440\u0430\u0437";
    await env.DB.batch([
      prepare("INSERT INTO outfits(user_id,data,created_at) VALUES (?,?,?)", uid, JSON.stringify({ title, ids }), second()),
      prepare("DELETE FROM outfits WHERE user_id=? AND id NOT IN (SELECT id FROM outfits WHERE user_id=? ORDER BY id DESC LIMIT 50)", uid, uid)
    ]);
    return json({ ok: true });
  }
  if ((match = /^\/api\/outfits\/saved\/(\d+)$/.exec(path)) && method === "DELETE") {
    const id = Number(match[1]);
    if (!integer(id)) fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u043E\u0431\u0440\u0430\u0437");
    await prepare("DELETE FROM outfits WHERE id=? AND user_id=?", id, uid).run();
    return json({ ok: true });
  }
  if (path === "/api/admin/products" && method === "GET") {
    admin();
    return json({ products: await catalog() });
  }
  if ((match = /^\/api\/admin\/products\/(\d+)$/.exec(path)) && method === "PUT") {
    admin();
    const pid = Number(match[1]), data = await payload(request), { slot, audience } = data, enabled = data.enabled ?? true;
    if (!integer(pid) || typeof slot !== "string" || !Object.hasOwn(SLOTS, slot) || !["women", "men", "unknown"].includes(audience) || typeof enabled !== "boolean") fail(400, "\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u0442\u043E\u0432\u0430\u0440\u0430");
    const result = await prepare("UPDATE products SET overrides=? WHERE id=?", JSON.stringify({ slot, audience, enabled }), pid).run();
    if (!result.meta.changes) fail(404, "\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E");
    return json({ ok: true });
  }
  fail(404, "\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E");
}
__name(route, "route");
var worker_default = {
  async scheduled(controller, env) {
    return env.SCHEDULER_DRIVER === "cloudflare-native" ? nativeTick(env, controller.scheduledTime) : scheduledTick(env, controller.scheduledTime);
  },
  async fetch(request, env, ctx = { waitUntil: /* @__PURE__ */ __name(() => {
  }, "waitUntil") }) {
    let response;
    try {
      response = await route(request, env, ctx);
    } catch (error) {
      response = json({ error: error instanceof HttpError ? error.message : "\u0421\u0435\u0440\u0432\u0438\u0441 \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u043F\u043E\u0437\u0436\u0435." }, error instanceof HttpError ? error.status : 503);
    }
    const secured = new Response(response.body, response);
    for (const [key, value] of Object.entries(headers)) secured.headers.set(key, value);
    secured.headers.set("Cache-Control", new URL(request.url).pathname.startsWith("/api/") ? "no-store" : "no-cache");
    return secured;
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
