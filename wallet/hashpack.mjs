// Browser side of the HashPack connection, bundled into public/hashpack.js (npm run build in this folder).
// The page never sees a key: it passes transactions the server prepared to HashPack, and the user approves them there.
import { DAppConnector, HederaJsonRpcMethod, HederaSessionEvent, HederaChainId } from "@hashgraph/hedera-wallet-connect";
import { LedgerId } from "@hiero-ledger/sdk";

let dc, ready;
function init(projectId) {
  if (ready) return ready;
  dc = new DAppConnector(
    { name: "AgentLeash prototype", description: "Agent budget on Hedera", url: location.origin, icons: [] },
    LedgerId.TESTNET, projectId, Object.values(HederaJsonRpcMethod),
    [HederaSessionEvent.ChainChanged, HederaSessionEvent.AccountsChanged], [HederaChainId.Testnet],
  );
  ready = dc.init({ logger: "error" }).catch((e) => { ready = null; throw e; });
  return ready;
}
const account = () => dc?.signers?.[0]?.getAccountId()?.toString() ?? null;

async function connect(projectId) {
  await init(projectId);
  if (account()) return account();
  // The HashPack extension announces itself shortly after the page loads; without it, show WalletConnect's QR code.
  await new Promise((r) => setTimeout(r, 400));
  const ext = dc.extensions.find((x) => x.available && /hashpack/i.test(x.name ?? ""));
  if (ext) await dc.connectExtension(ext.id); else await dc.openModal();
  return account();
}

async function signAndExecute(accountId, transactionBase64) {
  const r = await dc.signAndExecuteTransaction({ signerAccountId: `hedera:testnet:${accountId}`, transactionList: transactionBase64 });
  const id = (r?.result ?? r)?.transactionId;
  if (!id) throw new Error("HashPack didn't return a transaction ID");
  return id;
}

window.HashPack = { init, connect, account, signAndExecute, disconnect: () => dc?.disconnectAll() };
