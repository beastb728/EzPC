// TESTNET ONLY. Gives each demo shop its own Arkiv wallet (0.6 tGLM each, from ARKIV_PRIVATE_KEY) so each shop publishes
// its own offers. All shops are paid to the existing SELLER_ACCOUNT_ID on Hedera. Prints addresses only; keys go into .env.
// Safe to re-run: shops that already have a wallet are skipped. Run: npm run setup:shops -- --yes
import { appendFileSync } from "node:fs";

if (!process.argv.includes("--yes")) { console.log("Creates an Arkiv wallet for each demo shop. Re-run with --yes to go ahead."); process.exit(0); }
for (const k of ["ARKIV_PRIVATE_KEY", "SELLER_ACCOUNT_ID"]) if (!process.env[k]) throw new Error(`${k} must be set in .env`);
const [{ createPublicClient, createWalletClient }, { rabdi }, { http, parseEther, formatEther }, { privateKeyToAccount, generatePrivateKey }] = await Promise.all([import("@arkiv-network/sdk"), import("@arkiv-network/sdk/chains"), import("viem"), import("viem/accounts")]);
const chain = rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" });
const funder = privateKeyToAccount(process.env.ARKIV_PRIVATE_KEY);
const pub = createPublicClient({ chain, transport: http() }), wallet = createWalletClient({ chain, transport: http(), account: funder });
console.log(`Arkiv funder ${funder.address}: ${formatEther(await pub.getBalance({ address: funder.address }))} tGLM`);
for (const id of ["VOLTFORGE", "PIXELBAZAAR", "RIGROOM"]) {
  if (!process.env[`SHOP_${id}_ARKIV_ADDRESS`]) {
    const pk = generatePrivateKey(), acct = privateKeyToAccount(pk);
    await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: acct.address, value: parseEther("0.6") }) });
    appendFileSync(".env", `\nSHOP_${id}_ARKIV_ADDRESS=${acct.address.toLowerCase()}\nSHOP_${id}_ARKIV_PRIVATE_KEY=${pk}`);
    process.env[`SHOP_${id}_ARKIV_ADDRESS`] = acct.address.toLowerCase();
  }
  console.log(`${id.toLowerCase()}: publishes from ${process.env[`SHOP_${id}_ARKIV_ADDRESS`]}, paid to ${process.env.SELLER_ACCOUNT_ID}`);
}
console.log("Done. Next: npm run shop -- publish all");
