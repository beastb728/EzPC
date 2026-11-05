// Seller reviews as public Arkiv entities. Every review lives 90 days, positive or negative alike, then Arkiv drops it.
// The rating is worked out from the reviews still active each time it's read; there is no recalculation job.
// Only reviews written by the team's review-publisher wallet count, so a shop can't post, edit or delete reviews.
// What's on Arkiv is public: seller, a one-way order reference, rating, short text, labels. No World ID, name or address.
// Who may review (World-verified human, one review per completed demo order) is enforced by the Guard before publishing.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hexToString, stringToHex } from "viem";
import { modes } from "./common.mjs";

export const REVIEW_DAYS = 90;
export const KIND = "demo-order"; // purchases are simulated, so every review is labelled a demo-order review
export const SAMPLE_KIND = "sample"; // seeded by the team (sample-reviews.mjs): not World ID verified, not tied to an order
const SCHEMA = "agentleash-prototype-do-not-submit.pc-reviews.v1";
const BLOCK_MS = 2000;
const live = () => modes().arkiv === "live";
const file = () => process.env.REVIEWS_FILE || "data/demo-reviews.json";
export const orderRef = (orderId) => createHash("sha256").update(`order|${orderId}`).digest("hex").slice(0, 24);
// The publisher wallet: the Guard's Arkiv wallet. Readers without the key take it from APPROVED_OWNERS (the same wallet).
const publisher = async () => {
  if (process.env.ARKIV_PRIVATE_KEY) { const { privateKeyToAccount } = await import("viem/accounts"); return privateKeyToAccount(process.env.ARKIV_PRIVATE_KEY).address.toLowerCase(); }
  return (process.env.REVIEW_PUBLISHER || (process.env.APPROVED_OWNERS || "").split(",")[0] || "").trim().toLowerCase();
};

async function arkiv(withKey) {
  const [{ createPublicClient, createWalletClient, ExpirationTime }, { rabdi }, { http }, { privateKeyToAccount }, s, q] = await Promise.all([import("@arkiv-network/sdk"), import("@arkiv-network/sdk/chains"), import("viem"), import("viem/accounts"), import("@arkiv-network/sdk/schema"), import("@arkiv-network/sdk/query")]);
  const chain = rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" });
  const Reviews = s.defineSchema(SCHEMA, { sellerId: s.str().indexed(), orderRef: s.str().indexed(), packageId: s.str(), rating: s.u64().indexed(), text: s.bytes(), kind: s.str().indexed(), human: s.str(), createdAt: s.u64().indexed() });
  const out = { Reviews, q, u64: s.u64, bytes: s.bytes, ExpirationTime, pub: createPublicClient({ chain, transport: http(undefined, { timeout: 8000, retryCount: 1 }) }) };
  if (withKey) out.wallet = createWalletClient({ chain, transport: http(), account: privateKeyToAccount(process.env.ARKIV_PRIVATE_KEY) });
  return out;
}
const readSim = () => { try { return JSON.parse(readFileSync(file(), "utf8")); } catch { return []; } };
const writeSim = (list) => { mkdirSync(dirname(file()), { recursive: true }); writeFileSync(file(), JSON.stringify(list)); };
export const clearSimReviews = () => writeSim([]);

// r: { sellerId, orderId, packageId, rating 1..5, text, human: "world-verified" | "simulated" | "none", kind?, createdAt? }
export async function publishReview(r) {
  const rec = { sellerId: r.sellerId, orderRef: orderRef(r.orderId), packageId: r.packageId, rating: r.rating, text: r.text, kind: r.kind ?? KIND, human: r.human, createdAt: r.createdAt ?? Math.floor(Date.now() / 1000) };
  if (!live()) {
    const expiresAt = Date.now() + REVIEW_DAYS * 86400_000, entityKey = `sim:review:${rec.orderRef}`;
    writeSim([...readSim(), { ...rec, expiresAt, entityKey, source: "simulated" }]);
    return { entityKey, expiresAt, source: "simulated" };
  }
  const a = await arkiv(true);
  const { entityKey } = await a.wallet.createEntity(a.Reviews, { ...rec, rating: a.u64(rec.rating), createdAt: a.u64(rec.createdAt), text: a.bytes(stringToHex(rec.text)) }, { expiration: a.ExpirationTime.fromDays(REVIEW_DAYS) });
  return { entityKey, expiresAt: Date.now() + REVIEW_DAYS * 86400_000, source: "arkiv" };
}

// Active reviews for one seller: World ID verified ones first, then newest first.
const order = (a, b) => (b.human === "world-verified") - (a.human === "world-verified") || b.createdAt - a.createdAt;
export async function readReviews(sellerId) {
  if (!live()) return readSim().filter((x) => x.sellerId === sellerId && x.expiresAt > Date.now()).sort(order);
  const a = await arkiv(false), owner = await publisher();
  if (!owner) throw new Error("no review publisher wallet configured");
  const fields = Object.fromEntries(["$key", "$owner", "$expiresAt", "sellerId", "orderRef", "packageId", "rating", "text", "kind", "human", "createdAt"].map((k) => [k, true]));
  const res = await a.pub.select(fields).from(a.Reviews).where(a.q.eq("sellerId", sellerId)).ownedBy(owner).fetch();
  const block = BigInt(res.blockNumber), v = (e, k) => e[k]?.value;
  return res.entities.map((e) => ({ sellerId: v(e, "sellerId"), orderRef: v(e, "orderRef"), packageId: v(e, "packageId"), rating: Number(v(e, "rating")), text: (() => { try { return hexToString(v(e, "text")); } catch { return ""; } })(), kind: v(e, "kind"), human: v(e, "human"), createdAt: Number(v(e, "createdAt")), expiresAt: Date.now() + Number(BigInt(e.$expiresAt) - block) * BLOCK_MS, entityKey: e.$key, source: "arkiv" }))
    .filter((x) => x.expiresAt > Date.now() && x.rating >= 1 && x.rating <= 5).sort(order);
}
// Average of the active reviews only, and how many are World ID verified vs team samples.
export function summarise(list) {
  if (!list.length) return { count: 0, average: null, verified: 0, samples: 0, label: "No recent reviews" };
  const avg = list.reduce((t, x) => t + x.rating, 0) / list.length, verified = list.filter((x) => x.human === "world-verified").length, samples = list.filter((x) => x.kind === SAMPLE_KIND).length;
  const parts = [verified && `${verified} World ID verified`, samples && `${samples} sample`, list.length - verified - samples && `${list.length - verified - samples} demo-order (simulated World check)`].filter(Boolean).join(", ");
  return { count: list.length, average: Math.round(avg * 10) / 10, verified, samples, label: `${avg.toFixed(1)} / 5 from ${list.length} review${list.length === 1 ? "" : "s"} (${parts}; last ${REVIEW_DAYS} days)` };
}
// Publishes the team's SAMPLE reviews (sample-reviews.mjs) once: a review already on Arkiv (same sample reference) is skipped.
export async function seedSampleReviews(log = console.log) {
  const { SAMPLE_REVIEWS } = await import("./sample-reviews.mjs");
  let added = 0;
  for (const [sellerId, list] of Object.entries(SAMPLE_REVIEWS)) {
    const have = new Set((await readReviews(sellerId)).filter((x) => x.kind === SAMPLE_KIND).map((x) => x.orderRef));
    for (const [i, x] of list.entries()) {
      const id = `sample|${sellerId}|${i}`; if (have.has(orderRef(id))) continue;
      const out = await publishReview({ sellerId, orderId: id, packageId: "sample", rating: x.rating, text: x.text, kind: SAMPLE_KIND, human: "none", createdAt: Math.floor(Date.now() / 1000) - x.daysAgo * 86400 });
      added++; log(`${sellerId} ${x.rating}/5 ${out.source} ${String(out.entityKey).slice(0, 18)}`);
    }
  }
  log(`${added} sample review(s) published (${live() ? "Arkiv" : "simulated file"}); labelled "sample", not World ID verified.`);
  return added;
}
export async function sellerRating(sellerId) {
  try { return summarise(await readReviews(sellerId)); }
  catch { return { count: null, average: null, label: "Rating unavailable (Arkiv didn't answer)" }; }
}
