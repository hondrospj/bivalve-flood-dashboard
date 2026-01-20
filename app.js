// --- Config (your thresholds) ---
const TH = { minor: 4.19, moderate: 5.19, major: 6.19 };
const USGS_SITE = "01412150";            // Bivalve (observed)
const NOAA_STATION = "8535055";          // Bivalve CO-OPS station for predictions
const POINT = { lat: 39.0, lon: -74.9 }; // NWS alert point

// --- TXT (daily stats) in your repo ---
const DAILY_TXT_URL = "./data/bivalve_daily_stats.txt";
// Daily High / Daily Low-High (NAVD88) columns for param 72279
const COL_DAILY_HIGH = "239251_72279_00021";
const COL_DAILY_LOWHI = "239252_72279_00022";

// --- NOAA datum handling (predictions are typically MLLW) ---
const NAVD_MINUS_MLLW_FT = -3.41; // NAVD = MLLW - 3.41  (so MLLW = NAVD + 3.41)
function mllwToNavd(ft) { return ft + NAVD_MINUS_MLLW_FT; } // mllw - 3.41

// --- Helpers ---
const $ = (id) => document.getElementById(id);
const fmt = (x) => (x == null || Number.isNaN(x) ? "—" : (+x).toFixed(2));
const dt = (iso) => new Date(iso);
const local = (d) =>
  d.toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

function classify(ft) {
  if (ft >= TH.major) return { label: "Major", cls: "text-purple-700" };
  if (ft >= TH.moderate) return { label: "Moderate", cls: "text-red-700" };
  if (ft >= TH.minor) return { label: "Minor", cls: "text-amber-700" };
  return { label: "No flood", cls: "text-slate-600" };
}

async function jget(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

async function tget(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.text();
}

// --- TXT parse (USGS daily stats tab-delimited; NAVD88) ---
function parseUSGSDailyStatsTxt(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);

  const headerIdx = lines.findIndex(
    (l) => !l.startsWith("#") && l.startsWith("agency_cd\t")
  );
  if (headerIdx < 0) throw new Error("TXT header not found (agency_cd...).");

  const header = lines[headerIdx].split("\t");
  const idxDate = header.indexOf("datetime");
  const idxHigh = header.indexOf(COL_DAILY_HIGH);
  const idxLowHi = header.indexOf(COL_DAILY_LOWHI);

  if (idxDate < 0) throw new Error("TXT missing datetime column.");
  if (idxHigh < 0 || idxLowHi < 0) {
    throw new Error(
      `TXT missing expected columns. Need ${COL_DAILY_HIGH} and ${COL_DAILY_LOWHI}`
    );
  }

  const events = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln || ln.startsWith("#")) continue;
    const parts = ln.split("\t");
    if (parts.length < header.length) continue;

    const date = (parts[idxDate] || "").trim(); // YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const high = parseFloat((parts[idxHigh] || "").trim());
    const lowhi = parseFloat((parts[idxLowHi] || "").trim());

    const iso = `${date}T17:00:00Z`; // stable timestamp (~noon EST)

    if (Number.isFinite(high)) {
      const t = classify(high).label;
      events.push({ datetime: local(dt(iso)), _t: iso, peak: high, type: t });
    }
    if (Number.isFinite(lowhi)) {
      const t = classify(lowhi).label;
      events.push({ datetime: local(dt(iso)), _t: iso, peak: lowhi, type: t });
    }
  }

  events.sort((a, b) => dt(b._t) - dt(a._t));
  return events;
}

// --- Data loaders (repo datasets) ---
async function loadRepoJSON() {
  const [annual, topTen] = await Promise.all([
    jget("./data/annual_counts.json"),
    jget("./data/top_ten.json"),
  ]);

  let events;
  try {
    const txt = await tget(DAILY_TXT_URL);
    events = parseUSGSDailyStatsTxt(txt);
  } catch (e) {
    console.error("TXT load failed, falling back to events.json:", e);
    events = await jget("./data/events.json");
  }

  return { annual, topTen, events };
}

// --- USGS 15-min observations ---
async function loadUSGS(period) {
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${USGS_SITE}&period=${period}`;
  const js = await jget(url);
  const ts = js?.value?.timeSeries || [];
  const pick =
    ts.find((s) =>
      (s?.variable?.variableName || "")
        .toLowerCase()
        .match(/(gage height|water level|tidal|elevation)/)
    ) || ts[0];
  const vals = (pick?.values?.[0]?.value || [])
    .map((v) => ({ t: v.dateTime, ft: +v.value }))
    .filter((v) => Number.isFinite(v.ft));
  return vals;
}

// --- NOAA 6-min predictions (Bivalve station) -> convert to NAVD88 using -3.41 ---
async function loadNOAA72h() {
  const now = new Date();
  const end = new Date(now.getTime() + 72 * 3600 * 1000);
  const ymd = (d) => d.toISOString().slice(0, 10).replaceAll("-", "");

  // Predictions product is commonly returned relative to MLLW. Request MLLW explicitly.
  const url =
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?product=predictions&application=cupajoe` +
    `&begin_date=${ymd(now)}&end_date=${ymd(end)}` +
    `&datum=MLLW&station=${NOAA_STATION}` +
    `&time_zone=gmt&units=english&interval=6&format=json`;

  const js = await jget(url);
  const p = (js?.predictions || [])
    .map((r) => {
      const t = r.t.replace(" ", "T") + "Z";
      const mllw = +r.v;
      if (!Number.isFinite(mllw)) return null;
      const navd = mllwToNavd(mllw); // NAVD = MLLW - 3.41
      return { t, ft: navd };
    })
    .filter(Boolean);

  return p;
}

// --- NWS banner ---
async function loadNWSBanner() {
  const url = `https://api.weather.gov/alerts/active?point=${POINT.lat},${POINT.lon}`;
  const js = await jget(url);
  const feats = js?.features || [];
  const hit = feats.find((f) => {
    const ev = (f?.properties?.event || "").toLowerCase();
    return ev.includes("coastal flood");
  });
  if (!hit) return null;
  return {
    title: hit.properties.event,
    headline: hit.properties.headline || hit.properties.event,
    url: hit.properties.web || hit.properties.uri || "https://www.weather.gov/",
  };
}

// --- Render tables ---
function renderAnnual(rows) {
  $("annualRows").innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td class="p-2 font-medium">${r.year}</td>
      <td class="p-2">${r.minor}</td>
      <td class="p-2">${r.moderate}</td>
      <td class="p-2">${r.major}</td>
    </tr>
  `
    )
    .join("");
}

function renderTopTen(rows) {
  $("topTenRows").innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td class="p-2 font-medium">${r.rank}</td>
      <td class="p-2">${r.date}</td>
      <td class="p-2">${fmt(r.peak)}</td>
      <td class="p-2">${r.type}</td>
    </tr>
  `
    )
    .join("");
}

function renderEvents(rows, minFt) {
  const filt = rows
    .filter((r) => +r.peak >= minFt)
    .slice(0, 250);
  $("eventsRows").innerHTML = filt
    .map(
      (r) => `
    <tr>
      <td class="p-2">${r.datetime}</td>
      <td class="p-2 font-medium">${fmt(r.peak)}</td>
      <td class="p-2">${r.type}</td>
    </tr>
  `
    )
    .join("");
}

// --- Chart ---
let chart;
function renderChart(obs, pred) {
  const ctx = $("tsChart");
  const obsPts = obs.map((d) => ({ x: d.t, y: d.ft }));
  const predPts = pred.map((d) => ({ x: d.t, y: d.ft }));

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        {
          label: "Bivalve observed (USGS)",
          data: obsPts,
          tension: 0.15,
          pointRadius: 0,
          borderWidth: 2,
        },
        {
          label: "Bivalve predicted (NOAA)",
          data: predPts,
          tension: 0.15,
          pointRadius: 0,
          borderWidth: 2,
          borderDash: [6, 5],
        },
      ],
    },
    options: {
      parsing: false,
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          type: "time",
          time: { tooltipFormat: "MMM d, HH:mm" },
          ticks: { maxRotation: 0 },
        },
        y: { title: { display: true, text: "Feet (NAVD88)" } },
      },
      plugins: {
        legend: { position: "bottom" },
        tooltip: { mode: "index", intersect: false },
      },
      interaction: { mode: "index", intersect: false },
    },
  });
}

// --- KPIs from observations ---
function computeTodayMinMax(obs) {
  const today = new Date();
  const y = today.getFullYear(),
    m = today.getMonth(),
    d = today.getDate();
  const start = new Date(y, m, d, 0, 0, 0),
    end = new Date(y, m, d + 1, 0, 0, 0);
  const todays = obs
    .filter((p) => dt(p.t) >= start && dt(p.t) < end)
    .map((p) => p.ft);
  if (!todays.length) return { min: null, max: null };
  return { min: Math.min(...todays), max: Math.max(...todays) };
}

function computeMaxSince(obs) {
  let best = null;
  for (const p of obs) {
    if (best == null || p.ft > best.ft) best = p;
  }
  return best ? { ft: best.ft, t: best.t } : { ft: null, t: null };
}

function lastWithinTolerance(obs, target, tol = 0.2) {
  if (obs.length < 3) return null;
  const latestT = obs[obs.length - 1].t;
  for (let i = obs.length - 2; i >= 0; i--) {
    if (Math.abs(obs[i].ft - target) <= tol) return { ...obs[i], latestT };
  }
  return null;
}

// --- Main ---
(async function init() {
  $("minorVal").textContent = TH.minor.toFixed(2);
  $("moderateVal").textContent = TH.moderate.toFixed(2);
  $("majorVal").textContent = TH.major.toFixed(2);

  try {
    const b = await loadNWSBanner();
    if (b) {
      $("banner").classList.remove("hidden");
      $("bannerText").textContent = `${b.title}: ${b.headline}`;
      $("bannerLink").href = b.url;
    }
  } catch (e) {}

  const repo = await loadRepoJSON();
  renderAnnual(repo.annual);
  renderTopTen(repo.topTen);

  const filterInput = $("filterFt");
  const rerenderEvents = () =>
    renderEvents(repo.events, +filterInput.value || TH.minor);
  filterInput.addEventListener("input", rerenderEvents);
  rerenderEvents();

  const [obs72, obs31, pred72] = await Promise.all([
    loadUSGS("P3D"),
    loadUSGS("P31D"),
    loadNOAA72h(),
  ]);

  const cur = obs72[obs72.length - 1];
  $("currentLevel").textContent = fmt(cur?.ft);
  const c = classify(cur?.ft);
  $("currentClass").textContent = c.label;
  $("currentClass").className = `mt-2 text-sm font-semibold ${c.cls}`;

  const mm = computeMaxSince(obs31);
  $("monthlyMax").textContent = fmt(mm.ft);
  $("monthlyMaxWhen").textContent = mm.t ? local(dt(mm.t)) : "—";

  const tmm = computeTodayMinMax(obs72);
  $("todayMin").textContent = fmt(tmm.min);
  $("todayMax").textContent = fmt(tmm.max);

  if (cur?.ft >= TH.moderate) {
    const hit = lastWithinTolerance(obs72, cur.ft, 0.2);
    if (hit) {
      $("nearLast").textContent = local(dt(hit.t));
      $("nearMeta").textContent = `Within 0.2 ft of ${cur.ft.toFixed(2)} ft`;
    } else {
      $("nearLast").textContent = "No match in last 72h";
      $("nearMeta").textContent = `Target ${cur.ft.toFixed(2)} ft`;
    }
  } else {
    $("nearLast").textContent = "—";
    $("nearMeta").textContent = "—";
  }

  renderChart(obs72, pred72);
  $("updatedAt").textContent = new Date().toLocaleString();
})();
