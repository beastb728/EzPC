# EthPC: developer and operations guide

Everything needed to set EthPC up from scratch, run a demo, and understand how the pieces fit. The README is the overview; this file is the detail. It holds no secrets: keys live only in `.env` (git-ignored) and your password manager.

---

## 1. Accounts and keys

| What | Where | What you get | Notes |
|---|---|---|---|
| Hedera testnet account (setup) | portal.hedera.com | Account ID and private key | Needs at least 40 test HBAR. `setup:hedera` creates the other accounts from it |
| Test USDC | faucet.circle.com (Hedera testnet) | USDC for the user wallet | Only after the wallet is associated with token `0.0.429274` (`setup:usdc`) |
| HashPack | browser extension | The user wallet, imported | Signs the allowance, step-ups and revoke |
| WalletConnect project | dashboard.reown.com (free) | `WALLETCONNECT_PROJECT_ID` | Needed for `WALLET=hashpack` |
| Arkiv | hub.arkiv.network | Access key; a wallet key holding tGLM | Without an access key the public endpoint is heavily rate limited |
| Google sign-in | console.cloud.google.com → Google Auth Platform | OAuth client ID and secret (Web application) | Redirect URI `http://localhost:4000/auth/google/callback`. While the app is in Testing, add every user as a test user |
| World ID | auth.world.org/portal (production) and sandbox.auth.world.org/portal | Client ID and secret for each | Production (`PROD_WORLD_*`, used with `WORLD_USE=production`) needs a real Orb-verified World ID in World App; the sandbox (`WORLD_*`) uses the sandbox World App from TestFlight |
| AI model | console.groq.com (or any OpenAI-compatible API) | API key | Model `openai/gpt-oss-120b` |

**Public IDs in use** (on-chain, safe to share):

| Role | ID |
|---|---|
| User wallet (Hedera) | `0.0.11289315` |
| Guard (Hedera) | `0.0.11289391` |
| Seller: the recommendation API (Hedera) | `0.0.11286079` |
| HCS audit topic | `0.0.11286082` |
| USDC token | `0.0.429274` (Circle, 6 decimals) |
| Arkiv: listings and reviews writer | `0x28ad3aa463b31584fac2dbee6958ab5dde79de6c` |
| Arkiv: shop wallets | pixelbazaar `0x00d4…8d32`, voltforge `0xc002…b5ff`, rigroom `0xf995…0f1d` (full addresses in `arkiv/schema.md`) |

## 2. Setup

1. `npm install`, then `cp .env.example .env` and fill in **testnet values only**: the setup account (`HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY`, `HEDERA_KEY_TYPE`), `PAY_ASSET=usdc`, `WALLET=hashpack`, `WALLETCONNECT_PROJECT_ID`, the Arkiv keys, the World client, the Google client and `SESSION_SECRET` (`openssl rand -hex 32`), and the LLM URL, key and model.
2. **`npm run setup:hedera`**: checks the setup account, then creates whatever is missing: the seller (1 HBAR), the Guard (10 HBAR), the user wallet (20 HBAR) and the HCS topic. Accounts already in `.env` are skipped. It appends IDs and keys to `.env` and prints only IDs.
3. **`npm run setup:usdc`**: associates USDC with the user, Guard and seller. Then get USDC for the user from faucet.circle.com, and import the user wallet into HashPack.
4. **`npm run seed:arkiv`**: publishes the paid API's listing (and the example service listings). Set `APPROVED_OWNERS` to the writer wallet it prints.
5. **`npm run setup:shops`** once (gives each shop its own Arkiv wallet with a little tGLM), then **`npm run shop -- publish all`** (profiles and offers).
6. Optional: **`npm run seed:reviews`** for sample reviews.
7. **`npm start`**, then open http://localhost:4000.

## 3. Before a demo (30 minutes ahead)

- [ ] `npm run seed:arkiv` within the last 24 hours: **the API listing expires after 1 day**, and the agent then can't find the recommendation service.
- [ ] Shop offers last 7 days: `npm run shop -- renew all` if they're older.
- [ ] User wallet has at least 5 HBAR (an allowance change costs about 0.72 HBAR) and at least 1 USDC.
- [ ] Every judge's Google account is a test user in Google Auth Platform → Audience.
- [ ] HashPack is unlocked on the user wallet; World App (with the Orb-verified World ID) is on the phone that will scan.
- [ ] `npm test` passes. Stop the app first: tests use the same ports.
- [ ] Wait a minute after any test run so the AI provider isn't rate limited (Groq free tier: about 30 requests a minute).
- [ ] Keep a screen recording of a full run as a backup.

## 4. Demo flow (about 3 minutes)

1. **Problem:** "Agents can pay for things now. How do you let one shop for you without handing it your wallet?"
2. Type "Find me a gaming PC with a 4K monitor, within 4,000 USDC" and press **Build my PC**. Sign in with Google; the prompt is kept.
3. **Connect wallet**, then **Approve in wallet** for a 0.20 USDC allowance in HashPack. Point out: that's all the agent can ever spend.
4. Watch Agent progress tick: the agent finds RigAdvisor on Arkiv, pays 0.05 USDC with x402, reads shop listings and reviews from Arkiv. Then "Verified on Hedera by the agent" appears; open the payment on HashScan.
5. Three complete PCs. Open "All components" (compatibility checks) and "Seller reviews" (Arkiv, 90 days).
6. **Select this PC** → **Let my agent negotiate**: watch the two agents haggle live over A2A; the congratulations pop-up shows the saving.
7. Pay, mark delivered, then **Write a review**: scan with World ID, publish to Arkiv.
8. Open **Audit**: every decision on the public HCS topic. Then **Revoke**: one transaction, and the agent can't spend again.

## 5. Architecture

`start.mjs` launches each service as its own process on 127.0.0.1 and gives each only the key it needs:

| Service | Port | Holds | Job |
|---|---|---|---|
| web (`src/web.mjs`) | 4000 | Google client secret, session secret, DASH token. With `WALLET=server` only: a testnet user key | The app, Google sign-in, `/api/*` proxy |
| sellers (`src/sellers.mjs`) | 4100 | nothing | RigAdvisor x402 API, the shops' A2A sales agents, quotes |
| guard (`src/guard.mjs`) | 4200 | Guard key, Arkiv key | Checks, pulls, pays, refunds, schedules, HCS audit, orders, reviews, World checks |
| agent (`src/agent.mjs`) | 4300 | nothing (AGENT token) | Reads requests, asks the Guard to pay, negotiates, verifies payments with the Agent Kit |
| sim facilitator (`src/fac-sim.mjs`) | 4020 | nothing | Simulated mode only |
| MCP (`src/mcp.mjs`) | stdio | nothing | Started by Claude; reads the agent token from `data/agent-token` |

What `start.mjs` does: makes random AGENT and DASH tokens, works out the modes, strips every `*_PRIVATE_KEY` from the shared environment and hands each service only its own, writes the agent token to `data/agent-token` (mode 600), and waits for each service to answer. Services authenticate to each other with an `x-service-token` header; the agent and MCP server refuse to start if any private key is in their environment.

**Modes** (each live or simulated; everything works fully simulated with no keys, which is what the tests run):
payments (Guard and user accounts set) · wallet (`hashpack` / `server` / simulated) · arkiv (`ARKIV_PRIVATE_KEY` + `APPROVED_OWNERS`) · shops (shop wallets set) · world (`WORLD_CLIENT_ID`) · audit (`HCS_TOPIC_ID` + Guard key) · model (`LLM_BASE_URL`) · Google sign-in (`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`).

**Amounts:** integer strings in the asset's smallest unit (USDC: 6 decimals), compared with BigInt. Network fees are HBAR.

## 6. The Guard

**State** (SQLite, `data/guard-v2.db`): intents (allowances), purchases, approvals, audit, settings, orders, review checks, reviews.

**An allowance** is an intent the agent requests (`POST /intents`: task, categories, total, "ask me above", hours). It goes live only after the user approves it in HashPack and the Guard sees the allowance transaction on the Mirror Node: a successful approval by the user, made after the request, for exactly that amount. The approval request expires after 10 minutes.

**Purchase checks, in order (fail closed):**
1. Duplicate request ID → return the stored result (retries are free)
2. Active allowance
3. Listing on Arkiv, owned by an approved wallet, not expired
4. Quote (if any) confirmed with the seller: same listing, payee and asset, not expired, not above list price
5. Category allowed; no repeat without a new `purchaseRef`
6. Fee cap (1 USDC, `MAX_FEE_UNITS`) and remaining allowance
7. Seller account exists on the Mirror Node
8. The seller's 402 terms (network, asset, payee, amount) match the listing, **before** signing
9. AI intent check: below 0.3 blocked; below 0.6, or above "ask me", needs a step-up
10. Step-up: a Scheduled Transaction for the exact amount, signed by the user in HashPack, expiring after 180 s
11. Pull from the allowance (Hedera refuses if too low or revoked) → wait until the Mirror Node shows the funds → pay with x402
12. On failure, refund the user. An unclear outcome is marked `unknown` and reconciled from the Mirror Node, never retried blindly.

**Who approves:** the allowance itself can be approved by a Google account the web server verified (passed to the Guard by the only holder of the DASH token). **A step-up (a fee above the "ask me" amount) always needs a World ID check** from the linked World ID, for that payment or within the last 15 minutes, and then the user signs that exact payment in HashPack. Without Google sign-in configured, the allowance needs World ID too. The agent can never approve, revoke, reset or touch the wallet.

**HCS audit:** every event is written to SQLite first, then to the topic in order (JSON, ≤1000 bytes): allowance requested / approved / revoked, requested, paid (with `payTx`, `pullTx`, seller), blocked, refunded, step-up events, order placed, delivered, review checks, review published. No card, name, email or address is ever recorded.

## 7. Integrations

**Google sign-in** (`src/google-auth.mjs`): authorization code flow with PKCE and a `state` cookie; the code is swapped for an ID token with the client secret; the token's issuer, audience, expiry and email verification are checked; the session is a signed HttpOnly cookie (7 days). Without credentials, one click signs in a local user.

**World ID** (`src/world.mjs`, reviews in `src/orders.mjs`): OIDC **device flow** (World needs HTTPS callbacks, which localhost can't receive). The ID token is verified with `jose` against World's keys, and must be fresh. "Write a review" starts a check for that order; a review is accepted only with a check from the last 10 minutes, one review per order (enforced by the database's primary key). Step-ups use the same check, bound to the exact payment by its fingerprint. Optional `WORLD_REQUIRED_ACR` (e.g. `https://world.org/oidc/acr/orb`) refuses lower verification levels; the debrief for World is in `world/feedback.md`. The first World ID to verify is linked to the account; later checks must match it. Open the World popup synchronously inside the click handler, or the browser blocks it.

**Arkiv** (`src/pc-directory.mjs`, `src/reviews.mjs`, `src/directory.mjs`; full write-up in `arkiv/`): Rabdi testnet, `@arkiv-network/sdk`. Entity types `ethpc.pc-offers.v1`, `ethpc.pc-sellers.v1`, `ethpc.pc-reviews.v2`, `ethpc.listings.usdc`. Numbers are `u64`, blobs `bytes` (`str` is capped at 128 bytes). Offers only count if signed by the shop's registered wallet and paying its registered account.

**A2A negotiation** (`src/a2a.mjs`): one sales agent per shop. Messages are single JSON data parts: offer / accept from the buyer; counter / accept (with a quote) / reject from the shop. The shop accepts at or above its private floor, never counters higher than before, and an offer above the list price is accepted at the list price. Quotes last 5 minutes and are saved to disk (`data/seller-quotes.json`), as are the packages each shop recommended (`data/seller-packages.json`), so restarts don't break a negotiation. The A2A client needs the agent URL with a trailing slash.

**AI agents** (`src/seller-brain.mjs`, `src/buyer-brain.mjs`): the shop's counters and wording come from a model with a persona; the buyer model picks offers. Code clamps every price (floor, list price, never moving backwards) and replaces any message that leaks the floor. Without a model, fixed rules take over.

**AI intent check** (`src/intent-check.mjs`): scores whether a purchase serves the approved task and whether seller text steered it; seller text is untrusted. A model error scores 0.4, so a human decides.

**Hedera Agent Kit** (`src/onchain-proof.mjs`): after paying, the agent reads its own payment back with `get_transaction_record_query_tool` (the x402 transfer and the allowance pull) and `get_topic_messages_query_tool` (the Guard's audit entry naming both). Read-only, no key. `pending` until the audit entry reaches the Mirror Node. `src/spend-report.mjs` uses the same kit for the `spending_report` tool.

**MCP** (`src/mcp.mjs`): `pc_requirements`, `pc_allowance_status`, `pc_request_allowance`, `pc_find_builds`, `pc_negotiate`, `pc_verify_payment`, plus the general tools. Register with `claude mcp add ethpc -- node <absolute path>/src/mcp.mjs`; the path must point at the running folder, because the token file is read from there.

**Verifier** (`npm run verify`): public Mirror Node data only. Every USDC that left the Guard must match a `paid` or `refund` audit entry. Transaction IDs are normalised (`0.0.5@1793.000123` = `0.0.5-1793-123`).

## 8. Gotchas

- **IPv6-only networks (e.g. Jio hotspots):** the SDK's built-in IPv4 node addresses time out and transactions hang. The client dials nodes by hostname (`src/hedera-client.mjs`).
- **Mirror Node lag:** a few seconds. Wait for funds before an x402 USDC payment, and expect HCS messages late.
- **USDC:** every account must associate with the token before receiving it.
- **Arkiv:** `$expiresAt` is a block number (about 2 s each); re-publishing adds copies (readers keep the one expiring last); renaming an entity type means republishing everything. Details in `arkiv/friction.md`.
- **Google:** "Access blocked" means the account isn't a test user; `redirect_uri_mismatch` means `GOOGLE_REDIRECT_URI` doesn't exactly match the console.
- **HashPack:** the extension positions its own popup window; the page can't move it.
- **Tests and the app share ports:** stop the app before `npm test`. The test stack also writes `data/agent-token`, so restart the app after running tests.
- **Keep `.env` and `data/` out of git** (already in `.gitignore`).

## 9. Tests

`npm test` runs 123 tests against a full simulated stack (no keys) on a temporary database, one file at a time:

| File | Tests | Covers |
|---|---|---|
| `test/guard.test.mjs` | 53 | S1–S28 the Guard's checks and lifecycle; N1–N9 negotiation; F1–F16 the PC flow (fees, packages, checkout, reviews, sign-in, live negotiation, saved packages and quotes, Agent Kit proof) |
| `test/pc-compat.test.mjs` | 25 | Compatibility checks, the planner, requirements, review ratings |
| `test/world.test.mjs` | 16 | World ID against a local fake issuer that signs real tokens; Google-authorised allowances; step-ups always need World ID; required verification level |
| `test/seller-brain.test.mjs` | 8 | Shop AI clamps against garbage, injection and leaks |
| `test/google.test.mjs` | 6 | Google sign-in against a local fake Google: API lock, state, PKCE, token checks |
| `test/wallet.test.mjs` | 6 | HashPack allowance and schedule transactions |
| `test/buyer-brain.test.mjs` | 5 | Buyer AI never offers above the list price or its budget |
| `test/proof.test.mjs` | 4 | Agent Kit payment verification, with real kit output shapes |
