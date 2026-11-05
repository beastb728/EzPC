// Testnet client that dials nodes by hostname. Some networks (e.g. Jio's IPv6-only NAT64) can't reach the
// SDK's built-in IPv4 node addresses, but resolve these hostnames to reachable addresses.
import { Client, AccountId } from "@hiero-ledger/sdk";

export function testnetClient() {
  const net = {};
  for (let n = 0; n <= 6; n++) net[`${n}.testnet.hedera.com:50211`] = AccountId.fromString(`0.0.${n + 3}`);
  return Client.forNetwork(net).setMirrorNetwork("testnet.mirrornode.hedera.com:443").setLedgerId("testnet");
}
