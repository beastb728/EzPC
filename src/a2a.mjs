// Price negotiation between agents over A2A (Agent2Agent, official @a2a-js/sdk). Messages carry one JSON data part:
//   buyer → seller  { type: "offer", listing, price, message? }   or   { type: "accept", listing, price }
//   seller → buyer  { type: "counter", price, message }  or  { type: "accept", quote, message }  or  { type: "reject", reason }
// The seller's counters come from an AI model when one is configured (seller-brain.mjs); the floor and the other limits stay in code.
// Prices are in the payment asset's smallest unit. A quote is the seller's promise; the Guard re-checks it with the seller.
import { randomUUID } from "node:crypto";
import express from "express";
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, Role } from "@a2a-js/sdk";
import { InMemoryTaskStore, DefaultRequestHandler, AgentEvent } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { ClientFactory } from "@a2a-js/sdk/client";
import { ASSET } from "./asset.mjs";
import { counterOffer } from "./seller-brain.mjs";
import { amount, unitOf } from "./a2a-units.mjs";

const part = (value) => ({ content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "application/json" });
const message = (role, value, contextId = "") => ({ role, messageId: randomUUID(), parts: [part(value)], contextId, taskId: "", extensions: [], metadata: {}, referenceTaskIds: [] });
const data = (m) => m?.parts?.[0]?.content?.value;
export const QUOTE_TTL_MS = 5 * 60_000;


// Seller side: one A2A agent per listing, mounted at /a2a/<key>, or one per shop that looks listings up by key
// (lookup), for PC packages. The floor never leaves the seller.
export function sellerAgent({ listing, lookup, name, baseUrl, quotes }) {
  const find = lookup ?? ((k) => (k === listing.key ? listing : null));
  const title = name ?? listing.name;
  const card = {
    name: `${title} sales agent`, description: `Negotiates the price of ${title}.`,
    supportedInterfaces: [{ url: `${baseUrl}/`, protocolBinding: "JSONRPC", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION }],
    version: "1.0.0", capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {}, securityRequirements: [], defaultInputModes: ["data"], defaultOutputModes: ["data"], documentationUrl: "", signatures: [],
    skills: [{ id: "negotiate-price", name: "Negotiate price", description: "Offer a price; get a counter-offer or a quote.", tags: ["x402", "negotiation"], examples: [], inputModes: ["data"], outputModes: ["data"], securityRequirements: [] }],
  };
  // Remembers its last counter per conversation, so a higher offer from the buyer never makes its counter go up.
  const lastCounter = new Map(), rounds = new Map();
  const quote = (l, price) => { const q = { id: randomUUID(), listing: l.key, price: String(price), listPrice: String(l.priceTinybars), payTo: l.hederaPayTo ?? null, asset: l.unit ? `display-${l.unit.symbol}` : ASSET.id, expiresAt: Date.now() + QUOTE_TTL_MS }; quotes.set(q.id, q); return q; };
  const executor = {
    cancelTask: async () => {},
    async execute(ctx, bus) {
      const m = data(ctx.userMessage) ?? {}, price = /^\d+$/.test(String(m.price)) ? BigInt(m.price) : -1n, l = find(String(m.listing ?? ""));
      const list = l ? BigInt(l.priceTinybars) : 0n, floor = l ? (list * BigInt(Math.round((l.floor ?? 1) * 100))) / 100n : 0n, show = (u) => `${amount(l, u)} ${unitOf(l).symbol}`;
      let reply;
      if (!l || price < 0n) reply = { type: "reject", reason: l ? "unreadable offer" : "unknown listing" };
      else if (price > list) reply = { type: "accept", quote: quote(l, list), message: `Deal at the list price, ${show(list)}.` }; // never charge above the listing
      else if (price >= floor) reply = { type: "accept", quote: quote(l, price), message: `Deal at ${show(price)}.` };
      else if (m.type === "accept") reply = { type: "reject", reason: "below our lowest price" };
      else {
        const last = lastCounter.get(ctx.contextId), history = rounds.get(ctx.contextId) ?? [];
        const c = await counterOffer({ listing: l, list, floor, offered: price, last, history, buyerNote: m.message });
        if (lastCounter.size > 1000) { lastCounter.clear(); rounds.clear(); }
        lastCounter.set(ctx.contextId, c.price); rounds.set(ctx.contextId, [...history, { offered: price, counter: c.price }]);
        reply = { type: "counter", price: String(c.price), message: c.message, by: c.by };
      }
      bus.publish(AgentEvent.message(message(Role.ROLE_AGENT, reply, ctx.contextId)));
      bus.finished();
    },
  };
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  const router = express.Router();
  router.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  router.use(jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  return router;
}

// The trailing slash matters: the A2A client finds the agent card relative to this address.
export const sellerAgentUrl = (endpoint) => { const u = new URL(endpoint); return `${u.origin}/a2a${u.pathname}/`; };

// One A2A message to a seller's agent: an offer, or acceptance of a counter. Returns the seller's reply as-is.
// Used directly by Claude through the make_offer MCP tool, so Claude decides every move.
const clients = new Map();
export async function sendOffer({ listing, type = "offer", price, message: note, contextId = randomUUID() }) {
  const at = sellerAgentUrl(listing.endpoint);
  if (!clients.has(at)) clients.set(at, await new ClientFactory().createFromUrl(at));
  const reply = await clients.get(at).sendMessage({ tenant: "", message: message(Role.ROLE_USER, { type, listing: listing.key, price: String(price), ...(note ? { message: String(note).slice(0, 300) } : {}) }, contextId), configuration: undefined, metadata: {} });
  return data(reply);
}

// Buyer side: opens at 60% of the list price, accepts a counter at or below 85%, otherwise meets halfway. At most 3 rounds.
// A listing can change both shares (openShare, acceptShare): PC packages haggle over a few percent, not 40%.
// It never offers above the list price or maxPrice. Returns a quote, or null to pay the list price.
export async function negotiate({ listing, maxPrice, log = () => {} }) {
  const list = BigInt(listing.priceTinybars), cap = maxPrice != null && BigInt(maxPrice) < list ? BigInt(maxPrice) : list;
  const fmt = (u) => `${amount(listing, u).toFixed(listing.unit ? 2 : 3)} ${unitOf(listing).symbol}`;
  const client = await new ClientFactory().createFromUrl(sellerAgentUrl(listing.endpoint));
  const contextId = randomUUID();
  const send = async (v) => data(await client.sendMessage({ tenant: "", message: message(Role.ROLE_USER, { ...v, listing: listing.key }, contextId), configuration: undefined, metadata: {} }));
  const pct = (x, d) => BigInt(Math.round((x ?? d) * 100)), acceptAt = (list * pct(listing.acceptShare, 0.85)) / 100n;
  let offer = (list * pct(listing.openShare, 0.6)) / 100n;
  for (let round = 1; round <= 3; round++) {
    if (offer > cap) offer = cap;
    log(`Offers ${listing.name} ${fmt(offer)} over A2A (list ${fmt(list)})`);
    let r = await send({ type: "offer", price: String(offer) });
    if (r?.type === "counter") {
      const c = BigInt(r.price);
      log(`${listing.name}'s agent counters at ${fmt(c)}${r.message ? `: "${r.message}"` : ""}`);
      if (c <= acceptAt && c <= cap) r = await send({ type: "accept", price: String(c) });
      else { offer = (offer + c) / 2n; continue; }
    }
    if (r?.type === "accept") { log(`Deal: ${listing.name} for ${fmt(r.quote.price)}, quote ${r.quote.id.slice(0, 8)}`, "good"); return r.quote; }
    log(`${listing.name}'s agent declined: ${r?.reason ?? "no deal"}`); return null;
  }
  log(`No deal with ${listing.name}; it will be the list price`);
  return null;
}
