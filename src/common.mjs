import express from "express";
export const PORTS = { web: 4000, fac: 4020, sellers: 4100, guard: 4200, agent: 4300 };
export const url = (s, p = "") => `http://127.0.0.1:${PORTS[s]}${p}`;
export const NETWORK = "hedera:testnet";
export const HBAR = 100_000_000n;
export const hbar = (t) => (Number(t) / 1e8).toFixed(2);
// start.mjs works the modes out once from the full .env and passes them on, because each service only gets its own keys.
const hashpack = () => String(process.env.WALLET || "").toLowerCase() === "hashpack" && !!process.env.WALLETCONNECT_PROJECT_ID;
export const modes = () => process.env.PROTOTYPE_MODES ? JSON.parse(process.env.PROTOTYPE_MODES) : ({
  // With HashPack the user signs in their own wallet, so no user key is needed here.
  payments: process.env.GUARD_ACCOUNT_ID && process.env.GUARD_PRIVATE_KEY && process.env.USER_ACCOUNT_ID && (process.env.USER_PRIVATE_KEY || hashpack()) ? "live" : "simulated",
  wallet: !(process.env.GUARD_ACCOUNT_ID && process.env.USER_ACCOUNT_ID) ? "simulated" : hashpack() ? "hashpack" : process.env.USER_PRIVATE_KEY ? "server" : "simulated",
  // Live only after `npm run seed:arkiv` and APPROVED_OWNERS is set to the writer wallet it prints.
  arkiv: process.env.ARKIV_PRIVATE_KEY && process.env.APPROVED_OWNERS ? "live" : "simulated",
  // Gaming-PC demo shops: live once `npm run setup:shops` wrote each shop's Arkiv wallet (all shops are paid to SELLER_ACCOUNT_ID).
  shops: process.env.SELLER_ACCOUNT_ID && ["VOLTFORGE", "PIXELBAZAAR", "RIGROOM"].every((s) => process.env[`SHOP_${s}_ARKIV_ADDRESS`]) ? "live" : "simulated",
  world: (process.env.WORLD_USE === "production" ? process.env.PROD_WORLD_CLIENT_ID : process.env.WORLD_CLIENT_ID) ? "live" : "simulated",
  audit: process.env.HCS_TOPIC_ID && process.env.GUARD_PRIVATE_KEY ? "live" : "simulated",
  data: process.env.DATA_GOV_IN_API_KEY ? "live" : "sample",
  model: process.env.LLM_BASE_URL ? "live" : "rules",
});
export const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";
// "0.0.5@1793.000123" and "0.0.5-1793-123" are the same transaction.
export const txKey = (t) => { const m = /^(\d+\.\d+\.\d+)[@-](\d+)[.-](\d+)$/.exec(String(t ?? "")); return m ? `${m[1]}-${Number(m[2])}-${Number(m[3])}` : null; };
export const app = () => { const a = express(); a.use(express.json({ limit: "200kb" })); return a; };
export const requireToken = (...tokens) => (req, res, next) =>
  tokens.includes(req.get("x-service-token")) && req.get("x-service-token") ? next() : res.status(401).json({ error: "unauthorized" });
export async function post(u, body, token) {
  const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-service-token": token } : {}) }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
export async function get(u, token) {
  const r = await fetch(u, { headers: token ? { "x-service-token": token } : {} });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
export const listen = (a, port, name) => a.listen(port, "127.0.0.1", () => console.log(`[${name}] listening on ${port}`));
