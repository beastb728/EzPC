// Google sign-in for the PC app (OpenID Connect, authorization code flow with PKCE).
// The browser is sent to Google, Google sends it back to /auth/google/callback with a code, and this server swaps the
// code for an ID token using the client secret, checks the token, and sets a signed, HttpOnly session cookie.
// Without GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, sign-in is SIMULATED: one click signs in a local user.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
const REDIRECT = process.env.GOOGLE_REDIRECT_URI || "http://localhost:4000/auth/google/callback";
// Google's endpoints. Overridable only so the tests can run against a local fake.
const AUTH_URL = process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
export const googleLive = !!(CLIENT_ID && CLIENT_SECRET);
// Signs session cookies. Without SESSION_SECRET a random one is made at start-up, so sessions end when the server restarts.
const SECRET = process.env.SESSION_SECRET || randomBytes(32).toString("hex");
const SESSION = "ethpc_session", OAUTH = "ethpc_oauth", SESSION_MS = 7 * 86400_000, OAUTH_MS = 10 * 60_000;
const SECURE = REDIRECT.startsWith("https://");

const b64 = (b) => Buffer.from(b).toString("base64url");
const mac = (s) => createHmac("sha256", SECRET).update(s).digest("base64url");
const seal = (obj) => { const p = b64(JSON.stringify(obj)); return `${p}.${mac(p)}`; };
function unseal(v) {
  const [p, m] = String(v ?? "").split("."); if (!p || !m) return null;
  const a = Buffer.from(mac(p)), b = Buffer.from(m);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { const o = JSON.parse(Buffer.from(p, "base64url").toString()); return o.exp > Date.now() ? o : null; } catch { return null; }
}
const cookies = (q) => Object.fromEntries(String(q.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
const setCookie = (r, name, value, ms) => r.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ms / 1000)}${SECURE ? "; Secure" : ""}`);
const clearCookie = (r, name) => r.append("Set-Cookie", `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${SECURE ? "; Secure" : ""}`);
// Only same-site paths are allowed as the page to return to after sign-in.
const safeNext = (n) => (typeof n === "string" && /^\/(?!\/)[\w\-./?=&%]*$/.test(n) ? n : "/");

// The signed-in account for a request, or null.
export const sessionOf = (q) => unseal(cookies(q)[SESSION]);

// Checks the ID token Google returned from its token endpoint (received directly over TLS with the client secret).
function checkIdToken(idToken) {
  const part = String(idToken ?? "").split(".")[1]; if (!part) throw new Error("Google didn't return an ID token");
  const t = JSON.parse(Buffer.from(part, "base64url").toString());
  if (!["accounts.google.com", "https://accounts.google.com"].includes(t.iss)) throw new Error("ID token has the wrong issuer");
  if (t.aud !== CLIENT_ID) throw new Error("ID token was issued for a different app");
  if (!(t.exp * 1000 > Date.now())) throw new Error("ID token has expired");
  if (t.email && t.email_verified === false) throw new Error("this Google account's email isn't verified");
  return t;
}

export function googleAuthRoutes(a) {
  // Locks the API to signed-in accounts when Google sign-in is configured. The landing page's read-only calls stay open.
  const OPEN = new Set(["/auth/me", "/wallet", "/status", "/pc/fee"]);
  if (googleLive) a.use("/api", (q, r, n) => (OPEN.has(q.path) || sessionOf(q) ? n() : r.status(401).json({ error: "sign in with Google first" })));

  a.get("/api/auth/me", (q, r) => { const s = sessionOf(q); r.json({ mode: googleLive ? "live" : "simulated", signedIn: !!s, user: s ? { name: s.name, email: s.email, picture: s.picture } : null }); });

  a.get("/auth/google", (q, r) => {
    const next = safeNext(q.query.next);
    if (!googleLive) { setCookie(r, SESSION, seal({ sub: "local-user", name: "Local user", email: null, picture: null, mode: "simulated", exp: Date.now() + SESSION_MS }), SESSION_MS); return r.redirect(next); }
    const state = b64(randomBytes(24)), verifier = b64(randomBytes(48)), challenge = createHash("sha256").update(verifier).digest("base64url");
    setCookie(r, OAUTH, seal({ state, verifier, next, exp: Date.now() + OAUTH_MS }), OAUTH_MS);
    const u = new URL(AUTH_URL);
    for (const [k, v] of Object.entries({ client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", scope: "openid email profile", state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account" })) u.searchParams.set(k, v);
    r.redirect(u.toString());
  });

  a.get("/auth/google/callback", async (q, r) => {
    const fail = (msg) => { clearCookie(r, OAUTH); r.redirect(`/?login_error=${encodeURIComponent(msg)}`); };
    if (!googleLive) return r.redirect("/");
    const o = unseal(cookies(q)[OAUTH]);
    if (q.query.error) return fail(q.query.error === "access_denied" ? "Google sign-in was cancelled." : `Google sign-in failed (${q.query.error}).`);
    if (!o || !q.query.state || q.query.state !== o.state) return fail("The sign-in link expired. Please try again.");
    try {
      const res = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: String(q.query.code ?? ""), client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: "authorization_code", code_verifier: o.verifier }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error_description || j.error || `token exchange failed (HTTP ${res.status})`);
      const t = checkIdToken(j.id_token);
      clearCookie(r, OAUTH);
      setCookie(r, SESSION, seal({ sub: t.sub, name: t.name ?? t.email ?? "Google user", email: t.email ?? null, picture: t.picture ?? null, mode: "live", exp: Date.now() + SESSION_MS }), SESSION_MS);
      r.redirect(safeNext(o.next));
    } catch (e) { fail(`Google sign-in failed: ${String(e.message).slice(0, 120)}`); }
  });

  a.post("/auth/logout", (q, r) => { clearCookie(r, SESSION); r.json({ signedIn: false }); });
}
