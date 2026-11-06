# Arkiv feedback

What got in the way while building EthPC on Rabdi, and what would help. Each item is something we hit in this code.

## 1. Expiry comes back as a block number, not a time
**Expected:** `$expiresAt` as a timestamp, so "expires in 3 days" is one line.
**What happened:** it's a block number. We hard-code `BLOCK_MS = 2000` (Rabdi's ~2 s blocks) and convert, in two files (`src/directory.mjs`, `src/pc-directory.mjs`). If block time changes, every expiry we show is wrong.
**Would help:** return `expiresAt` as a time too, or expose the block time from the chain config.
**Reproduce:** `select({ $expiresAt: true })` on any entity; compare with `ExpirationTime.fromDays(1)` used to write it.

## 2. No "update or insert" by attribute, so re-publishing duplicates
**Expected:** publishing a shop's catalogue twice leaves one entity per product.
**What happened:** `createEntity` always adds; our first `seed:arkiv` re-runs created extra copies. Every reader now keeps only the copy that expires last (`trusted()` in `src/pc-directory.mjs`, `getListing()` in `src/directory.mjs`), and the publisher first queries its own entities to avoid writing duplicates.
**Would help:** an upsert keyed on an indexed attribute plus owner (e.g. `oid` + `$owner`).

## 3. Renaming a schema means republishing everything
**What happened:** we renamed our entity types (to `ethpc.*`). There's no rename or migration, so we re-wrote 3 profiles, 44 offers, 12 listings and 31 reviews from four wallets. The old copies stay readable until they expire.
**Would help:** a documented migration pattern, or a way to bulk-copy owned entities to a new type.

## 4. The public endpoint is heavily rate limited without an access key
**What happened:** without `ARKIV_ACCESS_KEY` the SDK warns that requests go to a rate-limited endpoint. Our 30 s offer cache and a saved last-good copy exist partly because of this.
**Would help:** a higher keyless limit for read-only `select` on testnet, or clearer numbers for the limit in the docs.

## 5. Values come back wrapped, and `$owner` is mixed-case
**What happened:** selected fields arrive as `{"type":"str","value":"rigroom"}`, and `$owner` comes back checksummed (`0xf995383ABA3b…`) while wallets are usually stored lowercase. Every owner check in our trust rules has to lowercase both sides; an owner check that silently fails on casing would be a security bug.
**Would help:** a plain typed result (`entity.sellerId === "rigroom"`) and a documented, normalised `$owner`.
**Reproduce:** `select({ $owner: true, sellerId: true })` on any `ethpc.pc-sellers.v1` entity.

## What worked well
- Owner-scoped queries (`ownedBy`) made "only the shop's own wallet counts" a one-liner.
- `extendEntity` and `patchEntity` let a shop renew offers and change price or stock without new entities.
- Costs were tiny: republishing everything cost 0.0112 tGLM for the listings and reviews wallet, and 0.0034–0.0042 tGLM per shop.
