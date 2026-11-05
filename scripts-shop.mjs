// The seller flow, run by a demo shop with its own Arkiv wallet (SHOP_<ID>_ARKIV_PRIVATE_KEY). Testnet (Rabdi) only.
//   npm run shop -- publish <shop|all>                      profile + offers; re-running updates instead of duplicating
//   npm run shop -- update <shop> <productId> price=579 stock=3   price in whole USDC (full scale)
//   npm run shop -- renew <shop|all> [days]                  extend every live offer and its validUntil
import { publishShop, updateOffer, renewShop } from "./src/pc-directory.mjs";
import { SHOPS, usdc } from "./src/pc-catalog.mjs";
const [cmd, shop, ...rest] = process.argv.slice(2);
const shops = shop === "all" ? SHOPS.map((s) => s.sellerId) : [shop];
if (!["publish", "update", "renew"].includes(cmd) || !shop) { console.log("usage: publish <shop|all> | update <shop> <productId> price=<usdc> stock=<n> | renew <shop|all> [days]"); process.exit(1); }
if (cmd === "publish") for (const s of shops) await publishShop(s);
if (cmd === "renew") for (const s of shops) await renewShop(s, Number(rest[0] ?? 7));
if (cmd === "update") {
  const kv = Object.fromEntries(rest.slice(1).map((x) => x.split("=")));
  await updateOffer(shop, rest[0], { priceUnits: kv.price != null ? usdc(kv.price) : undefined, stock: kv.stock != null ? Number(kv.stock) : undefined });
}
