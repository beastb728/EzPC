// Product offers and seller profiles on Arkiv. Live once `npm run setup:shops` has written each shop's wallet and payee to .env
// and the shops have published (`npm run shop -- publish <shop>`); otherwise an in-memory stand-in with the same rules.
// Anyone can write to Arkiv, so an offer only counts when BOTH match the shop registry (pc-catalog.mjs):
//   its Arkiv owner is the shop's publishing wallet, and its Hedera payee is the shop's payment account.
import { hexToString, stringToHex } from "viem";
import { modes, url } from "./common.mjs";
import { OFFERS, SHOPS, offerRecord, shopById, shopRegistry, offerId as mkOfferId } from "./pc-catalog.mjs";

const APP = "agentleash-prototype-do-not-submit";
const BLOCK_MS = 2000; // Rabdi: about one block every 2 seconds; Arkiv expiry is a block number.
export const isLive = () => modes().shops === "live";
const shopEndpoint = (id) => url("sellers", `/shops/${id}`);

// ---------- simulated store (same shape as live results) ----------
let sim = null;
function simStore() {
  if (sim) return sim;
  sim = { offers: [], sellers: [] };
  for (const x of OFFERS) { const reg = shopRegistry(x.sellerId, false); const r = offerRecord(x, { endpoint: shopEndpoint(x.sellerId), hederaPayTo: reg.hederaPayTo }); sim.offers.push({ ...r, owner: reg.arkivOwner, expiresAt: r.validUntil * 1000, entityKey: `sim:${r.offerId}`, source: "simulated" }); }
  for (const s of SHOPS) sim.sellers.push({ ...profileRecord(s, s.sim.hederaPayTo), owner: s.sim.arkivOwner, entityKey: `sim:seller:${s.sellerId}`, source: "simulated" });
  return sim;
}
// Test hook: lets simulated tests change a price or stock, as a shop would with `npm run shop -- update`.
export function simPatch(oid, changes) { const o = simStore().offers.find((x) => x.offerId === oid); if (!o) throw new Error("no such offer"); Object.assign(o, changes); return o; }
export function simReset() { sim = null; }

const profileRecord = (s, hederaPayTo) => ({ sellerId: s.sellerId, name: s.name, city: s.city, about: s.about, endpoint: shopEndpoint(s.sellerId), hederaPayTo, deliveryDays: s.delivery.days });

// ---------- live Arkiv ----------
async function arkiv(key) {
  const [{ createPublicClient, createWalletClient, ExpirationTime }, { rabdi }, { http }, { privateKeyToAccount }, s, q] = await Promise.all([import("@arkiv-network/sdk"), import("@arkiv-network/sdk/chains"), import("viem"), import("viem/accounts"), import("@arkiv-network/sdk/schema"), import("@arkiv-network/sdk/query")]);
  const chain = rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" });
  // Numbers are u64 so they can be range-filtered (price, stock, warranty, delivery days, expiry). Specs are a JSON blob.
  const Offers = s.defineSchema(`${APP}.pc-offers.v1`, {
    oid: s.str().indexed(), sellerId: s.str().indexed(), productId: s.str().indexed(), category: s.str().indexed(), brand: s.str(), model: s.str(), specs: s.bytes(),
    condition: s.str().indexed(), warrantyMonths: s.u64().indexed(), priceUnits: s.u64().indexed(), stock: s.u64().indexed(),
    deliveryFeeUnits: s.u64(), freeOverUnits: s.u64(), deliveryDays: s.u64().indexed(), deliversTo: s.str().indexed(), endpoint: s.str(), hederaPayTo: s.str().indexed(), validUntil: s.u64().indexed(),
  });
  const Sellers = s.defineSchema(`${APP}.pc-sellers.v1`, { sellerId: s.str().indexed(), name: s.str(), city: s.str(), about: s.str(), endpoint: s.str(), hederaPayTo: s.str(), deliveryDays: s.u64() });
  const out = { Offers, Sellers, q, ExpirationTime, u64: s.u64, bytes: s.bytes, pub: createPublicClient({ chain, transport: http(undefined, { timeout: 8000, retryCount: 1 }) }) };
  if (key) { out.account = privateKeyToAccount(key); out.wallet = createWalletClient({ chain, transport: http(), account: out.account }); }
  return out;
}
const v = (e, k) => e[k]?.value;
const OFFER_FIELDS = ["oid", "sellerId", "productId", "category", "brand", "model", "specs", "condition", "warrantyMonths", "priceUnits", "stock", "deliveryFeeUnits", "freeOverUnits", "deliveryDays", "deliversTo", "endpoint", "hederaPayTo", "validUntil"];
const normOffer = (e, block) => ({
  offerId: v(e, "oid"), sellerId: v(e, "sellerId"), productId: v(e, "productId"), category: v(e, "category"), brand: v(e, "brand"), model: v(e, "model"),
  specs: (() => { try { return JSON.parse(hexToString(v(e, "specs"))); } catch { return {}; } })(),
  condition: v(e, "condition"), warrantyMonths: Number(v(e, "warrantyMonths")), priceUnits: String(v(e, "priceUnits")), stock: Number(v(e, "stock")),
  deliveryFeeUnits: String(v(e, "deliveryFeeUnits")), freeOverUnits: String(v(e, "freeOverUnits")), deliveryDays: Number(v(e, "deliveryDays")), regions: [v(e, "deliversTo")],
  endpoint: v(e, "endpoint"), hederaPayTo: v(e, "hederaPayTo"), validUntil: Number(v(e, "validUntil")),
  owner: String(e.$owner).toLowerCase(), expiresAt: Date.now() + Number(BigInt(e.$expiresAt) - block) * BLOCK_MS, entityKey: e.$key, source: "arkiv",
});
async function liveOffers(where) {
  const a = await arkiv();
  const fields = Object.fromEntries(["$key", "$owner", "$expiresAt", ...OFFER_FIELDS].map((k) => [k, true]));
  const r = await a.pub.select(fields).from(a.Offers).where(where(a.q, a.u64)).fetch();
  return r.entities.map((e) => normOffer(e, BigInt(r.blockNumber)));
}
async function liveSellers() {
  const a = await arkiv();
  const fields = Object.fromEntries(["$key", "$owner", "sellerId", "name", "city", "about", "endpoint", "hederaPayTo", "deliveryDays"].map((k) => [k, true]));
  const r = await a.pub.select(fields).from(a.Sellers).where(a.q.or(...SHOPS.map((s) => a.q.eq("sellerId", s.sellerId)))).fetch();
  return r.entities.map((e) => ({ sellerId: v(e, "sellerId"), name: v(e, "name"), city: v(e, "city"), about: v(e, "about"), endpoint: v(e, "endpoint"), hederaPayTo: v(e, "hederaPayTo"), deliveryDays: Number(v(e, "deliveryDays")), owner: String(e.$owner).toLowerCase(), entityKey: e.$key, source: "arkiv" }));
}

// ---------- trust rules ----------
// Why an offer doesn't count, or null if it does. Checked on every read, and again by the Guard before payment.
export function offerProblem(o, now = Date.now()) {
  const reg = shopRegistry(o.sellerId, o.source === "arkiv");
  if (!reg || !reg.arkivOwner) return `unknown seller ${o.sellerId}`;
  if (o.owner !== reg.arkivOwner) return `published by ${o.owner}, not ${o.sellerId}'s registered wallet`;
  if (o.hederaPayTo !== reg.hederaPayTo) return `pays ${o.hederaPayTo}, not ${o.sellerId}'s registered account ${reg.hederaPayTo}`;
  if (o.validUntil * 1000 <= now || o.expiresAt <= now) return "offer has expired";
  if (!(o.stock > 0)) return "out of stock";
  return null;
}
// Keep only trusted, unexpired, in-stock offers; if a shop has several copies of one offer, the newest-expiring wins.
function trusted(list) {
  const best = new Map();
  for (const o of list) { if (offerProblem(o)) continue; const k = o.offerId, cur = best.get(k); if (!cur || o.expiresAt > cur.expiresAt) best.set(k, o); }
  return [...best.values()];
}

// ---------- reads ----------
// The built-in demo catalog, for when Arkiv can't be reached. Labelled "simulated"; its payees are fake, so nothing can be paid from it.
export const simulatedOffers = () => trusted(simStore().offers);
export const simulatedSellers = () => simStore().sellers;
export async function searchOffers({ category, condition, region = "IN", maxPriceUnits } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const all = isLive()
    ? await liveOffers((q, U) => q.and(...[category && q.eq("category", category), q.gt("stock", U(0)), q.gt("validUntil", U(now)), maxPriceUnits && q.lte("priceUnits", U(maxPriceUnits))].filter(Boolean)))
    : simStore().offers.filter((x) => (!category || x.category === category) && (!maxPriceUnits || BigInt(x.priceUnits) <= BigInt(maxPriceUnits)));
  return trusted(all).filter((x) => (!condition || condition === "any" || x.condition === condition) && x.regions.includes(region));
}
export async function getOffer(oid) {
  const all = isLive() ? await liveOffers((q) => q.eq("oid", oid)) : simStore().offers.filter((x) => x.offerId === oid);
  const ok = trusted(all)[0];
  return ok ?? (all[0] ? { ...all[0], problem: offerProblem(all[0]) } : null);
}
// Seller profiles, only from the shop's own registered wallet.
export async function listSellers() {
  const all = isLive() ? await liveSellers() : simStore().sellers;
  const out = new Map();
  for (const s of all) { const reg = shopRegistry(s.sellerId, s.source === "arkiv"); if (reg?.arkivOwner && s.owner === reg.arkivOwner && s.hederaPayTo === reg.hederaPayTo) out.set(s.sellerId, s); }
  return [...out.values()];
}

// ---------- seller flow (live only; run by a shop with its own wallet) ----------
const keyFor = (id) => { const k = process.env[`SHOP_${id.toUpperCase()}_ARKIV_PRIVATE_KEY`]; if (!k) throw new Error(`SHOP_${id.toUpperCase()}_ARKIV_PRIVATE_KEY is not set; run npm run setup:shops`); return k; };
const offerValues = (r, U, B) => ({
  oid: r.offerId, sellerId: r.sellerId, productId: r.productId, category: r.category, brand: r.brand.slice(0, 120), model: r.model.slice(0, 120), specs: B(stringToHex(JSON.stringify(r.specs))),
  condition: r.condition, warrantyMonths: U(r.warrantyMonths), priceUnits: U(r.priceUnits), stock: U(r.stock),
  deliveryFeeUnits: U(r.deliveryFeeUnits), freeOverUnits: U(r.freeOverUnits), deliveryDays: U(r.deliveryDays), deliversTo: r.regions[0], endpoint: r.endpoint, hederaPayTo: r.hederaPayTo, validUntil: U(r.validUntil),
});
async function ownOffers(a, sellerId) {
  const fields = Object.fromEntries(["$key", "$owner", "$expiresAt", ...OFFER_FIELDS].map((k) => [k, true]));
  const r = await a.pub.select(fields).from(a.Offers).where(a.q.eq("sellerId", sellerId)).ownedBy(a.account.address).fetch();
  return r.entities.map((e) => normOffer(e, BigInt(r.blockNumber)));
}
// Publish the shop's profile and every catalog offer it doesn't already have live. Re-running updates, never duplicates.
export async function publishShop(sellerId, log = console.log) {
  const s = shopById(sellerId); if (!s) throw new Error(`unknown shop ${sellerId}`);
  const reg = shopRegistry(sellerId, true); if (!reg.hederaPayTo) throw new Error("SELLER_ACCOUNT_ID is not set");
  const a = await arkiv(keyFor(sellerId));
  if (a.account.address.toLowerCase() !== reg.arkivOwner) throw new Error("this key isn't the shop's registered Arkiv wallet");
  const prof = profileRecord(s, reg.hederaPayTo);
  const hasProfile = (await a.pub.select({ $key: true }).from(a.Sellers).where(a.q.eq("sellerId", sellerId)).ownedBy(a.account.address).fetch()).entities.length;
  if (!hasProfile) { const { entityKey: pk } = await a.wallet.createEntity(a.Sellers, { ...prof, deliveryDays: a.u64(prof.deliveryDays) }, { expiration: a.ExpirationTime.fromDays(30) }); log(`profile ${sellerId} ${pk}`); }
  const have = new Map((await ownOffers(a, sellerId)).filter((o) => o.expiresAt > Date.now()).map((o) => [o.offerId, o]));
  for (const x of OFFERS.filter((o) => o.sellerId === sellerId)) {
    const r = offerRecord(x, { endpoint: shopEndpoint(sellerId), hederaPayTo: reg.hederaPayTo }), old = have.get(r.offerId);
    if (old) { await a.wallet.patchEntity(a.Offers, old.entityKey, { set: offerValues(r, a.u64, a.bytes) }); log(`updated ${r.offerId}`); continue; }
    const { entityKey } = await a.wallet.createEntity(a.Offers, offerValues(r, a.u64, a.bytes), { expiration: a.ExpirationTime.fromDays(x.validDays) });
    log(`offer ${r.offerId} ${entityKey}`);
  }
}
// Change price or stock on one of the shop's own offers.
export async function updateOffer(sellerId, productId, { priceUnits, stock }, log = console.log) {
  const a = await arkiv(keyFor(sellerId));
  const o = (await ownOffers(a, sellerId)).find((x) => x.offerId === mkOfferId(sellerId, productId) && x.expiresAt > Date.now());
  if (!o) throw new Error("no live offer to update; publish first");
  const set = {}; if (priceUnits != null) set.priceUnits = a.u64(priceUnits); if (stock != null) set.stock = a.u64(stock);
  await a.wallet.patchEntity(a.Offers, o.entityKey, { set });
  log(`updated ${o.offerId}: ${JSON.stringify({ priceUnits: set.priceUnits?.toString(), stock: set.stock?.toString() })}`);
}
// Extend every live offer by `days` and move its validUntil to match.
export async function renewShop(sellerId, days = 7, log = console.log) {
  const a = await arkiv(keyFor(sellerId));
  for (const o of (await ownOffers(a, sellerId)).filter((x) => x.expiresAt > Date.now())) {
    await a.wallet.extendEntity({ entityKey: o.entityKey, expiration: a.ExpirationTime.fromDays(days) });
    await a.wallet.patchEntity(a.Offers, o.entityKey, { set: { validUntil: a.u64(Math.floor(Date.now() / 1000) + days * 86400) } });
    log(`renewed ${o.offerId} for ${days} days`);
  }
}
