// Compatibility, requirements and build planning. Pure code, simulated catalog, no network.
import test from "node:test";
import assert from "node:assert/strict";
for (const k of Object.keys(process.env)) if (/^SHOP_|^PROTOTYPE_MODES$|^LLM_BASE_URL$|^PAY_ASSET$|^ARKIV_|^APPROVED_OWNERS$|^WORLD_/.test(k)) delete process.env[k];
const { checkBuild, compatible, basketCost } = await import("../src/compat.mjs");
const { PRODUCTS, usdc } = await import("../src/pc-catalog.mjs");
const { extractRules, parseRequirements, questions, applyAnswers, withDefaults } = await import("../src/requirements.mjs");
const { searchOffers, getOffer, offerProblem, simPatch, simReset } = await import("../src/pc-directory.mjs");
const { planPackages } = await import("../src/planner.mjs");
const { mkdtempSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
process.env.REVIEWS_FILE = `${mkdtempSync(`${tmpdir()}/al-rev-`)}/reviews.json`;
const { readReviews, summarise, publishReview, seedSampleReviews, REVIEW_DAYS, MAX_TEXT_BYTES } = await import("../src/reviews.mjs");

const part = (id) => ({ ...PRODUCTS[id], productId: id });
const good = () => ({ cpu: part("r7-7800x3d"), motherboard: part("b650-tomahawk"), ram: part("ddr5-32-6000"), gpu: part("rtx4080s"), storage: part("990pro-2tb"), psu: part("rm850x"), case: part("fractal-north"), cooler: part("nh-d15") });
const failed = (parts, req) => checkBuild(parts, req).filter((c) => !c.ok).map((c) => c.check);
const CATS = ["cpu", "motherboard", "ram", "gpu", "storage", "psu", "case", "cooler", "monitor", "keyboard", "mouse"];
const offers = async (condition = "new") => Object.fromEntries(await Promise.all(CATS.map(async (c) => [c, await searchOffers({ category: c, condition })])));
const EXAMPLE = "I want a gaming PC targeting GTA 6 at 60 FPS, a 4K monitor, and a total budget of 4,000 USDC.";

test("C1 a known-good build passes every check", () => { assert.deepEqual(failed(good()), []); assert.ok(compatible(checkBuild(good()))); });
test("C2 CPU socket must match the motherboard", () => assert.ok(failed({ ...good(), cpu: part("i5-14600k") }).includes("CPU socket")));
test("C3 RAM generation must match the board", () => assert.ok(failed({ ...good(), ram: part("ddr4-32-3600") }).includes("RAM generation")));
test("C4 RAM capacity must meet the requirement", () => assert.ok(failed(good(), { minRamGB: 64 }).includes("RAM capacity")));
test("C5 an ATX board doesn't fit an ITX-only case", () => assert.ok(failed({ ...good(), case: part("nr200p") }).includes("Board fits the case")));
test("C6 a GPU longer than the case allows is refused", () => assert.ok(failed({ ...good(), motherboard: { ...part("b650-tomahawk"), specs: { ...PRODUCTS["b650-tomahawk"].specs, formFactor: "ITX" } }, case: part("nr200p") }).includes("GPU length")));
test("C7 an air cooler taller than the case allows is refused", () => assert.ok(failed({ ...good(), case: part("lancool-207") }).includes("Cooler height")));
test("C8 PSU wattage needs headroom over the estimated draw", () => assert.ok(failed({ ...good(), gpu: part("rtx4090"), psu: part("mwe-650") }).includes("PSU wattage")));
test("C9 the PSU must have the GPU's power connectors (no adapters assumed)", () => assert.ok(failed({ ...good(), psu: part("focus-gx750") }).includes("PSU connectors")));
test("C10 storage needs a matching interface on the board", () => {
  const noM2 = { ...part("b650-tomahawk"), specs: { ...PRODUCTS["b650-tomahawk"].specs, m2Slots: 0 } };
  assert.ok(failed({ ...good(), motherboard: noM2 }).includes("Storage interface"));
  assert.ok(!failed({ ...good(), motherboard: noM2, storage: part("mx500-2tb") }).includes("Storage interface"));
});
test("C11 required parts and peripherals must all be present", () => {
  const { cooler, ...noCooler } = good();
  assert.ok(failed(noCooler).includes("required parts"));
  assert.match(checkBuild(good(), { needMonitor: true, needMouse: true })[0].detail, /missing: monitor, mouse/);
});
test("C12 total cost charges delivery once per shop, free above that shop's threshold", () => {
  const l = (sellerId, p, fee, free) => ({ sellerId, unitPrice: String(usdc(p)), deliveryFeeUnits: String(usdc(fee)), freeOverUnits: String(usdc(free)), deliveryDays: 2 });
  const c = basketCost([l("a", 100, 10, 1000), l("a", 50, 10, 1000), l("b", 2000, 20, 1500)]);
  assert.equal(c.items, usdc(2150)); assert.equal(c.delivery, usdc(10)); assert.equal(c.total, usdc(2160));
});

test("R1 the example prompt: budget, game, FPS and a 4K monitor, but no game resolution", async () => {
  const r = await parseRequirements(EXAMPLE);
  assert.equal(r.budgetUnits, String(usdc(4000))); assert.deepEqual(r.games, ["GTA 6"]); assert.equal(r.target.fps, 60);
  assert.equal(r.monitor.resolution, "4K"); assert.equal(r.target.resolution, null, "a 4K monitor must not imply native 4K gaming");
});
test("R2 only the budget is ever asked; a 4K monitor defaults to UPSCALED 4K gaming (stated), never native", async () => {
  assert.deepEqual(questions(await parseRequirements(EXAMPLE)).map((q) => q.id), []);
  assert.deepEqual(questions(await parseRequirements("Gaming PC with a 4K monitor")).map((q) => q.id), ["budgetUsdc"]);
  const r = withDefaults(await parseRequirements(EXAMPLE));
  assert.equal(r.target.resolution, "4K"); assert.equal(r.target.renderMode, "upscaled"); assert.equal(r.region, "IN");
  assert.ok(r.assumptions.some((a) => /upscaling.*not native 4K/.test(a))); assert.ok(r.assumptions.some((a) => /delivery within India/.test(a)));
});
test("R3 stated choices win over defaults, and defaults are listed back", async () => {
  const r = withDefaults(applyAnswers(await parseRequirements(EXAMPLE), { render: "native", region: "IN" }));
  assert.equal(r.target.renderMode, "native"); assert.equal(r.condition, "new"); assert.equal(r.peripherals.mouse, false);
  assert.ok(r.assumptions.some((a) => /new parts only/.test(a)));
});
test("R4 the rules never invent a budget or region", () => { const r = extractRules("Build me a PC for Valorant"); assert.equal(r.budgetUsdc, undefined); assert.equal(r.region, undefined); });

const plan = async (text, answers) => planPackages(withDefaults(applyAnswers(await parseRequirements(text), answers)), await offers("any"));
test("P1 three complete packages, each from ONE seller, compatible, within budget and estimated to reach the target", async () => {
  const p = await plan(EXAMPLE, { render: "upscaled", region: "IN" });
  assert.equal(p.packages.length, 3); assert.equal(p.shortfall, null); assert.equal(p.exactCount, 3);
  for (const b of p.packages) {
    assert.ok(b.compatible); assert.ok(b.exact); assert.deepEqual(b.relaxed, []); assert.ok(BigInt(b.cost.total) <= usdc(4000)); assert.notEqual(b.perf.verdict, "unlikely");
    assert.ok([...b.components, ...b.peripherals].every((l) => l.sellerId === b.sellerId), "one seller per package");
    assert.equal(b.components.length, 8); assert.ok(b.peripherals.some((l) => l.category === "monitor"));
    assert.ok(b.why.length && b.tradeoffs.some((t) => /not a benchmark/.test(t)));
  }
  assert.equal(new Set(p.packages.map((b) => b.id)).size, 3);
});
// Alternatives are real, compatible packages; each relaxed requirement is spelled out.
const alt = (p) => { assert.equal(p.packages.length, 3); for (const b of p.packages) { assert.ok(b.compatible); if (!b.exact) assert.ok(b.relaxed.length && /closest alternative/.test(b.label)); } assert.match(p.shortfall, /closest real alternatives/); };
test("P2 native 4K that nothing reaches: three closest alternatives, each saying what it relaxes", async () => {
  const p = await plan(EXAMPLE, { render: "native", region: "IN" }); alt(p); assert.equal(p.exactCount, 0);
  assert.ok(p.packages.some((b) => b.relaxed.some((r) => /performance target|used parts/.test(r))));
});
test("P3 a budget too small: alternatives say how far over budget they are", async () => {
  const p = await plan(EXAMPLE.replace("4,000", "900"), { render: "upscaled", region: "IN" }); alt(p);
  assert.ok(p.packages.every((b) => b.exact || b.relaxed.some((r) => /over your budget|performance/.test(r))));
});
test("P4 delivery outside India: every option says the shops only deliver within India", async () => {
  const p = await plan(EXAMPLE, { render: "upscaled", region: "OTHER", regionText: "Berlin" }); assert.equal(p.packages.length, 3);
  assert.ok(p.packages.every((b) => b.relaxed.some((r) => /within India only.*Berlin/.test(r))));
});
test("P5 fewer than three exact matches: the exact ones come first, the rest are labelled alternatives", async () => {
  const p = await plan("Gaming PC for GTA 6 at 1440p, budget 1,500 USDC", { region: "IN" }); alt(p);
  assert.ok(p.exactCount >= 1 && p.exactCount < 3); assert.ok(p.packages[0].exact);
});
test("V1 the seller rating counts only active reviews; expired ones (positive or negative) drop out", async () => {
  const now = Date.now();
  writeFileSync(process.env.REVIEWS_FILE, JSON.stringify([
    { sellerId: "rigroom", rating: 5, text: "fine", kind: "demo-order", createdAt: 2, expiresAt: now + 60_000 },
    { sellerId: "rigroom", rating: 1, text: "old", kind: "demo-order", createdAt: 1, expiresAt: now - 1 },
  ]));
  const s = summarise(await readReviews("rigroom")); assert.equal(s.count, 1); assert.equal(s.average, 5);
  assert.equal(summarise(await readReviews("voltforge")).label, "No recent reviews");
  for (const rating of [1, 5]) { const out = await publishReview({ sellerId: "voltforge", orderId: `o${rating}`, packageId: "x", rating, text: "t", human: "simulated" }); assert.ok(Math.abs(out.expiresAt - (Date.now() + REVIEW_DAYS * 86400_000)) < 5000); }
  assert.equal(REVIEW_DAYS, 90);
});
test("V3 review text fits Arkiv's string limit: up to MAX_TEXT_BYTES is published as written, one byte more is refused", async () => {
  const fits = "a".repeat(MAX_TEXT_BYTES), out = await publishReview({ sellerId: "rigroom", orderId: "len-ok", packageId: "x", rating: 4, text: fits, human: "simulated" });
  assert.equal((await readReviews("rigroom")).find((r) => r.entityKey === out.entityKey).text, fits);
  await assert.rejects(publishReview({ sellerId: "rigroom", orderId: "len-long", packageId: "x", rating: 4, text: "é".repeat(MAX_TEXT_BYTES / 2) + "a", human: "simulated" }), /over 128 bytes/);
});
test("V2 sample reviews: seeded once, labelled sample and never World ID verified, counted separately in the rating", async () => {
  writeFileSync(process.env.REVIEWS_FILE, "[]");
  const n = await seedSampleReviews(() => {}); assert.ok(n >= 30);
  assert.equal(await seedSampleReviews(() => {}), 0, "re-running adds nothing");
  for (const sid of ["voltforge", "pixelbazaar", "rigroom"]) {
    const list = await readReviews(sid), s = summarise(list);
    assert.ok(list.length >= 10); assert.ok(list.every((x) => x.kind === "sample" && x.human === "none"));
    assert.equal(s.verified, 0); assert.equal(s.samples, list.length); assert.match(s.label, /sample/); assert.doesNotMatch(s.label, /World ID verified/);
  }
  const avg = Object.fromEntries(await Promise.all(["voltforge", "pixelbazaar", "rigroom"].map(async (x) => [x, summarise(await readReviews(x)).average])));
  assert.ok(new Set(Object.values(avg)).size === 3, "the shops' ratings differ, so they help choose");
});
test("A1 offers from the wrong wallet, with the wrong payee, expired or out of stock are ignored", async () => {
  simReset();
  try {
    const before = (await searchOffers({ category: "gpu" })).length;
    simPatch("voltforge:rtx4070s", { owner: "0x9999999999999999999999999999999999999999" });
    simPatch("pixelbazaar:rx7700xt", { hederaPayTo: "0.0.6666" });
    simPatch("pixelbazaar:rx7900xt", { validUntil: Math.floor(Date.now() / 1000) - 1 });
    simPatch("rigroom:rtx4080s", { stock: 0 });
    const after = await searchOffers({ category: "gpu" });
    assert.equal(after.length, before - 4);
    assert.match((await getOffer("voltforge:rtx4070s")).problem, /not voltforge's registered wallet/);
    assert.match(offerProblem(await getOffer("pixelbazaar:rx7700xt")), /not pixelbazaar's registered account/);
  } finally { simReset(); }
});
test("A2 used parts only appear when the user allows them", async () => {
  assert.ok(!(await searchOffers({ category: "gpu", condition: "new" })).some((o) => o.condition === "used"));
  assert.ok((await searchOffers({ category: "gpu", condition: "any" })).some((o) => o.condition === "used"));
});
