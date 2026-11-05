// Service directory: real Arkiv once seeded and APPROVED_OWNERS is set; otherwise an in-memory stand-in.
// Anyone can write a listing to Arkiv, so only listings owned by an approved wallet count.
import { LISTINGS, TRUSTED_OWNER, ATTACKER } from "./catalog.mjs";
import { modes, url } from "./common.mjs";
import { ASSET, isHbar } from "./asset.mjs";
const live = () => modes().arkiv === "live";
const sim = LISTINGS.map((x) => ({ ...x, endpoint: url("sellers", x.endpoint), expiresAt: Date.now() + x.ttlHours * 3600_000, source: "simulated" }));
export const APPROVED_OWNERS = () => (process.env.APPROVED_OWNERS || TRUSTED_OWNER).toLowerCase().split(",").map((x) => x.trim());
const approved = (l) => APPROVED_OWNERS().includes(l.owner.toLowerCase());
// Prices are stored in the asset's smallest unit, so USDC listings live in their own schema and HBAR ones stay untouched.
const SCHEMA = `agentleash-prototype-do-not-submit.listings${isHbar ? "" : `.${ASSET.key}`}`;
const BLOCK_MS = 2000; // Rabdi makes a block about every 2 seconds; expiry is stored as a block number.
async function arkiv(key = process.env.ARKIV_PRIVATE_KEY) {
  const [{ createPublicClient, createWalletClient, ExpirationTime }, { rabdi }, { http }, { privateKeyToAccount }, s, q] = await Promise.all([import("@arkiv-network/sdk"), import("@arkiv-network/sdk/chains"), import("viem"), import("viem/accounts"), import("@arkiv-network/sdk/schema"), import("@arkiv-network/sdk/query")]);
  const chain = rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" });
  const account = privateKeyToAccount(key);
  const Listings = s.defineSchema(SCHEMA, { lk: s.str().indexed(), name: s.str(), category: s.str().indexed(), region: s.str().indexed(), priceTinybars: s.str().indexed(), freshnessMinutes: s.str().indexed(), endpoint: s.str(), hederaPayTo: s.str() });
  return { account, Listings, q, ExpirationTime, pub: createPublicClient({ chain, transport: http() }), wallet: createWalletClient({ chain, transport: http(), account }) };
}
const norm = (e, block) => ({ key: e.lk.value, name: e.name.value, category: e.category.value, region: e.region.value, priceTinybars: e.priceTinybars.value, freshnessMinutes: Number(e.freshnessMinutes.value), endpoint: e.endpoint.value, hederaPayTo: e.hederaPayTo.value, owner: String(e.$owner).toLowerCase(), expiresAt: Date.now() + Number(BigInt(e.$expiresAt) - block) * BLOCK_MS, source: "arkiv", entityKey: e.$key });
async function arkivQuery(where) {
  const a = await arkiv();
  const fields = { $key: true, $owner: true, $expiresAt: true, lk: true, name: true, category: true, region: true, priceTinybars: true, freshnessMinutes: true, endpoint: true, hederaPayTo: true };
  const r = await a.pub.select(fields).from(a.Listings).where(where(a.q)).fetch();
  return r.entities.map((e) => norm(e, BigInt(r.blockNumber)));
}
// The agent only ever sees approved, unexpired listings.
export async function search({ category, region = "MH" }) {
  const all = live() ? await arkivQuery((q) => q.and(q.eq("category", category), q.eq("region", region))) : sim.filter((x) => x.category === category && x.region === region);
  const seen = new Set();
  return all.filter((x) => approved(x) && x.expiresAt > Date.now()).sort((a, b) => b.expiresAt - a.expiresAt).filter((x) => !seen.has(x.key) && seen.add(x.key));
}
// If several listings share a name, an approved one wins; otherwise the Guard gets the impostor and blocks it.
export async function getListing(key) {
  const all = live() ? await arkivQuery((q) => q.eq("lk", key)) : sim.filter((x) => x.key === key);
  return all.filter(approved).sort((a, b) => b.expiresAt - a.expiresAt)[0] ?? all[0] ?? null;
}
const fields = (x, payTo = x.hederaPayTo) => ({ lk: x.key, name: x.name, category: x.category, region: x.region, priceTinybars: x.priceTinybars, freshnessMinutes: String(x.freshnessMinutes), endpoint: url("sellers", x.endpoint), hederaPayTo: payTo });
export async function seedArkiv() {
  const a = await arkiv();
  for (const x of LISTINGS.filter((l) => l.ttlHours > 0 && l.owner === TRUSTED_OWNER && !l.noSeed)) {
    const { entityKey } = await a.wallet.createEntity(a.Listings, fields(x), { expiration: a.ExpirationTime.fromDays(1) });
    console.log(x.key, entityKey);
  }
  console.log(`writer wallet ${a.account.address}, prices in ${ASSET.symbol}`);
}
// Attack test: a throwaway wallet, funded with a little tGLM, writes listings that impersonate a real seller and push a drain.
// Its key is never saved. The Guard should ignore all of them.
export async function seedImpostor() {
  const [{ generatePrivateKey }, { parseEther }] = await Promise.all([import("viem/accounts"), import("viem")]);
  const a = await arkiv(), bad = await arkiv(generatePrivateKey());
  const tx = await a.wallet.sendTransaction({ to: bad.account.address, value: parseEther("0.3") });
  await a.pub.waitForTransactionReceipt({ hash: tx });
  const mandi = LISTINGS.find((l) => l.key === "mandifresh"), drain = LISTINGS.find((l) => l.key === "drain");
  for (const [x, payTo, extra] of [[mandi, ATTACKER, { freshnessMinutes: "1", name: "MandiFresh" }], [drain, ATTACKER, {}]]) {
    const { entityKey } = await bad.wallet.createEntity(bad.Listings, { ...fields(x, payTo), ...extra }, { expiration: bad.ExpirationTime.fromDays(1) });
    console.log(`impostor ${x.key}`, entityKey);
  }
  console.log("impostor wallet", bad.account.address);
}
