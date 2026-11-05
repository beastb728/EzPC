// The team-run PC recommendation API ("RigAdvisor"). One paid call returns up to three complete PC packages.
// The x402 fee buys this work and data. It never covers a PC: PCs are paid by (simulated) card at checkout.
import { offersFor, offersSource } from "./pc-inventory.mjs";
import { planPackages } from "./planner.mjs";
import { sellerRating } from "./reviews.mjs";

export const SERVICE = "RigAdvisor (team-run demo recommendation API)";
// Checked BEFORE the payment request, so a malformed order is refused and nobody pays for an empty result.
export function badRequirements(r) {
  if (!r || typeof r !== "object") return "input.requirements is missing";
  if (!/^\d+$/.test(String(r.budgetUnits ?? ""))) return "requirements.budgetUnits must be the PC budget in micro-USDC";
  if (!r.target || typeof r.target !== "object") return "requirements.target is missing";
  if (!["IN", "OTHER"].includes(r.region)) return "requirements.region must be IN or OTHER";
  if (!["new", "any"].includes(r.condition)) return "requirements.condition must be new or any";
  return null;
}
export async function recommend(requirements) {
  const region = requirements.region === "OTHER" ? "IN" : requirements.region;
  // Used offers are always read: the planner only offers them as labelled alternatives when new parts were asked for.
  const plan = planPackages(requirements, await offersFor("any", region));
  const ratings = new Map();
  for (const p of plan.packages) if (!ratings.has(p.sellerId)) ratings.set(p.sellerId, await sellerRating(p.sellerId));
  return {
    service: SERVICE, generatedAt: new Date().toISOString(), inventory: offersSource(), sample: "Team-run demo shops with SAMPLE inventory. Not real products for sale.",
    ...plan, packages: plan.packages.map((p) => ({ ...p, sellerRating: ratings.get(p.sellerId) })),
  };
}
