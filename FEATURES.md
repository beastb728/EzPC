# What this prototype can do: feature inventory

Keep this file up to date: **every time a feature is added, add one line here and one line to the changelog.** (Learning prototype only; do not copy it into the ETHGlobal repo.)

Status: ✅ live on Hedera testnet · 🧪 live but only tested lightly · 🟡 simulated or stand-in

## Features

### Spending controls (the Guard)
| Feature | Status | Since | Where |
|---|---|---|---|
| Intent: the agent asks, you approve a task, categories, total, per-purchase limit, "ask me above" limit and an end time | ✅ | v0.1 | `src/guard.mjs` |
| Native Hedera allowance (HBAR or USDC) = the on-chain spending cap; revoke in one transaction | ✅ | v0.1, v0.3 | `src/ledger.mjs`, `src/user-wallet.mjs` |
| Pull-then-pay: the Guard pulls exactly one price from the allowance, then pays the seller with x402 | ✅ | v0.1 | `src/guard.mjs`, `src/sellers.mjs` |
| Fail-closed check order: duplicate, intent, listing owner/expiry, category, repeat, limits, seller account, seller terms vs listing, intent check, step-up, pull, pay, refund | ✅ | v0.1 | `src/guard.mjs` |
| Step-up approval over the limit, as a Hedera **scheduled transaction** you sign (expires on its own) | ✅ | v0.2 | `src/ledger.mjs` |
| Auto-refund if a payment fails | ✅ | v0.2 | `src/guard.mjs` |
| One retry on a network error, re-sending the same signed payment (Hedera rejects a duplicate, so no double pay); if a seller errors after being sent a payment, the Guard checks the Mirror Node and refunds if it never landed | 🧪 | v0.16.1, v0.16.2 | `src/guard.mjs`, `src/ledger.mjs` |
| Funds-visible wait (Mirror Node lag) before USDC payments | ✅ | v0.3 | `src/ledger.mjs` |
| Pays in HBAR or testnet USDC (`PAY_ASSET`) | ✅ | v0.3 | `src/asset.mjs` |
| Intent check: **AI** (Groq `gpt-oss-120b`) scores each purchase against the approved task; falls back to a human if the model fails; word-list rules if no model configured | ✅ | v0.13 | `src/intent-check.mjs` |
| Pre-payment refusal when a seller's order can't be fulfilled (BriefWriter without records) | ✅ | v0.9 | `src/sellers.mjs` |

### Hedera
| Feature | Status | Since | Where |
|---|---|---|---|
| **HashPack signing** (`WALLET=hashpack`): "Connect HashPack" button; the user approves the intent's allowance, step-up signatures and revoke in HashPack over WalletConnect (Hedera's `hedera-wallet-connect`). The server only prepares unsigned transactions and never receives the user's key. Before an intent goes live the Guard checks on the Mirror Node that the wallet transaction is a successful allowance approval by the user, made after the intent was requested, for exactly the approved amount. `WALLET=server` keeps the old server-signed demo wallet as a fallback. Tested by a person on 5 Nov: intent allowance, step-up and revoke all signed in HashPack, revoke confirmed on the Mirror Node (allowance 0, paid by the user's account) | ✅ | v0.16 | `src/user-wallet.mjs`, `src/web.mjs`, `wallet/hashpack.mjs`, `public/index.html` |
| HCS audit log of every decision, public and checkable | ✅ | v0.1 | `src/ledger.mjs` |
| Independent verifier: every token leaving the Guard has a matching audit entry | ✅ | v0.1 | `npm run verify`, `src/verify.mjs` |
| Hedera **Network MCP** + HashPack: Claude revokes the allowance, you sign in the wallet | ✅ | v0.4 | README |
| Hedera **Agent Kit**: read-only spending report from HCS and the wallet balance | ✅ | v0.5, v0.11 | `src/spend-report.mjs` |
| `spending_report` MCP tool (for Claude/GPT); filed report shows on the dashboard | ✅ | v0.11 | `src/mcp.mjs` |

### Identity and directory
| Feature | Status | Since | Where |
|---|---|---|---|
| **World ID** approval (OIDC device flow, sandbox, Orb-level); first World ID becomes the owner, others refused | ✅ | v0.2 on | `src/world.mjs` |
| One World scan per demo: later purchase approvals covered for 15 min (`WORLD_SESSION_MINUTES`); intents always need a fresh scan; revoke/reset ends it | ✅ | v0.12 | `src/guard.mjs` |
| World verification in a small popup window (browser-dependent; Firefox full screen turns it into a tab) | 🧪 | v0.12.x | `public/index.html` |
| **Arkiv** seller directory with approved-owner filter; impostor listings ignored | ✅ | v0.2 | `src/guard.mjs`, `seed:arkiv`, `seed:impostor` |

### Agents and negotiation
| Feature | Status | Since | Where |
|---|---|---|---|
| Scripted demo agent (Run agent button) | ✅ | v0.1 | `src/agent.mjs` |
| **MCP server** so Claude, GPT or any MCP client shops through the Guard (no keys held): `request_intent`, `get_intent`, `find_sellers`, `buy`, `check_purchase` | ✅ | v0.1 | `src/mcp.mjs` |
| **A2A** price negotiation (official `@a2a-js/sdk`): each seller runs an agent with a private floor; deal = quote the Guard confirms with the seller; x402 price must match | ✅ | v0.6 | `src/a2a.mjs`, `src/sellers.mjs` |
| `make_offer`: the buyer AI (Claude/GPT) negotiates move by move; code only enforces limits | ✅ | v0.7 | `src/mcp.mjs` |
| `negotiate_price`: scripted fallback buyer | ✅ | v0.6 | `src/a2a.mjs` |
| Sellers describe themselves (`needs`, `about`, `negotiates`) | ✅ | v0.9 | `src/catalog.mjs` |
| **AI seller agent**: the seller's counters and wording come from a model with a persona; the floor, list price and "never go up" rules stay in code; buyer notes are treated as untrusted; falls back to the fixed rule if the model fails | ✅ | v0.14 | `src/seller-brain.mjs` |
| Buyer can attach a short message to an offer, and read the seller's reply (`seller_says`) | ✅ | v0.14 | `src/mcp.mjs` |
| **Negotiate switch** on the dashboard. On: AI agents on both sides haggle over A2A. Off: list prices only (`make_offer` refuses, listings show `negotiates: false`, the Guard refuses any quote). Only the dashboard can flip it; each change is audited on HCS | ✅ | v0.15 | `src/guard.mjs`, `public/index.html` |
| **AI buyer** for the dashboard agent: the model picks each offer, accept or walk-away; code caps it at the list price and the budget, never lowers its own offer, 4 rounds max; falls back to the scripted negotiator | ✅ | v0.15 | `src/buyer-brain.mjs` |

### Dashboard
| Feature | Status | Since | Where |
|---|---|---|---|
| Dashboard: stats, wallet, intent, approvals, purchases, audit log | ✅ | v0.1, redesign v0.2 | `public/index.html` |
| Two-lane Live panel (agent vs. you/Guard) that also shows MCP runs | ✅ | v0.8 | `public/index.html` |
| Result card with the brief and the filed spending report, for any agent | ✅ | v0.11, v0.11.1 | `public/index.html` |
| Live and Audit log scroll in fixed windows | ✅ | v0.12 | `public/index.html` |

### PC Build Assistant (branch `gaming-pc`)
| Feature | Status | Since | Where |
|---|---|---|---|
| Requirements from plain words (AI or rules), with clarifying questions; 4K monitor ≠ native 4K gaming | ✅ | gaming-pc | `src/requirements.mjs` |
| Paid recommendation API (RigAdvisor): one x402 fee (0.05 USDC) per request, up to 3 complete PCs, each from ONE seller, with rating, why it fits and compromises; says so when fewer than 3 fit | 🧪 | gaming-pc | `src/recommend.mjs`, `src/planner.mjs`, `src/sellers.mjs` |
| Separate API spending limit (intent, category `pc-recommendations`); exact fee approved before paying; same requirements = same request = no second fee | 🧪 | gaming-pc | `src/agent.mjs` |
| Guard fee cap: no single data-service fee above 1 USDC (`MAX_FEE_UNITS`), so no PC-sized crypto payment | ✅ (tested) | gaming-pc | `src/guard.mjs` |
| Compatibility checks in code (socket, RAM, fit, cooling, PSU watts and connectors, storage, monitor) | ✅ (tested) | gaming-pc | `src/compat.mjs` |
| Demo shops and sample inventory on Arkiv, one wallet per shop; owner and payee checked against a registry | ✅ | gaming-pc | `src/pc-directory.mjs`, `scripts-shop.mjs` |
| "Pay with card": simulated checkout, demo order confirmation, simulated delivery; no crypto | 🟡 | gaming-pc | `src/orders.mjs` |
| Seller reviews: World ID (verified human) + delivered demo order, one per order (also under concurrency), 90-day Arkiv entities, rating computed on read | 🧪 | gaming-pc | `src/orders.mjs`, `src/reviews.mjs` |

## Not real yet (be honest with judges)
- Market data is labelled **sample** data; DeepReport is a stub; BriefWriter is a template unless an AI model is configured.
- With `WALLET=server` (the fallback) the dashboard server holds a testnet **user key**. With `WALLET=hashpack` (the default now) it holds none: the user signs everything in HashPack.
- World is the **sandbox**, not production.
- One user, no login on the dashboard (localhost only).
- AI checks only judge what the agent shows them; the hard limits are the real protection.

## Changelog (git tags)
| Tag | What changed |
|---|---|
| v0.1 | Allowance, Guard pipeline, x402 pay, HCS audit, verifier, MCP server |
| v0.2 / demo-ok | Scheduled step-up approvals, Arkiv live, World ID, dashboard redesign |
| v0.3 | USDC payments |
| v0.4 | Hedera Network MCP + HashPack revoke |
| v0.5 | Hedera Agent Kit spending report |
| v0.6 | A2A negotiating agents (scripted buyer) |
| v0.7 | `make_offer`: Claude negotiates |
| v0.8 | Live panel shows MCP activity |
| v0.9 / v0.9.1 | Sellers say what they need; per-intent message limit |
| v0.10 | Context and rule fixes from GPT testing |
| v0.11 / v0.11.1 | `spending_report` tool; dashboard Result card shows MCP runs |
| v0.12 | Scrollable Live/Audit; one World scan per demo |
| v0.13 | AI intent check live (Groq) |
| v0.14 | AI seller agents; buyer messages over A2A; this feature list |
| v0.14.1 | Intent check no longer penalises an agent for saying data is sample/untrusted; seller-steered purchases still refused (9-case live test) |
| v0.16 | HashPack signing for intents, step-ups and revoke; the Guard verifies the allowance on-chain before an intent goes live; tests H1-H6 |
| v0.16.1 | BriefWriter falls back to the template brief if the AI model fails (no more seller 500); when a seller errors after being sent a payment, the Guard checks on the Mirror Node once the payment can no longer run and refunds the user if it never landed; Live panel keeps the dashboard run's negotiation after the run ends |
| v0.16.2 | HashPack signing tested end to end by a person (intent, step-up, revoke); the Guard retries a payment once on a network error, with the same signed transaction so it can't pay twice |
| v0.15.1 | Hedera client dials nodes by hostname (`src/hedera-client.mjs`): on Jio/IPv6-only networks the SDK's built-in IPv4 node addresses time out, which hung intent approval after World ID |
| gaming-pc (untagged) | PC Build Assistant: paid recommendation API via x402, three one-seller PC packages from Arkiv, simulated card checkout, World-verified 90-day seller reviews, Guard fee cap |
