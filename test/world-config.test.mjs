// WORLD_USE=production switches World ID to the production credentials; without it, the sandbox ones are used.
// Each case runs world.mjs in its own process against a local fake issuer that records which client called it.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const ISS = "http://127.0.0.1:4557"; let fake, seen = [];

before(async () => {
  fake = createServer(async (q, r) => {
    let body = ""; for await (const c of q) body += c;
    const json = (o) => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify(o)); };
    if (q.url === "/.well-known/openid-configuration") return json({ issuer: ISS, device_authorization_endpoint: `${ISS}/device`, token_endpoint: `${ISS}/token`, jwks_uri: `${ISS}/jwks` });
    if (q.url === "/device") { const f = new URLSearchParams(body); seen.push({ id: f.get("client_id"), secret: f.get("client_secret") }); return json({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://example.test/d", interval: 5, expires_in: 600 }); }
    r.writeHead(404).end();
  });
  await new Promise((ok) => fake.listen(4557, ok));
});
after(() => fake.close());

// Starts one World check in a fresh process with only the given World settings, and reports which issuer it used.
async function startWith(env) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PROD_)?WORLD_/.test(k)));
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", "const w = await import('./src/world.mjs'); await w.startDevice(); console.log(w.worldIssuer());"], { env: { ...base, ...env } });
  return stdout.trim();
}

test("C1 WORLD_USE=production uses the PROD_WORLD_* issuer and client; the sandbox client is never sent", async () => {
  seen = [];
  const used = await startWith({ WORLD_USE: "production", PROD_WORLD_ISSUER: ISS, PROD_WORLD_CLIENT_ID: "prod-client", PROD_WORLD_CLIENT_SECRET: "worldidp_client_secret_prod", WORLD_ISSUER: "http://127.0.0.1:9/never", WORLD_CLIENT_ID: "sandbox-client", WORLD_CLIENT_SECRET: "sandbox-secret" });
  assert.equal(used, ISS);
  assert.deepEqual(seen, [{ id: "prod-client", secret: "worldidp_client_secret_prod" }]);
});
test("C2 without WORLD_USE, the sandbox settings are used, as before", async () => {
  seen = [];
  const used = await startWith({ WORLD_ISSUER: ISS, WORLD_CLIENT_ID: "sandbox-client", WORLD_CLIENT_SECRET: "sandbox-secret", PROD_WORLD_CLIENT_ID: "prod-client" });
  assert.equal(used, ISS);
  assert.deepEqual(seen, [{ id: "sandbox-client", secret: "sandbox-secret" }]);
});
test("C3 WORLD_USE=production without production credentials fails clearly instead of falling back", async () => {
  await assert.rejects(startWith({ WORLD_USE: "production", PROD_WORLD_ISSUER: ISS, WORLD_CLIENT_ID: "sandbox-client" }), /needs PROD_WORLD_CLIENT_ID/);
});
