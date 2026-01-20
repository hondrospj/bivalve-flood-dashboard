// tools/build_nwps_forecast.js
// Fetch NWPS forecast for bvvn4 and write /data/nwps_forecast.json
// Output format: [{t: ISOString, ft: Number}, ...]

const fs = require("fs");

const GAUGE = process.env.NWPS_GAUGE || "bvvn4";
const OUTFILE = "data/nwps_forecast.json";

// Common NWPS endpoint pattern used for hydrograph data
const URL = `https://api.water.noaa.gov/nwps/v1/gauges/${GAUGE}/stageflow`;

async function main() {
  const res = await fetch(URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (GitHub Actions)",
      "Accept": "application/json",
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`NWPS fetch failed ${res.status}: ${txt.slice(0, 300)}`);
  }

  const j = await res.json();

  // The API shape can vary; these are common containers.
  // We try a few likely paths and flatten into [{t, ft}] where ft = stage (water level).
  const candidates =
    j?.forecast?.data ||
    j?.forecast ||
    j?.data ||
    j?.stageflow?.forecast?.data ||
    j?.stageflow?.data ||
    [];

  const arr = Array.isArray(candidates) ? candidates : [];

  // Try common field names
  const out = arr
    .map((p) => {
      const t = p?.validTime || p?.t || p?.time || p?.dateTime || p?.datetime;
      const ft = p?.primary || p?.stage || p?.value || p?.ft;
      const n = Number(ft);
      if (!t || !Number.isFinite(n)) return null;
      const iso = new Date(t).toISOString();
      return { t: iso, ft: n };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.t) - new Date(b.t));

  fs.writeFileSync(OUTFILE, JSON.stringify(out, null, 2));
  console.log(`Wrote ${out.length} points to ${OUTFILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
