// Demo PC orders and seller reviews, mounted on the Guard (it already holds the database, the HCS audit log,
// World ID and the Arkiv publisher wallet). Nothing in this file can move money: checkout is a SIMULATED card
// payment, no card details are collected, no payment processor is called and no real order is placed.
// Review rules, all enforced here before anything is published:
//   the order must exist, come from a paid recommendation, and be marked delivered (simulated);
//   a fresh World ID check (verified human) for this order, from the account's linked World ID if there is one;
//   at most one review per order, even under concurrent requests (the database's primary key decides).
// This state stays in the database after the Arkiv review expires, so an expired review can't be posted again.
import { createHash, randomUUID } from "node:crypto";
import { startDevice, pollDevice } from "./world.mjs";
import { publishReview, readReviews, summarise, clearSimReviews, REVIEW_DAYS, KIND } from "./reviews.mjs";
import { showUsdc } from "./pc-catalog.mjs";
import { url } from "./common.mjs";

const CHECK_MS = 10 * 60_000; // a World check for a review is good for 10 minutes
const CONTACT = /@|https?:\/\/|www\.|\d[\d\s-]{8,}\d/i; // reviews are public: no emails, links or phone numbers

export function ordersRoutes(a, { db, audit, token, worldLive, setting, h, purchase }) {
  db.exec(`CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, order_key TEXT UNIQUE, request_id TEXT, package_id TEXT, seller_id TEXT, shop_name TEXT, total TEXT, package TEXT, payment TEXT, state TEXT, created_at INTEGER, delivered_at INTEGER);
CREATE TABLE IF NOT EXISTS review_checks(order_id TEXT PRIMARY KEY, login TEXT, who TEXT, verified_at INTEGER, error TEXT);
CREATE TABLE IF NOT EXISTS reviews(order_id TEXT PRIMARY KEY, seller_id TEXT, reviewer TEXT, rating INTEGER, state TEXT, entity_key TEXT, expires_at INTEGER, created_at INTEGER);`);
  try { db.exec("ALTER TABLE orders ADD COLUMN list_total TEXT"); } catch {} // the price before negotiation
  const one = (sql, ...x) => db.prepare(sql).get(...x);
  const order = (id) => one("SELECT * FROM orders WHERE id=?", id);
  const orderView = (o) => o && ({ orderId: o.id, requestId: o.request_id, packageId: o.package_id, sellerId: o.seller_id, shopName: o.shop_name, total: o.total, listTotal: o.list_total ?? o.total, package: JSON.parse(o.package), payment: o.payment, state: o.state, createdAt: o.created_at, deliveredAt: o.delivered_at, demo: true });
  const check = (id) => one("SELECT * FROM review_checks WHERE order_id=?", id);
  const fresh = (c) => c?.verified_at && Date.now() - c.verified_at < CHECK_MS;
  const reviewView = (id) => {
    const c = check(id), r = one("SELECT * FROM reviews WHERE order_id=?", id), w = c?.login ? JSON.parse(c.login) : null;
    return { worldMode: worldLive ? "live" : "simulated", verified: !!fresh(c), verifiedAt: c?.verified_at ?? null, error: c?.error ?? null,
      world: w && !c.verified_at ? { userCode: w.userCode, verificationUri: w.verificationUri, verificationUriComplete: w.verificationUriComplete, expiresAt: w.expiresAt } : null,
      review: r && { rating: r.rating, state: r.state, entityKey: r.entity_key, expiresAt: r.expires_at, kind: KIND } };
  };
  async function pollCheck(id) {
    const c = check(id); if (!c?.login || c.verified_at) return;
    const w = JSON.parse(c.login); if (!w.deviceCode || Date.now() < (w.nextPollAt ?? 0)) return;
    const r = await pollDevice(w).catch((e) => ({ state: "pending", error: e.message }));
    const keep = (x, err = null) => db.prepare("UPDATE review_checks SET login=?, error=? WHERE order_id=?").run(JSON.stringify({ ...w, ...x }), err, id);
    if (r.state === "pending") return keep({ nextPollAt: Date.now() + (w.interval + (r.slowDown ? 5 : 0)) * 1000 });
    if (r.state !== "verified") return keep({ deviceCode: null }, r.state === "failed" ? r.error : `World check ${r.state}`);
    const who = `${r.iss}|${r.sub}`, owner = setting("world_owner");
    if (owner && owner !== who) return keep({ deviceCode: null }, "a different World ID verified; the review must come from the account that placed the order");
    db.prepare("UPDATE review_checks SET login=?, who=?, verified_at=?, error=NULL WHERE order_id=?").run(JSON.stringify({ ...w, deviceCode: null }), who, Date.now(), id);
    await audit("review_world_verified", id, `fresh World ID check: verified human, for a demo-order review${r.acr ? `, ${r.acr}` : ""}`);
  }

  // Simulated card checkout for one package from a PAID recommendation. The package comes from the Guard's own copy of
  // what the API returned, never from the browser. The same recommendation and package always give the same order.
  a.post("/orders", token, h(async (q, r) => {
    const rid = String(q.body?.requestId ?? ""), pid = String(q.body?.packageId ?? "");
    const p = purchase(rid);
    if (!p || p.listing_key !== "pc-recommend" || p.state !== "paid" || !p.result) return r.status(409).json({ error: "no paid recommendation with that ID" });
    const pkg = (JSON.parse(p.result).packages ?? []).find((x) => x.id === pid);
    if (!pkg) return r.status(404).json({ error: "that package isn't in this recommendation" });
    const key = `${rid}|${pid}`, had = one("SELECT * FROM orders WHERE order_key=?", key);
    if (had) return r.json({ ...orderView(had), duplicate: true });
    // A negotiated price counts only once the shop itself confirms the quote: the agent's or browser's word isn't enough.
    let total = BigInt(pkg.cost.total);
    if (q.body?.quoteId) {
      let qt = null; try { const x = await fetch(url("sellers", `/quotes/${encodeURIComponent(String(q.body.quoteId))}`)); qt = x.ok ? await x.json() : null; } catch {}
      if (!qt) return r.status(409).json({ error: "the shop doesn't know this quote" });
      if (qt.listing !== `pkg:${pid}`) return r.status(409).json({ error: "that quote is for a different package" });
      if (qt.expiresAt <= Date.now()) return r.status(409).json({ error: "the negotiated price has expired; negotiate again" });
      if (!/^\d+$/.test(String(qt.price)) || BigInt(qt.price) > total) return r.status(409).json({ error: "the quote is above the package price" });
      total = BigInt(qt.price);
    }
    const id = `DEMO-${randomUUID().slice(0, 8).toUpperCase()}`;
    const keep = { label: pkg.label, components: pkg.components.map((l) => `${l.brand} ${l.model}`), peripherals: pkg.peripherals.map((l) => `${l.brand} ${l.model}`), cost: pkg.cost };
    db.prepare("INSERT INTO orders(id,order_key,request_id,package_id,seller_id,shop_name,total,package,payment,state,created_at,list_total) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, key, rid, pid, pkg.sellerId, pkg.shopName, String(total), JSON.stringify(keep), "card (SIMULATED: no card collected, nothing charged)", "confirmed", Date.now(), String(pkg.cost.total));
    const deal = total < BigInt(pkg.cost.total) ? `${showUsdc(total)}, negotiated down from ${showUsdc(pkg.cost.total)}` : `${showUsdc(total)}`;
    await audit("demo_order", id, `SIMULATED card checkout: ${pkg.shopName} package, ${deal} display price. No crypto moved, no real order placed.`, { seller: pkg.sellerId });
    r.json(orderView(order(id)));
  }));
  a.get("/orders", token, (q, r) => r.json((q.query.requestId ? db.prepare("SELECT * FROM orders WHERE request_id=? ORDER BY created_at DESC").all(String(q.query.requestId)) : db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 50").all()).map(orderView)));
  a.get("/orders/:id", token, (q, r) => { const o = order(q.params.id); o ? r.json(orderView(o)) : r.status(404).json({}); });
  // Simulated fulfilment: stands in for the shop's delivery. Only a delivered order can be reviewed.
  a.post("/orders/:id/deliver", token, h(async (q, r) => {
    const o = order(q.params.id); if (!o) return r.status(404).json({});
    if (o.state !== "delivered") { db.prepare("UPDATE orders SET state='delivered', delivered_at=? WHERE id=?").run(Date.now(), o.id); await audit("demo_delivered", o.id, "SIMULATED delivery marked complete"); }
    r.json(orderView(order(o.id)));
  }));

  a.post("/orders/:id/review/world", token, h(async (q, r) => {
    const o = order(q.params.id); if (!o) return r.status(404).json({});
    if (o.state !== "delivered") return r.status(409).json({ error: "the order isn't delivered yet" });
    if (one("SELECT 1 FROM reviews WHERE order_id=?", o.id)) return r.status(409).json({ error: "this order already has a review" });
    if (!worldLive) {
      db.prepare("INSERT OR REPLACE INTO review_checks VALUES(?,NULL,?,?,NULL)").run(o.id, "simulated-human", Date.now());
      await audit("review_world_verified", o.id, "SIMULATED World check (World credentials aren't configured)");
    } else {
      db.prepare("INSERT OR REPLACE INTO review_checks VALUES(?,?,NULL,NULL,NULL)").run(o.id, JSON.stringify(await startDevice()));
      await audit("review_world_requested", o.id, "waiting for a fresh World ID check before a review");
    }
    r.json(reviewView(o.id));
  }));
  a.get("/orders/:id/review", token, h(async (q, r) => { if (!order(q.params.id)) return r.status(404).json({}); await pollCheck(q.params.id); r.json(reviewView(q.params.id)); }));
  a.post("/orders/:id/review", token, h(async (q, r) => {
    const o = order(q.params.id); if (!o) return r.status(404).json({});
    const rating = Number(q.body?.rating), text = String(q.body?.text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return r.status(400).json({ error: "rating must be a whole number from 1 to 5" });
    if (text.length < 3 || text.length > 280) return r.status(400).json({ error: "write 3 to 280 characters" });
    if (CONTACT.test(text)) return r.status(400).json({ error: "reviews are public: leave out emails, links and phone numbers" });
    if (o.state !== "delivered") return r.status(409).json({ error: "only a delivered order can be reviewed" });
    if (one("SELECT 1 FROM reviews WHERE order_id=?", o.id)) return r.status(409).json({ error: "this order already has a review" });
    const c = check(o.id);
    if (!fresh(c)) return r.status(403).json({ error: "verify with World first (a fresh check is needed for each review)" });
    // The primary key on order_id is the one-review-per-order rule. A second, concurrent request fails right here.
    try { db.prepare("INSERT INTO reviews VALUES(?,?,?,?,'publishing',NULL,NULL,?)").run(o.id, o.seller_id, createHash("sha256").update(c.who).digest("hex"), rating, Date.now()); }
    catch { return r.status(409).json({ error: "this order already has a review" }); }
    let out;
    try { out = await publishReview({ sellerId: o.seller_id, orderId: o.id, packageId: o.package_id, rating, text, human: worldLive ? "world-verified" : "simulated" }); }
    catch (e) { db.prepare("DELETE FROM reviews WHERE order_id=?").run(o.id); return r.status(502).json({ error: `couldn't publish to Arkiv, try again: ${String(e.shortMessage ?? e.message).split("\n")[0].replace(/https?:\/\/\S+/g, "[url]").slice(0, 120)}` }); }
    db.prepare("UPDATE reviews SET state='published', entity_key=?, expires_at=? WHERE order_id=?").run(out.entityKey, out.expiresAt, o.id);
    db.prepare("DELETE FROM review_checks WHERE order_id=?").run(o.id);
    await audit("review_published", o.id, `${KIND} review of ${o.seller_id}: ${rating}/5, ${out.source} entity ${String(out.entityKey).slice(0, 20)}, expires in ${REVIEW_DAYS} days`);
    r.json(reviewView(o.id));
  }));
  // Public reviews for one seller, and the rating worked out from the active ones right now.
  a.get("/reviews/:sellerId", token, h(async (q, r) => {
    const list = await readReviews(String(q.params.sellerId));
    r.json({ sellerId: q.params.sellerId, rating: summarise(list), reviews: list.map(({ rating, text, kind, human, createdAt, expiresAt, entityKey, source }) => ({ rating, text, kind, human, createdAt, expiresAt, entityKey, source })) });
  }));
  return { reset: () => { db.exec("DELETE FROM orders; DELETE FROM review_checks; DELETE FROM reviews;"); try { clearSimReviews(); } catch {} } };
}
