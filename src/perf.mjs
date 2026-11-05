// Performance ESTIMATES from SAMPLE data. These are not benchmarks and guarantee nothing.
// perfIndex on each GPU and CPU is a rough relative index the team wrote for this demo (RTX 4070 SUPER ≈ 170).
// No measured PC benchmarks exist for unreleased games (e.g. GTA 6 on PC), so every game maps to a workload profile instead.
export const PERF_SOURCE = "SAMPLE ESTIMATE: team-written relative index and workload profiles, not measured benchmarks";

// Index a GPU needs for 60 FPS at "high" settings, per workload profile and render mode. Sample values.
const PROFILES = {
  "demanding-aaa": { label: "demanding 2025-26 open-world AAA", gpu: { "1080p": 100, "1440p": 150, "4K-upscaled": 170, "4K": 280 }, cpu60: 100 },
  "esports": { label: "competitive esports title", gpu: { "1080p": 40, "1440p": 60, "4K-upscaled": 70, "4K": 110 }, cpu60: 80 },
  "general": { label: "mainstream AAA", gpu: { "1080p": 80, "1440p": 120, "4K-upscaled": 140, "4K": 220 }, cpu60: 90 },
};
// Known titles and the profile used for them. Anything else uses "general" and says so.
const GAMES = [
  [/gta ?(6|vi)|grand theft auto (6|vi)/i, "GTA 6", "demanding-aaa", "No PC version or PC benchmarks were available when this catalog was written; treated as a demanding open-world AAA game."],
  [/cyberpunk/i, "Cyberpunk 2077", "demanding-aaa", null],
  [/alan wake/i, "Alan Wake 2", "demanding-aaa", null],
  [/black myth|wukong/i, "Black Myth: Wukong", "demanding-aaa", null],
  [/valorant/i, "Valorant", "esports", null],
  [/counter.?strike|cs2|csgo/i, "Counter-Strike 2", "esports", null],
  [/fortnite/i, "Fortnite", "general", null],
];
export const knownGames = (text) => GAMES.filter(([re]) => re.test(text)).map(([, name]) => name);
const gameInfo = (name) => { const g = GAMES.find(([, n]) => n.toLowerCase() === String(name).toLowerCase()); return g ? { name: g[1], profile: g[2], note: g[3] } : { name, profile: "general", note: `${name} isn't in the sample table; treated as a mainstream AAA game.` }; };
const SETTINGS = { low: 0.65, medium: 0.8, high: 1, ultra: 1.2 };

// target: { resolution: "1080p"|"1440p"|"4K", renderMode: "native"|"upscaled", fps, settings }
export function estimate({ gpu, cpu, games, target }) {
  const mode = target.resolution === "4K" && target.renderMode === "upscaled" ? "4K-upscaled" : target.resolution;
  const fps = Number(target.fps || 60), mult = (SETTINGS[target.settings] ?? 1) * (fps / 60);
  const list = (games?.length ? games : ["a demanding AAA game"]).map(gameInfo);
  const per = list.map((g) => {
    const p = PROFILES[g.profile], needGpu = Math.round(p.gpu[mode] * mult), needCpu = Math.round(p.cpu60 * (fps / 60));
    const gi = gpu.specs.perfIndex, ci = cpu.specs.perfIndex;
    const verdict = gi >= needGpu * 1.15 && ci >= needCpu ? "likely" : gi >= needGpu && ci >= needCpu * 0.9 ? "borderline" : "unlikely";
    return { game: g.name, profile: p.label, needGpuIndex: needGpu, gpuIndex: gi, needCpuIndex: needCpu, cpuIndex: ci, verdict, note: g.note };
  });
  const order = ["unlikely", "borderline", "likely"];
  const worst = per.reduce((w, x) => (order.indexOf(x.verdict) < order.indexOf(w) ? x.verdict : w), "likely");
  const label = `${target.resolution}${target.resolution === "4K" ? (target.renderMode === "upscaled" ? ` with ${gpu.specs.upscaler ?? "upscaling"}` : " native") : ""}, ${fps} FPS, ${target.settings ?? "high"} settings`;
  return { verdict: worst, target: label, perGame: per, source: PERF_SOURCE, assumptions: [
    "Relative index values are sample estimates for this demo, not measurements.",
    ...(mode === "4K-upscaled" ? ["Upscaled 4K renders at a lower internal resolution (about 1440p) and outputs to the 4K monitor."] : []),
    "Real frame rates vary with drivers, patches, scenes and settings. Nothing here is a guarantee.",
  ] };
}
export const verdictRank = (v) => ({ likely: 2, borderline: 1, unlikely: 0 })[v] ?? 0;
