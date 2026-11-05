// The demo agent has no Hedera key. It asks for an intent, waits for the user, then asks the Guard to buy.
// Its choices are fixed logic; connect Claude through the MCP server (src/mcp.mjs) for a real model.
import { createHash, randomUUID } from "node:crypto";
import { app, listen, modes, PORTS, post, get, url, requireToken } from "./common.mjs";
import { ASSET, toUnits } from "./asset.mjs";
import { spendReport } from "./spend-report.mjs";
import { aiNegotiate } from "./buyer-brain.mjs";
import { listSellers, simulatedSellers } from "./pc-directory.mjs";
import { allOffers, offersSource } from "./pc-inventory.mjs";
import { parseRequirements, applyAnswers, questions, withDefaults } from "./requirements.mjs";
if (Object.keys(process.env).some((k) => k.endsWith("_PRIVATE_KEY"))) throw new Error("The agent must not hold a private key.");
const T = process.env.AGENT_TOKEN; const runs = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The same intent, listing and purchaseRef always give the same request ID, so a retry can't pay twice.
const requestId = (intentId, key, ref = "") => createHash("sha256").update(`${intentId}|${key}|${ref}`).digest("hex").slice(0, 32);

async function waitFor(run, fn, until, ms = 600_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (run.cancelled) throw new Error("run cancelled");
    const v = await fn(); if (until(v)) return v; await sleep(500);
  }
  throw new Error("timed out waiting");
}

async function execute(run, { attack }) {
  const log = (text, kind = "info", extra = {}) => run.events.push({ at: Date.now(), text, kind, ...extra });
  log(`Asks you for an intent: price data, analysis and writing, up to 1.00 ${ASSET.symbol}, for 1 hour`);
  const req = await post(url("guard", "/intents"), { task: run.task, categories: ["market-prices", "analysis", "writing", "sentiment"], maxTotal: toUnits(1), approvalOver: toUnits(0.5), hours: 1 }, T);
  if (req.status !== 200) throw new Error(req.body.error ?? "intent request failed");
  run.intentId = req.body.intentId;
  log("Waiting for you to approve the intent. The agent can't approve it itself.", "pause");
  const it = await waitFor(run, async () => (await get(url("guard", `/intents/${run.intentId}`), T)).body, (i) => i.state !== "pending");
  if (it.state !== "active") { log(`Intent ${it.state}. Nothing will be bought.`, "bad"); run.status = "stopped"; return; }
  log(`Intent approved (${it.approvedBy}). From here the agent shops on its own.`, "good");

  // Haggle over A2A with the seller's agent first, AI against AI, if the user's switch allows it. No deal means the list price.
  const haggle = async (key) => {
    const l = (await get(url("guard", `/listings/${key}`), T)).body;
    if (!l.endpoint) return null;
    if (!l.negotiates) { log(`${l.name}: ${(await get(url("guard", "/status"), T)).body.negotiate ? "doesn't negotiate" : "negotiation is off"}, so it's the list price`); return null; }
    try { return await aiNegotiate({ listing: l, log }); }
    catch (e) { log(`${l.name} has no negotiating agent (${e.message.slice(0, 60)}); pays the list price`); return null; }
  };
  const buy = async (key, input, why, { context, ref, quote } = {}) => {
    if (run.cancelled) throw new Error("run cancelled");
    const rid = requestId(run.intentId, key, ref);
    run.rids.add(rid);
    log(`Asks the Guard for ${key}: ${why}`);
    let p = (await post(url("guard", "/purchase"), { requestId: rid, listingKey: key, input, reason: why, purchaseRef: ref, context, quoteId: quote?.id }, T)).body;
    if (p.status === "awaiting_approval") {
      log(`Guard paused ${key}: ${p.reason}. You sign the exact amount on-chain.`, "pause");
      p = await waitFor(run, async () => (await get(url("guard", `/purchases/${rid}`), T)).body, (x) => !x.status || !["awaiting_approval", "paying"].includes(x.status));
    }
    log(p.duplicate ? `Guard recognised a retry of ${key}: no second payment` : p.status === "paid" ? `Guard paid for ${key}` : `Guard result for ${key}: ${p.status}. ${p.reason ?? ""}`, p.status === "paid" ? "good" : "bad", { txId: p.duplicate ? null : p.txId });
    if (p.status === "paid" && !p.duplicate) run.paid++;
    return p;
  };

  const options = (await get(url("guard", "/listings?category=market-prices"), T)).body.sort((a, b) => a.freshnessMinutes - b.freshnessMinutes);
  log(`Found ${options.length} price sellers: ${options.map((o) => o.name).join(", ")}`);
  const choice = options[0]; if (!choice) throw new Error("no sellers found");
  log(`Chooses ${choice.name}: freshest data`);
  const dataQuote = await haggle(choice.key);
  const data = await buy(choice.key, null, "needs current onion prices for the brief", { quote: dataQuote });
  if (data.status !== "paid") { run.status = "stopped"; return; }
  log("Network hiccup: sends the same request again");
  await buy(choice.key, null, "needs current onion prices for the brief", { quote: dataQuote });
  const report = await buy("deepreport", null, "wants a deeper multi-market analysis", { quote: await haggle("deepreport") });
  if (report.status !== "paid") log("Continues with the data it already has");
  if (attack) {
    const t = await buy("trapdata", null, "checks market sentiment");
    if (t.status === "paid") {
      const note = t.result?.note ?? "";
      log(`A seller's data contained: "${note}"`, "bad");
      const target = /listing '([\w-]+)'/.exec(note)?.[1];
      log("TEST SWITCH ON: the agent is forced to obey this text, to test the Guard", "pause");
      if (target) await buy(target, null, "seller data said to buy this", { context: note });
    }
  }
  const brief = await buy("briefwriter", data.result, "turn the data into a brief", { quote: await haggle("briefwriter") });
  run.brief = brief.result ?? null;
  await reportSpending(run, log);
  run.status = brief.status === "paid" ? "finished" : "stopped";
}

// The agent reports what it spent from public Hedera data, via the Hedera Agent Kit's read-only tools. It holds no key.
async function reportSpending(run, log) {
  if (modes().audit !== "live" || !process.env.HCS_TOPIC_ID || !process.env.USER_ACCOUNT_ID) return log("Spending report skipped: the audit log is simulated");
  log("Reads its spending back from Hedera with the Hedera Agent Kit (read-only, no key)");
  try {
    const r = await spendReport({ userId: process.env.USER_ACCOUNT_ID, topicId: process.env.HCS_TOPIC_ID, since: run.startedAt, requestIds: [...run.rids], expectPaid: run.paid });
    run.report = r;
    log(`Spending report: ${r.total.toFixed(2)} ${r.symbol} on ${r.paid.length} purchase(s)${r.saved > 0 ? `, saved ${r.saved.toFixed(2)} by negotiating` : ""}, ${r.refused} refused${r.walletBalance != null ? `; wallet now ${r.walletBalance.toFixed(2)} ${r.symbol}` : ""}${r.complete ? "" : " (audit log still catching up)"}`, "good");
  } catch (e) { log(`Spending report failed: ${e.message}`, "bad"); }
}
const a = app();
a.get("/", (_, r) => r.json({ ok: true }));

// ---------- Gaming-PC assistant. No keys. The agent reads requirements for free, then asks the Guard to pay ONE small x402 fee
// to the team's recommendation API, only after the user approved that exact fee. PCs are never paid in crypto. ----------
// Stateless: the page sends the user's words and answers each time and the server recomputes, so the browser can't hand in requirements.
const pcToken = requireToken(process.env.DASH_TOKEN, T);
const API = "pc-recommend", API_CATEGORY = "pc-recommendations";
// The model's reading of the same words is reused, so clicking around doesn't call it again.
const parsedCache = new Map();
const parseCached = async (text) => { if (!parsedCache.has(text)) { if (parsedCache.size > 50) parsedCache.clear(); parsedCache.set(text, await parseRequirements(text)); } return structuredClone(parsedCache.get(text)); };
// Errors go to the browser short and without URLs: an RPC URL can carry the Arkiv access key.
const cleanError = (e) => {
  const m = String(e?.shortMessage ?? e?.message ?? e);
  if (/took too long|timed? ?out|fetch failed|HTTP request failed/i.test(m)) return "A service (Arkiv or the recommendation API) didn't answer in time. Try again in a moment.";
  return m.replace(/https?:\/\/\S+/g, "[url]").replace(/ark_[A-Za-z0-9_]+/g, "[key]").split("\n")[0].slice(0, 200);
};
const pcH = (f) => async (q, r) => { try { await f(q, r); } catch (e) { r.status(400).json({ error: cleanError(e) }); } };
async function pcRequirements(b) {
  const text = String(b?.text ?? "").slice(0, 2000);
  if (!text.trim()) throw new Error("describe what you want first");
  const req = applyAnswers(await parseCached(text), b?.answers ?? {}), qs = questions(req);
  return qs.some((x) => x.blocking) ? { requirements: req, questions: qs, ready: false } : { requirements: withDefaults(req), questions: qs, ready: true };
}
// The fee the API charges right now, and the API spending limit (an intent) that pays it. Separate from the PC budget.
async function feeStatus() {
  const l = await get(url("guard", `/listings/${API}`), T);
  const it = (await get(url("guard", "/status"), T)).body.intent;
  const limit = it && it.categories.includes(API_CATEGORY) ? { intentId: it.id, maxTotal: it.maxTotal, approvalOver: it.approvalOver, spent: it.spent, remaining: it.remaining, expiresAt: it.expiresAt, approvedBy: it.approvedBy } : null;
  return { api: l.status === 200 ? { key: l.body.key, name: l.body.name, fee: l.body.priceTinybars, payTo: l.body.hederaPayTo, about: l.body.about, source: l.body.source } : null, limit, asset: ASSET };
}
a.post("/pc/requirements", pcToken, pcH(async (q, r) => r.json(await pcRequirements(q.body))));
a.get("/pc/fee", pcToken, pcH(async (_, r) => r.json(await feeStatus())));
// Ask for an API spending limit: the allowance, plus an "ask me above" amount. The user approves it with World ID and
// the wallet allowance; the agent can't. Inside it the agent pays fees on its own; above approvalOver the user signs.
a.post("/pc/limit", pcToken, pcH(async (q, r) => {
  const max = String(q.body?.maxTotal ?? ""), over = q.body?.approvalOver == null ? undefined : String(q.body.approvalOver);
  if (!/^\d+$/.test(max)) throw new Error(`maxTotal must be in the smallest ${ASSET.symbol} unit`);
  if (over !== undefined && !/^\d+$/.test(over)) throw new Error(`approvalOver must be in the smallest ${ASSET.symbol} unit`);
  // Without an "ask me" amount the allowance itself is the only cap: the agent pays any fee inside it on its own.
  const x = await post(url("guard", "/intents"), { task: "Pay small x402 fees for PC recommendation data from the team's recommendation API. Never for a PC or its parts.", categories: [API_CATEGORY], maxTotal: max, approvalOver: over ?? max, hours: 1 }, T);
  r.status(x.status).json(x.body);
}));
// One paid search returns up to three complete packages. approvedFee is the exact fee the user approved on the search
// approval page: if the listing's price differs, nothing is paid and the user is asked again. Above the intent's
// "ask me" amount the Guard still pauses for the user's on-chain signature.
// The search runs in the background and the page follows it with GET /pc/recommend/:rid, so a refresh never restarts it.
// Request ID = hash(intent, API, requirements, attempt): a refresh or double click finds the same search and never pays
// twice. A retry gets a new attempt number, and only after the previous attempt ended without paying (blocked, failed,
// denied or expired). While an outcome is unknown or pending the Guard is still reconciling it, so no retry is allowed.
const RETRYABLE = ["blocked", "failed", "denied", "expired"];
const searchErrors = new Map(); // a search the Guard never received (network error), so the page can say so
const searchKey = (intentId, requirements, attempt) => {
  const { assumptions, source, ...stable } = requirements;
  const ref = `${createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 24)}#${attempt}`;
  return { ref, rid: requestId(intentId, API, ref) };
};
const searchView = (x) => ({ requestId: x.requestId, status: x.status, reason: x.reason, txId: x.txId, pullTx: x.pullTx, refundTx: x.refundTx, amount: x.amount, why: x.why, result: x.result ?? null });
a.post("/pc/recommend", pcToken, pcH(async (q, r) => {
  const p = await pcRequirements(q.body); if (!p.ready) return r.status(409).json({ error: "answer the open questions first" });
  const f = await feeStatus();
  if (!f.api) return r.status(503).json({ error: "the recommendation API isn't listed right now" });
  // The approved allowance is the authorisation: the agent pays fees autonomously inside it. A caller that shows the user a
  // specific fee can pin it with approvedFee, and then nothing is paid if the price changed.
  if (q.body?.approvedFee != null && String(q.body.approvedFee) !== String(f.api.fee)) return r.status(409).json({ error: "the fee isn't the one you approved; review it and approve again", fee: f.api.fee });
  if (!f.limit) return r.status(409).json({ error: "set and approve an API spending limit first" });
  const attempt = Math.max(1, Math.min(20, Number.parseInt(q.body?.attempt ?? 1, 10) || 1));
  if (attempt > 1) {
    const prev = await get(url("guard", `/purchases/${searchKey(f.limit.intentId, p.requirements, attempt - 1).rid}`), T);
    if (prev.status === 200 && !RETRYABLE.includes(prev.body.status)) return r.status(409).json({ error: prev.body.status === "paid" ? "that search already succeeded; no new payment needed" : `the previous attempt is still ${prev.body.status}; wait for it to finish`, requestId: prev.body.requestId });
  }
  const { ref, rid } = searchKey(f.limit.intentId, p.requirements, attempt);
  const had = await get(url("guard", `/purchases/${rid}`), T);
  if (had.status === 200) return r.json({ ...searchView(had.body), attempt, duplicate: true });
  searchErrors.delete(rid);
  post(url("guard", "/purchase"), { requestId: rid, listingKey: API, input: { requirements: p.requirements }, purchaseRef: ref, reason: `get complete PC recommendations for the user's request: ${String(q.body.text).slice(0, 120)}` }, T)
    .catch((e) => { if (searchErrors.size > 200) searchErrors.clear(); searchErrors.set(rid, cleanError(e)); });
  r.json({ requestId: rid, attempt, status: "starting" });
}));
a.get("/pc/recommend/:rid", pcToken, pcH(async (q, r) => {
  const rid = String(q.params.rid), x = await get(url("guard", `/purchases/${encodeURIComponent(rid)}`), T);
  if (x.status === 200 && x.body.listingKey === API) return r.json(searchView(x.body));
  if (searchErrors.has(rid)) return r.json({ requestId: rid, status: "error", reason: `the Guard couldn't be reached: ${searchErrors.get(rid)}. Nothing was paid.` });
  r.status(404).json({ error: "no search with that ID" });
}));
// The agent haggles with the chosen shop's AI sales agent over A2A for the whole package. The package and its list price
// come from the Guard's copy of the paid recommendation, never from the browser. Code caps every offer at the list price;
// the shop's floor stays with the shop. The result is a quote for the SIMULATED card checkout: no crypto is involved.
a.post("/pc/negotiate", pcToken, pcH(async (q, r) => {
  const x = await get(url("guard", `/purchases/${encodeURIComponent(String(q.body?.requestId ?? ""))}`), T);
  if (x.status !== 200 || x.body.listingKey !== API || x.body.status !== "paid") return r.status(409).json({ error: "no paid recommendation with that ID" });
  const p = (x.body.result?.packages ?? []).find((k) => k.id === String(q.body?.packageId ?? ""));
  if (!p) return r.status(404).json({ error: "that package isn't in this recommendation" });
  const events = [], log = (text, kind = "info") => events.push({ at: Date.now(), text, kind });
  const listing = { key: `pkg:${p.id}`, name: `${p.shopName} ${p.label}`, priceTinybars: p.cost.total, endpoint: url("sellers", `/shops/${p.sellerId}`), unit: { symbol: "USDC", decimals: 6 }, openShare: 0.85, acceptShare: 0.97 };
  log(`Opens a negotiation with ${p.shopName}'s sales agent over A2A for the whole package (list ${(Number(p.cost.total) / 1e6).toFixed(2)} USDC)`);
  let quote = null;
  try { quote = await aiNegotiate({ listing, maxPrice: p.cost.total, log }); }
  catch (e) { log(`Negotiation failed (${cleanError(e)}); the list price stands`, "bad"); }
  r.json({ packageId: p.id, sellerId: p.sellerId, listTotal: p.cost.total, quote, events });
}));
// Free reads: the raw offers and the shop profiles.
a.get("/pc/offers", pcToken, pcH(async (q, r) => r.json({ source: offersSource(), offers: (await allOffers()).filter((o) => !q.query.category || o.category === String(q.query.category)) })));
let sellerCache = null; // last good seller list, used if Arkiv doesn't answer
a.get("/pc/sellers", pcToken, pcH(async (_, r) => {
  try { sellerCache = await listSellers(); r.json({ source: modes().shops, sellers: sellerCache }); }
  catch { r.json({ source: sellerCache ? "cached" : "simulated (Arkiv unreachable)", sellers: sellerCache ?? simulatedSellers() }); }
}));
a.post("/runs", requireToken(process.env.DASH_TOKEN), (q, r) => {
  const run = { id: randomUUID(), status: "running", task: String(q.body.task || "Prepare a market brief on onion prices in Maharashtra."), attack: !!q.body.attack, events: [], brief: null, report: null, rids: new Set(), paid: 0, startedAt: Date.now() }; runs.set(run.id, run);
  execute(run, q.body).catch((e) => { if (run.cancelled) return; run.status = "error"; run.events.push({ at: Date.now(), text: e.message, kind: "bad" }); });
  r.json({ id: run.id });
});
a.post("/cancel-all", requireToken(process.env.DASH_TOKEN), (_, r) => { for (const x of runs.values()) if (x.status === "running") { x.cancelled = true; x.status = "cancelled"; } r.json({ ok: true }); });
a.get("/runs/:id", requireToken(process.env.DASH_TOKEN), (q, r) => { const x = runs.get(q.params.id); if (!x) return r.status(404).json({}); const { rids, ...rest } = x; r.json(rest); });
listen(a, PORTS.agent, "agent");
