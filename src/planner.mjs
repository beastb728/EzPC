// Packs Arkiv offers into complete PCs. A package is ONE seller's parts and peripherals, so the user picks a whole PC,
// never single components. Code does all of it: every combination is checked with compat.mjs, costed with that shop's
// delivery, and estimated with perf.mjs (sample data, not benchmarks). Nothing here pays or orders anything.
import { createHash } from "node:crypto";
import { CORE, checkBuild, compatible, basketCost } from "./compat.mjs";
import { estimate, verdictRank } from "./perf.mjs";
import { shopById, showUsdc } from "./pc-catalog.mjs";

export const WANTED = 3; // options per recommendation, when enough matching inventory exists
const str = (o) => JSON.parse(JSON.stringify(o, (_, x) => (typeof x === "bigint" ? String(x) : x)));
const line = (o) => ({ category: o.category, offerId: o.offerId, sellerId: o.sellerId, productId: o.productId, brand: o.brand, model: o.model, condition: o.condition, warrantyMonths: o.warrantyMonths, unitPrice: o.priceUnits, qty: 1, deliveryFeeUnits: o.deliveryFeeUnits, freeOverUnits: o.freeOverUnits, deliveryDays: o.deliveryDays, specs: o.specs });
const shopName = (id) => shopById(id)?.name ?? id;

function needs(req) {
  return { minRamGB: req.minRamGB ?? 16, needMonitor: !!req.monitor?.needed, monitorResolution: req.monitor?.resolution ?? null, needKeyboard: !!req.peripherals?.keyboard, needMouse: !!req.peripherals?.mouse };
}

// Every compatible core build from one shop's offers, with its performance estimate.
function coreBuilds(offers, req) {
  const n = needs(req), out = [], perfCache = new Map();
  const [cpus, mbs, rams, gpus, sts, psus, cases, coolers] = CORE.map((c) => offers[c] ?? []);
  for (const cpu of cpus) for (const mb of mbs) {
    if (cpu.specs.socket !== mb.specs.socket) continue; // quick prune; checkBuild re-checks everything below
    for (const ram of rams) for (const cs of cases) for (const cooler of coolers) for (const gpu of gpus) for (const psu of psus) for (const st of sts) {
      const parts = { cpu, motherboard: mb, ram, gpu, storage: st, psu, case: cs, cooler };
      if (!compatible(checkBuild(parts, { ...n, needMonitor: false, needKeyboard: false, needMouse: false }))) continue;
      const k = `${cpu.productId}|${gpu.productId}`;
      if (!perfCache.has(k)) perfCache.set(k, estimate({ gpu, cpu, games: req.games, target: req.target }));
      out.push({ parts, perf: perfCache.get(k) });
    }
  }
  return out;
}
// Peripherals from the same shop: the cheapest offer that meets the requirement. Returns the categories it can't supply.
function extras(offers, req) {
  const n = needs(req), pick = {}, missing = [], cheapest = (l) => [...l].sort((a, b) => Number(BigInt(a.priceUnits) - BigInt(b.priceUnits)))[0];
  const want = (cat, list) => { const x = cheapest(list); x ? (pick[cat] = x) : missing.push(cat); };
  if (n.needMonitor) want("monitor", (offers.monitor ?? []).filter((m) => (!n.monitorResolution || m.specs.resolution === n.monitorResolution) && (!req.monitor.minHz || m.specs.refreshHz >= req.monitor.minHz)));
  if (n.needKeyboard) want("keyboard", offers.keyboard ?? []);
  if (n.needMouse) want("mouse", offers.mouse ?? []);
  return { pick, missing };
}
const byShop = (offers, sellerId) => Object.fromEntries(Object.entries(offers).map(([c, l]) => [c, l.filter((o) => o.sellerId === sellerId)]));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Better verdict first, then cheaper.
const rank = (a, b) => verdictRank(b.perf.verdict) - verdictRank(a.perf.verdict) || cmp(a.total, b.total);

// Why this package fits, and what it gives up. Only facts the code checked, plus the labelled sample estimate.
function explain(c, req, budget) {
  const gpu = c.parts.gpu, t = c.perf.target, why = [], tradeoffs = [];
  why.push(c.total <= budget ? `${showUsdc(c.total)} including delivery: ${showUsdc(budget - c.total)} under your ${showUsdc(budget)} budget.` : `${showUsdc(c.total)} including delivery: ${showUsdc(c.total - budget)} over your ${showUsdc(budget)} budget.`);
  why.push(`${gpu.brand} ${gpu.model} (${gpu.specs.vramGB} GB): sample estimate says ${c.perf.verdict} to reach ${t}.`);
  why.push(`All ${c.checks.length} compatibility checks pass (socket, memory, fit, cooling, power and connectors).`);
  if (c.ex.monitor) why.push(`Includes the ${c.ex.monitor.specs.resolution} ${c.ex.monitor.specs.refreshHz} Hz monitor you asked for.`);
  if (c.perf.verdict === "borderline") tradeoffs.push(`Little performance margin: it may need lower settings to hold ${req.target.fps} FPS.`);
  for (const p of Object.values(c.parts)) if (p.condition !== "new") tradeoffs.push(`${p.model} is ${p.condition}, with ${p.warrantyMonths} months' warranty.`);
  if (req.target.resolution === "4K" && req.target.renderMode === "upscaled") tradeoffs.push(`4K here means upscaled (${gpu.specs.upscaler}), not native 4K rendering.`);
  for (const g of c.perf.perGame) if (g.note) tradeoffs.push(`${g.game}: ${g.note}`);
  tradeoffs.push(`Performance is a ${c.perf.source.split(":")[0].toLowerCase()}, not a benchmark; real results vary with settings, drivers and patches.`);
  const days = Math.max(...[...Object.values(c.parts), ...Object.values(c.ex)].map((p) => p.deliveryDays));
  tradeoffs.push(`Delivery in about ${days} days from ${shopName(c.sellerId)} (demo shop, simulated delivery).`);
  return { why, tradeoffs };
}
function packageOf(c, req, budget, label) {
  // A peripheral the shop doesn't have is left out (and labelled), so it isn't counted as a failed check.
  const n = needs(req); for (const m of c.missing ?? []) n[`need${m[0].toUpperCase()}${m.slice(1)}`] = false;
  const parts = { ...c.parts, ...c.ex }, checks = checkBuild(parts, n), all = Object.values(parts).map(line), cost = basketCost(all);
  const id = `${c.sellerId}:${createHash("sha256").update(all.map((l) => l.offerId).sort().join("|")).digest("hex").slice(0, 10)}`;
  const { why, tradeoffs } = explain({ ...c, checks }, req, budget);
  return { id, label, exact: !c.relaxed.length, relaxed: c.relaxed, sellerId: c.sellerId, shopName: shopName(c.sellerId), components: all.filter((l) => CORE.includes(l.category)), peripherals: all.filter((l) => !CORE.includes(l.category)), checks, compatible: compatible(checks), cost, perf: c.perf, why, tradeoffs };
}

// Main entry. req has gone through requirements.withDefaults; offers is { cpu: [...], motherboard: [...], ... } and should
// include used offers (a used part is only ever offered as a labelled alternative when the user asked for new).
// Always returns up to three real packages: first every exact match (one per shop first), then, if fewer than three match
// everything, the closest alternatives, each with the requirements it relaxes spelled out. Nothing is invented.
export function planPackages(req, offers) {
  const budget = BigInt(req.budgetUnits), sellers = [...new Set(Object.values(offers).flat().map((o) => o.sellerId))].sort();
  const cands = [];
  for (const sid of sellers) {
    const mine = byShop(offers, sid), ex = extras(mine, req);
    for (const b of coreBuilds(mine, req)) {
      const total = basketCost([...Object.values(b.parts), ...Object.values(ex.pick)].map(line)).total;
      cands.push({ ...b, ex: ex.pick, missing: ex.missing, sellerId: sid, total, used: Object.values(b.parts).some((p) => p.condition !== "new") });
    }
  }
  if (!cands.length) return { packages: [], constraint: "None of the demo shops can put together a compatible PC from their current stock." };
  const relax = (c) => [
    ...(req.region === "OTHER" ? [`Delivers within India only (you asked for ${req.regionText ?? "another region"})`] : []),
    ...(c.total > budget ? [`${showUsdc(c.total - budget)} over your budget`] : []),
    ...(verdictRank(c.perf.verdict) < 1 ? [`Below your performance target: sample estimate says unlikely to reach ${c.perf.target}`] : []),
    ...(c.used && req.condition !== "any" ? ["Includes used parts with a shorter warranty (you asked for new)"] : []),
    ...c.missing.map((m) => `No matching ${m} at this shop, so it isn't included`),
  ];
  // How far an alternative is from the request: smaller is closer.
  const distance = (c) => (c.total > budget ? Number(c.total - budget) / Number(budget) * 10 : 0) + (verdictRank(c.perf.verdict) < 1 ? 4 : 0) + (c.used && req.condition !== "any" ? 3 : 0) + c.missing.length * 5;
  for (const c of cands) { c.relaxed = relax(c); c.distance = distance(c); }
  const exact = cands.filter((c) => c.distance === 0).sort(rank), near = cands.filter((c) => c.distance > 0).sort((a, b) => a.distance - b.distance || rank(a, b));
  const picks = [], seen = new Set(), sig = (c) => `${c.sellerId}|${c.parts.cpu.productId}|${c.parts.gpu.productId}`;
  const take = (list, newShopsOnly) => { for (const c of list) { if (picks.length >= WANTED) return; if (seen.has(sig(c)) || (newShopsOnly && picks.some((p) => p.sellerId === c.sellerId))) continue; picks.push(c); seen.add(sig(c)); } };
  take(exact, true); take(exact, false); take(near, true); take(near, false);
  const exactCount = picks.filter((c) => c.distance === 0).length;
  const packages = picks.map((c, i) => packageOf(c, req, budget, c.distance === 0 ? `Option ${i + 1}` : `Option ${i + 1} · closest alternative`));
  const shortfall = exactCount < packages.length
    ? `${exactCount ? `Only ${exactCount} option${exactCount === 1 ? "" : "s"} match${exactCount === 1 ? "es" : ""}` : "No option matches"} everything you asked for, so the rest are the closest real alternatives from the demo shops. Each one says which requirement it relaxes.`
    : null;
  return str({ packages, shortfall, exactCount, considered: cands.length, perfSource: cands[0].perf.source });
}
