// Negotiated quotes on Arkiv. When a shop's agent agrees a price, the shop publishes the quote from its own Arkiv wallet:
// readonly (nobody can change the agreed price afterwards) and living exactly as long as the quote is honoured (5 minutes).
// Anyone can open it on the explorer while it's valid; then Arkiv drops it on its own. Nothing here moves money: the PC
// checkout is simulated, and the shop's own copy of the quote (sellers /quotes/:id) is still what checkout trusts.
import { modes } from "./common.mjs";

const SCHEMA = "ethpc.pc-quotes.v1";
const live = () => modes().shops === "live";
const shopKey = (sellerId) => process.env[`SHOP_${String(sellerId).toUpperCase()}_ARKIV_PRIVATE_KEY`];
// Seconds left until the quote expires, rounded DOWN to whole 2 s blocks, so the Arkiv entry never outlives the quote.
export const quoteSeconds = (expiresAt, now = Date.now()) => Math.max(2, Math.floor((expiresAt - now) / 2000) * 2);

// q: { id, listing: "pkg:<packageId>", price, listPrice, asset, expiresAt }. Returns { entityKey, source }.
export async function publishQuote(sellerId, q) {
  if (!live() || !shopKey(sellerId)) return { entityKey: `sim:quote:${q.id}`, source: "simulated" };
  const [{ createWalletClient, ExpirationTime }, { rabdi }, { http }, { privateKeyToAccount }, s] = await Promise.all([import("@arkiv-network/sdk"), import("@arkiv-network/sdk/chains"), import("viem"), import("viem/accounts"), import("@arkiv-network/sdk/schema")]);
  const Quotes = s.defineSchema(SCHEMA, { quoteId: s.str().indexed(), sellerId: s.str().indexed(), packageId: s.str().indexed(), price: s.u64(), listPrice: s.u64(), unit: s.str(), agreedAt: s.u64(), expiresAt: s.u64().indexed() });
  const wallet = createWalletClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" }), transport: http(), account: privateKeyToAccount(shopKey(sellerId)) });
  const values = { quoteId: q.id, sellerId, packageId: String(q.listing).replace(/^pkg:/, ""), price: s.u64(BigInt(q.price)), listPrice: s.u64(BigInt(q.listPrice)), unit: String(q.asset ?? "").replace(/^display-/, ""), agreedAt: s.u64(Math.floor(Date.now() / 1000)), expiresAt: s.u64(Math.floor(q.expiresAt / 1000)) };
  const { entityKey } = await wallet.createEntity(Quotes, values, { expiration: ExpirationTime.fromSeconds(quoteSeconds(q.expiresAt)), flags: { readonly: true } });
  return { entityKey, source: "arkiv" };
}
