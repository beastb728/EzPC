// World ID through the OIDC device flow, used when WORLD_CLIENT_ID is set. The device flow needs no callback URL,
// so it works on localhost, and World requires a fresh approval for every attempt.
// World only proves a person approved; the Guard records what they approved.
import { createRemoteJWKSet, jwtVerify } from "jose";
const issuer = () => process.env.WORLD_ISSUER || "https://sandbox.auth.world.org";
let disco;
const discovery = async () => (disco ??= await (await fetch(`${issuer()}/.well-known/openid-configuration`)).json());
// Registered as client_secret_post or client_secret_basic in World's portal; this must match.
function clientAuth(body) {
  const id = process.env.WORLD_CLIENT_ID, secret = process.env.WORLD_CLIENT_SECRET ?? "";
  if ((process.env.WORLD_CLIENT_AUTH || "post") === "basic") return { headers: { authorization: `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}` }, body };
  return { headers: {}, body: { ...body, client_id: id, client_secret: secret } };
}
const form = async (url, body) => {
  const a = clientAuth(body);
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...a.headers }, body: new URLSearchParams(a.body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

export async function startDevice() {
  const d = await discovery();
  const r = await form(d.device_authorization_endpoint, { client_id: process.env.WORLD_CLIENT_ID, scope: "openid" });
  if (r.status !== 200 || !r.body.device_code) throw new Error(`World device request failed: ${r.body.error ?? r.status}`);
  const b = r.body;
  return { deviceCode: b.device_code, userCode: b.user_code, verificationUri: b.verification_uri, verificationUriComplete: b.verification_uri_complete ?? b.verification_uri, interval: Number(b.interval ?? 5), expiresAt: Date.now() + Number(b.expires_in ?? 600) * 1000, startedAt: Math.floor(Date.now() / 1000), nextPollAt: 0 };
}

// Returns { state: "pending" | "verified" | "denied" | "expired" | "failed", ... }
export async function pollDevice(s) {
  const d = await discovery();
  const r = await form(d.token_endpoint, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: s.deviceCode, client_id: process.env.WORLD_CLIENT_ID });
  const err = r.body.error;
  if (err === "authorization_pending") return { state: "pending" };
  if (err === "slow_down") return { state: "pending", slowDown: true };
  if (err === "access_denied") return { state: "denied" };
  if (err === "expired_token") return { state: "expired" };
  if (!r.body.id_token) return { state: "failed", error: err ?? `token endpoint ${r.status}` };
  try {
    const { payload } = await jwtVerify(r.body.id_token, createRemoteJWKSet(new URL(d.jwks_uri)), { issuer: d.issuer, audience: process.env.WORLD_CLIENT_ID });
    if (!payload.auth_time || payload.auth_time < s.startedAt - 5) return { state: "failed", error: "authentication is not fresh" };
    return { state: "verified", iss: payload.iss, sub: String(payload.sub), acr: payload.acr ?? null, amr: payload.amr ?? null, authTime: payload.auth_time };
  } catch (e) { return { state: "failed", error: `ID token rejected: ${e.message}` }; }
}
