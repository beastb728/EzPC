// HashPack mode: the server only prepares unsigned transactions for the user's wallet, and can't sign anything itself.
import test from "node:test";
import assert from "node:assert/strict";
for (const k of Object.keys(process.env)) if (/_PRIVATE_KEY$|^PROTOTYPE_MODES$/.test(k)) delete process.env[k];
Object.assign(process.env, { PAY_ASSET: "usdc", USER_ACCOUNT_ID: "0.0.7003", GUARD_ACCOUNT_ID: "0.0.7001", WALLET: "hashpack", WALLETCONNECT_PROJECT_ID: "0123456789abcdef0123456789abcdef" });
const { Transaction, AccountAllowanceApproveTransaction, ScheduleSignTransaction } = await import("@hiero-ledger/sdk");
const { prepare, userWallet, walletMode } = await import("../src/user-wallet.mjs");
const { modes } = await import("../src/common.mjs");
const decode = (b64) => Transaction.fromBytes(Buffer.from(b64, "base64"));
// node → transaction ID → (public key → signature): count the signatures at the bottom.
const unsigned = (tx) => [...tx.getSignatures().values()].flatMap((m) => [...m.values()]).every((pairs) => pairs.size === 0);

test("H1 HashPack mode needs no user key, and payments count as live once the Guard is set", () => {
  assert.equal(walletMode(), "hashpack");
  assert.equal(modes().wallet, "hashpack");
  assert.equal(modes().payments, "simulated", "no Guard key in this test, so payments stay simulated");
  process.env.GUARD_PRIVATE_KEY = "x"; try { assert.equal(modes().payments, "live"); } finally { delete process.env.GUARD_PRIVATE_KEY; }
});
test("H2 the allowance for an intent: exact amount, user to Guard, paid by the user, unsigned", () => {
  const tx = decode(prepare.allowance("1000000"));
  assert.ok(tx instanceof AccountAllowanceApproveTransaction);
  const a = tx.tokenApprovals[0];
  assert.equal(a.tokenId.toString(), "0.0.429274"); assert.equal(a.ownerAccountId.toString(), "0.0.7003");
  assert.equal(a.spenderAccountId.toString(), "0.0.7001"); assert.equal(a.amount.toString(), "1000000");
  assert.equal(tx.transactionId.accountId.toString(), "0.0.7003", "the user pays the fee");
  assert.ok(tx.isFrozen() && unsigned(tx), "the server never signs it");
});
test("H3 revoke prepares an allowance of zero", () => {
  assert.equal(decode(prepare.allowance(0)).tokenApprovals[0].amount.toString(), "0");
});
test("H4 a step-up prepares the user's signature on that exact schedule, unsigned", () => {
  const tx = decode(prepare.scheduleSign("0.0.9999"));
  assert.ok(tx instanceof ScheduleSignTransaction);
  assert.equal(tx.scheduleId.toString(), "0.0.9999");
  assert.equal(tx.transactionId.accountId.toString(), "0.0.7003");
  assert.ok(unsigned(tx));
});
test("H5 in HashPack mode the server wallet refuses to sign", async () => {
  const w = userWallet("t");
  assert.equal(w.mode, "hashpack");
  assert.throws(() => w.setAllowance("1"), /HashPack/);
  assert.throws(() => w.signSchedule("0.0.1"), /HashPack/);
});
test("H6 without a WalletConnect project ID, HashPack mode doesn't switch on", () => {
  const id = process.env.WALLETCONNECT_PROJECT_ID; delete process.env.WALLETCONNECT_PROJECT_ID;
  try { assert.notEqual(modes().wallet, "hashpack"); } finally { process.env.WALLETCONNECT_PROJECT_ID = id; }
});
