// The user's wallet, in one of three modes (WALLET in .env):
//   hashpack: the user signs in HashPack. This server only prepares unsigned transactions and never holds the user's key.
//   server:   DEMO stand-in. The dashboard server holds a testnet user key and signs for the user.
//   simulated: no testnet keys; drives the Guard's simulated wallet.
import { AccountAllowanceApproveTransaction, Hbar, PrivateKey, ScheduleSignTransaction, TransactionId } from "@hiero-ledger/sdk";
import { modes, post, url } from "./common.mjs";
import { ASSET, isHbar } from "./asset.mjs";
import { testnetClient } from "./hedera-client.mjs";

// Server mode also needs the key to actually be here (start.mjs gives it only to the dashboard).
export const walletMode = () => { const m = modes().wallet; return m === "server" && !process.env.USER_PRIVATE_KEY ? "simulated" : m; };

const userId = () => process.env.USER_ACCOUNT_ID;
// Sets, not adds: approving a new amount replaces the old allowance. Zero revokes it.
const allowanceTx = (amount) => isHbar
  ? new AccountAllowanceApproveTransaction().approveHbarAllowance(userId(), process.env.GUARD_ACCOUNT_ID, Hbar.fromTinybars(String(amount)))
  : new AccountAllowanceApproveTransaction().approveTokenAllowance(ASSET.id, userId(), process.env.GUARD_ACCOUNT_ID, Number(amount));

// An unsigned transaction paid for by the user, as base64, for HashPack to show, sign and send.
export function prepareForWallet(tx) {
  const client = testnetClient(); // only supplies the node list; nothing is sent from here
  try { tx.setTransactionId(TransactionId.generate(userId())).freezeWith(client); return Buffer.from(tx.toBytes()).toString("base64"); }
  finally { client.close(); }
}
export const prepare = {
  allowance: (amount) => prepareForWallet(allowanceTx(amount)),
  scheduleSign: (scheduleId) => prepareForWallet(new ScheduleSignTransaction().setScheduleId(scheduleId)),
};

export function userWallet(dashToken) {
  const mode = walletMode();
  if (mode === "hashpack") {
    const no = () => { throw new Error("the user signs in HashPack; this server has no user key"); };
    return { mode, live: true, setAllowance: no, signSchedule: no };
  }
  if (mode === "simulated") return {
    mode, live: false,
    setAllowance: async (amount) => { const r = await post(url("guard", "/sim/wallet/allowance"), { amount: String(amount) }, dashToken); if (r.status !== 200) throw new Error(r.body.error); return r.body.txId; },
    signSchedule: async (id) => { const r = await post(url("guard", `/sim/wallet/sign/${id}`), {}, dashToken); if (r.status !== 200) throw new Error(r.body.error); return r.body.txId; },
  };
  const key = PrivateKey.fromStringDer(process.env.USER_PRIVATE_KEY);
  const client = testnetClient().setOperator(userId(), key);
  const run = async (tx) => { const r = await tx.execute(client); await r.getReceipt(client); return r.transactionId.toString(); };
  return {
    mode, live: true,
    setAllowance: (amount) => run(allowanceTx(amount)),
    signSchedule: async (id) => run(await new ScheduleSignTransaction().setScheduleId(id).freezeWith(client).sign(key)),
  };
}
