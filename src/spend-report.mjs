// The agent's spending report, built only from public Hedera data with the Hedera Agent Kit's read-only query tools.
// No key is needed: the agent reads the HCS audit log and the user's balance, and can't sign anything.
import { HederaAgentAPI, AgentMode } from "@hashgraph/hedera-agent-kit";
import { coreAccountQueryPlugin, coreConsensusQueryPlugin, coreTokenQueryPlugin } from "@hashgraph/hedera-agent-kit/plugins";
import { ASSET, isHbar, fromUnits } from "./asset.mjs";
import { testnetClient } from "./hedera-client.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// requestIds: this run's purchases. expectPaid: how many the Guard reported paid, so we wait for the audit log to catch up.
export async function spendReport({ userId, topicId, since, requestIds, expectPaid }) {
  const ctx = { accountId: userId, mode: AgentMode.RETURN_BYTES };
  const client = testnetClient();
  try {
    const tools = [coreAccountQueryPlugin, coreConsensusQueryPlugin, coreTokenQueryPlugin].flatMap((p) => p.tools(ctx));
    const kit = new HederaAgentAPI(client, ctx, tools);
    const ids = new Set(requestIds);
    // A start time keeps the read to one page; the Agent Kit 4.2.0 builds a broken URL for a second page of topic messages.
    const startTime = new Date(since - 10_000).toISOString();
    let entries = [];
    for (let i = 0; i < 8; i++) {
      const r = JSON.parse(await kit.run("get_topic_messages_query_tool", { topicId, startTime, limit: 100 }));
      if (r.raw?.status !== "SUCCESS") throw new Error(r.raw?.error ?? "topic read failed");
      entries = (r.raw.messages ?? []).flatMap((m) => { try { const j = JSON.parse(m.message); return ids.has(j.ref) ? [{ ...j, at: m.consensus_timestamp }] : []; } catch { return []; } });
      if (entries.filter((e) => e.event === "paid").length >= expectPaid) break;
      await sleep(3000); // HCS messages reach the Mirror Node a few seconds after consensus.
    }
    const paid = entries.filter((e) => e.event === "paid").sort((a, b) => Number(a.at) - Number(b.at));
    const total = paid.reduce((s, e) => s + Number(e.units ?? e.tinybars ?? 0), 0);
    // Paid below the list price thanks to an A2A negotiation.
    const saved = paid.reduce((s, e) => s + Math.max(0, Number(e.listUnits ?? e.units ?? 0) - Number(e.units ?? 0)), 0);
    const bal = JSON.parse(await kit.run(isHbar ? "get_hbar_balance_query_tool" : "get_account_token_balances_query_tool", isHbar ? { accountId: userId } : { accountId: userId, tokenId: ASSET.id }));
    const units = isHbar ? Number(bal.raw?.hbarBalance ?? NaN) * 1e8 : Number(bal.raw?.tokenBalances?.tokens?.find((t) => t.token_id === ASSET.id)?.balance ?? NaN);
    return {
      source: "Hedera Agent Kit (read-only) over the public HCS audit log",
      topicId, paid: paid.map((e) => ({ item: String(e.detail).replace(/^paid /, ""), amount: fromUnits(e.units ?? e.tinybars ?? 0), list: fromUnits(e.listUnits ?? e.units ?? e.tinybars ?? 0), negotiated: !!e.quote, payTx: e.payTx })),
      total: fromUnits(total), saved: fromUnits(saved), refused: entries.filter((e) => ["blocked", "denied", "failed", "expired"].includes(e.event)).length,
      walletBalance: Number.isFinite(units) ? fromUnits(units) : null, symbol: ASSET.symbol,
      complete: paid.length >= expectPaid,
    };
  } finally { client.close(); }
}
