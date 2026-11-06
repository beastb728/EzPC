// One query judges can run, no keys needed: graphics cards in stock, still on offer, at or under a price, published by
// EthPC's three shop wallets on Arkiv's Rabdi testnet. This is the same filter the agent uses to build a PC.
//   npm install && node arkiv/query.mjs            (optional: node arkiv/query.mjs cpu 300)
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http } from "viem";
import * as s from "@arkiv-network/sdk/schema";
import * as q from "@arkiv-network/sdk/query";

const SHOP_WALLETS = {
  pixelbazaar: "0x00d4a9331add38bb2e0d7e32da9f687bf05a8d32",
  voltforge: "0xc0020afb29fae96b31614c25d6d3ac23eb1fb5ff",
  rigroom: "0xf995383aba3b72151501ad4b49b475afa7390f1d",
};
const [category = "gpu", maxUsdc = "800"] = process.argv.slice(2);
const Offers = s.defineSchema("ethpc.pc-offers.v1", {
  oid: s.str().indexed(), sellerId: s.str().indexed(), productId: s.str().indexed(), category: s.str().indexed(), brand: s.str(), model: s.str(), specs: s.bytes(),
  condition: s.str().indexed(), warrantyMonths: s.u64().indexed(), priceUnits: s.u64().indexed(), stock: s.u64().indexed(),
  deliveryFeeUnits: s.u64(), freeOverUnits: s.u64(), deliveryDays: s.u64().indexed(), deliversTo: s.str().indexed(), endpoint: s.str(), hederaPayTo: s.str().indexed(), validUntil: s.u64().indexed(),
});
const pub = createPublicClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" }), transport: http() });
const now = BigInt(Math.floor(Date.now() / 1000));
const res = await pub.select({ $key: true, $owner: true, sellerId: true, brand: true, model: true, condition: true, priceUnits: true, stock: true })
  .from(Offers)
  .where(q.and(q.eq("category", category), q.gt("stock", s.u64(0)), q.gt("validUntil", s.u64(now)), q.lte("priceUnits", s.u64(BigInt(Math.round(Number(maxUsdc) * 1e6))))))
  .fetch();
const v = (e, k) => e[k]?.value ?? e[k];
const rows = res.entities
  .filter((e) => SHOP_WALLETS[v(e, "sellerId")] === String(e.$owner).toLowerCase()) // only offers signed by that shop's own wallet count
  .map((e) => ({ shop: v(e, "sellerId"), item: `${v(e, "brand")} ${v(e, "model")}`, condition: v(e, "condition"), usdc: Number(v(e, "priceUnits")) / 1e6, stock: Number(v(e, "stock")), entity: e.$key }))
  .sort((a, b) => a.usdc - b.usdc);
console.log(`${category} offers in stock at or under ${maxUsdc} USDC, from EthPC's shop wallets (ethpc.pc-offers.v1 on Rabdi):`);
console.table(rows);
console.log(`${rows.length} of ${res.entities.length} matching entities were published by the shop's own wallet.`);
