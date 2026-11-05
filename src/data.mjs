// Mandi data. Uses data.gov.in when a key is present; otherwise clearly labelled sample data.
// Each sample record says so itself, so the label survives when an agent passes only the records on.
const SAMPLE = [
  { market: "Lasalgaon", commodity: "Onion", modal_price: 1850, sample: true },
  { market: "Pimpalgaon", commodity: "Onion", modal_price: 1790, sample: true },
  { market: "Nashik", commodity: "Onion", modal_price: 1720, sample: true },
  { market: "Solapur", commodity: "Onion", modal_price: 1640, sample: true },
];
const RESOURCE = "9ef84268-d588-465a-a308-a864a43d0070";
export async function mandi(commodity = "Onion", state = "Maharashtra") {
  const key = process.env.DATA_GOV_IN_API_KEY;
  if (key) {
    const u = new URL(`https://api.data.gov.in/resource/${RESOURCE}`);
    Object.entries({ "api-key": key, format: "json", limit: "20", "filters[state]": state, "filters[commodity]": commodity }).forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u); const j = await r.json();
    if (r.ok && j.records?.length) return { source: "data.gov.in (Agmarknet)", sample: false, records: j.records.map((x) => ({ market: x.market, commodity: x.commodity, modal_price: Number(x.modal_price) })) };
  }
  return { source: "SAMPLE DATA, not real prices", sample: true, records: SAMPLE };
}
