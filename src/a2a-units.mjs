// Prices in a negotiation are in a unit's smallest denomination: the payment asset by default, or listing.unit
// (PC packages are priced in display USDC, never paid in crypto).
import { ASSET } from "./asset.mjs";
export const unitOf = (l) => l?.unit ?? ASSET;
export const amount = (l, u) => Number(u) / 10 ** unitOf(l).decimals;
