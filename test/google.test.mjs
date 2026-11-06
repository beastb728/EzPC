// Google sign-in against a local fake Google (authorize + token endpoints), with World ID set to live.
// Proves the dashboard's checks (state, PKCE, ID token, API lock, approvals by a signed-in account), not Google itself.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const G = "http://127.0.0.1:4200", W = "http://127.0.0.1:4000", FAKE = "http://127.0.0.1:4556", CLIENT = "test-google-client", SECRET = "test-google-secret";
const AGENT = "agent-test", DASH = "dash-test"; const dir = mkdtempSync(join(tmpdir(), "alg-")); let kid, fake;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
// What the fake Google puts in the next ID token, and what it saw.
const google = { aud: CLIENT, emailVerified: true, challenge: null, seen: null };

before(async () => {
  fake = createServer(async (q, r) => {
    let body = ""; for await (const c of q) body += c; const f = new URLSearchParams(body);
    const json = (s, o) => { r.writeHead(s, { "content-type": "application/json" }); r.end(JSON.stringify(o)); };
    if (q.url === "/token") {
      google.seen = Object.fromEntries(f);
      const pkce = createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === google.challenge;
      if (f.get("client_secret") !== SECRET || f.get("code") !== "good-code" || !pkce) return json(400, { error: "invalid_grant", error_description: "Bad Request" });
      const now = Math.floor(Date.now() / 1000);
      const idt = `${b64({ alg: "RS256" })}.${b64({ iss: "https://accounts.google.com", aud: google.aud, sub: "g-sub-1", email: "buyer@example.com", email_verified: google.emailVerified, name: "Asha Buyer", iat: now, exp: now + 3600 })}.sig`;
      return json(200, { id_token: idt, access_token: "x", token_type: "Bearer" });
    }
    json(404, {});
  }).listen(4556);
  const e = { ...process.env, AGENT_TOKEN: AGENT, DASH_TOKEN: DASH, GUARD_DB: join(dir, "g.db"), REVIEWS_FILE: join(dir, "reviews.json"),
    GOOGLE_CLIENT_ID: CLIENT, GOOGLE_CLIENT_SECRET: SECRET, GOOGLE_REDIRECT_URI: `${W}/auth/google/callback`, GOOGLE_AUTH_URL: `${FAKE}/authorize`, GOOGLE_TOKEN_URL: `${FAKE}/token`, SESSION_SECRET: "test-session-secret",
    WORLD_ISSUER: FAKE, WORLD_CLIENT_ID: "test-world", WORLD_CLIENT_SECRET: "worldidp_client_secret_test" };
  for (const k of Object.keys(e)) if (/_PRIVATE_KEY$|_ACCOUNT_ID$|^HCS_TOPIC_ID$|^LLM_BASE_URL$|^DATA_GOV_IN_API_KEY$|^PROTOTYPE_MODES$|^APPROVED_OWNERS$|^PAY_ASSET$|^SHOP_/.test(k)) delete e[k];
  kid = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "start.mjs"], { env: e, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { await fetch(W + "/"); return; } catch { await sleep(200); } } throw new Error("stack did not start");
});
after(() => { kid.kill(); fake.close(); rmSync(dir, { recursive: true, force: true }); });

const cookieOf = (r) => (r.headers.getSetCookie?.() ?? [r.headers.get("set-cookie")]).filter(Boolean).map((c) => c.split(";")[0]).filter((c) => !/=$/.test(c)).join("; ");
// Starts sign-in and returns the authorize URL's parameters plus the state cookie.
async function start(next = "/build") {
  const r = await fetch(`${W}/auth/google?next=${encodeURIComponent(next)}`, { redirect: "manual" });
  assert.equal(r.status, 302); const u = new URL(r.headers.get("location"));
  google.challenge = u.searchParams.get("code_challenge");
  return { u, cookie: cookieOf(r) };
}
async function signIn() {
  const { u, cookie } = await start();
  const r = await fetch(`${W}/auth/google/callback?code=good-code&state=${u.searchParams.get("state")}`, { headers: { cookie }, redirect: "manual" });
  return { r, session: cookieOf(r) };
}

test("G1 with Google configured, the API needs a session; the landing page's reads stay open", async () => {
  assert.equal((await fetch(W + "/api/pc/orders")).status, 401);
  assert.equal((await fetch(W + "/api/approvals")).status, 401);
  for (const p of ["/api/status", "/api/wallet", "/api/pc/fee"]) assert.equal((await fetch(W + p)).status, 200, p);
  assert.deepEqual(await (await fetch(W + "/api/auth/me")).json(), { mode: "live", signedIn: false, user: null });
});
test("G2 sign-in sends the browser to Google with the client, redirect URI, scopes, state and a PKCE challenge", async () => {
  const { u, cookie } = await start();
  assert.equal(u.origin + u.pathname, `${FAKE}/authorize`);
  assert.equal(u.searchParams.get("client_id"), CLIENT); assert.equal(u.searchParams.get("redirect_uri"), `${W}/auth/google/callback`);
  assert.equal(u.searchParams.get("scope"), "openid email profile"); assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.ok(u.searchParams.get("state")?.length >= 30); assert.match(cookie, /^ethpc_oauth=/);
});
test("G3 the callback swaps the code (with the secret and PKCE verifier), sets a session and returns to the saved page", async () => {
  const { r, session } = await signIn();
  assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "/build");
  assert.equal(google.seen.client_secret, SECRET); assert.equal(google.seen.grant_type, "authorization_code");
  const me = await (await fetch(W + "/api/auth/me", { headers: { cookie: session } })).json();
  assert.deepEqual(me, { mode: "live", signedIn: true, user: { name: "Asha Buyer", email: "buyer@example.com", picture: null } });
  assert.equal((await fetch(W + "/api/pc/orders", { headers: { cookie: session } })).status, 200);
});
test("G4 a wrong state, a token for another app, or an unverified email is refused", async () => {
  const { cookie } = await start();
  const bad = await fetch(`${W}/auth/google/callback?code=good-code&state=not-the-state`, { headers: { cookie }, redirect: "manual" });
  assert.match(bad.headers.get("location"), /^\/\?login_error=/); assert.equal(cookieOf(bad), "");
  google.aud = "someone-else"; let x = await signIn(); google.aud = CLIENT;
  assert.match(decodeURIComponent(x.r.headers.get("location")), /different app/); assert.equal(x.session, "");
  google.emailVerified = false; x = await signIn(); google.emailVerified = true;
  assert.match(decodeURIComponent(x.r.headers.get("location")), /email isn't verified/); assert.equal(x.session, "");
  const cancelled = await fetch(`${W}/auth/google/callback?error=access_denied`, { redirect: "manual" });
  assert.match(decodeURIComponent(cancelled.headers.get("location")), /cancelled/);
});
test("G5 with World ID live, a signed-in Google account approves the allowance without a World check", async () => {
  const { session } = await signIn();
  const i = (await (await fetch(G + "/intents", { method: "POST", headers: { "content-type": "application/json", "x-service-token": AGENT }, body: JSON.stringify({ task: "pc fees", categories: ["market-prices"], maxTotal: "100000000", approvalOver: "100000000" }) })).json());
  assert.equal((await fetch(`${W}/api/approvals/${i.approvalId}/approve`, { method: "POST" })).status, 401, "no session, no approval");
  const d = await fetch(`${W}/api/approvals/${i.approvalId}/approve`, { method: "POST", headers: { "content-type": "application/json", cookie: session }, body: "{}" });
  const body = await d.json(); assert.equal(d.status, 200, JSON.stringify(body)); assert.equal(body.state, "active"); assert.match(body.approvedBy, /Google account buyer@example.com/);
});
test("G6 signing out ends the session", async () => {
  const { session } = await signIn();
  const out = await fetch(W + "/auth/logout", { method: "POST", headers: { cookie: session } });
  assert.match(out.headers.get("set-cookie"), /^ethpc_session=; .*Max-Age=0/);
});
