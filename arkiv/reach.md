# Reach

## Who it's for
- **PC buyers who don't want to research parts.** They say what they play and what they can spend; an agent compares complete, compatible PCs across shops and haggles for them, while it can only spend what they allowed.
- **Independent PC shops.** They publish their catalogue once, from their own wallet, and any buyer agent can find it. No marketplace account, no listing fee, and nobody else can change their prices.
- **Builders of other shopping agents.** The shop catalogue and reviews are public Arkiv data: another agent can use `ethpc.pc-offers.v1` with no API key or partnership.

## Can they try it today?
- **Yes, locally:** clone the repo, follow "Run it" in the README, and open http://localhost:4000. It runs fully offline in simulated mode without any keys, or against Rabdi and Hedera testnet with them.
- **The data is already live:** `node arkiv/query.mjs` reads the 44 live offers from Rabdi with no setup beyond `npm install`.
- Not yet deployed to a public URL.

## Numbers today
| | |
|---|---|
| Shops publishing on Arkiv | 3 (each from its own wallet) |
| Live offers | 44 across 11 part categories |
| Live reviews | 31 (seeded samples) |
| Paid API listings | 1 (`pc-recommend`, 0.05 USDC per request) |

## After Mumbai
_Team: replace this with your own plans, honestly (e.g. onboarding a first real shop, a public deployment, opening the offer schema to other agents)._
