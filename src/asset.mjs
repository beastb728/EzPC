// What the prototype pays in: HBAR, or testnet USDC (an HTS token), set by PAY_ASSET. HBAR is the default.
// Every amount in the code is in the asset's smallest unit: tinybars for HBAR, micro-USDC for USDC.
// Network fees are always HBAR.
export const ASSETS = {
  hbar: { key: "hbar", id: "0.0.0", symbol: "HBAR", decimals: 8 },
  usdc: { key: "usdc", id: process.env.USDC_TOKEN_ID || "0.0.429274", symbol: "USDC", decimals: 6 },
};
const chosen = String(process.env.PAY_ASSET || "hbar").toLowerCase();
if (!ASSETS[chosen]) throw new Error(`PAY_ASSET must be hbar or usdc, not ${chosen}`);
export const ASSET = ASSETS[chosen];
export const isHbar = ASSET.id === "0.0.0";
export const toUnits = (x) => String(Math.round(Number(x) * 10 ** ASSET.decimals));
export const fromUnits = (u) => Number(u) / 10 ** ASSET.decimals;
