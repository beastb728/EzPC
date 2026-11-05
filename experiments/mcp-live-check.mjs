// Drives the MCP server the way Claude would, against the running stack, then approves and revokes through the dashboard.
// Run with the stack started: node experiments/mcp-live-check.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const W = "http://127.0.0.1:4000";
const web = async (p, b) => (await fetch(W + p, { method: b === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) })).json();
const c = new Client({ name: "live-check", version: "1" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ["src/mcp.mjs"], env: { PATH: process.env.PATH } }));
const tool = async (name, args = {}) => { const t = (await c.callTool({ name, arguments: args })).content[0].text; try { return JSON.parse(t); } catch { return t; } };
console.log("tools:", (await c.listTools()).tools.map((t) => t.name).join(", "));
const req = await tool("request_intent", { task: "Get today's onion prices", categories: ["market-prices"], max_total_hbar: 0.2, hours: 1 });
console.log("request_intent:", req.state);
console.log("approve (sets allowance on Hedera):", (await web(`/api/approvals/${req.approvalId}/approve`, {})).state);
const a = await tool("buy", { listing_key: "mandilite", reason: "cheap current prices" });
console.log("buy:", a.status, a.pullTx, a.txId);
const b = await tool("buy", { listing_key: "mandilite", reason: "cheap current prices" });
console.log("retry:", b.duplicate ? "duplicate, no second payment" : b.status);
const g = await tool("buy", { listing_key: "giftcards", reason: "a treat" });
console.log("outside intent:", g.status, "-", g.reason);
const it = (await tool("get_intent"))[0];
console.log("revoke:", (await web(`/api/intents/${it.id}/revoke`, {})).state);
const after = await tool("buy", { listing_key: "mandifresh", reason: "more prices" });
console.log("after revoke:", typeof after === "string" ? after : `${after.status} - ${after.reason}`);
await c.close();
