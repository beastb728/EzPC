// Starts every service as its own process. Each gets only the key it needs:
// the Guard gets the Guard account key, the dashboard gets the demo user-wallet key, the sellers get only each shop's own
// Arkiv key (to publish negotiated quotes), and the agent gets none.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { modes, PORTS } from "./src/common.mjs";
const AGENT_TOKEN = process.env.AGENT_TOKEN || randomBytes(24).toString("hex"), DASH_TOKEN = process.env.DASH_TOKEN || randomBytes(24).toString("hex");
const M = modes(), live = M.payments === "live";
const X402_URL = live ? process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator" : `http://127.0.0.1:${PORTS.fac}`;
const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.endsWith("_PRIVATE_KEY")));
delete base.HEDERA_ACCOUNT_ID; // The setup account isn't used by any service.
const common = { ...base, AGENT_TOKEN, DASH_TOKEN, X402_URL, PROTOTYPE_MODES: JSON.stringify(M) };
// The MCP server reads the agent token from here, so Claude can use the running Guard without any key.
mkdirSync("data", { recursive: true }); writeFileSync("data/agent-token", AGENT_TOKEN, { mode: 0o600 });
const kids = [];
const run = (file, env, port) => new Promise((ok, no) => {
  const k = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", file], { env, stdio: "inherit" }); kids.push(k);
  k.on("exit", (c) => { if (c) console.error(`${file} exited with ${c}`); });
  const t = Date.now(); const poll = () => fetch(`http://127.0.0.1:${port}/`).then(ok, () => Date.now() - t > 15000 ? no(new Error(`${file} did not start`)) : setTimeout(poll, 150)); poll();
});
const only = (...k) => Object.fromEntries(k.filter((x) => process.env[x]).map((x) => [x, process.env[x]]));
if (!live) await run("src/fac-sim.mjs", common, PORTS.fac);
await run("src/sellers.mjs", { ...common, ...only(...Object.keys(process.env).filter((k) => /^SHOP_[A-Z0-9]+_ARKIV_PRIVATE_KEY$/.test(k))) }, PORTS.sellers);
await run("src/guard.mjs", { ...common, ...only("GUARD_PRIVATE_KEY", "ARKIV_PRIVATE_KEY") }, PORTS.guard);
await run("src/agent.mjs", common, PORTS.agent);
// With HashPack the user signs in their wallet, so the dashboard never receives the user's key.
await run("src/web.mjs", { ...common, ...(M.wallet === "hashpack" ? {} : only("USER_PRIVATE_KEY")) }, PORTS.web);
console.log(`\nDashboard: http://localhost:${PORTS.web}\nModes: ${JSON.stringify(M)}\n`);
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { kids.forEach((k) => k.kill()); process.exit(0); });
