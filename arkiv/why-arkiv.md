# Why Arkiv

EthPC is a marketplace where an AI agent buys on a user's behalf. The shop catalogue and the reviews are the shared state that every party has to trust, so they live on Arkiv.

## If Arkiv were swapped for Postgres, users would lose

| With Arkiv | With our own database |
|---|---|
| **Each shop publishes and edits its own offers** from its own wallet (`ethpc.pc-offers.v1`). Nobody else, including EthPC, can change a shop's price or stock. | EthPC would hold every shop's prices and could change them; shops and buyers would have to trust us. |
| **An offer is only trusted if the shop's own wallet signed it.** The agent rejects copies published by anyone else (`offerProblem()` in `src/pc-directory.mjs`). | A row in our table says whatever we wrote. |
| **Any other agent or app can read the same catalogue** with a public query (`node arkiv/query.mjs`), with no API key and no account with us. | The catalogue is locked inside EthPC. |
| **Stale offers disappear by themselves.** An offer expires at the end of its offer period unless the shop renews it, so the agent never builds a PC from parts a shop stopped selling. | Someone has to remember to delete old rows. |
| **Reviews can't be edited by the shops they're about**, and every review expires after 90 days, so a shop's rating reflects recent buyers. | The operator (or a shop with access) could quietly remove bad reviews. |
| **The paid API is discovered on Arkiv**: the agent finds the recommendation service, its price and its payee in a listing owned by an approved wallet, and refuses impostor listings. | The service address and price would be hard-coded in the agent. |

## What we kept off Arkiv, and why

| Data | Where | Why not Arkiv |
|---|---|---|
| Payments, allowances, refunds | Hedera (HTS USDC) | It's money: it needs Hedera's token service and allowances |
| The Guard's decision log | Hedera Consensus Service | Tamper-evident ordering of the agent's spending, verified against the token transfers |
| Orders, delivery state, "one review per order" | The Guard's SQLite | Tied to private purchase details, and must outlast a review's 90 days so an expired review can't be posted again |
| World ID results, Google accounts | The Guard and the web server | Personal data; never public |
| Negotiation quotes | The shop's service (5-minute life) | Private between the two agents until checkout |
| Review text with contact details | Refused before publishing | Arkiv entities are public |

## Honest limits
- The review publisher wallet belongs to the team, so the team could still edit or delete reviews. Shops can't.
- 31 of the 32 reviews live today are seeded samples (`kind = "sample"`), so ratings aren't empty at launch.
