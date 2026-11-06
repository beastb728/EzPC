# How EthPC uses Arkiv

Every Arkiv feature we use changes something the user sees. Entity definitions are in [schema.md](schema.md).

## Filtered fields
| Filter | Runs on | What the user sees |
|---|---|---|
| `stock > 0` | Arkiv | Sold-out parts never appear in a recommended PC |
| `validUntil > now` | Arkiv | Offers past their deadline never appear, even before the entity itself expires |
| `sellerId = X` + `ownedBy(publisher)` | Arkiv | "Seller reviews" on each option, and the star rating next to the shop |
| `lk = "pc-recommend"` (+ `category`, `region`) | Arkiv | The agent finds the paid recommendation service, its price and payee; the fee shown in the app comes from this listing |
| `category`, `priceUnits ≤ budget` | Arkiv (in `arkiv/query.mjs` and `searchOffers()`) | The same filter a shop or another app can run: in-stock parts of a type under a price |
| owner wallet, Hedera payee, region, new/used | In code, on the Arkiv result | Offers signed by the wrong wallet, or paying the wrong account, are dropped; used parts are shown with their shorter warranty, and only when allowed |

The recommendation does **one** Arkiv query per 30 seconds (in stock and still valid) and then builds packages in code, because it needs every category at once to check compatibility (socket, power, case size) across parts.

## Who can edit what
| Entity | Who can change it | Visible effect |
|---|---|---|
| Offers, shop profile | Only that shop's wallet (`patchEntity` for price/stock, `extendEntity` to renew) | A price or stock change by the shop shows up in the next recommendation, within 30 s |
| Reviews | Only the publisher wallet; never the shop being reviewed | Ratings a shop can't tamper with |
| API listing | Only an approved owner wallet | Impostor listings with a different price or payee are ignored, and the Guard refuses to pay them |

## Expiry
| Entity | Expiry | Visible effect |
|---|---|---|
| Offers | 7 days, renewable | Parts a shop stops renewing drop out of recommendations on their own |
| Reviews | 90 days | "★ 4.4 from 11 World ID verified reviews in the last 90 days": the rating only counts recent buyers |
| API listing | 1 day | If the service stops re-listing, the agent stops finding and paying it |
| Shop profiles | 30 days | A shop that disappears stops being shown |

## Where to see it in the app
1. Build page → **Agent progress**: "Read shop listings and seller reviews from Arkiv (free)".
2. **Three complete PCs**: every part, price, stock and delivery estimate comes from an Arkiv offer.
3. **Seller reviews** under each option: read from Arkiv, with the 90-day window.
4. The recommendation fee and its payee: read from the `pc-recommend` listing.
