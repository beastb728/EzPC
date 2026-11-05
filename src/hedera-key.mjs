import { PrivateKey } from "@hiero-ledger/sdk";
// The Hedera portal may show a DER key or a raw hex key. Raw hex needs its type.
export function parseKey(raw, type = process.env.HEDERA_KEY_TYPE || "ECDSA") {
  const k = String(raw ?? "").trim().replace(/^0x/, "");
  if (k.length > 66) return PrivateKey.fromStringDer(k);
  return type.toUpperCase() === "ED25519" ? PrivateKey.fromStringED25519(k) : PrivateKey.fromStringECDSA(k);
}
