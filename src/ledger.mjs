// What the Guard does on Hedera. Live on testnet when the Guard and user accounts are set; otherwise simulated in the Guard's database.
// The budget lives on-chain as the user's allowance to the Guard, in HBAR or USDC (see asset.mjs). The Guard pulls exactly one purchase at a time,
// because x402 on Hedera needs the paying account itself to sign, so it can't pay straight from an allowance.
import { randomUUID } from "node:crypto";
import { Hbar, PrivateKey, ScheduleCreateTransaction, ScheduleDeleteTransaction, ScheduleInfoQuery, Timestamp, TopicMessageSubmitTransaction, Transaction, TransferTransaction } from "@hiero-ledger/sdk";
import { MIRROR, txKey } from "./common.mjs";
import { parseKey } from "./hedera-key.mjs";
import { ASSET, isHbar } from "./asset.mjs";
import { testnetClient } from "./hedera-client.mjs";

const tb = (n) => Hbar.fromTinybars(String(n));
const mirror = async (p) => { const r = await fetch(MIRROR + p); return r.status === 404 ? null : r.json(); };

export function ledger(db, { live, audit }) {
  const guardId = process.env.GUARD_ACCOUNT_ID || "0.0.7001", userId = process.env.USER_ACCOUNT_ID || "0.0.7003";
  const guardKey = process.env.GUARD_PRIVATE_KEY ? parseKey(process.env.GUARD_PRIVATE_KEY, "ED25519") : PrivateKey.generateED25519();
  const client = live || audit ? testnetClient().setOperator(guardId, guardKey) : null;
  const run = async (tx) => { const r = await tx.execute(client); await r.getReceipt(client); return r.transactionId.toString(); };
  // Moves the payment asset. "approved" spends from the owner's allowance, signed only by the Guard.
  const transfer = (from, to, amount, memo, approved) => {
    const t = new TransferTransaction().setTransactionMemo(memo.slice(0, 100));
    if (isHbar) {
      (approved ? t.addApprovedHbarTransfer(from, tb(-BigInt(amount))) : t.addHbarTransfer(from, tb(-BigInt(amount))));
      return t.addHbarTransfer(to, tb(amount));
    }
    const n = Number(amount);
    (approved ? t.addApprovedTokenTransfer(ASSET.id, from, -n) : t.addTokenTransfer(ASSET.id, from, -n));
    return t.addTokenTransfer(ASSET.id, to, n);
  };

  db.exec(`CREATE TABLE IF NOT EXISTS sim_wallet(id INTEGER PRIMARY KEY CHECK(id=1), allowance TEXT, balance TEXT);
  CREATE TABLE IF NOT EXISTS sim_schedules(id TEXT PRIMARY KEY, amount TEXT, state TEXT, expires_at INTEGER);
  INSERT OR IGNORE INTO sim_wallet VALUES(1,'0','1000000000');`);
  const sim = () => db.prepare("SELECT * FROM sim_wallet WHERE id=1").get();
  const setSim = (allowance, balance) => db.prepare("UPDATE sim_wallet SET allowance=?, balance=? WHERE id=1").run(String(allowance), String(balance));

  let cache = { at: 0, v: null };
  return {
    guardId, userId, guardKey, live,
    async submitAudit(message) {
      if (!audit) return "simulated";
      return run(new TopicMessageSubmitTransaction({ topicId: process.env.HCS_TOPIC_ID, message }));
    },
    // The user's wallet as the Guard sees it. Live values come from the Mirror Node, which lags a few seconds.
    async wallet() {
      if (!live) { const w = sim(); return { allowance: w.allowance, balance: w.balance, source: "simulated" }; }
      if (Date.now() - cache.at < 3000) return cache.v;
      const [a, b] = await Promise.all([
        mirror(isHbar ? `/accounts/${userId}/allowances/crypto?spender.id=${guardId}` : `/accounts/${userId}/allowances/tokens?spender.id=${guardId}&token.id=${ASSET.id}`),
        mirror(`/accounts/${userId}`),
      ]);
      const balance = isHbar ? b?.balance?.balance : b?.balance?.tokens?.find((t) => t.token_id === ASSET.id)?.balance;
      cache = { at: Date.now(), v: { allowance: String(a?.allowances?.[0]?.amount ?? 0), balance: String(balance ?? 0), hbarForFees: String(b?.balance?.balance ?? 0), source: "mirror node" } };
      return cache.v;
    },
    // Moves one purchase's price from the user to the Guard. Hedera itself refuses it if the allowance is too low or revoked.
    async pull(amount, memo) {
      if (!live) {
        const w = sim(); if (BigInt(w.allowance) === 0n) return { ok: false, error: "SPENDER_DOES_NOT_HAVE_ALLOWANCE" };
        if (BigInt(amount) > BigInt(w.allowance)) return { ok: false, error: "AMOUNT_EXCEEDS_ALLOWANCE" };
        setSim(BigInt(w.allowance) - BigInt(amount), BigInt(w.balance) - BigInt(amount));
        return { ok: true, txId: `SIMULATED-PULL-${randomUUID().slice(0, 8)}` };
      }
      try { cache.at = 0; return { ok: true, txId: await run(transfer(userId, guardId, amount, memo, true)) }; }
      catch (e) { return { ok: false, error: String(e.status ?? e.message) }; }
    },
    // The x402 facilitator checks the payer's token balance on the Mirror Node, which lags the network by a few seconds.
    // After a USDC pull, wait until the Mirror Node shows the funds, or the facilitator refuses with preflight_failed.
    async fundsVisible(amount, ms = 20000) {
      if (!live || isHbar) return true;
      for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 1000))) {
        const t = await mirror(`/accounts/${guardId}/tokens?token.id=${ASSET.id}`).catch(() => null);
        if (BigInt(t?.tokens?.[0]?.balance ?? 0) >= BigInt(amount)) return true;
      }
      return false;
    },
    async refund(amount, memo) {
      if (!live) { const w = sim(); setSim(w.allowance, BigInt(w.balance) + BigInt(amount)); return `SIMULATED-REFUND-${randomUUID().slice(0, 8)}`; }
      return run(transfer(guardId, userId, amount, memo, false));
    },
    // Did a signed x402 payment land on Hedera? A signed transaction can only run until its validity window closes,
    // so once that has passed the Mirror Node's answer is final. Returns "settled", "not_settled" or "unknown".
    async paymentSettled(b64) {
      if (!live) return "unknown";
      let tx; try { tx = Transaction.fromBytes(Buffer.from(String(b64), "base64")); } catch { return "unknown"; }
      const id = tx.transactionId, k = txKey(id?.toString()); if (!k) return "unknown";
      const closes = id.validStart.toDate().getTime() + Number(tx.transactionValidDuration ?? 120) * 1000;
      await new Promise((r) => setTimeout(r, Math.max(0, closes - Date.now()) + 10000)); // + Mirror Node lag
      for (let i = 0; i < 5; i++, await new Promise((r) => setTimeout(r, 3000))) {
        const t = await mirror(`/transactions/${k}`).catch(() => undefined);
        if (t === null) return "not_settled";
        if (t?.transactions?.length) return t.transactions.some((x) => x.result === "SUCCESS") ? "settled" : "not_settled";
      }
      return "unknown";
    },
    // A transfer of the exact amount from the user to the Guard that only runs once the user signs it.
    async schedule(amount, memo, ttlMs) {
      if (!live) { const id = `SIM-SCHEDULE-${randomUUID().slice(0, 8)}`; db.prepare("INSERT INTO sim_schedules VALUES(?,?,'pending',?)").run(id, String(amount), Date.now() + ttlMs); return id; }
      const tx = new ScheduleCreateTransaction().setScheduledTransaction(transfer(userId, guardId, amount, memo, false)).setScheduleMemo(memo.slice(0, 100))
        .setAdminKey(guardKey.publicKey).setExpirationTime(Timestamp.fromDate(new Date(Date.now() + ttlMs))).setWaitForExpiry(false);
      const r = await tx.execute(client); return (await r.getReceipt(client)).scheduleId.toString();
    },
    async scheduleState(id) {
      if (!live) { const s = db.prepare("SELECT * FROM sim_schedules WHERE id=?").get(id); if (!s) return "missing"; return s.state === "pending" && s.expires_at < Date.now() ? "expired" : s.state; }
      const i = await new ScheduleInfoQuery().setScheduleId(id).execute(client).catch((e) => ({ error: e }));
      if (i.error) return /INVALID_SCHEDULE_ID|SCHEDULE_ALREADY_DELETED|SCHEDULE_ALREADY_EXPIRED/.test(String(i.error.status ?? i.error.message)) ? "expired" : "unknown";
      if (i.executed) return "executed"; if (i.deleted) return "deleted";
      return i.expirationTime && i.expirationTime.toDate() < new Date() ? "expired" : "pending";
    },
    async cancelSchedule(id) {
      if (!live) { db.prepare("UPDATE sim_schedules SET state='deleted' WHERE id=? AND state='pending'").run(id); return; }
      await run(new ScheduleDeleteTransaction().setScheduleId(id)).catch(() => {});
    },
    // Before an intent goes live: the user's wallet really approved this exact allowance, after the intent was requested.
    // The dashboard's word isn't enough, since with HashPack the browser reports the transaction. Waits out Mirror Node lag.
    async allowanceApproved(walletTx, amount, sinceMs, ms = 20000) {
      if (!live) return { ok: true };
      const k = txKey(walletTx); if (!k) return { ok: false, why: "no wallet transaction was given" };
      let why = "the Mirror Node doesn't show the wallet transaction yet";
      for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 1500))) {
        const t = (await mirror(`/transactions/${k}`).catch(() => null))?.transactions?.[0];
        if (!t) continue;
        if (t.name !== "CRYPTOAPPROVEALLOWANCE") return { ok: false, why: `the wallet transaction is a ${t.name}, not an allowance approval` };
        if (t.result !== "SUCCESS") return { ok: false, why: `the wallet transaction failed: ${t.result}` };
        if (!k.startsWith(`${userId}-`)) return { ok: false, why: "the wallet transaction wasn't paid by the user's account" };
        if (Number(t.consensus_timestamp) * 1000 < sinceMs) return { ok: false, why: "the wallet transaction is older than this intent" };
        cache.at = 0; const w = await this.wallet().catch(() => null);
        if (w && BigInt(w.allowance) === BigInt(amount)) return { ok: true };
        why = `Hedera shows an allowance of ${w?.allowance ?? "?"} units, not the approved ${amount}`;
      }
      return { ok: false, why };
    },
    // Seller account must exist on Hedera and not be deleted.
    async sellerCheck(accountId) {
      if (!live) return { ok: true, detail: "simulated" };
      const a = await mirror(`/accounts/${accountId}`).catch(() => undefined);
      if (a === undefined) return { ok: false, detail: "Mirror Node unreachable" };
      if (!a?.account) return { ok: false, detail: `${accountId} doesn't exist on testnet` };
      if (a.deleted) return { ok: false, detail: `${accountId} is deleted` };
      return { ok: true, detail: `account since ${new Date(Number(a.created_timestamp) * 1000).toISOString().slice(0, 10)}` };
    },
    // Simulated wallet controls, standing in for the user's own wallet in tests and demos without keys.
    sim: {
      get: sim,
      setAllowance: (amount) => { const w = sim(); setSim(amount, w.balance); return `SIMULATED-ALLOWANCE-${randomUUID().slice(0, 8)}`; },
      sign: (id) => {
        const s = db.prepare("SELECT * FROM sim_schedules WHERE id=?").get(id);
        if (!s || s.state !== "pending" || s.expires_at < Date.now()) return null;
        const w = sim(); setSim(w.allowance, BigInt(w.balance) - BigInt(s.amount));
        db.prepare("UPDATE sim_schedules SET state='executed' WHERE id=?").run(id); return `SIMULATED-SIGN-${randomUUID().slice(0, 8)}`;
      },
    },
  };
}
