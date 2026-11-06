# Arkiv schema

Network: **Rabdi testnet** (chain ID 7794095), written with `@arkiv-network/sdk`. Explorer: https://rabdi.explorer.arkiv.network

Four entity types. Every one has an owner wallet and an expiry, and the app checks the owner on every read.

| Entity | Owner (writer wallet) | Expiry | Live now |
|---|---|---|---|
| `ethpc.pc-offers.v1`: one product a shop sells | That shop's own wallet (one wallet per shop) | 7 days, renewable by the shop (`npm run shop -- renew`) | 44 |
| `ethpc.pc-sellers.v1`: a shop's profile | That shop's own wallet | 30 days | 3 |
| `ethpc.pc-reviews.v1`: a review of a shop | The review publisher wallet | 90 days, for every review | 31 |
| `ethpc.listings.usdc`: a paid API's listing (price, endpoint, payee) | The approved service owner wallet | 1 day; re-published before a demo | 12 (incl. `pc-recommend`) |

## Writer wallets

| Wallet | Writes |
|---|---|
| `0x00d4a9331add38bb2e0d7e32da9f687bf05a8d32` | **pixelbazaar** shop: profile + 15 offers |
| `0xc0020afb29fae96b31614c25d6d3ac23eb1fb5ff` | **voltforge** shop: profile + 13 offers |
| `0xf995383aba3b72151501ad4b49b475afa7390f1d` | **rigroom** shop: profile + 16 offers |
| `0x28ad3aa463b31584fac2dbee6958ab5dde79de6c` | API listings (incl. RigAdvisor `pc-recommend`) and reviews |

## Fields

### `ethpc.pc-offers.v1` (`src/pc-directory.mjs`)
| Field | Type | Indexed | Used for |
|---|---|---|---|
| `oid` | string | ✓ | Offer ID `<shop>:<product>`; looking one offer up |
| `sellerId` | string | ✓ | Which shop; must match the owner wallet's registered shop |
| `productId`, `category` | string | ✓ | What it is (cpu, gpu, ram, …) |
| `brand`, `model`, `specs` | string, string, bytes | | Shown to users; `specs` (socket, TDP, VRAM, …) feed the compatibility checks |
| `condition`, `warrantyMonths` | string, u64 | ✓ | New or used; warranty shown on used parts |
| `priceUnits` | u64 | ✓ | Price in USDC's smallest unit; range filters |
| `stock` | u64 | ✓ | `stock > 0` on every read |
| `deliveryFeeUnits`, `freeOverUnits` | u64 | | Delivery cost of a package |
| `deliveryDays` | u64 | ✓ | Delivery estimate on the order page |
| `deliversTo` | string | ✓ | Regions the shop delivers to |
| `endpoint` | string | | The shop's A2A sales agent |
| `hederaPayTo` | string | ✓ | The shop's Hedera account; must match the registry |
| `validUntil` | u64 (unix s) | ✓ | `validUntil > now` on every read; kept in step with the entity's expiry |

### `ethpc.pc-sellers.v1`
`sellerId` (indexed), `name`, `city`, `about`, `endpoint`, `hederaPayTo`, `deliveryDays` (u64). Read with `sellerId IN (registered shops)`.

### `ethpc.pc-reviews.v1` (`src/reviews.mjs`)
`sellerId` (indexed), `orderRef` (indexed, a one-way hash of the order, never the order ID), `packageId`, `rating` (u64, indexed), `text` (bytes, max 280 chars; emails, links and phone numbers refused), `kind` (indexed), `human`, `createdAt` (u64, indexed). Read with `sellerId = X` **and** `ownedBy(publisher wallet)`, so reviews written by anyone else never count. No name, email, World ID or address is stored.

The 31 live reviews are **sample reviews seeded by the team** (`kind = "sample"`, `npm run seed:reviews`) so the ratings aren't empty at launch. Reviews written through the app after a World ID check carry `human = "world-verified"`.

### `ethpc.listings.usdc` (`src/directory.mjs`)
`lk` (listing key, indexed), `name`, `category` (indexed), `region` (indexed), `priceTinybars` (price in USDC's smallest unit, indexed string), `freshnessMinutes` (indexed), `endpoint`, `hederaPayTo`. The agent finds the paid recommendation API here (`lk = "pc-recommend"`), and only listings owned by an approved wallet count.

## Queries the app runs
| Where | Query on Arkiv | Then, in code |
|---|---|---|
| Building three PCs (`src/pc-inventory.mjs`) | offers where `stock > 0 AND validUntil > now` (one query, cached 30 s) | owner = shop's registered wallet, payee = registered account, region, new/used, then compatibility and ranking |
| Shop profiles | sellers where `sellerId = pixelbazaar OR voltforge OR rigroom` | owner and payee checked against the registry |
| Seller reviews and rating | reviews where `sellerId = X`, `ownedBy(publisher)` | drop expired; rating = average of active reviews |
| Finding the paid API | listings where `lk = "pc-recommend"` (and `category`, `region` for searches) | only approved owners; newest-expiring copy wins |
| A shop managing its stock | offers where `sellerId = X`, `ownedBy(shop wallet)` | publish, `patchEntity` price/stock, `extendEntity` to renew |

Run one yourself, no keys needed: `node arkiv/query.mjs` (see the README).
