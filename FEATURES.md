# EthPC features

What EthPC does today, where each feature lives, and how far it has been proven. When you add a feature, add a line here.

Status: ✅ live on testnet (Hedera / Arkiv / World) · 🧪 covered by tests in simulated mode, lightly tried live · 🟡 mock, by design

## The user journey (web app, `public/index.html`)
| Feature | Status | Where |
|---|---|---|
| Landing page: describe the PC in plain words, example prompts, **Log in** with Google | ✅ | `public/index.html` |
| **Google sign-in** (OpenID Connect, code flow with PKCE, signed HttpOnly session). "Build my PC" while signed out signs in and keeps the prompt. With Google configured, the API needs a session | ✅ | `src/google-auth.mjs`, `src/web.mjs` |
| Requirements from plain words (AI or rules). Only the PC budget is ever asked; everything else gets a stated default (e.g. 4K monitor → 4K upscaled gaming) | ✅ | `src/requirements.mjs` |
| Two setup steps: connect HashPack, approve one USDC allowance, with an optional "Ask me with World ID for any fee above…" amount | ✅ | `public/index.html`, `src/user-wallet.mjs` |
| Agent progress that ticks step by step: request read → fee paid (x402) → Arkiv listings and reviews read → PCs compared | ✅ | `public/index.html` |
| **Three complete PCs**, each from one shop: exact matches first, then the closest real alternatives, each listing what it relaxes | ✅ | `src/planner.mjs`, `src/recommend.mjs` |
| Compatibility checks in code: CPU socket, RAM type, case fit, cooling, PSU watts and connectors, storage, monitor | ✅ | `src/compat.mjs` |
| **Live A2A negotiation** in the checkout: the user watches both agents' messages as they arrive, then a congratulations pop-up with the saving | ✅ | `src/agent.mjs`, `src/a2a.mjs`, `public/index.html` |
| Checkout with a card on file, order page, mark delivered | 🟡 | `src/orders.mjs` |
| **Write a review** after delivery: starts a World ID check; the server only accepts a review with a fresh check for that order, one per order | ✅ | `src/orders.mjs`, `src/world.mjs` |
| Sidebar: x402 budget left with **Revoke**, Google account, connected wallet with USDC and HBAR balances | ✅ | `public/index.html` |
| **Activity** (every agent action and x402 payment, live) and **Audit** (the Guard's log and its HCS topic) pages | ✅ | `public/index.html` |

## Spending controls (the Guard, `src/guard.mjs`)
| Feature | Status |
|---|---|
| Native Hedera **allowance** in USDC is the spending cap; revoke is one transaction | ✅ |
| **Pull, then pay:** the Guard pulls exactly one fee from the allowance, then pays the seller with x402; refunds if the payment fails | ✅ |
| Fail-closed checks: duplicate → active allowance → listing owner and expiry → category → limits → seller account on the Mirror Node → the seller's 402 terms match the listing before signing → AI intent check → step-up → pull → pay → refund | ✅ |
| Fee cap: no single fee above 1 USDC (`MAX_FEE_UNITS`), so a PC-sized amount can never be paid in crypto | ✅ |
| **Step-up** above an "ask me" amount: a Hedera Scheduled Transaction the user signs in HashPack; expires on its own | ✅ |
| Same request = same request ID: retries never pay twice; a new attempt only after a clear failure | ✅ |
| A Google account the dashboard verified can approve the allowance; **step-ups (a fee above the "ask me" amount) always need World ID**, then the user signs that exact payment in HashPack | ✅ |
| Optional verification level: `WORLD_REQUIRED_ACR` (e.g. Orb) refuses World IDs at a lower level | 🧪 |
| AI **intent check** scores each purchase against the approved task; a model error sends it to a human; rules without a model | ✅ |

## Hedera
| Feature | Status | Where |
|---|---|---|
| **x402 on Hedera** with the official facilitator, settling testnet USDC | ✅ | `src/sellers.mjs`, `src/guard.mjs` |
| **HashPack** signing over WalletConnect for the allowance, step-ups and revoke; the server never gets the user's key | ✅ | `wallet/hashpack.mjs`, `src/user-wallet.mjs` |
| **HCS** audit log of every Guard decision | ✅ | `src/ledger.mjs` |
| Independent verifier: every USDC leaving the Guard has an audit entry (`npm run verify`) | ✅ | `src/verify.mjs` |
| **Hedera Agent Kit:** the agent verifies its own payment (transfer, allowance pull, audit entry) with read-only tools, shown on the build page | ✅ | `src/onchain-proof.mjs` |
| Hedera Agent Kit spending report over the HCS log (`spending_report` MCP tool) | ✅ | `src/spend-report.mjs` |
| Mirror Node checks: allowance confirmed before it goes live, funds visible before a USDC payment, balances | ✅ | `src/ledger.mjs` |
| Hedera client dials nodes by hostname (works on IPv6-only networks) | ✅ | `src/hedera-client.mjs` |

## Arkiv (`arkiv/` has the full write-up)
| Feature | Status | Where |
|---|---|---|
| Shop catalogue: 44 offers and 3 profiles, each shop publishing from its own wallet (`ethpc.pc-offers.v1`, `ethpc.pc-sellers.v1`) | ✅ | `src/pc-directory.mjs`, `scripts-shop.mjs` |
| Trust rules on every read: owner = the shop's registered wallet, payee = its Hedera account, in stock, not expired | ✅ | `src/pc-directory.mjs` |
| Shops update price and stock (`patchEntity`) and renew offers (`extendEntity`) | ✅ | `npm run shop` |
| Reviews on Arkiv with a 90-day expiry; rating from active reviews only (`ethpc.pc-reviews.v1`) | ✅ | `src/reviews.mjs` |
| Paid API discovery: the recommendation service's listing, price and payee (`ethpc.listings.usdc`); impostor listings ignored | ✅ | `src/directory.mjs` |
| A query anyone can run with no keys | ✅ | `arkiv/query.mjs` |

## Agents
| Feature | Status | Where |
|---|---|---|
| **A2A** sales agent per shop (official `@a2a-js/sdk`); the shop's lowest price stays private | ✅ | `src/a2a.mjs`, `src/sellers.mjs` |
| AI shop agents with personas; floor, list price and "never counter higher" enforced in code | ✅ | `src/seller-brain.mjs` |
| AI buyer agent; capped at the list price, never lowers its own offer | ✅ | `src/buyer-brain.mjs` |
| Agreed quotes are honoured at checkout for 5 minutes; shops keep packages and quotes on disk across restarts | ✅ | `src/sellers.mjs` |
| **MCP server** for Claude: `pc_requirements`, `pc_allowance_status`, `pc_request_allowance`, `pc_find_builds`, `pc_negotiate`, `pc_verify_payment`, plus general tools | 🧪 | `src/mcp.mjs` |
| Works next to **Hedera's hosted MCP** (`agentic-testnet-mcp.hedera.com`) for wallet actions in the same chat | 🧪 | README |

## Not real (say so to judges)
- The shops and their stock are sample data, published on Arkiv by the team's shop wallets.
- The PC checkout is a mock: no card details are collected, nothing is charged, no order ships.
- Performance verdicts are labelled sample estimates, not benchmarks.
- The 31 reviews on Arkiv are seeded samples; reviews written in the app after a World ID check are real.
- World ID uses World's sandbox.
- One user per running copy.
