// All shop offers, read from Arkiv in one query and cached for 30 s. Arkiv's query is free; it isn't the paid product.
// The last good copy is saved to data/, so when Arkiv's RPC is slow or down the service keeps working from it,
// labelled with when it was read. With no saved copy it falls back to the built-in SAMPLE catalog, labelled as such.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { modes } from "./common.mjs";
import { searchOffers, simulatedOffers } from "./pc-directory.mjs";

export const PC = ["cpu", "motherboard", "ram", "gpu", "storage", "psu", "case", "cooler", "monitor", "keyboard", "mouse"];
const CACHE_FILE = "data/arkiv-offers-cache.json";
const hhmm = (t) => new Date(t).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
let cache = { at: 0, list: null, pending: null, from: null };

export async function allOffers() {
  if (cache.list && Date.now() - cache.at < 30_000) return cache.list;
  cache.pending ??= searchOffers({ condition: "any" }).then((list) => {
    cache = { at: Date.now(), list, pending: null, from: modes().shops === "live" ? "arkiv" : "simulated" };
    if (cache.from === "arkiv") try { mkdirSync("data", { recursive: true }); writeFileSync(CACHE_FILE, JSON.stringify({ at: cache.at, list })); } catch {}
    return list;
  }, () => {
    let saved = cache.list ? { at: cache.at, list: cache.list } : null;
    if (!saved) try { saved = JSON.parse(readFileSync(CACHE_FILE, "utf8")); } catch {}
    const now = Date.now();
    cache = saved
      ? { at: now - 20_000, list: saved.list.filter((o) => o.validUntil * 1000 > now && o.expiresAt > now), pending: null, from: `arkiv, cached ${hhmm(saved.at)} (Arkiv didn't answer)` }
      : { at: now - 20_000, list: simulatedOffers(), pending: null, from: "simulated sample catalog (Arkiv unreachable)" };
    return cache.list;
  });
  return cache.pending;
}
// Where the last list came from: "arkiv", "simulated", or a labelled fallback.
export const offersSource = () => cache.from ?? modes().shops;
// Offers by category, for one condition setting and delivery region.
export async function offersFor(condition, region = "IN") {
  const list = (await allOffers()).filter((o) => (condition === "any" || o.condition === condition) && o.regions.includes(region));
  return Object.fromEntries(PC.map((c) => [c, list.filter((o) => o.category === c)]));
}
