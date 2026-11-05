// Compatibility rules, enforced in code. A model may suggest parts, but only these checks decide whether a build is valid.
// Each check returns { check, ok, detail }. A build is compatible only if every check passes.
export const CORE = ["cpu", "motherboard", "ram", "gpu", "storage", "psu", "case", "cooler"];
// Board, memory, storage and fans on top of CPU and GPU power, and the headroom required on the PSU. Rule-of-thumb values.
export const BASE_SYSTEM_W = 75, PSU_HEADROOM = 1.3;

export const estimatedDrawW = (b) => (b.cpu?.specs.tdpW ?? 0) + (b.gpu?.specs.tdpW ?? 0) + BASE_SYSTEM_W;

// parts: { cpu, motherboard, ram, gpu, storage, psu, case, cooler, monitor?, keyboard?, mouse? } — each an offer with .specs and .category
// req: { minRamGB, needMonitor, monitorResolution, needKeyboard, needMouse }
export function checkBuild(parts, req = {}) {
  const out = [], add = (check, ok, detail) => out.push({ check, ok: !!ok, detail });
  const { cpu, motherboard: mb, ram, gpu, storage, psu, case: cs, cooler } = parts;
  const need = [...CORE, ...(req.needMonitor ? ["monitor"] : []), ...(req.needKeyboard ? ["keyboard"] : []), ...(req.needMouse ? ["mouse"] : [])];
  const missing = need.filter((c) => !parts[c]);
  add("required parts", !missing.length, missing.length ? `missing: ${missing.join(", ")}` : `all ${need.length} required parts present`);
  for (const [c, p] of Object.entries(parts)) if (p && p.category !== c) add("part categories", false, `${p.model} is a ${p.category}, not a ${c}`);
  if (missing.some((c) => CORE.includes(c))) return out;

  add("CPU socket", cpu.specs.socket === mb.specs.socket, `${cpu.model} needs ${cpu.specs.socket}; ${mb.model} is ${mb.specs.socket}`);
  add("RAM generation", ram.specs.type === mb.specs.memoryType, `${ram.specs.type} memory on a ${mb.specs.memoryType} board`);
  add("RAM fits the board", ram.specs.modules <= mb.specs.memorySlots && ram.specs.capacityGB <= mb.specs.maxMemoryGB, `${ram.specs.modules} modules / ${ram.specs.capacityGB} GB; board has ${mb.specs.memorySlots} slots, up to ${mb.specs.maxMemoryGB} GB`);
  const minRam = req.minRamGB ?? 16;
  add("RAM capacity", ram.specs.capacityGB >= minRam, `${ram.specs.capacityGB} GB, ${minRam} GB required`);
  add("Board fits the case", cs.specs.formFactors.includes(mb.specs.formFactor), `${mb.specs.formFactor} board; case takes ${cs.specs.formFactors.join("/")}`);
  if (gpu.specs.lengthMm != null && cs.specs.maxGpuLengthMm != null) add("GPU length", gpu.specs.lengthMm <= cs.specs.maxGpuLengthMm, `${gpu.specs.lengthMm} mm card; case fits up to ${cs.specs.maxGpuLengthMm} mm`);
  add("Cooler socket", cooler.specs.sockets.includes(cpu.specs.socket), `${cooler.model} supports ${cooler.specs.sockets.join("/")}`);
  if (cooler.specs.type === "air" && cooler.specs.heightMm != null) add("Cooler height", cooler.specs.heightMm <= cs.specs.maxCoolerHeightMm, `${cooler.specs.heightMm} mm cooler; case fits up to ${cs.specs.maxCoolerHeightMm} mm`);
  if (cooler.specs.type === "aio") add("Radiator fits the case", (cs.specs.radiatorsMm ?? []).includes(cooler.specs.radiatorMm), `${cooler.specs.radiatorMm} mm radiator; case takes ${(cs.specs.radiatorsMm ?? []).join("/") || "none"}`);
  if (cooler.specs.maxTdpW != null) add("Cooler capacity", cooler.specs.maxTdpW >= cpu.specs.tdpW, `cooler rated ${cooler.specs.maxTdpW} W; CPU up to ${cpu.specs.tdpW} W`);
  const draw = estimatedDrawW(parts), needW = Math.ceil(draw * PSU_HEADROOM);
  add("PSU wattage", psu.specs.wattage >= needW, `${psu.specs.wattage} W; estimated draw ${draw} W × ${PSU_HEADROOM} headroom = ${needW} W`);
  if (gpu.specs.minPsuW != null) add("GPU maker's PSU minimum", psu.specs.wattage >= gpu.specs.minPsuW, `${gpu.model}: maker recommends at least ${gpu.specs.minPsuW} W`);
  const lacking = Object.entries(gpu.specs.powerConnectors ?? {}).filter(([k, n]) => (psu.specs.connectors?.[k] ?? 0) < n).map(([k, n]) => `${n}× ${k}`);
  add("PSU connectors", !lacking.length, lacking.length ? `GPU needs ${lacking.join(", ")} that the PSU doesn't have (adapters not assumed)` : `GPU power connectors available on the PSU`);
  const iface = storage.specs.interface;
  add("Storage interface", iface === "NVMe" ? mb.specs.m2Slots >= 1 : (mb.specs.sataPorts ?? 0) >= 1, `${iface} drive; board has ${mb.specs.m2Slots} M.2 slots and ${mb.specs.sataPorts ?? 0} SATA ports`);
  if (req.needMonitor && parts.monitor && req.monitorResolution) add("Monitor resolution", parts.monitor.specs.resolution === req.monitorResolution, `${parts.monitor.specs.resolution} monitor; ${req.monitorResolution} requested`);
  return out;
}
export const compatible = (checks) => checks.every((c) => c.ok);

// Cost: item prices, plus one delivery charge per shop (free above that shop's threshold). All integers in micro-USDC.
export function basketCost(lines) {
  const byShop = new Map();
  for (const l of lines) { const s = byShop.get(l.sellerId) ?? { sellerId: l.sellerId, subtotal: 0n, fee: BigInt(l.deliveryFeeUnits), freeOver: BigInt(l.freeOverUnits), days: 0 }; s.subtotal += BigInt(l.unitPrice ?? l.priceUnits) * BigInt(l.qty ?? 1); s.days = Math.max(s.days, l.deliveryDays); byShop.set(l.sellerId, s); }
  const shops = [...byShop.values()].map((s) => ({ ...s, delivery: s.subtotal >= s.freeOver ? 0n : s.fee }));
  const items = shops.reduce((a, s) => a + s.subtotal, 0n), delivery = shops.reduce((a, s) => a + s.delivery, 0n);
  return { items, delivery, total: items + delivery, shops };
}
