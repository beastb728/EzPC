// Checks the Hedera testnet setup account, then creates whatever is missing: the seller, the Guard account,
// a demo user wallet and the audit topic. Prints IDs only, never private keys.
import { appendFileSync } from "node:fs";
import { AccountCreateTransaction, Hbar, PrivateKey, TopicCreateTransaction } from "@hiero-ledger/sdk";
import { parseKey } from "./src/hedera-key.mjs";
import { testnetClient } from "./src/hedera-client.mjs";
const id = process.env.HEDERA_ACCOUNT_ID, raw = process.env.HEDERA_PRIVATE_KEY;
if (!id || !raw) { console.error("Add HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY to .env first."); process.exit(1); }
if (!/^0\.0\.\d+$/.test(id)) { console.error("HEDERA_ACCOUNT_ID should look like 0.0.1234567."); process.exit(1); }
const m = await (await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${id}`)).json();
if (!m.account) { console.error(`Account ${id} wasn't found on testnet.`); process.exit(1); }
const key = parseKey(raw);
if (m.key?.key && !m.key.key.toLowerCase().endsWith(key.publicKey.toStringRaw().toLowerCase())) { console.error("The private key doesn't match this account. Check the key and HEDERA_KEY_TYPE."); process.exit(1); }
console.log(`Account ${id} found. Balance: ${(m.balance.balance / 1e8).toFixed(2)} test HBAR. Key matches.`);
if (m.balance.balance < 40e8) { console.error("Balance is too low. Use the Hedera portal faucet first."); process.exit(1); }
const client = testnetClient().setOperator(id, key);
async function account(name, hbar, label) {
  if (process.env[`${name}_ACCOUNT_ID`]) return console.log(`${label}: ${process.env[`${name}_ACCOUNT_ID`]}`);
  const sk = PrivateKey.generateED25519();
  const rcpt = await (await new AccountCreateTransaction().setKeyWithoutAlias(sk.publicKey).setInitialBalance(new Hbar(hbar)).execute(client)).getReceipt(client);
  appendFileSync(".env", `\n${name}_ACCOUNT_ID=${rcpt.accountId}\n${name}_PRIVATE_KEY=${sk.toStringDer()}\n`);
  console.log(`Created ${label.toLowerCase()} ${rcpt.accountId} with ${hbar} test HBAR`);
}
await account("SELLER", 1, "Seller account");
// The Guard's own account only needs HBAR for fees; purchases are pulled from the user's allowance.
await account("GUARD", 10, "Guard account");
await account("USER", 20, "Demo user wallet");
if (!process.env.HCS_TOPIC_ID) {
  const rcpt = await (await new TopicCreateTransaction().setTopicMemo("Learning prototype audit log").execute(client)).getReceipt(client);
  appendFileSync(".env", `\nHCS_TOPIC_ID=${rcpt.topicId}\n`);
  console.log(`Created audit topic ${rcpt.topicId}`);
} else console.log(`Audit topic: ${process.env.HCS_TOPIC_ID}`);
client.close(); console.log("Hedera setup finished.");
