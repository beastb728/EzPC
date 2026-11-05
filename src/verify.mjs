// Independent check using only public data: every HBAR or token payment that left the Guard account must match an entry in the HCS audit log.
// Run it with `npm run verify`. It needs no keys.
import { MIRROR, txKey } from "./common.mjs";

async function all(path) {
  const out = []; let next = path;
  for (let i = 0; next && i < 50; i++) {
    const r = await fetch(MIRROR + next.replace(/^\/api\/v1/, "")); if (!r.ok) throw new Error(`Mirror Node ${r.status} for ${next}`);
    const j = await r.json(); out.push(...(j.transactions ?? j.messages ?? [])); next = j.links?.next;
  }
  return out;
}
// Accounts below 0.0.1000 are nodes and fee collectors.
const isFee = (id) => Number(id.split(".")[2]) < 1000;

export async function verify({ guardId = process.env.GUARD_ACCOUNT_ID, userId = process.env.USER_ACCOUNT_ID, topicId = process.env.HCS_TOPIC_ID } = {}) {
  if (!guardId || !topicId) return { mode: "simulated", note: "The verifier reads Hedera testnet. Set GUARD_ACCOUNT_ID and HCS_TOPIC_ID." };
  const logged = new Map();
  for (const m of await all(`/topics/${topicId}/messages?limit=100&order=asc`)) {
    let j; try { j = JSON.parse(Buffer.from(m.message, "base64").toString()); } catch { continue; }
    for (const f of ["payTx", "refundTx"]) if (txKey(j[f])) logged.set(txKey(j[f]), { event: j.event, ref: j.ref, kind: f === "payTx" ? "payment" : "refund" });
  }
  const outflows = [];
  for (const t of await all(`/transactions?account.id=${guardId}&limit=100&order=asc`)) {
    if (t.result !== "SUCCESS") continue;
    // HBAR moves are in "transfers"; token moves such as USDC are in "token_transfers". Fee payouts don't count.
    const moves = [...(t.transfers ?? []).map((x) => ({ ...x, asset: "HBAR" })), ...(t.token_transfers ?? []).map((x) => ({ ...x, asset: x.token_id }))];
    const out = moves.find((x) => x.account === guardId && x.amount < 0 && !(x.asset === "HBAR" && (t.transfers ?? []).every((y) => y.amount <= 0 || y.account === guardId || isFee(y.account))));
    const to = moves.filter((x) => out && x.asset === out.asset && x.amount > 0 && x.account !== guardId && !isFee(x.account));
    if (!out || !to.length) continue;
    const key = txKey(t.transaction_id);
    outflows.push({ txId: t.transaction_id, asset: out.asset, to: to.map((x) => x.account).join(","), units: to.reduce((s, x) => s + x.amount, 0), at: new Date(Number(t.consensus_timestamp.split(".")[0]) * 1000).toISOString(), audit: logged.get(key) ?? null, toUser: to.every((x) => x.account === userId) });
  }
  const unmatched = outflows.filter((o) => !o.audit);
  return {
    mode: "live", guardId, topicId, checkedAt: new Date().toISOString(),
    outflows: outflows.length, payments: outflows.filter((o) => !o.toUser).length, refunds: outflows.filter((o) => o.toUser).length,
    matched: outflows.length - unmatched.length, unmatched,
    verdict: unmatched.length ? `${unmatched.length} payment(s) left the Guard with no audit entry` : "Every payment out of the Guard matches an audit entry",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await verify();
  console.log(JSON.stringify({ ...r, unmatched: r.unmatched?.map((u) => `${u.txId} → ${u.to} ${u.units} units of ${u.asset}`) }, null, 2));
  process.exit(r.unmatched?.length ? 1 : 0);
}
