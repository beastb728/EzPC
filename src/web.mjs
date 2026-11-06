// Dashboard server. Service tokens and the demo wallet's key stay here and never reach the browser.
import express from "express";
import { app, get, listen, post, PORTS, url } from "./common.mjs";
import { userWallet, prepare } from "./user-wallet.mjs";
import { verify } from "./verify.mjs";
import { googleAuthRoutes, googleLive, sessionOf } from "./google-auth.mjs";
const T = process.env.DASH_TOKEN; const a = app(); a.get("/shop.html", (_, r) => r.redirect("/"));
// Google sign-in (account access). When it is configured, every /api route except the landing page's reads needs a session.
googleAuthRoutes(a);
// A verified Google account authorises allowance and fee approvals; World ID is kept for reviews. Without Google sign-in
// configured, approvals still need World ID when World is live, as before.
const account = (q) => { const s = googleLive ? sessionOf(q) : null; return s?.mode === "live" ? { via: "google", sub: s.sub, email: s.email } : null; };
// The PC app's pages are one HTML shell with a client-side router: each stage has its own URL, and a refresh on any of
// them loads the shell, which then restores state from the backend.
// The landing prompt (/), the build page (/build), orders, activity and audit. Old journey URLs go to the landing page.
a.get(["/", "/build", "/order", "/orders", "/activity", "/audit"], (_, r) => r.set("Cache-Control", "no-store").sendFile("index.html", { root: "public" }));
a.get(["/requirements", "/approve", "/search", "/results", "/checkout"], (_, r) => r.redirect("/"));
a.use(express.static("public"));
const wallet = userWallet(T);
const pass = (r, x) => r.status(x.status).json(x.body);
const h = (f) => async (q, r) => { try { await f(q, r); } catch (e) { r.status(400).json({ error: e.message }); } };
const hashpack = wallet.mode === "hashpack";
// With HashPack, the browser hands back the ID of the transaction the user signed; the Guard then checks it on Hedera.
const walletTxFrom = (q) => { const t = String(q.body?.walletTx ?? ""); if (!/^0\.0\.\d+@\d+\.\d+$/.test(t)) throw new Error("sign this in HashPack first"); return t; };
// What the page needs to talk to HashPack. The WalletConnect project ID is public by design; no key is ever sent.
a.get("/api/wallet", (_, r) => r.json({ mode: wallet.mode, userId: process.env.USER_ACCOUNT_ID ?? null, projectId: hashpack ? process.env.WALLETCONNECT_PROJECT_ID : null }));
// The unsigned transaction for HashPack: the allowance for an intent, the user's signature on a step-up's schedule, or a revoke.
a.post("/api/wallet/prepare", h(async (q, r) => {
  if (!hashpack) return r.status(400).json({ error: "HashPack mode is off" });
  if (q.body?.revoke) return r.json({ transaction: prepare.allowance(0) });
  const ap = await get(url("guard", `/approvals/${encodeURIComponent(String(q.body?.approvalId ?? ""))}`), T);
  if (ap.status !== 200 || ap.body.state !== "pending") return r.status(409).json({ error: "approval is not pending" });
  const s = (await get(url("guard", "/status"), T)).body;
  if (s.modes.world === "live" && !ap.body.verified && !account(q)) return r.status(403).json({ error: "verify with World first" });
  r.json({ transaction: ap.body.kind === "intent" ? prepare.allowance(ap.body.intent.maxTotal) : prepare.scheduleSign(ap.body.schedule_id) });
}));
a.get("/api/status", h(async (_, r) => pass(r, await get(url("guard", "/status"), T))));
a.get("/api/intents", h(async (_, r) => pass(r, await get(url("guard", "/intents"), T))));
a.get("/api/purchases", h(async (_, r) => pass(r, await get(url("guard", "/purchases"), T))));
a.get("/api/audit", h(async (_, r) => pass(r, await get(url("guard", "/audit"), T))));
a.get("/api/activity", h(async (q, r) => pass(r, await get(url("guard", `/activity?intent=${encodeURIComponent(String(q.query.intent ?? ""))}`), T))));
a.get("/api/approvals", h(async (_, r) => pass(r, await get(url("guard", "/approvals"), T))));
a.post("/api/approvals/:id/world", h(async (q, r) => pass(r, await post(url("guard", `/approvals/${q.params.id}/world`), {}, T))));
// Approving signs with the user's wallet first: an allowance for an intent, or the exact scheduled transfer for a step-up.
a.post("/api/approvals/:id/approve", h(async (q, r) => {
  const ap = await get(url("guard", `/approvals/${q.params.id}`), T);
  if (ap.status !== 200 || ap.body.state !== "pending") return r.status(409).json({ error: "approval is not pending" });
  const s = (await get(url("guard", "/status"), T)).body;
  if (s.modes.world === "live" && !ap.body.verified && !account(q)) return r.status(403).json({ error: "verify with World first" });
  const walletTx = hashpack ? walletTxFrom(q) : ap.body.kind === "intent" ? await wallet.setAllowance(ap.body.intent.maxTotal) : await wallet.signSchedule(ap.body.schedule_id);
  pass(r, await post(url("guard", `/approvals/${q.params.id}/decision`), { decision: "approve", walletTx, account: account(q) }, T));
}));
a.post("/api/approvals/:id/deny", h(async (q, r) => pass(r, await post(url("guard", `/approvals/${q.params.id}/decision`), { decision: "deny" }, T))));
// Stopping the agent never waits on the wallet: without a HashPack signature the intent still ends, and the allowance stays until revoked.
a.post("/api/intents/:id/revoke", h(async (q, r) => { const walletTx = hashpack ? (q.body?.walletTx ? walletTxFrom(q) : null) : await wallet.setAllowance(0); pass(r, await post(url("guard", `/intents/${q.params.id}/revoke`), { walletTx }, T)); }));
a.post("/api/settings", h(async (q, r) => pass(r, await post(url("guard", "/settings"), { negotiate: q.body?.negotiate }, T))));
a.get("/api/verify", h(async (_, r) => r.json(await verify())));
a.post("/api/runs", h(async (q, r) => pass(r, await post(url("agent", "/runs"), { task: String(q.body.task ?? "").slice(0, 300), attack: !!q.body.attack }, T))));
a.get("/api/runs/:id", h(async (q, r) => pass(r, await get(url("agent", `/runs/${q.params.id}`), T))));
// Gaming-PC assistant. The agent reads requirements and asks the Guard to pay the recommendation API's fee;
// orders (simulated card checkout) and reviews go to the Guard. The dashboard only relays, with its token.
const enc = encodeURIComponent;
a.post("/api/pc/requirements", h(async (q, r) => pass(r, await post(url("agent", "/pc/requirements"), q.body, T))));
a.get("/api/pc/fee", h(async (_, r) => pass(r, await get(url("agent", "/pc/fee"), T))));
a.post("/api/pc/limit", h(async (q, r) => pass(r, await post(url("agent", "/pc/limit"), { maxTotal: q.body?.maxTotal, approvalOver: q.body?.approvalOver }, T))));
a.post("/api/pc/recommend", h(async (q, r) => pass(r, await post(url("agent", "/pc/recommend"), q.body, T))));
a.get("/api/pc/recommend/:rid", h(async (q, r) => pass(r, await get(url("agent", `/pc/recommend/${enc(q.params.rid)}`), T))));
// A search's progress: the Guard's state for it, plus its audit entries (discovery, checks, payment, result).
a.get("/api/pc/search/:rid", h(async (q, r) => {
  const [s, ev] = await Promise.all([get(url("agent", `/pc/recommend/${enc(q.params.rid)}`), T), get(url("guard", `/audit/ref/${enc(q.params.rid)}`), T)]);
  r.status(s.status).json({ ...s.body, events: ev.status === 200 ? ev.body : [] });
}));
// Log in with World ID (the Guard runs the device flow and keeps the session).
a.get("/api/login", h(async (_, r) => pass(r, await get(url("guard", "/login"), T))));
a.post("/api/login/world", h(async (_, r) => pass(r, await post(url("guard", "/login/world"), {}, T))));
a.post("/api/logout", h(async (_, r) => pass(r, await post(url("guard", "/logout"), {}, T))));
// One request's or order's audit entries (the order page's "View audit trail").
a.get("/api/pc/audit/:ref", h(async (q, r) => pass(r, await get(url("guard", `/audit/ref/${enc(q.params.ref)}`), T))));
a.get("/api/pc/orders", h(async (q, r) => pass(r, await get(url("guard", `/orders?requestId=${enc(String(q.query.search ?? ""))}`), T))));
a.get("/api/pc/offers", h(async (q, r) => pass(r, await get(url("agent", `/pc/offers?category=${enc(String(q.query.category ?? ""))}`), T))));
a.get("/api/pc/sellers", h(async (_, r) => pass(r, await get(url("agent", "/pc/sellers"), T))));
// "Pay with card" is SIMULATED: the page sends no card details; only the recommendation, package and quote IDs are relayed.
a.post("/api/pc/negotiate", h(async (q, r) => pass(r, await post(url("agent", "/pc/negotiate"), { requestId: q.body?.requestId, packageId: q.body?.packageId }, T))));
a.post("/api/pc/checkout", h(async (q, r) => pass(r, await post(url("guard", "/orders"), { requestId: q.body?.requestId, packageId: q.body?.packageId, quoteId: q.body?.quoteId }, T))));
a.get("/api/pc/orders/:id", h(async (q, r) => pass(r, await get(url("guard", `/orders/${enc(q.params.id)}`), T))));
a.post("/api/pc/orders/:id/deliver", h(async (q, r) => pass(r, await post(url("guard", `/orders/${enc(q.params.id)}/deliver`), {}, T))));
a.post("/api/pc/orders/:id/review/world", h(async (q, r) => pass(r, await post(url("guard", `/orders/${enc(q.params.id)}/review/world`), {}, T))));
a.get("/api/pc/orders/:id/review", h(async (q, r) => pass(r, await get(url("guard", `/orders/${enc(q.params.id)}/review`), T))));
a.post("/api/pc/orders/:id/review", h(async (q, r) => pass(r, await post(url("guard", `/orders/${enc(q.params.id)}/review`), { rating: q.body?.rating, text: q.body?.text }, T))));
a.get("/api/pc/reviews/:sellerId", h(async (q, r) => pass(r, await get(url("guard", `/reviews/${enc(q.params.sellerId)}`), T))));
a.post("/api/reset", h(async (q, r) => { await post(url("agent", "/cancel-all"), {}, T); if (!hashpack) await wallet.setAllowance(0).catch(() => {}); pass(r, await post(url("guard", "/reset"), { forgetWorld: q.body?.forgetWorld === true }, T)); }));
listen(a, PORTS.web, "dashboard");
