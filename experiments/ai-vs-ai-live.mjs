// Live check: the AI buyer haggles with each AI seller over A2A. Needs the stack running (npm start) and an LLM in .env.
// node --env-file=.env experiments/ai-vs-ai-live.mjs
process.env.PAY_ASSET ??= "usdc";
const { aiNegotiate } = await import("../src/buyer-brain.mjs");
const { LISTINGS } = await import("../src/catalog.mjs");
const { ASSET, fromUnits } = await import("../src/asset.mjs");
for (const key of process.argv.slice(2).length ? process.argv.slice(2) : ["mandifresh", "deepreport", "briefwriter"]) {
  const l = LISTINGS.find((x) => x.key === key), t = Date.now();
  console.log(`\n== ${l.name}, list ${fromUnits(l.priceTinybars)} ${ASSET.symbol} ==`);
  const q = await aiNegotiate({ listing: { ...l, endpoint: `http://127.0.0.1:4100/${key}` }, log: (x) => console.log("  " + x) });
  console.log(`  → ${q ? `deal at ${fromUnits(q.price)}` : "list price"} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}
