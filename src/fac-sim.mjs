// SIMULATED settlement only. Runs the real x402 Hedera verification code, but nothing reaches Hedera.
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactHederaScheme } from "@x402/hedera/exact/facilitator";
import { app, listen, NETWORK, PORTS } from "./common.mjs";
const feePayer = "0.0.9000";
const signer = {
  getAddresses: () => [feePayer],
  signAndSubmitTransaction: async () => ({ transactionId: `SIMULATED-${Date.now()}` }),
  verifyPayerSignature: async () => ({ ok: true }),
  preflightTransfer: async () => ({ ok: true }),
};
const f = new x402Facilitator().register(NETWORK, new ExactHederaScheme(signer));
const a = app();
a.get("/supported", (_, r) => r.json(f.getSupported()));
a.post("/verify", async (q, r) => r.json(await f.verify(q.body.paymentPayload, q.body.paymentRequirements)));
a.post("/settle", async (q, r) => r.json(await f.settle(q.body.paymentPayload, q.body.paymentRequirements)));
listen(a, PORTS.fac, "sim-facilitator");
