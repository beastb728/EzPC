// The Guard: the only process with the Guard account's key. It never holds the user's key.
// It pays small x402 fees to paid data services (the PC recommendation API, the market-data demo services) and nothing else:
// every fee runs the checks below before anything is signed or moved, and fails closed. PCs are never paid here.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";
import { app, listen, modes, NETWORK, PORTS, requireToken } from "./common.mjs";
import { getListing, search, APPROVED_OWNERS } from "./directory.mjs";
import { byKey } from "./catalog.mjs";
import { startDevice, pollDevice, worldIssuer } from "./world.mjs";
import { ledger } from "./ledger.mjs";
import { intentCheck } from "./intent-check.mjs";
import { ASSET, toUnits, fromUnits } from "./asset.mjs";
import { ordersRoutes } from "./orders.mjs";

mkdirSync("data", { recursive: true });
const db = new DatabaseSync(process.env.GUARD_DB || "data/guard-v2.db");
db.exec(`CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY, task TEXT, categories TEXT, max_total TEXT, max_per_purchase TEXT, approval_over TEXT, expires_at INTEGER, state TEXT, approved_by TEXT, allowance_tx TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS purchases(request_id TEXT PRIMARY KEY, intent_id TEXT, listing_key TEXT, purchase_ref TEXT, seller TEXT, amount TEXT, state TEXT, reason TEXT, why TEXT, score REAL, pull_tx TEXT, tx_id TEXT, refund_tx TEXT, result TEXT, fingerprint TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, kind TEXT, ref TEXT, fingerprint TEXT, schedule_id TEXT, state TEXT, expires_at INTEGER, login TEXT, verified INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, event TEXT, ref TEXT, detail TEXT, reference TEXT);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);`);
try { db.exec("ALTER TABLE purchases ADD COLUMN quote TEXT"); } catch {} // added for A2A quotes; older databases lack it
try { db.exec("ALTER TABLE intents ADD COLUMN report TEXT"); } catch {} // the agent's Agent Kit spending report

const m = modes();
const L = ledger(db, { live: m.payments === "live", audit: m.audit === "live" });
const APPROVAL_TTL = Number(process.env.APPROVAL_TTL_MS || 180000), INTENT_TTL = Number(process.env.INTENT_APPROVAL_TTL_MS || 600000);
// Hard cap for any intent, in the asset's smallest unit: 5 HBAR or 5 USDC unless set.
const HARD_CAP = BigInt(process.env.MAX_INTENT_UNITS || process.env.MAX_INTENT_TINYBARS || toUnits(5));
const SPENDING = "('paying','paid','unknown','awaiting_approval')";
// The largest single data-service fee the Guard will ever pay: 1 HBAR or 1 USDC unless set. API fees are cents;
// anything PC-sized is refused here whatever the intent allows.
const MAX_FEE = BigInt(process.env.MAX_FEE_UNITS || toUnits(1));

// Audit entries go to HCS in order, without making each purchase wait for consensus.
let chain = Promise.resolve();
function audit(event, ref, detail, extra = {}) {
  const id = db.prepare("INSERT INTO audit(at,event,ref,detail,reference) VALUES(?,?,?,?,'pending')").run(Date.now(), event, ref, String(detail ?? "")).lastInsertRowid;
  const message = JSON.stringify({ event, ref, detail: String(detail ?? "").slice(0, 300), ...extra }).slice(0, 1000);
  chain = chain.then(() => L.submitAudit(message)).then((r) => r, (e) => `audit-failed: ${e.message}`).then((r) => { db.prepare("UPDATE audit SET reference=? WHERE id=?").run(r, id); });
  return chain;
}

const one = (sql, ...a) => db.prepare(sql).get(...a);
const intent = (id) => one("SELECT * FROM intents WHERE id=?", id);
const setIntent = (id, state) => db.prepare("UPDATE intents SET state=? WHERE id=?").run(state, id);
const spent = (intentId, except = "") => BigInt(one(`SELECT COALESCE(SUM(CAST(amount AS INTEGER)),0) s FROM purchases WHERE intent_id=? AND request_id<>? AND state IN ${SPENDING}`, intentId, except).s);
function activeIntent() {
  const i = one("SELECT * FROM intents WHERE state='active' ORDER BY created_at DESC");
  if (i && i.expires_at <= Date.now()) { setIntent(i.id, "expired"); audit("intent_expired", i.id, "intent reached its end time"); return null; }
  return i ?? null;
}
const intentView = (i) => i && ({ id: i.id, task: i.task, categories: JSON.parse(i.categories), maxTotal: i.max_total, maxPerPurchase: i.max_per_purchase, approvalOver: i.approval_over, expiresAt: i.expires_at, state: i.state, approvedBy: i.approved_by, allowanceTx: i.allowance_tx, spent: String(spent(i.id)), remaining: String(BigInt(i.max_total) - spent(i.id)), createdAt: i.created_at, report: i.report ? JSON.parse(i.report) : null });

const row = (id) => one("SELECT * FROM purchases WHERE request_id=?", id);
const save = (id, f) => { const k = Object.keys(f); db.prepare(`UPDATE purchases SET ${k.map((x) => `${x}=?`).join(",")} WHERE request_id=?`).run(...k.map((x) => f[x]), id); };
const view = (p, extra = {}) => ({ requestId: p.request_id, intentId: p.intent_id, listingKey: p.listing_key, purchaseRef: p.purchase_ref, status: p.state, reason: p.reason, why: p.why, score: p.score, amount: p.amount, pullTx: p.pull_tx, txId: p.tx_id, refundTx: p.refund_tx, result: p.state === "paid" && p.result ? JSON.parse(p.result) : undefined, quote: p.quote ? JSON.parse(p.quote) : null, ...extra });
const finish = async (id, state, reason, extra = {}) => { save(id, { state, reason }); await audit(state, id, reason, extra); return view(row(id)); };
const fingerprint = (l, input, intentId) => createHash("sha256").update(JSON.stringify([intentId, l.key, l.priceTinybars, l.hederaPayTo, input ?? null])).digest("hex");

// Money that reached the Guard but didn't go to the seller goes straight back to the user.
async function refundAndFinish(id, state, reason) {
  const p = row(id);
  if (!p.pull_tx) return finish(id, state, reason);
  try { const t = await L.refund(p.amount, `refund ${id.slice(0, 8)}`); save(id, { refund_tx: t }); return finish(id, state, `${reason}. Refunded to the user.`, { refundTx: t }); }
  catch (e) { return finish(id, "unknown", `${reason}. Refund failed, needs checking: ${e.message}`); }
}

// The seller failed after we sent it a signed payment, so we can't tell yet whether it was paid. Mark it unknown (never retry),
// then ask Hedera once the payment can no longer run: not on-chain means the seller never got the money, so the user gets it back.
async function unsure(id, payload, why) {
  const out = await finish(id, "unknown", `${why}. Checking on Hedera whether the payment went through`);
  L.paymentSettled(payload?.payload?.transaction).then((s) => {
    if (s === "not_settled") return refundAndFinish(id, "failed", `${why}. Hedera shows the payment never went through`);
    if (s === "settled") return finish(id, "unknown", `${why}. Hedera shows the data service was paid but delivered nothing`);
  }).catch(() => {});
  return out;
}

async function retryNote(id, why) {
  await audit("payment_retry", id, `network error, retrying once with the same signed payment: ${String(why).slice(0, 120)}`);
  await new Promise((r) => setTimeout(r, 1500));
}

function checkTerms(q, l) {
  if (q.network !== NETWORK) return `wrong network ${q.network}`;
  if (q.asset !== ASSET.id) return `unexpected asset ${q.asset}, expected ${ASSET.symbol} (${ASSET.id})`;
  if (q.payTo !== l.hederaPayTo) return `data service asked to pay ${q.payTo}, but the listing says ${l.hederaPayTo}`;
  if (BigInt(q.amount) > BigInt(l.priceTinybars)) return `data service asked for ${q.amount} units, above the ${l.quoteId ? "negotiated" : "listed"} ${l.priceTinybars}`;
  return null;
}
function buyerClient(l) {
  const signer = createClientHederaSigner(L.guardId, L.guardKey, { network: NETWORK });
  // allowedAssets: HBAR is not an SDK default asset. The hook re-checks the exact terms right before signing.
  const client = new x402Client().setSpendControls({ allowedAssets: true }).register(NETWORK, new ExactHederaScheme(signer));
  client.onBeforePaymentCreation(async ({ selectedRequirements: q }) => { const bad = checkTerms(q, l); if (bad) return { abort: true, reason: bad }; });
  return new x402HTTPClient(client);
}
const send = (l, input, headers = {}) => fetch(l.endpoint, { method: "POST", headers: { "content-type": "application/json", ...(l.quoteId ? { "x-quote-id": l.quoteId } : {}), ...headers }, body: JSON.stringify(input ?? {}) });

// A price the agent negotiated over A2A, confirmed with the seller itself: the agent's word isn't enough.
async function checkQuote(l, quoteId) {
  let q;
  try { const r = await fetch(`${new URL(l.endpoint).origin}/quotes/${encodeURIComponent(quoteId)}`); q = r.ok ? await r.json() : null; }
  catch { return "the seller couldn't be reached to confirm it"; }
  if (!q) return "the seller doesn't know this quote";
  if (q.listing !== l.key) return `it's for ${q.listing}, not ${l.key}`;
  if (q.payTo !== l.hederaPayTo || q.asset !== ASSET.id) return "its account or asset doesn't match the listing";
  if (q.expiresAt <= Date.now()) return "it has expired";
  if (!/^\d+$/.test(String(q.price)) || BigInt(q.price) > BigInt(l.priceTinybars)) return "it's above the listed price";
  return q;
}
// From here on, the agreed price is the price: limits, the seller's 402 terms and the payment are all checked against it.
const withQuote = (l, q) => (q ? { ...l, priceTinybars: q.price, listPrice: l.priceTinybars, quoteId: q.id } : l);

// Reads the seller's 402 terms without paying, so a bad seller is refused before any money moves.
async function previewTerms(l, input) {
  let r; try { r = await send(l, input); } catch (e) { return `data service unreachable: ${e.message}`; }
  if (r.status !== 402) { const why = (await r.json().catch(() => ({}))).error; return why ? `the data service refused the request: ${String(why).slice(0, 200)}` : `expected a 402 payment request, got ${r.status}`; }
  try {
    const req = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((h) => r.headers.get(h), await r.json().catch(() => undefined));
    const q = req.accepts.find((x) => x.network === NETWORK) ?? req.accepts[0];
    return checkTerms(q, l);
  } catch (e) { return `unreadable payment terms: ${e.message}`; }
}

async function pay(id, l, input) {
  const http = buyerClient(l);
  let first; try { first = await send(l, input); } catch (e) { return refundAndFinish(id, "failed", `data service unreachable: ${e.message}`); }
  if (first.status !== 402) return refundAndFinish(id, "failed", `expected 402, got ${first.status}`);
  let payload;
  try { payload = await http.createPaymentPayload(http.getPaymentRequiredResponse((h) => first.headers.get(h), await first.clone().json().catch(() => undefined))); }
  catch (e) { return refundAndFinish(id, "blocked", `Refused before signing: ${e.message}`); }
  // A network blip (here, or between the seller and its x402 facilitator) gets ONE retry with the SAME signed payment:
  // Hedera rejects a repeated transaction ID, so the seller can't be paid twice. If the retry also fails we can't be sure
  // the first attempt didn't land, so the on-chain check decides whether to refund.
  const header = http.encodePaymentSignatureHeader(payload);
  const blip = (s) => /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|timed? ?out/i.test(String(s));
  let paid, b = "";
  for (let attempt = 1; ; attempt++) {
    try { paid = await send(l, input, header); }
    catch (e) {
      b = e.message;
      if (attempt === 1 && blip(b)) { await retryNote(id, b); continue; }
      return unsure(id, payload, `payment outcome unknown${attempt > 1 ? " after one retry" : ", not retrying"}: ${b}`);
    }
    if (paid.status === 200) break;
    b = (await paid.text()).slice(0, 160);
    if (attempt === 1 && paid.status === 402 && blip(b)) { await retryNote(id, b); continue; }
    if (attempt > 1) return unsure(id, payload, `the retry failed too, data service returned ${paid.status}: ${b}`);
    return paid.status === 402 ? refundAndFinish(id, "failed", `data service refused the payment: ${b}`) : unsure(id, payload, `data service returned ${paid.status}: ${b}`);
  }
  let tx = ""; try { tx = http.getPaymentSettleResponse((h) => paid.headers.get(h)).transaction ?? ""; } catch {}
  save(id, { tx_id: tx, result: JSON.stringify(await paid.json().catch(() => ({}))) });
  return finish(id, "paid", `paid ${l.name}`, { payTx: tx, pullTx: row(id).pull_tx, seller: l.hederaPayTo, asset: ASSET.id, units: l.priceTinybars, listUnits: l.listPrice ?? l.priceTinybars, quote: l.quoteId ?? null });
}

async function purchase(b) {
  const id = String(b.requestId), purchaseRef = String(b.purchaseRef ?? "").slice(0, 64);
  const existing = row(id); if (existing) return view(existing, { duplicate: true });
  const it = activeIntent();
  db.prepare("INSERT INTO purchases(request_id,intent_id,listing_key,purchase_ref,state,why,created_at) VALUES(?,?,?,?,'requested',?,?)").run(id, it?.id ?? null, String(b.listingKey), purchaseRef, String(b.reason ?? "").slice(0, 300), Date.now());
  audit("requested", id, `${b.listingKey}: ${String(b.reason ?? "").slice(0, 160)}`);
  // 1. Intent
  if (!it) return finish(id, "blocked", "no active intent; the user must approve one first");
  // 2. Listing from the directory
  let l = await getListing(b.listingKey);
  if (!l) return finish(id, "blocked", "listing not found");
  save(id, { seller: l.hederaPayTo, amount: l.priceTinybars });
  if (!APPROVED_OWNERS().includes(l.owner.toLowerCase())) return finish(id, "blocked", `data-service listing wallet ${l.owner} is not approved`);
  if (l.expiresAt <= Date.now()) return finish(id, "blocked", "listing has expired");
  // 2b. A negotiated quote replaces the list price, once the seller confirms it
  if (b.quoteId && !negotiateOn()) return finish(id, "blocked", "negotiation is turned off by the user: buy at the list price, without a quote");
  if (b.quoteId) {
    const q = await checkQuote(l, String(b.quoteId));
    if (typeof q === "string") return finish(id, "blocked", `quote refused: ${q}`);
    l = withQuote(l, q);
    save(id, { amount: l.priceTinybars, quote: JSON.stringify(q) });
    audit("quote_confirmed", id, `${l.name}: ${fromUnits(q.price)} instead of ${fromUnits(q.listPrice)} ${ASSET.symbol}, confirmed with the seller`, { quote: q.id });
  }
  // 3. Inside what the user approved
  const cats = JSON.parse(it.categories);
  if (!cats.includes(l.category)) return finish(id, "blocked", `outside the intent: ${l.category} isn't one of ${cats.join(", ")}`);
  if (one(`SELECT 1 FROM purchases WHERE intent_id=? AND listing_key=? AND purchase_ref=? AND request_id<>? AND state IN ${SPENDING}`, it.id, l.key, purchaseRef, id))
    return finish(id, "blocked", `already bought ${l.name} in this intent; a deliberate repeat needs a new purchaseRef`);
  const amt = BigInt(l.priceTinybars);
  if (amt > MAX_FEE) return finish(id, "blocked", `${fromUnits(amt)} ${ASSET.symbol} is above the ${fromUnits(MAX_FEE)} ${ASSET.symbol} cap for one data-service fee; the Guard only pays API fees, never goods`);
  if (amt > BigInt(it.max_per_purchase)) return finish(id, "blocked", "over the intent's per-purchase limit");
  if (spent(it.id, id) + amt > BigInt(it.max_total)) return finish(id, "blocked", "the intent's budget would be exceeded");
  // 4. Seller account and payment terms, before anything is signed
  const acct = await L.sellerCheck(l.hederaPayTo);
  if (!acct.ok) return finish(id, "blocked", `data-service account check failed: ${acct.detail}`);
  const bad = await previewTerms(l, b.input);
  if (bad) return finish(id, "blocked", `Refused before signing: ${bad}`);
  // 5. Does it serve the task?
  const c = await intentCheck({ task: it.task, listing: l, reason: b.reason, context: b.context });
  save(id, { score: c.score });
  if (c.score < 0.3) return finish(id, "blocked", `intent check refused it (score ${c.score.toFixed(2)}, ${c.by}): ${c.why}`);
  // 6. A human signs anything big or doubtful, on-chain
  if (amt > BigInt(it.approval_over) || c.score < 0.6) {
    const why = amt > BigInt(it.approval_over) ? "over the intent's approval limit" : `doubtful (score ${c.score.toFixed(2)}): ${c.why}`;
    let sid; try { sid = await L.schedule(amt, `approve ${l.key} ${id.slice(0, 8)}`, APPROVAL_TTL); }
    catch (e) { return finish(id, "failed", `couldn't create the on-chain approval: ${e.message}`); }
    const a = randomUUID();
    db.prepare("INSERT INTO approvals(id,kind,ref,fingerprint,schedule_id,state,expires_at,created_at) VALUES(?,'stepup',?,?,?,'pending',?,?)").run(a, id, fingerprint(l, b.input, it.id), sid, Date.now() + APPROVAL_TTL, Date.now());
    save(id, { state: "awaiting_approval", reason: why, result: JSON.stringify({ input: b.input ?? null }) });
    await audit("awaiting_approval", id, `${l.name}: ${why}`, { schedule: sid });
    return view(row(id), { approvalId: a, scheduleId: sid });
  }
  // 7. Pull exactly this price from the user's allowance, then pay
  save(id, { state: "paying", reason: "" });
  const p = await L.pull(amt, `${l.key} ${id.slice(0, 8)}`);
  if (!p.ok) return finish(id, "blocked", `Hedera refused the allowance pull (${p.error}); the user may have revoked it`);
  save(id, { pull_tx: p.txId });
  if (!(await L.fundsVisible(amt))) return refundAndFinish(id, "failed", "pulled funds didn't show on the Mirror Node in time");
  return pay(id, l, b.input);
}

async function createIntent(b) {
  const task = String(b.task ?? "").trim().slice(0, 300), cats = Array.isArray(b.categories) ? b.categories.map(String) : [];
  if (!task) throw new Error("task required");
  if (!cats.length || cats.length > 8 || cats.some((c) => !/^[a-z-]{2,30}$/.test(c))) throw new Error("categories: 1 to 8 lowercase names");
  if (!/^\d+$/.test(String(b.maxTotal))) throw new Error(`maxTotal must be in the smallest ${ASSET.symbol} unit`);
  const total = BigInt(b.maxTotal); if (total <= 0n || total > HARD_CAP) throw new Error(`maxTotal must be between 1 and ${HARD_CAP} units of ${ASSET.symbol}`);
  const per = b.maxPerPurchase && /^\d+$/.test(String(b.maxPerPurchase)) ? BigInt(b.maxPerPurchase) : total;
  const over = b.approvalOver && /^\d+$/.test(String(b.approvalOver)) ? BigInt(b.approvalOver) : (total / 2n);
  const hours = Number(b.hours ?? 1); if (!(hours > 0 && hours <= 24)) throw new Error("hours must be between 0 and 24");
  const id = randomUUID(), a = randomUUID();
  db.prepare("INSERT INTO intents(id,task,categories,max_total,max_per_purchase,approval_over,expires_at,state,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)").run(id, task, JSON.stringify(cats), String(total), String(per < total ? per : total), String(over), Date.now() + hours * 3600_000, Date.now());
  db.prepare("INSERT INTO approvals(id,kind,ref,state,expires_at,created_at) VALUES(?,'intent',?,'pending',?,?)").run(a, id, Date.now() + INTENT_TTL, Date.now());
  await audit("intent_requested", id, `${task.slice(0, 120)} | ${cats.join(",")} | up to ${fromUnits(total)} ${ASSET.symbol}`);
  return { intentId: id, approvalId: a, state: "pending" };
}

// Only what the user needs to approve on World; the device code itself stays in the Guard.
const worldView = (ap) => { if (!ap.login) return null; const w = JSON.parse(ap.login); return { userCode: w.userCode, verificationUri: w.verificationUri, verificationUriComplete: w.verificationUriComplete, expiresAt: w.expiresAt, error: w.error ?? null }; };
const approvalView = (ap) => {
  if (ap.kind === "intent") { const i = intent(ap.ref), c = covered(ap); return { ...ap, login: undefined, world: worldView(ap), intent: intentView(i), amount: i?.max_total, ...(c ? { verified: 1, worldSession: { verifiedAt: c.at, endsAt: c.at + SESSION_MS } } : {}) }; }
  const p = row(ap.ref), c = covered(ap);
  return { ...ap, login: undefined, world: worldView(ap), purchase: p && view(p), amount: p?.amount, listing_key: p?.listing_key, ...(c ? { verified: 1, worldSession: { verifiedAt: c.at, endsAt: c.at + SESSION_MS } } : {}) };
};

// The first World ID to approve becomes the account owner. Every later approval must come from that same World ID.
const setting = (k) => one("SELECT v FROM settings WHERE k=?", k)?.v ?? null;
// One World check covers later step-up approvals for a short while, like a bank app after a face scan.
// Intents always need a fresh check; a different World ID can never reach this, and revoke or reset ends it.
const SESSION_MS = Number(process.env.WORLD_SESSION_MINUTES ?? 15) * 60_000;
// The account's linked World ID for the World service in use (sandbox or production), stored per service. An owner
// saved before this was per service ("world_owner") still counts when it came from the same service.
const ownerKey = () => `world_owner:${worldIssuer()}`;
const worldOwner = () => setting(ownerKey()) ?? (setting("world_owner")?.startsWith(`${worldIssuer()}|`) ? setting("world_owner") : null);
const linkOwner = (who) => db.prepare("INSERT OR REPLACE INTO settings VALUES(?,?)").run(ownerKey(), who);
const worldSession = () => { const v = setting("world_session"); const x = v && JSON.parse(v); return x && x.who === worldOwner() && Date.now() - x.at < SESSION_MS ? x : null; };
// The user's negotiation switch. On: agents may haggle over A2A and buy with a quote. Off: list prices only.
const negotiateOn = () => setting("negotiate") !== "off";
const endWorldSession = () => db.prepare("DELETE FROM settings WHERE k='world_session'").run();
// A recent World check from the account owner (a login, or an earlier approval) covers step-ups and new intents for a while.
const covered = (ap) => !ap.verified ? worldSession() : null;
async function pollWorld(ap) {
  const w = JSON.parse(ap.login);
  if (Date.now() < w.nextPollAt) return;
  const r = await pollDevice(w).catch((e) => ({ state: "pending", error: e.message }));
  const keep = (extra) => db.prepare("UPDATE approvals SET login=? WHERE id=?").run(JSON.stringify({ ...w, ...extra }), ap.id);
  if (r.state === "pending") return keep({ interval: r.slowDown ? w.interval + 5 : w.interval, nextPollAt: Date.now() + (r.slowDown ? w.interval + 5 : w.interval) * 1000 });
  if (r.state !== "verified") { keep({ deviceCode: null, error: r.state === "failed" ? r.error : `World approval ${r.state}` }); return audit("world_failed", ap.ref, r.error ?? r.state); }
  const who = `${r.iss}|${r.sub}`, owner = worldOwner();
  if (owner && owner !== who) { keep({ deviceCode: null, error: "a different World ID approved; it must be the account owner" }); return audit("world_failed", ap.ref, "different World ID from the account owner"); }
  if (!owner) { linkOwner(who); await audit("world_linked", ap.ref, `account linked to World ID ${r.sub.slice(0, 10)}…`); }
  keep({ deviceCode: null, verifiedAt: Date.now(), acr: r.acr });
  db.prepare("UPDATE approvals SET verified=1 WHERE id=?").run(ap.id);
  db.prepare("INSERT OR REPLACE INTO settings VALUES('world_session',?)").run(JSON.stringify({ who, at: Date.now() }));
  await audit("world_verified", ap.ref, `fresh World ID approval${r.acr ? `, ${r.acr}` : ""}`);
}
const waitFor = async (f, ms) => { for (const end = Date.now() + ms; ;) { const v = await f(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 700)); } };

async function decide(ap, decision, walletTx, account) {
  const set = (s) => db.prepare("UPDATE approvals SET state=? WHERE id=?").run(s, ap.id);
  // The dashboard (the only holder of the DASH token) passes the Google account it verified; that authorises the approval.
  const google = account?.via === "google" && account.sub ? account : null;
  const approver = google ? `Google account ${google.email ?? google.sub} (verified by the dashboard)` : m.world === "live" ? "World ID (verified on the server)" : "SIMULATED approval";
  if (ap.kind === "intent") {
    const i = intent(ap.ref);
    if (Date.now() > ap.expires_at) { set("expired"); setIntent(i.id, "expired"); await audit("intent_expired", i.id, "approval expired"); return { status: 200, body: intentView(intent(i.id)) }; }
    if (decision !== "approve") { set("denied"); setIntent(i.id, "denied"); await audit("intent_denied", i.id, "user said no"); return { status: 200, body: intentView(intent(i.id)) }; }
    if (m.world === "live" && !ap.verified && !covered(ap) && !google) return { status: 403, body: { error: "World login is not verified" } };
    const onChain = await L.allowanceApproved(walletTx, i.max_total, ap.created_at);
    if (!onChain.ok) return { status: 409, body: { error: `allowance not confirmed on Hedera: ${onChain.why}` } };
    for (const old of db.prepare("SELECT id FROM intents WHERE state='active'").all()) { setIntent(old.id, "replaced"); await audit("intent_replaced", old.id, `replaced by ${i.id}`); }
    set("approved");
    db.prepare("UPDATE intents SET state='active', approved_by=?, allowance_tx=? WHERE id=?").run(approver, String(walletTx ?? ""), i.id);
    await audit("intent_approved", i.id, `${approver}; allowance set on-chain`, { allowanceTx: walletTx ?? null });
    return { status: 200, body: intentView(intent(i.id)) };
  }
  const id = ap.ref, p = row(id);
  if (Date.now() > ap.expires_at) { set("expired"); return { status: 200, body: await expireStepup(ap) }; }
  if (decision !== "approve") { set("denied"); await L.cancelSchedule(ap.schedule_id); return { status: 200, body: await finish(id, "denied", "human denied, no payment") }; }
  // A step-up is the agent asking to pay above the user's "ask me" amount: a human checkpoint. Only a World ID check
  // (for this approval, or the owner's recent World session) passes it; a Google account alone never does.
  const session = m.world === "live" && covered(ap);
  if (m.world === "live" && !ap.verified && !session) return { status: 403, body: { error: "verify with World ID first" } };
  const it = intent(p.intent_id), base = await getListing(p.listing_key), l = base && withQuote(base, p.quote ? JSON.parse(p.quote) : null), input = p.result ? JSON.parse(p.result).input : null;
  const changed = !l || fingerprint(l, input, it.id) !== ap.fingerprint || it.state !== "active";
  // The user's signature is what moves the money, so the Guard waits to see it executed on-chain.
  const state = await waitFor(async () => { const s = await L.scheduleState(ap.schedule_id); return s === "pending" ? null : s; }, L.live ? 12000 : 0) ?? "pending";
  if (state === "pending") return { status: 409, body: { error: "the user's wallet hasn't signed the on-chain approval yet" } };
  if (state !== "executed") { set("invalid"); return { status: 200, body: await finish(id, "blocked", `on-chain approval ${state}, no payment`) }; }
  save(id, { pull_tx: `schedule:${ap.schedule_id}`, result: null });
  if (changed) { set("invalid"); return { status: 200, body: await refundAndFinish(id, "blocked", "purchase or intent changed after approval") }; }
  set("approved"); save(id, { state: "paying" });
  if (!(await L.fundsVisible(p.amount))) return { status: 200, body: await refundAndFinish(id, "failed", "signed funds didn't show on the Mirror Node in time") };
  await audit("approved", id, `${session ? `World ID check from ${new Date(session.at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} (session)` : approver}; user signed schedule ${ap.schedule_id}`, { schedule: ap.schedule_id, walletTx: walletTx ?? null });
  return { status: 200, body: await pay(id, l, input) };
}
async function expireStepup(ap) {
  const s = await L.scheduleState(ap.schedule_id).catch(() => "unknown");
  if (s === "executed") { save(ap.ref, { pull_tx: `schedule:${ap.schedule_id}` }); return refundAndFinish(ap.ref, "expired", "approval expired after the user signed"); }
  await L.cancelSchedule(ap.schedule_id);
  return finish(ap.ref, "expired", "approval expired, no payment");
}

const a = app();
const AGENT = process.env.AGENT_TOKEN, DASH = process.env.DASH_TOKEN;
const h = (f) => async (q, r) => { try { await f(q, r); } catch (e) { r.status(400).json({ error: e.message }); } };
a.get("/", (_, r) => r.json({ ok: true }));
a.get("/status", requireToken(DASH, AGENT), h(async (_, r) => r.json({ modes: m, asset: ASSET, guardId: L.guardId, userId: L.userId, negotiate: negotiateOn(), topicId: process.env.HCS_TOPIC_ID ?? null, intent: intentView(activeIntent()), wallet: await L.wallet().catch((e) => ({ error: e.message })) })));
// needs and about come from the seller catalog: what to send, and what you really get.
const listingView = ({ key, name, category, priceTinybars, freshnessMinutes, hederaPayTo, endpoint, source }) => ({ key, name, category, priceTinybars, freshnessMinutes, hederaPayTo, endpoint, source, needs: byKey(key)?.needs ?? null, about: byKey(key)?.about ?? null, negotiates: !!byKey(key)?.floor && negotiateOn() });
a.get("/listings", requireToken(AGENT, DASH), h(async (q, r) => r.json((await search({ category: String(q.query.category ?? "") })).map(listingView))));
a.get("/listings/:key", requireToken(AGENT, DASH), h(async (q, r) => { const l = await getListing(q.params.key); l ? r.json(listingView(l)) : r.status(404).json({}); }));
a.post("/intents", requireToken(AGENT), h(async (q, r) => r.json(await createIntent(q.body))));
a.get("/intents", requireToken(AGENT, DASH), (_, r) => { activeIntent(); r.json(db.prepare("SELECT * FROM intents ORDER BY created_at DESC LIMIT 20").all().map(intentView)); });
// What was bought under an intent, for the agent's own spending report.
a.get("/intents/:id/purchases", requireToken(AGENT, DASH), (q, r) => r.json(db.prepare("SELECT * FROM purchases WHERE intent_id=? ORDER BY created_at").all(q.params.id).map((p) => view(p))));
// The agent files the report it read back from Hedera with the Agent Kit; the dashboard shows it. Logged on HCS too.
a.post("/intents/:id/report", requireToken(AGENT), h(async (q, r) => {
  const i = intent(q.params.id); if (!i) return r.status(404).json({});
  const rep = q.body ?? {};
  db.prepare("UPDATE intents SET report=? WHERE id=?").run(JSON.stringify(rep).slice(0, 20000), i.id);
  await audit("spending_report", i.id, `agent reports ${Number(rep.total ?? 0).toFixed(2)} ${ASSET.symbol} on ${rep.paid?.length ?? 0} purchase(s), saved ${Number(rep.saved ?? 0).toFixed(2)}, read with the Hedera Agent Kit`);
  r.json({ ok: true });
}));
a.get("/intents/:id", requireToken(AGENT, DASH), (q, r) => { activeIntent(); const i = intent(q.params.id); i ? r.json(intentView(i)) : r.status(404).json({}); });
a.post("/intents/:id/revoke", requireToken(DASH), h(async (q, r) => {
  const i = intent(q.params.id); if (!i) return r.status(404).json({});
  if (["active", "pending"].includes(i.state)) setIntent(i.id, "revoked");
  for (const ap of db.prepare("SELECT a.* FROM approvals a JOIN purchases p ON p.request_id=a.ref WHERE a.kind='stepup' AND a.state='pending' AND p.intent_id=?").all(i.id)) { db.prepare("UPDATE approvals SET state='invalid' WHERE id=?").run(ap.id); await expireStepup(ap); }
  endWorldSession();
  await audit("intent_revoked", i.id, "user revoked the intent and the allowance", { walletTx: q.body.walletTx ?? null });
  r.json(intentView(intent(i.id)));
}));
// Only the dashboard can flip the negotiation switch, and the change is audited.
a.post("/settings", requireToken(DASH), h(async (q, r) => {
  if (typeof q.body?.negotiate !== "boolean") return r.status(400).json({ error: "negotiate must be true or false" });
  db.prepare("INSERT OR REPLACE INTO settings VALUES('negotiate',?)").run(q.body.negotiate ? "on" : "off");
  await audit("setting_changed", "negotiate", q.body.negotiate ? "negotiation on: AI agents on both sides haggle over A2A" : "negotiation off: list prices only");
  r.json({ negotiate: negotiateOn() });
}));
// Each A2A offer and reply goes on the audit log, so the negotiation before a payment is public too.
a.post("/negotiation", requireToken(AGENT), h(async (q, r) => {
  const b = q.body, it = activeIntent();
  if (!it) return r.status(409).json({ error: "no active intent" });
  if (!negotiateOn()) return r.status(409).json({ error: "negotiation is turned off" });
  const n = (x) => (/^\d+$/.test(String(x ?? "")) ? String(x) : "-"), show = (x) => (/^\d+$/.test(String(x ?? "")) ? `${fromUnits(x)} ${ASSET.symbol}` : "-");
  const said = { counter: `countered ${show(b.price)}`, accept: `agreed at ${show(b.price)}`, reject: "said no" }[b.reply] ?? `replied ${String(b.reply).slice(0, 10)}`;
  await audit("a2a_offer", it.id, `${String(b.listingKey).slice(0, 40)}: ${b.type === "accept" ? "accepted" : "offered"} ${show(b.offer)}, seller ${said}${b.say ? `: "${String(b.say).replace(/[^\x20-\x7E]/g, " ").slice(0, 90)}"` : ""}`, { listing: String(b.listingKey).slice(0, 40), offer: n(b.offer), reply: String(b.reply).slice(0, 10), price: n(b.price), by: String(b.by ?? "agent").slice(0, 20) });
  r.json({ ok: true });
}));
a.post("/purchase", requireToken(AGENT, DASH), h(async (q, r) => {
  if (!q.body.requestId || !q.body.listingKey) return r.status(400).json({ error: "requestId and listingKey required" });
  r.json(await purchase(q.body));
}));
a.get("/purchases/:id", requireToken(AGENT, DASH), (q, r) => { const p = row(q.params.id); p ? r.json(view(p)) : r.status(404).json({}); });
a.get("/purchases", requireToken(DASH), (_, r) => r.json(db.prepare("SELECT * FROM purchases ORDER BY created_at DESC LIMIT 100").all().map((p) => view(p))));
a.get("/audit", requireToken(DASH), (_, r) => r.json(db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 100").all()));
// The audit entries for one request or order, oldest first: the PC app's search progress and receipts.
a.get("/audit/ref/:ref", requireToken(DASH), (q, r) => r.json(db.prepare("SELECT at,event,detail,reference FROM audit WHERE ref=? ORDER BY id LIMIT 100").all(q.params.ref)));
// Everything that happened under one intent, oldest first, whoever the agent was: the dashboard's scripted agent or Claude through MCP.
a.get("/activity", requireToken(DASH), (q, r) => r.json(db.prepare("SELECT * FROM audit WHERE ref=? OR ref IN (SELECT request_id FROM purchases WHERE intent_id=?) ORDER BY id LIMIT 300").all(String(q.query.intent ?? ""), String(q.query.intent ?? ""))));
a.get("/approvals", requireToken(DASH, AGENT), (_, r) => r.json(db.prepare("SELECT * FROM approvals WHERE state='pending' ORDER BY created_at").all().map(approvalView)));
a.get("/approvals/:id", requireToken(DASH), (q, r) => { const ap = one("SELECT * FROM approvals WHERE id=?", q.params.id); ap ? r.json(approvalView(ap)) : r.status(404).json({}); });
// Only the dashboard token reaches these, so the agent can't approve its own requests.
// Login with World ID (the PC app's "Log in"): a fresh World check from the account owner, which starts the World session.
// The first World ID to log in becomes the owner, as with approvals. Simulated without WORLD_CLIENT_ID.
const loginState = () => { const v = setting("login"); return v ? JSON.parse(v) : null; };
const saveLogin = (x) => db.prepare("INSERT OR REPLACE INTO settings VALUES('login',?)").run(JSON.stringify(x));
const loginView = () => {
  const s = m.world === "live" ? worldSession() : (setting("sim_login") ? { at: Number(setting("sim_login")) } : null), l = loginState();
  return { mode: m.world, loggedIn: !!s, verifiedAt: s?.at ?? null, endsAt: s ? s.at + SESSION_MS : null, who: worldOwner() ? `World ID …${worldOwner().split("|").pop().slice(-6)}` : null,
    world: l?.deviceCode ? { userCode: l.userCode, verificationUri: l.verificationUri, verificationUriComplete: l.verificationUriComplete, expiresAt: l.expiresAt } : null, error: l?.error ?? null };
};
async function pollLogin() {
  const l = loginState(); if (!l?.deviceCode || Date.now() < (l.nextPollAt ?? 0)) return;
  const r = await pollDevice(l).catch((e) => ({ state: "pending", error: e.message }));
  if (r.state === "pending") return saveLogin({ ...l, nextPollAt: Date.now() + (l.interval + (r.slowDown ? 5 : 0)) * 1000 });
  if (r.state !== "verified") { saveLogin({ ...l, deviceCode: null, error: r.state === "failed" ? r.error : `World login ${r.state}` }); return audit("world_failed", "login", r.error ?? r.state); }
  const who = `${r.iss}|${r.sub}`, owner = worldOwner();
  if (owner && owner !== who) { saveLogin({ ...l, deviceCode: null, error: "a different World ID; log in with the account owner's World ID" }); return audit("world_failed", "login", "different World ID from the account owner"); }
  if (!owner) { linkOwner(who); await audit("world_linked", "login", `account linked to World ID ${r.sub.slice(0, 10)}…`); }
  saveLogin({ deviceCode: null });
  db.prepare("INSERT OR REPLACE INTO settings VALUES('world_session',?)").run(JSON.stringify({ who, at: Date.now() }));
  await audit("world_verified", "login", `logged in with a fresh World ID check${r.acr ? `, ${r.acr}` : ""}`);
}
a.post("/login/world", requireToken(DASH), h(async (_, r) => {
  if (m.world !== "live") { db.prepare("INSERT OR REPLACE INTO settings VALUES('sim_login',?)").run(String(Date.now())); await audit("world_verified", "login", "SIMULATED login (World credentials aren't configured)"); return r.json(loginView()); }
  saveLogin(await startDevice()); await audit("world_requested", "login", "waiting for a World ID login");
  r.json(loginView());
}));
a.get("/login", requireToken(DASH), h(async (_, r) => { await pollLogin(); r.json(loginView()); }));
a.post("/logout", requireToken(DASH), h(async (_, r) => { endWorldSession(); db.exec("DELETE FROM settings WHERE k IN ('login','sim_login')"); r.json(loginView()); }));
a.post("/approvals/:id/world", requireToken(DASH), h(async (q, r) => {
  if (m.world !== "live") return r.status(400).json({ error: "World is simulated" });
  const ap = one("SELECT * FROM approvals WHERE id=?", q.params.id);
  if (!ap || ap.state !== "pending") return r.status(409).json({ error: "approval is not pending" });
  if (ap.verified) return r.status(409).json({ error: "already verified" });
  db.prepare("UPDATE approvals SET login=? WHERE id=?").run(JSON.stringify(await startDevice()), ap.id);
  await audit("world_requested", ap.ref, "waiting for a fresh World ID approval");
  r.json(approvalView(one("SELECT * FROM approvals WHERE id=?", ap.id)));
}));
a.post("/approvals/:id/decision", requireToken(DASH), h(async (q, r) => {
  const ap = one("SELECT * FROM approvals WHERE id=?", q.params.id);
  if (!ap || ap.state !== "pending") return r.status(409).json({ error: "approval is not pending" });
  const x = await decide(ap, q.body.decision, q.body.walletTx, q.body.account); r.status(x.status).json(x.body);
}));
// Stand-in for the user's wallet when there are no testnet keys. Disabled in live mode.
a.get("/sim/wallet", requireToken(DASH), (_, r) => L.live ? r.status(404).json({}) : r.json(L.sim.get()));
a.post("/sim/wallet/allowance", requireToken(DASH), (q, r) => L.live || !/^\d+$/.test(String(q.body.amount)) ? r.status(400).json({ error: "simulated wallet only, amount in the asset's smallest unit" }) : r.json({ txId: L.sim.setAllowance(q.body.amount) }));
a.post("/sim/wallet/sign/:id", requireToken(DASH), (q, r) => { if (L.live) return r.status(404).json({}); const t = L.sim.sign(q.params.id); t ? r.json({ txId: t }) : r.status(409).json({ error: "schedule not pending" }); });
// Unanswered approvals expire, so silence never pays. One pass at a time, so World is never polled twice at once.
let sweeping = false;
setInterval(async () => {
  if (sweeping) return; sweeping = true;
  try { await sweep(); } finally { sweeping = false; }
}, 1000).unref();
async function sweep() {
  for (const ap of db.prepare("SELECT * FROM approvals WHERE state='pending' AND expires_at<?").all(Date.now())) {
    db.prepare("UPDATE approvals SET state='expired' WHERE id=?").run(ap.id);
    if (ap.kind === "intent") { setIntent(ap.ref, "expired"); audit("intent_expired", ap.ref, "approval expired"); } else await expireStepup(ap);
  }
  if (m.world === "live") for (const ap of db.prepare("SELECT * FROM approvals WHERE state='pending' AND verified=0 AND login IS NOT NULL").all()) if (JSON.parse(ap.login).deviceCode) await pollWorld(ap).catch(() => {});
}
// Demo PC orders (simulated card checkout) and World-verified seller reviews. No payment code is reachable from these routes.
const orders = ordersRoutes(a, { db, audit, token: requireToken(DASH), worldLive: m.world === "live", setting, worldOwner, h, purchase: row });
// Reset keeps the linked World ID owner, like a real account would, unless forgetWorld is set (the PC app's Reset demo):
// then the next World ID to approve becomes the owner.
a.post("/reset", requireToken(DASH), (q, r) => { orders.reset(); if (q.body?.forgetWorld === true) { db.exec("DELETE FROM settings WHERE k='world_owner' OR k LIKE 'world_owner:%'"); audit("world_unlinked", "reset", "demo reset: the linked World ID was forgotten"); } db.exec("DELETE FROM purchases; DELETE FROM approvals; DELETE FROM audit; DELETE FROM intents; DELETE FROM sim_schedules; DELETE FROM settings WHERE k IN ('world_session','login','sim_login'); UPDATE sim_wallet SET allowance='0', balance='1000000000';"); r.json({ ok: true }); });
listen(a, PORTS.guard, "guard");
