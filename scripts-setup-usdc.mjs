// Associates testnet USDC with the demo wallet, the Guard and the seller, so each can hold it.
// On Hedera an account must associate with a token before receiving it. Prints IDs and balances only, never keys.
import { PrivateKey, TokenAssociateTransaction } from "@hiero-ledger/sdk";
import { ASSETS } from "./src/asset.mjs";
import { testnetClient } from "./src/hedera-client.mjs";
const USDC = ASSETS.usdc.id;
const mirror = (p) => fetch(`https://testnet.mirrornode.hedera.com/api/v1${p}`).then((r) => r.json());
for (const [name, label] of [["USER", "Demo wallet"], ["GUARD", "Guard"], ["SELLER", "Seller"]]) {
  const id = process.env[`${name}_ACCOUNT_ID`], raw = process.env[`${name}_PRIVATE_KEY`];
  if (!id || !raw) { console.error(`${label}: ${name}_ACCOUNT_ID or ${name}_PRIVATE_KEY missing. Run npm run setup:hedera first.`); process.exit(1); }
  const held = (await mirror(`/accounts/${id}/tokens?token.id=${USDC}`)).tokens?.[0];
  if (held) { console.log(`${label} ${id}: already associated, ${(held.balance / 1e6).toFixed(2)} USDC`); continue; }
  const key = PrivateKey.fromStringDer(raw);
  const client = testnetClient().setOperator(id, key);
  const tx = await new TokenAssociateTransaction().setAccountId(id).setTokenIds([USDC]).freezeWith(client).sign(key);
  const status = (await (await tx.execute(client)).getReceipt(client)).status.toString();
  console.log(`${label} ${id}: associated with USDC ${USDC} (${status})`);
  client.close();
}
console.log(`\nNext: get test USDC from https://faucet.circle.com (Hedera testnet) for the demo wallet ${process.env.USER_ACCOUNT_ID}.`);
