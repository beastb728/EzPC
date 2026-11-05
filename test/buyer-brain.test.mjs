// The AI buyer's limits live in code. A fake model and a fake seller prove no answer can break them.
import test from "node:test";
import assert from "node:assert/strict";
process.env.PAY_ASSET = "usdc"; process.env.LLM_BASE_URL ??= "http://fake"; // set before the modules read them
const { aiNegotiate } = await import("../src/buyer-brain.mjs");
const listing = { key: "x", name: "TestSeller", priceTinybars: "100000", endpoint: "http://fake/x" }; // 0.10
// A fake seller: counters at 0.08 until offered at least 0.08, then deals.
const seller = (sent) => async (m) => { sent.push(m); const p = BigInt(m.price); return p >= 80000n || m.type === "accept" ? { type: "accept", quote: { id: "q1", price: m.price } } : { type: "counter", price: "80000", message: "0.08 is my best" }; };
const script = (...moves) => { let i = 0; return async () => moves[Math.min(i++, moves.length - 1)]; };

test("U1 an offer above the list price or the cap is cut to the cap", async () => {
  const sent = []; await aiNegotiate({ listing, maxPrice: "90000", ask: script({ action: "offer", price: 5, message: "take it" }), send: seller(sent) });
  assert.equal(sent[0].price, "90000");
});
test("U2 the buyer never lowers its own offer", async () => {
  const sent = []; await aiNegotiate({ listing, ask: script({ action: "offer", price: 0.05 }, { action: "offer", price: 0.01 }, { action: "walk" }), send: seller(sent) });
  assert.equal(sent[1].price, "50000");
});
test("U3 accepting takes the seller's counter, and only within the cap", async () => {
  const sent = []; const q = await aiNegotiate({ listing, ask: script({ action: "offer", price: 0.06 }, { action: "accept" }), send: seller(sent) });
  assert.equal(sent[1].type, "accept"); assert.equal(sent[1].price, "80000"); assert.equal(q.id, "q1");
  const sent2 = []; await aiNegotiate({ listing, maxPrice: "70000", ask: script({ action: "offer", price: 0.06 }, { action: "accept" }, { action: "walk" }), send: seller(sent2) });
  assert.ok(sent2.every((m) => BigInt(m.price) <= 70000n), "never above the cap, even when accepting");
});
test("U4 walking away means no quote: the list price", async () => {
  assert.equal(await aiNegotiate({ listing, ask: script({ action: "walk" }), send: seller([]) }), null);
});
test("U5 at most 4 offers, then it stops", async () => {
  const sent = []; await aiNegotiate({ listing, maxPrice: "70000", ask: script({ action: "offer", price: 0.06 }), send: seller(sent) });
  assert.ok(sent.filter((m) => m.type === "offer").length <= 4);
});
