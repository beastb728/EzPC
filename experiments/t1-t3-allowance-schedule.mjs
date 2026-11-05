// T1 and T3 on Hedera testnet. Prints IDs and results only, never keys.
// T1: can the Guard spend from a user's allowance, and does revoking stop it?
// T3: can a scheduled transfer wait for the user's signature, and does an unsigned one stay unexecuted?
import { appendFileSync } from "node:fs";
import {
  AccountAllowanceApproveTransaction, AccountCreateTransaction, Client, Hbar, PrivateKey,
  ScheduleCreateTransaction, ScheduleInfoQuery, ScheduleSignTransaction, Timestamp, TransferTransaction,
} from "@hiero-ledger/sdk";
import { parseKey } from "../src/hedera-key.mjs";

const guardId = process.env.HEDERA_ACCOUNT_ID, guardKey = parseKey(process.env.HEDERA_PRIVATE_KEY);
const guard = Client.forTestnet().setOperator(guardId, guardKey);
const mirror = (p) => fetch(`https://testnet.mirrornode.hedera.com/api/v1${p}`).then((r) => r.json());
const tinybar = (h) => Hbar.fromTinybars(Math.round(h * 1e8));
const log = (k, v) => console.log(`${k.padEnd(34)} ${v}`);

// Stand-in for the human's own wallet. In the product this account is the user's, e.g. in HashPack.
let userId = process.env.USER_ACCOUNT_ID, userKey = process.env.USER_PRIVATE_KEY && PrivateKey.fromStringDer(process.env.USER_PRIVATE_KEY);
if (!userId) {
  userKey = PrivateKey.generateED25519();
  const r = await (await new AccountCreateTransaction().setKeyWithoutAlias(userKey.publicKey).setInitialBalance(new Hbar(10)).execute(guard)).getReceipt(guard);
  userId = r.accountId.toString();
  appendFileSync(".env", `\nUSER_ACCOUNT_ID=${userId}\nUSER_PRIVATE_KEY=${userKey.toStringDer()}\n`);
}
const user = Client.forTestnet().setOperator(userId, userKey);
log("User account", userId);
log("Guard account", guardId);

// T1a: user approves a 2 HBAR allowance for the Guard.
const approve = async (h) => (await (await new AccountAllowanceApproveTransaction().approveHbarAllowance(userId, guardId, tinybar(h)).execute(user)).getReceipt(user)).status.toString();
log("T1 approve 2 HBAR", await approve(2));

// T1b: the Guard pulls 0.3 HBAR from the user's account, signing only with its own key.
const pull = async (h) => {
  try {
    const tx = await new TransferTransaction().addApprovedHbarTransfer(userId, tinybar(-h)).addHbarTransfer(guardId, tinybar(h)).execute(guard);
    const r = await tx.getReceipt(guard);
    return `${r.status} https://hashscan.io/testnet/transaction/${tx.transactionId.toString().replace("@", "-").replace(/\.(\d+)$/, "-$1")}`;
  } catch (e) { return `refused: ${e.status ?? e.message}`; }
};
log("T1 Guard pulls 0.3 HBAR", await pull(0.3));
// T1c: pulling more than what's left must fail.
log("T1 Guard pulls 1.8 HBAR (over)", await pull(1.8));
// T1d: revoke, then any pull must fail.
log("T1 revoke (approve 0)", await approve(0));
log("T1 Guard pulls 0.1 after revoke", await pull(0.1));

// T3a: the Guard schedules a 0.4 HBAR transfer from the user. It needs the user's signature to run.
const schedule = async (h, memo, expiry) => {
  const inner = new TransferTransaction().addHbarTransfer(userId, tinybar(-h)).addHbarTransfer(guardId, tinybar(h));
  const tx = new ScheduleCreateTransaction().setScheduledTransaction(inner).setScheduleMemo(memo);
  if (expiry) tx.setExpirationTime(Timestamp.fromDate(new Date(Date.now() + expiry * 1000))).setWaitForExpiry(false);
  return (await (await tx.execute(guard)).getReceipt(guard)).scheduleId.toString();
};
const s1 = await schedule(0.4, "approval test: will be signed");
log("T3 scheduled (to sign)", s1);
let info = await new ScheduleInfoQuery().setScheduleId(s1).execute(guard);
log("T3 executed before user signs?", info.executed ? "yes (bad)" : "no (good)");
const signed = await (await new ScheduleSignTransaction().setScheduleId(s1).freezeWith(user).sign(userKey)).execute(user);
log("T3 user signs", (await signed.getReceipt(user)).status.toString());
info = await new ScheduleInfoQuery().setScheduleId(s1).execute(guard);
log("T3 executed after user signs?", info.executed ? `yes at ${info.executed.toDate().toISOString()}` : "no");

// T3b: a schedule nobody signs, with a short expiry. Check it later on the Mirror Node.
const s2 = await schedule(0.4, "approval test: will expire", 90);
log("T3 scheduled (to expire in 90s)", s2);

console.log("\nCheck later:", `https://testnet.mirrornode.hedera.com/api/v1/schedules/${s2}`);
const bal = await mirror(`/accounts/${userId}`);
log("User balance now", `${(bal.balance.balance / 1e8).toFixed(4)} HBAR (mirror may lag a few seconds)`);
guard.close(); user.close();
