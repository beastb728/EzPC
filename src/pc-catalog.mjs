// Gaming-PC catalog: three TEAM-RUN DEMO SHOPS and their SAMPLE inventory. Not real shops or real stock.
// The recommendation service packs each shop's parts into complete PCs. PCs are never paid in crypto: checkout is a
// simulated card payment, so these prices are display prices only. Integer micro-USDC, e.g. 599 USDC = 599_000_000.
export const USDC = 1_000_000n;
export const usdc = (x) => BigInt(Math.round(Number(x) * 1000)) * 1000n; // whole USDC (3 decimals max) -> micro-USDC
export const showUsdc = (u) => `${(Number(u) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;

// haggle: the shop's PRIVATE negotiation terms (lowest share of a package price its sales agent accepts, and its manner).
// They stay in the sellers service and never go to Arkiv or the buyer.
// Stable seller identities. Reputation is keyed by sellerId, so publishing new offers never resets it.
// arkivOwner: the wallet allowed to publish this shop's Arkiv entities. hederaPayTo: the shop's registered Hedera account.
// Nothing pays a shop in crypto any more; hederaPayTo stays on each record only as an integrity check against this registry.
export const SHOPS = [
  { sellerId: "voltforge", name: "VoltForge Components", city: "Mumbai", about: "Demo shop (team-run). New parts only, fast Mumbai dispatch.", haggle: { floor: 0.96, persona: "A premium Mumbai shop. Proud of fast dispatch and genuine parts; you give only small discounts." }, delivery: { feeUsdc: 15, freeOverUsdc: 1500, days: 2, regions: ["IN"] }, sim: { arkivOwner: "0x1000000000000000000000000000000000000001", hederaPayTo: "0.0.7101" } },
  { sellerId: "pixelbazaar", name: "Pixel Bazaar", city: "Pune", about: "Demo shop (team-run). Value parts, haggles readily.", haggle: { floor: 0.9, persona: "A cheerful value shop in Pune that loves to close a deal and haggles readily." }, delivery: { feeUsdc: 12, freeOverUsdc: 1000, days: 4, regions: ["IN"] }, sim: { arkivOwner: "0x1000000000000000000000000000000000000002", hederaPayTo: "0.0.7102" } },
  { sellerId: "rigroom", name: "RigRoom Refurb & New", city: "Bengaluru", about: "Demo shop (team-run). New and used high-end parts, short warranties on used.", haggle: { floor: 0.93, persona: "A Bengaluru enthusiast shop. Businesslike, talks about build quality, moderate discounts." }, delivery: { feeUsdc: 20, freeOverUsdc: 2500, days: 5, regions: ["IN"] }, sim: { arkivOwner: "0x1000000000000000000000000000000000000003", hederaPayTo: "0.0.7103" } },
];
export const shopById = (id) => SHOPS.find((s) => s.sellerId === id);
const envKey = (id) => id.toUpperCase();
// Live values come from .env (written by `npm run setup:shops`); otherwise the simulated stand-ins above.
export const shopRegistry = (id, live) => {
  const s = shopById(id); if (!s) return null;
  if (!live) return { ...s.sim };
  return { arkivOwner: (process.env[`SHOP_${envKey(id)}_ARKIV_ADDRESS`] || "").toLowerCase() || null, hederaPayTo: process.env.SELLER_ACCOUNT_ID || null };
};

// Products. Specs are what compatibility checks read. perfIndex is a SAMPLE relative index (see perf.mjs), not a benchmark.
const P = {
  // CPUs
  "r7-7800x3d": { category: "cpu", brand: "AMD", model: "Ryzen 7 7800X3D", specs: { socket: "AM5", cores: 8, tdpW: 120, perfIndex: 150, boxCooler: false } },
  "r5-7600": { category: "cpu", brand: "AMD", model: "Ryzen 5 7600", specs: { socket: "AM5", cores: 6, tdpW: 65, perfIndex: 110, boxCooler: true } },
  "i5-14600k": { category: "cpu", brand: "Intel", model: "Core i5-14600K", specs: { socket: "LGA1700", cores: 14, tdpW: 181, perfIndex: 125, boxCooler: false } },
  // Motherboards
  "b650-tomahawk": { category: "motherboard", brand: "MSI", model: "MAG B650 Tomahawk WiFi", specs: { socket: "AM5", formFactor: "ATX", memoryType: "DDR5", memorySlots: 4, maxMemoryGB: 192, m2Slots: 3, sataPorts: 6 } },
  "b650m-pro": { category: "motherboard", brand: "ASRock", model: "B650M Pro RS", specs: { socket: "AM5", formFactor: "mATX", memoryType: "DDR5", memorySlots: 4, maxMemoryGB: 128, m2Slots: 2, sataPorts: 4 } },
  "b760-tuf-d4": { category: "motherboard", brand: "ASUS", model: "TUF Gaming B760-Plus WiFi D4", specs: { socket: "LGA1700", formFactor: "ATX", memoryType: "DDR4", memorySlots: 4, maxMemoryGB: 128, m2Slots: 3, sataPorts: 4 } },
  // Memory
  "ddr5-32-6000": { category: "ram", brand: "Corsair", model: "Vengeance 32GB (2x16) DDR5-6000", specs: { type: "DDR5", capacityGB: 32, modules: 2, speedMTs: 6000 } },
  "ddr5-64-6000": { category: "ram", brand: "G.Skill", model: "Flare X5 64GB (2x32) DDR5-6000", specs: { type: "DDR5", capacityGB: 64, modules: 2, speedMTs: 6000 } },
  "ddr4-32-3600": { category: "ram", brand: "Kingston", model: "FURY Beast 32GB (2x16) DDR4-3600", specs: { type: "DDR4", capacityGB: 32, modules: 2, speedMTs: 3600 } },
  // Graphics cards
  "rtx4070s": { category: "gpu", brand: "MSI", model: "GeForce RTX 4070 SUPER Ventus 2X", specs: { lengthMm: 242, tdpW: 220, vramGB: 12, powerConnectors: { "12V-2x6": 1 }, upscaler: "DLSS", minPsuW: 650, perfIndex: 170 } },
  "rx7700xt": { category: "gpu", brand: "Sapphire", model: "Pulse Radeon RX 7700 XT", specs: { lengthMm: 280, tdpW: 245, vramGB: 12, powerConnectors: { "8-pin": 2 }, upscaler: "FSR", minPsuW: 700, perfIndex: 135 } },
  "rx7900xt": { category: "gpu", brand: "Sapphire", model: "Pulse Radeon RX 7900 XT", specs: { lengthMm: 313, tdpW: 315, vramGB: 20, powerConnectors: { "8-pin": 2 }, upscaler: "FSR", minPsuW: 750, perfIndex: 215 } },
  "rtx4080s": { category: "gpu", brand: "Gigabyte", model: "GeForce RTX 4080 SUPER Windforce", specs: { lengthMm: 342, tdpW: 320, vramGB: 16, powerConnectors: { "12V-2x6": 1 }, upscaler: "DLSS", minPsuW: 750, perfIndex: 250 } },
  "rtx4090": { category: "gpu", brand: "NVIDIA", model: "GeForce RTX 4090 Founders Edition", specs: { lengthMm: 304, tdpW: 450, vramGB: 24, powerConnectors: { "12V-2x6": 1 }, upscaler: "DLSS", minPsuW: 850, perfIndex: 320 } },
  // Storage
  "990pro-2tb": { category: "storage", brand: "Samsung", model: "990 PRO 2TB NVMe", specs: { interface: "NVMe", capacityGB: 2000 } },
  "sn770-1tb": { category: "storage", brand: "WD", model: "Black SN770 1TB NVMe", specs: { interface: "NVMe", capacityGB: 1000 } },
  "mx500-2tb": { category: "storage", brand: "Crucial", model: "MX500 2TB SATA SSD", specs: { interface: "SATA", capacityGB: 2000 } },
  // Power supplies
  "rm850x": { category: "psu", brand: "Corsair", model: "RM850x (2024)", specs: { wattage: 850, connectors: { "12V-2x6": 1, "8-pin": 4 } } },
  "focus-gx750": { category: "psu", brand: "Seasonic", model: "Focus GX-750", specs: { wattage: 750, connectors: { "8-pin": 4 } } },
  "pure-1000": { category: "psu", brand: "be quiet!", model: "Pure Power 12 M 1000W", specs: { wattage: 1000, connectors: { "12V-2x6": 1, "8-pin": 6 } } },
  "mwe-650": { category: "psu", brand: "Cooler Master", model: "MWE Bronze 650 V2", specs: { wattage: 650, connectors: { "8-pin": 2 } } },
  // Cases
  "fractal-north": { category: "case", brand: "Fractal Design", model: "North", specs: { formFactors: ["ATX", "mATX", "ITX"], maxGpuLengthMm: 355, maxCoolerHeightMm: 170, radiatorsMm: [240, 280, 360] } },
  "lancool-207": { category: "case", brand: "Lian Li", model: "Lancool 207", specs: { formFactors: ["ATX", "mATX", "ITX"], maxGpuLengthMm: 375, maxCoolerHeightMm: 160, radiatorsMm: [240, 280, 360] } },
  "nr200p": { category: "case", brand: "Cooler Master", model: "MasterBox NR200P", specs: { formFactors: ["ITX"], maxGpuLengthMm: 330, maxCoolerHeightMm: 155, radiatorsMm: [240, 280] } },
  // CPU coolers
  "pa120se": { category: "cooler", brand: "Thermalright", model: "Peerless Assassin 120 SE", specs: { type: "air", heightMm: 155, sockets: ["AM5", "AM4", "LGA1700"], maxTdpW: 220 } },
  "nh-d15": { category: "cooler", brand: "Noctua", model: "NH-D15", specs: { type: "air", heightMm: 165, sockets: ["AM5", "AM4", "LGA1700"], maxTdpW: 250 } },
  "lf3-360": { category: "cooler", brand: "Arctic", model: "Liquid Freezer III 360", specs: { type: "aio", radiatorMm: 360, sockets: ["AM5", "LGA1700"], maxTdpW: 300 } },
  // Monitors
  "lg-27gr93u": { category: "monitor", brand: "LG", model: "UltraGear 27GR93U 27\" 4K 144Hz", specs: { resolution: "4K", refreshHz: 144, sizeIn: 27 } },
  "gb-m27u": { category: "monitor", brand: "Gigabyte", model: "M27U 27\" 4K 160Hz", specs: { resolution: "4K", refreshHz: 160, sizeIn: 27 } },
  "dell-s2722dgm": { category: "monitor", brand: "Dell", model: "S2722DGM 27\" 1440p 165Hz", specs: { resolution: "1440p", refreshHz: 165, sizeIn: 27 } },
  // Peripherals
  "keychron-k8": { category: "keyboard", brand: "Keychron", model: "K8 Pro", specs: { layout: "TKL", wireless: true } },
  "g413": { category: "keyboard", brand: "Logitech", model: "G413 SE", specs: { layout: "full", wireless: false } },
  "gpx-superlight2": { category: "mouse", brand: "Logitech", model: "G PRO X SUPERLIGHT 2", specs: { wireless: true } },
  "deathadder-v3": { category: "mouse", brand: "Razer", model: "DeathAdder V3", specs: { wireless: false } },
};
export const PRODUCTS = P;

// Offers: which shop sells which product, at what price, condition, warranty and stock. SAMPLE inventory.
// Each shop carries enough to build a complete PC on its own, because a recommendation is one package from one seller.
const o = (sellerId, productId, priceUsdc, extra = {}) => ({ sellerId, productId, priceUsdc, condition: "new", warrantyMonths: 36, stock: 5, validDays: 7, ...extra });
export const OFFERS = [
  o("voltforge", "r7-7800x3d", 449), o("rigroom", "r7-7800x3d", 439, { stock: 2 }), o("pixelbazaar", "r5-7600", 199), o("pixelbazaar", "i5-14600k", 289),
  o("voltforge", "b650-tomahawk", 219), o("rigroom", "b650m-pro", 149), o("pixelbazaar", "b760-tuf-d4", 179),
  o("voltforge", "ddr5-32-6000", 109), o("pixelbazaar", "ddr5-32-6000", 104), o("rigroom", "ddr5-64-6000", 199), o("pixelbazaar", "ddr4-32-3600", 79),
  o("voltforge", "rtx4070s", 599), o("pixelbazaar", "rx7700xt", 399), o("pixelbazaar", "rx7900xt", 699), o("rigroom", "rtx4080s", 999), o("voltforge", "rtx4080s", 1049),
  o("rigroom", "rtx4090", 1499, { condition: "used", warrantyMonths: 3, stock: 1 }),
  o("voltforge", "990pro-2tb", 169), o("pixelbazaar", "sn770-1tb", 69), o("rigroom", "mx500-2tb", 119),
  o("voltforge", "rm850x", 139), o("pixelbazaar", "focus-gx750", 109), o("rigroom", "pure-1000", 159), o("rigroom", "mwe-650", 59),
  o("voltforge", "fractal-north", 139), o("pixelbazaar", "lancool-207", 89), o("rigroom", "nr200p", 99),
  o("pixelbazaar", "pa120se", 39), o("voltforge", "nh-d15", 119), o("rigroom", "lf3-360", 109),
  o("voltforge", "lg-27gr93u", 499), o("pixelbazaar", "gb-m27u", 449), o("rigroom", "dell-s2722dgm", 249),
  o("pixelbazaar", "keychron-k8", 99), o("rigroom", "g413", 69), o("voltforge", "gpx-superlight2", 149), o("rigroom", "deathadder-v3", 89),
  // Added so every shop can supply a complete PC (board, case, monitor and peripherals) by itself.
  o("voltforge", "r5-7600", 209), o("voltforge", "keychron-k8", 109),
  o("pixelbazaar", "b650m-pro", 145), o("pixelbazaar", "deathadder-v3", 85),
  o("rigroom", "rtx4070s", 589), o("rigroom", "lancool-207", 95), o("rigroom", "gb-m27u", 459),
];
export const offerId = (sellerId, productId) => `${sellerId}:${productId}`;

// The full offer record as published on Arkiv.
export function offerRecord(x, { endpoint, hederaPayTo, now = Date.now() }) {
  const p = P[x.productId], s = shopById(x.sellerId);
  return {
    offerId: offerId(x.sellerId, x.productId), sellerId: x.sellerId, productId: x.productId, category: p.category, brand: p.brand, model: p.model, specs: p.specs,
    condition: x.condition, warrantyMonths: x.warrantyMonths, priceUnits: String(usdc(x.priceUsdc)), stock: x.stock,
    deliveryFeeUnits: String(usdc(s.delivery.feeUsdc)), freeOverUnits: String(usdc(s.delivery.freeOverUsdc)), deliveryDays: s.delivery.days, regions: s.delivery.regions,
    endpoint, hederaPayTo, validUntil: Math.floor(now / 1000) + x.validDays * 86400,
  };
}
