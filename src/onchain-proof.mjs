// After the agent pays for recommendations, it checks its own payment on Hedera with the Hedera Agent Kit's read-only
// query tools: the x402 payment and the allowance pull (transaction records), and the Guard's HCS audit entry that names
// both. No key is involved: the kit only reads public data. `run` is the kit's tool runner, so tests can replace it.
import { HederaAgentAPI, AgentMode } from "@hashgraph/hedera-agent-kit";
import { coreTransactionQueryPlugin, coreConsensusQueryPlugin } from "@hashgraph/hedera-agent-kit/plugins";
import { testnetClient } from "./hedera-client.mjs";

export const KIT_TOOLS = ["get_transaction_record_query_tool", "get_topic_messages_query_tool"];

// A runner over the Agent Kit for one account. Call close() when done.
export function kitRunner(accountId) {
  const ctx = { accountId, mode: AgentMode.RETURN_BYTES };
  const tools = [coreTransactionQueryPlugin, coreConsensusQueryPlugin].flatMap((p) => p.tools(ctx));
  const client = testnetClient(), kit = new HederaAgentAPI(client, ctx, tools);
  return { run: async (tool, args) => JSON.parse(await kit.run(tool, args)), close: () => client.close() };
}

// What a transaction did, from the kit's record: result, consensus time, net amount per account, and whether it used an allowance.
async function record(run, id, tokenId) {
  const r = await run("get_transaction_record_query_tool", { transactionId: id });
  const t = r?.raw?.transactionRecord?.transactions?.[0]; if (!t) return null;
  const list = tokenId ? (t.token_transfers ?? []).filter((x) => x.token_id === tokenId) : (t.transfers ?? []);
  const moved = (acct) => list.filter((x) => x.account === acct).reduce((s, x) => s + BigInt(x.amount), 0n);
  return { result: t.result, at: t.consensus_timestamp, moved, approval: list.some((x) => x.is_approval) };
}

// payTx / pullTx: the purchase's transaction IDs. ref: the search's request ID in the audit log. tokenId: null for HBAR.
export async function proveSearchPayment({ run, payTx, pullTx, topicId, ref, tokenId, userId, guardId, sellerId }) {
  const pay = await record(run, payTx, tokenId), pull = pullTx ? await record(run, pullTx, tokenId) : null;
  const paid = pay ? pay.moved(sellerId) : 0n;
  const out = {
    by: "Hedera Agent Kit", tools: KIT_TOOLS,
    payment: pay && { tx: payTx, result: pay.result, amount: String(paid), ok: pay.result === "SUCCESS" && paid > 0n && pay.moved(guardId) === -paid },
    pull: pull && { tx: pullTx, result: pull.result, amount: String(-pull.moved(userId)), ok: pull.result === "SUCCESS" && pull.approval && pull.moved(guardId) === -pull.moved(userId) && pull.moved(guardId) > 0n },
    audit: null,
  };
  // HCS messages reach the Mirror Node a few seconds after consensus; read from just before the payment.
  if (pay?.at) {
    const since = new Date((Number(pay.at.split(".")[0]) - 120) * 1000).toISOString();
    const msgs = await run("get_topic_messages_query_tool", { topicId, startTime: since, limit: 100 });
    const entry = (msgs?.raw?.messages ?? []).map((m) => { try { return { ...JSON.parse(m.message), seq: m.sequence_number, at: m.consensus_timestamp }; } catch { return null; } })
      .find((j) => j?.event === "paid" && j.ref === ref);
    if (entry) out.audit = { topicId, seq: entry.seq, at: entry.at, ok: entry.payTx === payTx && (!pullTx || entry.pullTx === pullTx) };
  }
  out.ok = !!(out.payment?.ok && (!pullTx || out.pull?.ok) && out.audit?.ok);
  return out;
}
