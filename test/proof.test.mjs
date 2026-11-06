// The agent's on-chain check of its own payment (Hedera Agent Kit), with a stand-in for the kit's tool runner.
// The shapes below are copied from real kit output for testnet transaction 0.0.9185802@1793920133.334517547.
import test from "node:test";
import assert from "node:assert/strict";
import { proveSearchPayment } from "../src/onchain-proof.mjs";

const USDC = "0.0.429274", USER = "0.0.11289315", GUARD = "0.0.11289391", SELLER = "0.0.11286079", TOPIC = "0.0.11286082";
const PAY = "0.0.9185802@1793920133.334517547", PULL = "0.0.11289391@1793920131.554598077", REF = "e8fc956f5b6c677b3fd9aa423a223792";
const tx = (result, transfers, at = "1793920141.027977935") => ({ raw: { status: "SUCCESS", transactionRecord: { transactions: [{ result, consensus_timestamp: at, token_transfers: transfers.map(([account, amount, is_approval = false]) => ({ token_id: USDC, account, amount, is_approval })) }] } } });
const msg = (o, seq = 862) => ({ sequence_number: seq, consensus_timestamp: "1793920142.128212740", message: JSON.stringify(o) });
function kit({ pay = tx("SUCCESS", [[SELLER, 50000], [GUARD, -50000]]), pull = tx("SUCCESS", [[USER, -50000, true], [GUARD, 50000]]), messages = [msg({ event: "paid", ref: REF, payTx: PAY, pullTx: PULL, seller: SELLER })] } = {}) {
  const calls = [];
  const run = async (tool, args) => {
    calls.push([tool, args]);
    if (tool === "get_transaction_record_query_tool") return args.transactionId === PAY ? pay : pull;
    if (tool === "get_topic_messages_query_tool") return { raw: { status: "SUCCESS", messages } };
    throw new Error(`unexpected tool ${tool}`);
  };
  return { run, calls };
}
const prove = (k) => proveSearchPayment({ run: k.run, payTx: PAY, pullTx: PULL, topicId: TOPIC, ref: REF, tokenId: USDC, userId: USER, guardId: GUARD, sellerId: SELLER });

test("K1 a settled payment, its allowance pull and its audit entry are all confirmed with the kit's read-only tools", async () => {
  const k = kit(), p = await prove(k);
  assert.equal(p.ok, true); assert.equal(p.by, "Hedera Agent Kit");
  assert.deepEqual([p.payment.ok, p.payment.amount, p.pull.ok, p.pull.amount], [true, "50000", true, "50000"]);
  assert.deepEqual(p.audit, { topicId: TOPIC, seq: 862, at: "1793920142.128212740", ok: true });
  assert.deepEqual([...new Set(k.calls.map(([t]) => t))], ["get_transaction_record_query_tool", "get_topic_messages_query_tool"]);
  assert.equal(k.calls.find(([t]) => t === "get_topic_messages_query_tool")[1].topicId, TOPIC);
});
test("K2 a failed transaction, or money that didn't reach the seller, is not verified", async () => {
  assert.equal((await prove(kit({ pay: tx("INSUFFICIENT_TOKEN_BALANCE", [[SELLER, 50000], [GUARD, -50000]]) }))).ok, false);
  const elsewhere = await prove(kit({ pay: tx("SUCCESS", [["0.0.999", 50000], [GUARD, -50000]]) }));
  assert.equal(elsewhere.payment.ok, false); assert.equal(elsewhere.ok, false);
});
test("K3 a pull that didn't use the allowance, or moved a different amount, is not verified", async () => {
  assert.equal((await prove(kit({ pull: tx("SUCCESS", [[USER, -50000, false], [GUARD, 50000]]) }))).pull.ok, false);
  assert.equal((await prove(kit({ pull: tx("SUCCESS", [[USER, -90000, true], [GUARD, 50000]]) }))).pull.ok, false);
});
test("K4 no audit entry yet means not verified (still pending), and an entry naming other transactions doesn't count", async () => {
  const none = await prove(kit({ messages: [msg({ event: "paid", ref: "some-other-search", payTx: PAY, pullTx: PULL })] }));
  assert.equal(none.audit, null); assert.equal(none.ok, false);
  const wrong = await prove(kit({ messages: [msg({ event: "paid", ref: REF, payTx: "0.0.1@1.1", pullTx: PULL })] }));
  assert.equal(wrong.audit.ok, false); assert.equal(wrong.ok, false);
});
