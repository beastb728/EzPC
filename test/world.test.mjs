// World device flow against a local fake issuer that signs real ID tokens. Proves the Guard's checks, not World itself.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
const G = "http://127.0.0.1:4200", W = "http://127.0.0.1:4000", ISS = "http://127.0.0.1:4555", CLIENT = "test-client";
const AGENT = "agent-test", DASH = "dash-test"; const dir = mkdtempSync(join(tmpdir(), "alw-")); let kid, fake;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (p, b, t = AGENT, m = "POST") => { const r = await fetch(G + p, { method: m, headers: { "content-type": "application/json", "x-service-token": t }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
const web = async (p, b) => { const r = await fetch(W + p, { method: b === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
// What the fake World does next: "pending", or approve as a given subject, or deny. Also lets a test send a stale token.
const world = { next: "pending", sub: "human-1", stale: false, secretSeen: null, acr: "https://world.org/oidc/acr/orb" };
const { publicKey, privateKey } = await generateKeyPair("RS256"); const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };

before(async () => {
  fake = createServer(async (q, r) => {
    let body = ""; for await (const c of q) body += c; const f = new URLSearchParams(body);
    const json = (s, o) => { r.writeHead(s, { "content-type": "application/json" }); r.end(JSON.stringify(o)); };
    if (q.url === "/.well-known/openid-configuration") return json(200, { issuer: ISS, token_endpoint: `${ISS}/token`, device_authorization_endpoint: `${ISS}/device`, jwks_uri: `${ISS}/jwks` });
    if (q.url === "/jwks") return json(200, { keys: [jwk] });
    if (q.url === "/device") { world.secretSeen = f.get("client_secret"); return json(200, { device_code: `dc-${Date.now()}`, user_code: "ABCD-1234", verification_uri: "https://example.test/device", verification_uri_complete: "https://example.test/device?code=ABCD-1234", interval: 1, expires_in: 600 }); }
    if (q.url === "/token") {
      if (world.next === "pending") return json(400, { error: "authorization_pending" });
      if (world.next === "deny") return json(400, { error: "access_denied" });
      const now = Math.floor(Date.now() / 1000);
      const t = await new SignJWT({ auth_time: world.stale ? now - 3600 : now, acr: world.acr }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISS).setAudience(CLIENT).setSubject(world.sub).setIssuedAt().setExpirationTime("5m").sign(privateKey);
      return json(200, { id_token: t, access_token: "x", token_type: "Bearer" });
    }
    json(404, {});
  }).listen(4555);
  const e = { ...process.env, AGENT_TOKEN: AGENT, DASH_TOKEN: DASH, GUARD_DB: join(dir, "g.db"), SELLER_PACKAGES_FILE: join(dir, "seller-packages.json"), SELLER_QUOTES_FILE: join(dir, "seller-quotes.json"), WORLD_ISSUER: ISS, WORLD_CLIENT_ID: CLIENT, WORLD_CLIENT_SECRET: "worldidp_client_secret_test", WORLD_REQUIRED_ACR: "https://world.org/oidc/acr/orb", REVIEWS_FILE: join(dir, "reviews.json") };
  for (const k of Object.keys(e)) if (/_PRIVATE_KEY$|_ACCOUNT_ID$|^HCS_TOPIC_ID$|^LLM_BASE_URL$|^DATA_GOV_IN_API_KEY$|^PROTOTYPE_MODES$|^APPROVED_OWNERS$|^PAY_ASSET$|^SHOP_|^GOOGLE_|^SESSION_SECRET$/.test(k)) delete e[k];
  kid = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "start.mjs"], { env: e, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { await fetch(W + "/"); return; } catch { await sleep(200); } } throw new Error("stack did not start");
});
after(() => { kid.kill(); fake.close(); rmSync(dir, { recursive: true, force: true }); });

const newIntent = async () => (await call("/intents", { task: "onion brief", categories: ["market-prices", "analysis"], maxTotal: "100000000", approvalOver: "50000000" })).body;
async function verifyAs(approvalId, next, sub = "human-1", stale = false) {
  Object.assign(world, { next: "pending", sub, stale });
  const s = await web(`/api/approvals/${approvalId}/world`, {}); assert.equal(s.status, 200); assert.equal(s.body.world.userCode, "ABCD-1234"); assert.equal(s.body.world.deviceCode, undefined);
  await sleep(1500); world.next = next;
  for (let i = 0; i < 30; i++) { const ap = (await call(`/approvals/${approvalId}`, null, DASH, "GET")).body; if (ap.verified || ap.world?.error) return ap; await sleep(300); }
  throw new Error("World poll didn't finish");
}

test("W1 approving before World verifies is refused", async () => {
  const i = await newIntent(); assert.equal((await web(`/api/approvals/${i.approvalId}/approve`, {})).status, 403);
});
test("W2 a fresh World approval links the owner, then the intent can be approved", async () => {
  const i = await newIntent(); const ap = await verifyAs(i.approvalId, "approve");
  assert.equal(ap.verified, 1); assert.equal(world.secretSeen, "worldidp_client_secret_test");
  const d = await web(`/api/approvals/${i.approvalId}/approve`, {}); assert.equal(d.body.state, "active"); assert.match(d.body.approvedBy, /World ID/);
  const ev = (await call("/audit", null, DASH, "GET")).body.map((x) => x.event); assert.ok(ev.includes("world_linked")); assert.ok(ev.includes("world_verified"));
});
test("W3 a different World ID can't approve for the owner", async () => {
  await web("/api/logout", {}); // no World session, so only this check's outcome counts
  const i = await newIntent(); const ap = await verifyAs(i.approvalId, "approve", "someone-else");
  assert.equal(ap.verified, 0); assert.match(ap.world.error, /different World ID/); assert.equal((await web(`/api/approvals/${i.approvalId}/approve`, {})).status, 403);
});
test("W4 denied in World: nothing is approved", async () => {
  await web("/api/logout", {}); // no World session, so only this check's outcome counts
  const i = await newIntent(); const ap = await verifyAs(i.approvalId, "deny"); assert.equal(ap.verified, 0); assert.match(ap.world.error, /denied/);
});
test("W5 a stale authentication is rejected", async () => {
  await web("/api/logout", {}); // no World session, so only this check's outcome counts
  const i = await newIntent(); const ap = await verifyAs(i.approvalId, "approve", "human-1", true); assert.equal(ap.verified, 0); assert.match(ap.world.error, /not fresh/);
});
test("W6 the agent can't start or read World approvals' secrets", async () => {
  const i = await newIntent(); assert.equal((await call(`/approvals/${i.approvalId}/world`, {})).status, 401);
  const list = (await call("/approvals", null, AGENT, "GET")).body; assert.ok(list.every((a) => !a.login));
});
// One World check covers later purchase approvals for a while (WORLD_SESSION_MINUTES, 15 by default); intents always need a fresh one.
const stepup = async (ref) => { await call("/purchase", { requestId: `ws-${ref}-${Date.now()}`, listingKey: "deepreport", reason: "deeper analysis", purchaseRef: ref }); return (await call("/approvals", null, DASH, "GET")).body.find((a) => a.kind === "stepup"); };
test("W7 a recent World check covers a purchase approval: no new scan, and it can be signed", async () => {
  const i = await newIntent(); await verifyAs(i.approvalId, "approve"); assert.equal((await web(`/api/approvals/${i.approvalId}/approve`, {})).body.state, "active");
  const ap = await stepup("w7"); assert.ok(ap, "step-up created"); assert.equal(ap.verified, 1); assert.ok(ap.worldSession.endsAt > Date.now());
  const d = await web(`/api/approvals/${ap.id}/approve`, {}); assert.notEqual(d.status, 403);
  const ev = (await call("/audit", null, DASH, "GET")).body.find((x) => x.event === "approved"); assert.match(ev.detail, /session/);
});
test("W8 a recent World check from the owner (the session) also covers a new intent, so the user scans once", async () => {
  const i = await newIntent(); const ap = (await call(`/approvals/${i.approvalId}`, null, DASH, "GET")).body; assert.equal(ap.verified, 1); assert.ok(ap.worldSession);
  assert.notEqual((await web(`/api/approvals/${i.approvalId}/approve`, {})).status, 403);
});
test("W9 revoking ends the session: the next purchase approval needs World again", async () => {
  const i = await newIntent(); await verifyAs(i.approvalId, "approve"); await web(`/api/approvals/${i.approvalId}/approve`, {});
  const ap = await stepup("w9"); assert.equal(ap.verified, 1);
  await web(`/api/intents/${i.intentId}/revoke`, {});
  const after = (await call(`/approvals/${ap.id}`, null, DASH, "GET")).body; assert.ok(!after.verified && !after.worldSession);
});
test("W10 a seller review needs a fresh World check from the account's own World ID; the review is labelled world-verified", async () => {
  const text = "I want a gaming PC targeting GTA 6 at 60 FPS, a 4K monitor, and a total budget of 4,000 USDC.", answers = { render: "upscaled", region: "IN" };
  const lim = (await web("/api/pc/limit", { maxTotal: "20000000" })).body; await verifyAs(lim.approvalId, "approve");
  assert.equal((await web(`/api/approvals/${lim.approvalId}/approve`, {})).body.state, "active");
  const fee = (await web("/api/pc/fee")).body.api.fee, start = (await web("/api/pc/recommend", { text, answers, approvedFee: fee })).body;
  let rec; for (let i = 0; i < 100; i++) { rec = (await web(`/api/pc/recommend/${start.requestId}`)).body; if (rec.status === "paid" || ["blocked", "failed"].includes(rec.status)) break; await sleep(100); }
  assert.equal(rec.status, "paid", rec.reason);
  const o = (await web("/api/pc/checkout", { requestId: rec.requestId, packageId: rec.result.packages[0].id })).body; await web(`/api/pc/orders/${o.orderId}/deliver`, {});
  const check = async (sub) => {
    Object.assign(world, { next: "pending", sub, stale: false });
    const s = (await web(`/api/pc/orders/${o.orderId}/review/world`, {})).body; assert.equal(s.verified, false); assert.equal(s.world.userCode, "ABCD-1234");
    await sleep(300); world.next = "approve";
    for (let i = 0; i < 30; i++) { const v = (await web(`/api/pc/orders/${o.orderId}/review`)).body; if (v.verified || v.error) return v; await sleep(300); }
    throw new Error("review World check didn't finish");
  };
  assert.match((await check("someone-else")).error, /different World ID/);
  assert.equal((await web(`/api/pc/orders/${o.orderId}/review`, { rating: 3, text: "Okay overall" })).status, 403);
  assert.equal((await check("human-1")).verified, true);
  const ok = await web(`/api/pc/orders/${o.orderId}/review`, { rating: 3, text: "Okay overall" }); assert.equal(ok.status, 200);
  assert.equal((await web(`/api/pc/reviews/${o.sellerId}`)).body.reviews[0].human, "world-verified");
});
test("W11 a plain reset keeps the linked World ID; the app's Reset demo (forgetWorld) clears it, so a new World ID can link", async () => {
  await web("/api/reset", {});
  const a = await newIntent(); assert.match((await verifyAs(a.approvalId, "approve", "someone-new")).world.error, /different World ID/);
  await web("/api/reset", { forgetWorld: true });
  const b = await newIntent(); const ap = await verifyAs(b.approvalId, "approve", "someone-new"); assert.equal(ap.verified, 1);
  assert.ok((await call("/audit", null, DASH, "GET")).body.some((x) => x.event === "world_linked"));
});
test("W12 log in with World ID: the owner's login starts the session that covers the allowance; logging out ends it", async () => {
  await web("/api/reset", { forgetWorld: true });
  const before = await newIntent(); assert.equal((await web(`/api/approvals/${before.approvalId}/approve`, {})).status, 403, "no session yet");
  Object.assign(world, { next: "pending", sub: "human-9", stale: false });
  const l = (await web("/api/login/world", {})).body; assert.equal(l.loggedIn, false); assert.equal(l.world.userCode, "ABCD-1234");
  await sleep(300); world.next = "approve";
  let st; for (let i = 0; i < 30; i++) { st = (await web("/api/login")).body; if (st.loggedIn || st.error) break; await sleep(300); }
  assert.equal(st.loggedIn, true, st.error);
  const i = await newIntent(); assert.notEqual((await web(`/api/approvals/${i.approvalId}/approve`, {})).status, 403, "covered by the login");
  await web("/api/logout", {});
  const after = await newIntent(); assert.equal((await web(`/api/approvals/${after.approvalId}/approve`, {})).status, 403, "logged out: World needed again");
});
test("W13 a Google account the dashboard verified authorises an allowance without a World ID check", async () => {
  const i = await newIntent();
  const d = await call(`/approvals/${i.approvalId}/decision`, { decision: "approve", account: { via: "google", sub: "g-123", email: "buyer@example.com" } }, DASH);
  assert.equal(d.status, 200); assert.equal(d.body.state, "active"); assert.match(d.body.approvedBy, /Google account buyer@example.com/);
});
test("W14 only the dashboard can vouch for an account; without one, World ID is still required", async () => {
  const i = await newIntent();
  assert.equal((await call(`/approvals/${i.approvalId}/decision`, { decision: "approve", account: { via: "google", sub: "x" } }, AGENT)).status, 401);
  assert.equal((await call(`/approvals/${i.approvalId}/decision`, { decision: "approve" }, DASH)).status, 403);
  assert.equal((await call(`/approvals/${i.approvalId}/decision`, { decision: "approve", account: { via: "email", sub: "x" } }, DASH)).status, 403);
});
test("W15 a step-up (a fee above the 'ask me' amount) needs World ID even when a Google account approved the allowance", async () => {
  await call("/reset", { forgetWorld: true }, DASH); // a clean start: no World session, no linked owner left by earlier tests
  const GOOGLE = { via: "google", sub: "g-123", email: "buyer@example.com" };
  const i = await newIntent();
  assert.equal((await call(`/approvals/${i.approvalId}/decision`, { decision: "approve", account: GOOGLE }, DASH)).body.state, "active", "Google approves the allowance");
  const ap = await stepup("w15"); assert.ok(ap, "step-up created"); assert.ok(!ap.verified, "no World session covers it");
  const refused = await call(`/approvals/${ap.id}/decision`, { decision: "approve", account: GOOGLE }, DASH);
  assert.equal(refused.status, 403); assert.match(refused.body.error, /World ID/);
  assert.equal((await web(`/api/approvals/${ap.id}/approve`, {})).status, 403, "the web route refuses it too");
  const v = await verifyAs(ap.id, "approve"); assert.equal(v.verified, 1, JSON.stringify(v.world));
  assert.notEqual((await call(`/approvals/${ap.id}/decision`, { decision: "approve", account: GOOGLE }, DASH)).status, 403, "after World ID, the user can sign it");
});
test("W16 with WORLD_REQUIRED_ACR set, a World ID at a lower verification level is refused; Orb level passes", async () => {
  await call("/reset", { forgetWorld: true }, DASH);
  const i = await newIntent();
  world.acr = "https://world.org/oidc/acr/selfie";
  const low = await verifyAs(i.approvalId, "approve");
  world.acr = "https://world.org/oidc/acr/orb";
  assert.ok(!low.verified); assert.match(low.world.error, /verified at https:\/\/world.org\/oidc\/acr\/selfie, but https:\/\/world.org\/oidc\/acr\/orb is required/);
  const j = await newIntent(), ok = await verifyAs(j.approvalId, "approve"); assert.equal(ok.verified, 1, JSON.stringify(ok.world));
});
