// Turns the user's words into structured requirements, then lists what still has to be asked.
// A model extracts when LLM_BASE_URL is set; otherwise simple rules (labelled). Either way code normalises and validates the result,
// and nothing is bought from this step: it only feeds the build planner.
import { knownGames } from "./perf.mjs";
import { usdc } from "./pc-catalog.mjs";

const INDIA = /\b(india|mumbai|pune|bengaluru|bangalore|delhi|hyderabad|chennai|kolkata|ahmedabad|jaipur|maharashtra|karnataka)\b/i;
const RES = (t) => (/\b(4k|2160p|uhd)\b/i.test(t) ? "4K" : /\b(1440p|2k|qhd)\b/i.test(t) ? "1440p" : /\b(1080p|full ?hd|fhd)\b/i.test(t) ? "1080p" : null);

// Rule-based extraction: good enough for clear prompts, and honest about what it couldn't find.
export function extractRules(text) {
  const t = String(text ?? "");
  const r = { games: knownGames(t), workloads: [], target: {}, monitor: {}, peripherals: {}, other: [] };
  const money = /(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:usdc|usd|dollars?|\$)|\$\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?/i.exec(t);
  if (money) { const n = Number((money[1] ?? money[4]).replace(/,/g, "")) * (money[2] || money[5] ? 1000 : 1); if (n > 0) r.budgetUsdc = n; }
  const fps = /(\d{2,3})\s*(?:fps|frames)/i.exec(t); if (fps) r.target.fps = Number(fps[1]);
  const set = /\b(ultra|high|medium|low)\s*(?:settings|graphics|preset)?\b/i.exec(t); if (set && /settings|graphics|preset/i.test(t)) r.target.settings = set[1].toLowerCase();
  // "a 4K monitor" describes the screen, not the game resolution; only "play at 4K"-style wording sets the game target.
  const mon = /([^.,;]*?)\bmonitor\b/i.exec(t);
  if (mon) { r.monitor.needed = true; r.monitor.resolution = RES(mon[1]) ?? RES(t.slice(mon.index, mon.index + 40)); const hz = /(\d{2,3})\s*hz/i.exec(t); if (hz) r.monitor.minHz = Number(hz[1]); }
  const playAt = /(?:at|in|run(?:ning)?|play(?:ing)?)\s+(?:native\s+)?(4k|2160p|1440p|2k|1080p)\b(?!\s*monitor)/i.exec(t);
  if (playAt) r.target.resolution = RES(playAt[1]);
  if (/\bnative\s+4k\b/i.test(t)) { r.target.resolution = "4K"; r.target.renderMode = "native"; }
  if (/\b(dlss|fsr|upscal)/i.test(t)) r.target.renderMode = "upscaled";
  if (/\bno (keyboard|mouse|peripherals)\b|already have (a )?(keyboard|mouse|peripherals)/i.test(t)) { r.peripherals.keyboard = false; r.peripherals.mouse = false; }
  if (/\bkeyboard\b/i.test(t) && r.peripherals.keyboard !== false) r.peripherals.keyboard = true;
  if (/\bmouse\b/i.test(t) && r.peripherals.mouse !== false) r.peripherals.mouse = true;
  if (/\b(used|second.?hand|refurb)/i.test(t)) r.condition = /\b(no|not|avoid)\s+(used|second.?hand|refurb)/i.test(t) ? "new" : "any";
  else if (/\bnew (parts )?only\b|\bbrand new\b/i.test(t)) r.condition = "new";
  const where = INDIA.exec(t); if (where) { r.region = "IN"; r.regionText = where[1]; }
  else { const d = /deliver(?:y|ed)?\s+(?:to|in)\s+([A-Za-z ]{3,30})/i.exec(t); if (d) { r.region = "OTHER"; r.regionText = d[1].trim(); } }
  if (/\b(stream|streaming|obs)\b/i.test(t)) r.workloads.push("streaming");
  if (/\b(video edit|editing|premiere|davinci|blender|3d)\b/i.test(t)) r.workloads.push("content creation");
  if (/\b(quiet|silent)\b/i.test(t)) r.other.push("quiet build preferred");
  if (/\b(small|compact|itx)\b/i.test(t)) r.other.push("small case preferred");
  return r;
}

async function extractModel(text) {
  const r = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.LLM_API_KEY}` }, signal: AbortSignal.timeout(12000),
    body: JSON.stringify({ model: process.env.LLM_MODEL, temperature: 0, response_format: { type: "json_object" }, messages: [
      { role: "system", content: `Extract gaming-PC shopping requirements from the user's message. Only record what the user actually said; use null for anything not stated. Never guess a budget, region or game resolution.
A monitor's resolution is NOT the game's render resolution: "a 4K monitor" sets monitor.resolution only. Set target.resolution only if the user says what resolution games should run at.
Reply only with JSON: {"budgetUsdc": number|null, "games": [string], "workloads": [string], "target": {"resolution": "1080p"|"1440p"|"4K"|null, "renderMode": "native"|"upscaled"|null, "fps": number|null, "settings": "low"|"medium"|"high"|"ultra"|null}, "monitor": {"needed": boolean, "resolution": "1080p"|"1440p"|"4K"|null, "minHz": number|null}, "peripherals": {"keyboard": boolean|null, "mouse": boolean|null}, "condition": "new"|"any"|null, "region": "IN"|"OTHER"|null, "regionText": string|null, "other": [string]}` },
      { role: "user", content: String(text).slice(0, 2000) },
    ] }),
  });
  return JSON.parse((await r.json()).choices[0].message.content);
}

const pick = (x, allowed) => (allowed.includes(x) ? x : null);
const num = (x, lo, hi) => (Number.isFinite(Number(x)) && Number(x) >= lo && Number(x) <= hi ? Number(x) : null);
// Code decides the final shape: unknown values are dropped, never invented.
function normalise(raw, source) {
  const g = raw ?? {}, tg = g.target ?? {}, mo = g.monitor ?? {}, pe = g.peripherals ?? {};
  const games = [...new Set([...(Array.isArray(g.games) ? g.games.map(String) : []), ...knownGames(String(g.games ?? ""))])].map((x) => x.slice(0, 60)).slice(0, 6);
  return {
    budgetUnits: num(g.budgetUsdc, 1, 100000) ? String(usdc(num(g.budgetUsdc, 1, 100000))) : null,
    games, workloads: (Array.isArray(g.workloads) ? g.workloads : []).map(String).slice(0, 5),
    target: { resolution: pick(tg.resolution, ["1080p", "1440p", "4K"]), renderMode: pick(tg.renderMode, ["native", "upscaled"]), fps: num(tg.fps, 30, 360), settings: pick(tg.settings, ["low", "medium", "high", "ultra"]) },
    monitor: { needed: !!mo.needed, resolution: pick(mo.resolution, ["1080p", "1440p", "4K"]), minHz: num(mo.minHz, 50, 540) },
    peripherals: { keyboard: typeof pe.keyboard === "boolean" ? pe.keyboard : null, mouse: typeof pe.mouse === "boolean" ? pe.mouse : null },
    condition: pick(g.condition, ["new", "any"]), region: pick(g.region, ["IN", "OTHER"]), regionText: g.regionText ? String(g.regionText).slice(0, 40) : null,
    other: (Array.isArray(g.other) ? g.other : []).map(String).slice(0, 5), source,
  };
}

// Answers to clarifying questions, merged in by code.
export function applyAnswers(req, answers = {}) {
  const r = structuredClone(req);
  if (answers.budgetUsdc != null && num(answers.budgetUsdc, 1, 100000)) r.budgetUnits = String(usdc(Number(answers.budgetUsdc)));
  if (answers.render === "native") Object.assign(r.target, { resolution: "4K", renderMode: "native" });
  if (answers.render === "upscaled") Object.assign(r.target, { resolution: "4K", renderMode: "upscaled" });
  if (answers.render === "1440p") Object.assign(r.target, { resolution: "1440p", renderMode: "native" });
  if (answers.render === "1080p") Object.assign(r.target, { resolution: "1080p", renderMode: "native" });
  if (answers.region === "IN" || answers.region === "OTHER") { r.region = answers.region; r.regionText = answers.region === "IN" ? "India" : String(answers.regionText ?? "outside India"); }
  if (answers.condition === "new" || answers.condition === "any") r.condition = answers.condition;
  if (answers.peripherals) { const p = String(answers.peripherals); r.peripherals = { keyboard: /both|keyboard/.test(p), mouse: /both|mouse/.test(p) }; }
  if (answers.fps != null && num(answers.fps, 30, 360)) r.target.fps = Number(answers.fps);
  if (answers.settings) r.target.settings = pick(answers.settings, ["low", "medium", "high", "ultra"]) ?? r.target.settings;
  return r;
}

// Only what can't be sensibly assumed is asked: the PC budget. Everything else gets a default that is stated back to the
// user (and the planner labels any option that had to relax a requirement).
export function questions(req) {
  return req.budgetUnits ? [] : [{ id: "budgetUsdc", blocking: true, question: "What is your total PC budget in USDC, including delivery?", kind: "number" }];
}
export function withDefaults(req) {
  const r = structuredClone(req), assumed = [];
  if (!r.target.fps) { r.target.fps = 60; assumed.push("60 FPS target (not stated)"); }
  if (!r.target.settings) { r.target.settings = "high"; assumed.push("high graphics settings (not stated)"); }
  if (!r.target.resolution) {
    const fourK = r.monitor.resolution === "4K";
    r.target.resolution = fourK ? "4K" : "1440p"; r.target.renderMode = fourK ? "upscaled" : "native";
    assumed.push(fourK ? "games at 4K with upscaling (DLSS/FSR), not native 4K, to match the 4K monitor (not stated)" : "games at 1440p (not stated)");
  } else if (r.target.resolution === "4K" && !r.target.renderMode) { r.target.renderMode = "upscaled"; assumed.push("4K with upscaling (DLSS/FSR), not native 4K (not stated)"); }
  if (r.target.resolution && r.target.resolution !== "4K") r.target.renderMode = "native";
  if (!r.region) { r.region = "IN"; r.regionText = "India"; assumed.push("delivery within India (the demo shops only deliver there)"); }
  if (!r.condition) { r.condition = "new"; assumed.push("new parts only (not stated)"); }
  if (r.peripherals.keyboard == null) { r.peripherals.keyboard = false; if (r.peripherals.mouse == null) assumed.push("no keyboard or mouse (not stated)"); }
  if (r.peripherals.mouse == null) r.peripherals.mouse = false;
  r.minRamGB = r.games.length || r.workloads.length ? 32 : 16;
  assumed.push(`${r.minRamGB} GB RAM minimum for these games and workloads (team rule of thumb)`);
  if (r.monitor.needed && !r.monitor.resolution) { r.monitor.resolution = r.target.resolution === "4K" ? "4K" : r.target.resolution; assumed.push(`${r.monitor.resolution} monitor (matches the game target)`); }
  return { ...r, assumptions: assumed };
}

export async function parseRequirements(text) {
  if (process.env.LLM_BASE_URL) {
    try { return normalise(await extractModel(text), process.env.LLM_MODEL || "model"); }
    catch (e) { return { ...normalise(extractRules(text), "rules"), note: `model unavailable (${String(e.message).slice(0, 60)}); used simple rules` }; }
  }
  return normalise(extractRules(text), "rules");
}
