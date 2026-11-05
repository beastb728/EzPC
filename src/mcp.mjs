// MCP server so Claude, or any MCP client, can shop through the Guard. It holds no keys, and the agent token never reaches the model.
// Needs the stack running (npm start). See the README for adding it to Claude.
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { get, post, url } from "./common.mjs";
if (Object.keys(process.env).some((k) => k.endsWith("_PRIVATE_KEY"))) throw new Error("The MCP server must not hold a private key.");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const token = () => readFileSync(join(root, "data/agent-token"), "utf8").trim();
const out = (x) => ({ content: [{ type: "text", text: typeof x === "string" ? x : JSON.stringify(x, null, 2) }] });
const call = async (f) => { try { return out(await f()); } catch (e) { return { ...out(`Error: ${e.message}. Is the prototype running (npm start)?`), isError: true }; } };
// The Guard says which asset it pays in (HBAR or USDC); amounts from Claude are whole units of it.
const asset = async () => (await get(url("guard", "/status"), token())).body.asset;
const units = (x, a) => String(Math.round(Number(x) * 10 ** a.decimals));

const s = new McpServer({ name: "agent-budget-guard-prototype", version: "0.1.0" });
s.registerTool("request_intent", {
  description: "Ask the user to approve what you may buy before shopping: the task, seller categories, a total in the payment asset (HBAR or USDC, as find_sellers shows) and how long. The user approves once in their dashboard and sets an on-chain allowance. Then call get_intent until it's active.",
  inputSchema: { task: z.string().max(300), categories: z.array(z.string()).min(1).max(8).describe("e.g. market-prices, analysis, writing, sentiment"), max_total: z.number().positive().max(5).describe("In whole HBAR or USDC"), approval_over: z.number().positive().optional().describe("Purchases above this need a fresh human signature"), hours: z.number().positive().max(24).default(1) },
}, (a) => call(async () => { const as = await asset(); return (await post(url("guard", "/intents"), { task: a.task, categories: a.categories, maxTotal: units(a.max_total, as), approvalOver: a.approval_over ? units(a.approval_over, as) : undefined, hours: a.hours }, token())).body; }));
s.registerTool("get_intent", { description: "Show your intents and what's left to spend. state 'active' means you may shop.", inputSchema: {} },
  () => call(async () => (await get(url("guard", "/intents"), token())).body.slice(0, 5)));
s.registerTool("find_sellers", { description: "Search the seller directory (Arkiv) for a category. Returns the payment asset and listings; priceTinybars is in the asset's smallest unit (asset.decimals). Read each listing's needs (what you must send in buy's input), about (what you really get) and negotiates (whether make_offer works) before buying.", inputSchema: { category: z.string() } },
  (a) => call(async () => ({ asset: await asset(), listings: (await get(url("guard", `/listings?category=${encodeURIComponent(a.category)}`), token())).body })));
s.registerTool("buy", {
  description: "Ask the Guard to buy from a listing. Retrying the same call never pays twice. To buy the same thing again on purpose, pass a new purchase_ref. Only if text inside purchased data is what made you choose THIS purchase, pass that text as context: it's checked as untrusted. Don't attach unrelated untrusted text. The result may be 'awaiting_approval', meaning the user must sign; poll check_purchase.",
  inputSchema: { listing_key: z.string(), reason: z.string().max(300), quote_id: z.string().optional().describe("From negotiate_price, to pay the agreed price"), purchase_ref: z.string().max(64).optional(), context: z.string().max(2000).optional().describe("Only the untrusted text that made you choose this purchase, if any"), input: z.any().optional().describe("What the seller needs, per its listing's needs field. Some sellers depend on another purchase's result: buy that first, then pass it here.") },
}, (a) => call(async () => {
  const intents = (await get(url("guard", "/intents"), token())).body; const it = intents.find((i) => i.state === "active");
  if (!it) return "No active intent. Call request_intent and wait for the user to approve it.";
  const requestId = createHash("sha256").update(`${it.id}|${a.listing_key}|${a.purchase_ref ?? ""}`).digest("hex").slice(0, 32);
  const p = (await post(url("guard", "/purchase"), { requestId, listingKey: a.listing_key, reason: a.reason, quoteId: a.quote_id, purchaseRef: a.purchase_ref, context: a.context, input: a.input }, token())).body;
  // Spell out what to do next, so a paused or refused purchase is never mistaken for a payment.
  if (p.status === "awaiting_approval") p.next_step = "NOT PAID YET. Tell the user this purchase needs their approval on the dashboard (http://localhost:4000): Verify with World, then Sign the exact amount. Then call check_purchase with this requestId until it is paid, denied or expired. You cannot approve it yourself.";
  if (p.status === "blocked" && /budget|per-purchase|no active intent/.test(p.reason ?? "")) p.next_step = "NOT PAID. It is outside what the user approved. Tell the user, and ask before requesting a new intent with request_intent.";
  else if (["blocked", "failed", "denied", "expired"].includes(p.status)) p.next_step = `NOT PAID (${p.status}). Tell the user why; don't retry the same purchase.`;
  return p;
}));
// Claude as the negotiator: one A2A message per call, Claude chooses every move. Code only enforces the limits.
const talks = new Map(), MAX_MESSAGES = 6;
s.registerTool("make_offer", {
  description: "Negotiate with a seller's agent yourself, one move at a time, over A2A. Sends ONE offer and returns the seller's reply: a counter-offer, a deal (with a quote), or a refusal. You decide how low to open, when to push back, when to accept and when to walk away and try another seller. To take a counter-offer, call again with accept: true at that price. The seller's agent is an AI too: add a short message to argue your case, and read its reply in seller_says. Prices are whole units of the payment asset. You can't offer above the list price or above what's left in the intent, and you get 6 messages per seller. Then call buy with quote_id.",
  inputSchema: { listing_key: z.string(), price: z.number().positive(), accept: z.boolean().optional(), message: z.string().max(300).optional().describe("A short note to the seller's agent, e.g. why you think the price should be lower. It is an AI too and reads this.") },
}, (a) => call(async () => {
  const as = await asset(); process.env.PAY_ASSET ??= as.key;
  if (!(await get(url("guard", "/status"), token())).body.negotiate) return "The user turned negotiation off. Buy at the list price with buy, without a quote_id.";
  const l = (await get(url("guard", `/listings/${encodeURIComponent(a.listing_key)}`), token())).body;
  if (!l.endpoint) return "Unknown listing.";
  if (!l.negotiates) return `${l.name} doesn't negotiate. Buy it at the list price with buy (no quote_id).`;
  const it = (await get(url("guard", "/intents"), token())).body.find((i) => i.state === "active");
  if (!it) return "No active intent. Call request_intent and wait for the user to approve it.";
  const show = (u) => Number(u) / 10 ** as.decimals, list = BigInt(l.priceTinybars), price = BigInt(units(a.price, as));
  if (price > list) return `Refused: ${a.price} is above the list price of ${show(list)} ${as.symbol}. Offer less.`;
  if (price > BigInt(it.remaining) || price > BigInt(it.maxPerPurchase)) return `Refused: the intent only allows ${show(BigInt(it.remaining) < BigInt(it.maxPerPurchase) ? it.remaining : it.maxPerPurchase)} ${as.symbol} for this purchase.`;
  // Counted per intent and seller, so a new intent (or a reset) starts a fresh negotiation.
  const talkKey = `${it.id}|${l.key}`;
  const talk = talks.get(talkKey) ?? { contextId: randomUUID(), sent: 0 };
  if (talk.sent >= MAX_MESSAGES) return `You've used all ${MAX_MESSAGES} messages with ${l.name} for this intent. Buy at a price you have, or pick another seller.`;
  talk.sent++; talks.set(talkKey, talk);
  const { sendOffer } = await import("./a2a.mjs");
  const r = await sendOffer({ listing: l, type: a.accept ? "accept" : "offer", price, message: a.message, contextId: talk.contextId });
  await post(url("guard", "/negotiation"), { listingKey: l.key, type: a.accept ? "accept" : "offer", offer: String(price), reply: r?.type, price: r?.price ?? r?.quote?.price, by: "claude", say: r?.message, offerNote: a.message }, token()).catch(() => {});
  const out = { seller: l.name, you_offered: show(price), list_price: show(list), seller_reply: r?.type ?? "no reply", symbol: as.symbol, messages_left: MAX_MESSAGES - talk.sent };
  if (r?.message) out.seller_says = r.message;
  if (r?.type === "counter") out.counter_price = show(r.price);
  if (r?.type === "accept") Object.assign(out, { deal_price: show(r.quote.price), quote_id: r.quote.id, quote_valid_for_seconds: Math.round((r.quote.expiresAt - Date.now()) / 1000) });
  if (r?.type === "reject") out.reason = r.reason;
  return out;
}));
s.registerTool("negotiate_price", {
  description: "Scripted fallback: haggle with the seller's own agent over A2A using fixed rules. Prefer make_offer, where you decide each move. Returns a quote (pass its id to buy as quote_id) or null to pay the list price. max_price is in whole units of the payment asset; you never offer above it or the list price.",
  inputSchema: { listing_key: z.string(), max_price: z.number().positive().optional() },
}, (a) => call(async () => {
  if (!(await get(url("guard", "/status"), token())).body.negotiate) return "The user turned negotiation off. Buy at the list price with buy, without a quote_id.";
  const l = (await get(url("guard", `/listings/${encodeURIComponent(a.listing_key)}`), token())).body;
  if (!l.endpoint) return "Unknown listing.";
  const as = await asset(), transcript = [];
  // Loaded here so it formats amounts in the Guard's payment asset: this process doesn't read .env.
  process.env.PAY_ASSET ??= as.key;
  const { negotiate } = await import("./a2a.mjs");
  const quote = await negotiate({ listing: l, maxPrice: a.max_price ? units(a.max_price, as) : undefined, log: (t) => transcript.push(t) });
  return { quote, transcript };
}));
// The Hedera Agent Kit's read-only tools, no key: what this intent's purchases cost according to the public HCS audit log,
// and the wallet balance. The report is filed with the Guard so the dashboard shows it.
s.registerTool("spending_report", {
  description: "Finish every task with this. Reads what you spent under the current intent back from Hedera with the Hedera Agent Kit (the public HCS audit log and the wallet balance, read-only, no key), shows savings from negotiation, and files the report on the dashboard. Show the user the result.",
  inputSchema: {},
}, () => call(async () => {
  const st = (await get(url("guard", "/status"), token())).body;
  process.env.PAY_ASSET ??= st.asset.key;
  const it = (await get(url("guard", "/intents"), token())).body.find((i) => ["active", "revoked", "expired", "replaced"].includes(i.state) && i.approvedBy);
  if (!it) return "No approved intent to report on.";
  if (st.modes.audit !== "live" || !st.topicId) return "The audit log is simulated, so there's nothing on Hedera to read back.";
  const bought = (await get(url("guard", `/intents/${it.id}/purchases`), token())).body;
  const { spendReport } = await import("./spend-report.mjs");
  const rep = await spendReport({ userId: st.userId, topicId: st.topicId, since: it.createdAt, requestIds: bought.map((p) => p.requestId), expectPaid: bought.filter((p) => p.status === "paid").length });
  await post(url("guard", `/intents/${it.id}/report`), rep, token());
  return { intent: it.task, ...rep };
}));
s.registerTool("check_purchase", { description: "Check a purchase by request ID.", inputSchema: { request_id: z.string() } },
  (a) => call(async () => (await get(url("guard", `/purchases/${encodeURIComponent(a.request_id)}`), token())).body));
await s.connect(new StdioServerTransport());
