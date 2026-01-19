// --- Config (your thresholds) ---
const TH = { minor: 4.19, moderate: 5.19, major: 6.19 };
const USGS_SITE = "01412150";          // Bivalve
const NOAA_STATION = "8536110";        // Cape May
const POINT = { lat: 39.0, lon: -74.9 }; // used for NWS alert point; tweak if you want exact

// --- Helpers ---
const $ = (id) => document.getElementById(id);
const fmt = (x) => (x == null || Number.isNaN(x) ? "—" : (+x).toFixed(2));
const dt = (iso) => new Date(iso);
const local = (d) => d.toLocaleString([], { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });

function classify(ft){
  if (ft >= TH.major) return { label:"Major", cls:"text-purple-700" };
  if (ft >= TH.moderate) return { label:"Moderate", cls:"text-red-700" };
  if (ft >= TH.minor) return { label:"Minor", cls:"text-amber-700" };
  return { label:"No flood", cls:"text-slate-600" };
}

async function jget(url){
  const r = await fetch(url, { headers: { "Accept":"application/json" }});
  if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

// --- Data loaders (repo datasets) ---
async function loadRepoJSON(){
  const [annual, topTen, events] = await Promise.all([
    jget("data/annual_counts.json"),
    jget("data/top_ten.json"),
    jget("data/events.json")
  ]);
  return { annual, topTen, events };
}

// --- USGS 15-min observations (last 72h, plus last 31d for monthly max) ---
async function loadUSGS(period){
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${USGS_SITE}&period=${period}`;
  const js = await jget(url);
  const ts = js?.value?.timeSeries || [];
  // pick the first series that looks like water level / gage height / tidal elevation
  const pick = ts.find(s => (s?.variable?.variableName || "").toLowerCase().match(/(gage height|water level|tidal|elevation)/))
            || ts[0];
  const vals = (pick?.values?.[0]?.value || []).map(v => ({ t: v.dateTime, ft: +v.value })).filter(v => Number.isFinite(v.ft));
  return vals;
}

// --- NOAA 6-min predictions (Cape May) ---
async function loadNOAA72h(){
  // CO-OPS API supports predictions; datum handling varies by station/settings.
  // Start with NAVD; if your response errors, change datum=MLLW and apply your known offset, or remove datum.
  const now = new Date();
  const end = new Date(now.getTime() + 72*3600*1000);
  const ymd = (d)=> d.toISOString().slice(0,10).replaceAll("-","");
  const url =
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
    `?product=predictions&application=cupajoe` +
    `&begin_date=${ymd(now)}&end_date=${ymd(end)}` +
    `&datum=NAVD&station=${NOAA_STATION}` +
    `&time_zone=gmt&units=english&interval=6&format=json`;
  const js = await jget(url);
  const p = (js?.predictions || []).map(r => ({ t: r.t.replace(" ", "T")+"Z", ft: +r.v })).filter(v => Number.isFinite(v.ft));
  return p;
}

// --- NWS: banner if any active Coastal Flood Advisory/Warning/Watch ---
async function loadNWSBanner(){
  const url = `https://api.weather.gov/alerts/active?point=${POINT.lat},${POINT.lon}`;
  const js = await jget(url);
  const feats = js?.features || [];
  const hit = feats.find(f => {
    const ev = (f?.properties?.event || "").toLowerCase();
    return ev.includes("coastal flood");
  });
  if (!hit) return null;
  return {
    title: hit.properties.event,
    headline: hit.properties.headline || hit.properties.event,
    url: hit.properties.web || hit.properties.uri || "https://www.weather.gov/"
  };
}

// --- Render tables ---
function renderAnnual(rows){
  $("annualRows").innerHTML = rows.map(r => `
    <tr>
      <td class="p-2 font-medium">${r.year}</td>
      <td class="p-2">${r.minor}</td>
      <td class="p-2">${r.moderate}</td>
      <td class="p-2">${r.major}</td>
    </tr>
  `).join("");
}

function renderTopTen(rows){
  $("topTenRows").innerHTML = rows.map(r => `
    <tr>
      <td class="p-2 font-medium">${r.rank}</td>
      <td class="p-2">${r.date}</td>
      <td class="p-2">${fmt(r.peak)}</td>
      <td class="p-2">${r.type}</td>
    </tr>
  `).join("");
}

function renderEvents(rows, minFt){
  const filt = rows.filter(r => +r.peak >= minFt).slice(0, 250); // cap display for UI smoothness; data itself is not time-limited
  $("eventsRows").innerHTML = filt.map(r => `
    <tr>
      <td class="p-2">${r.datetime}</td>
      <td class="p-2 font-medium">${fmt(r.peak)}</td>
      <td class="p-2">${r.type}</td>
    </tr>
  `).join("");
}

// --- Chart ---
let chart;
function renderChart(obs, pred){
  const ctx = $("tsChart");
  const obsPts = obs.map(d => ({ x: d.t, y: d.ft }));
  const predPts = pred.map(d => ({ x: d.t, y: d.ft }));

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        { label: "Bivalve observed (USGS)", data: obsPts, tension: 0.15, pointRadius: 0, borderWidth: 2 },
        { label: "Cape May predicted (NOAA)", data: predPts, tension: 0.15, pointRadius: 0, borderWidth: 2 }
      ]
    },
    options: {
      parsing: false,
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { type: "time", time: { tooltipFormat: "MMM d, HH:mm" }, ticks: { maxRotation: 0 } },
        y: { title: { display: true, text: "Feet" } }
      },
      plugins: {
        legend: { position: "bottom" },
        tooltip: { mode: "index", intersect: false }
      },
      interaction: { mode: "index", intersect: false }
    }
  });
}

// --- KPIs from observations ---
function computeTodayMinMax(obs){
  const today = new Date();
  const y = today.getFullYear(), m = today.getMonth(), d = today.getDate();
  const start = new Date(y,m,d,0,0,0), end = new Date(y,m,d+1,0,0,0);
  const todays = obs.filter(p => dt(p.t) >= start && dt(p.t) < end).map(p=>p.ft);
  if(!todays.length) return { min:null, max:null };
  return { min: Math.min(...todays), max: Math.max(...todays) };
}

function computeMaxSince(obs){
  let best = null;
  for (const p of obs){
    if (best == null || p.ft > best.ft) best = p;
  }
  return best ? { ft: best.ft, t: best.t } : { ft:null, t:null };
}

function lastWithinTolerance(obs, target, tol=0.2){
  // obs sorted oldest->newest; scan backwards skipping the latest point
  if (obs.length < 3) return null;
  const latestT = obs[obs.length-1].t;
  for (let i = obs.length-2; i >= 0; i--){
    if (Math.abs(obs[i].ft - target) <= tol) return { ...obs[i], latestT };
  }
  return null;
}

// --- Main ---
(async function init(){
  $("minorVal").textContent = TH.minor.toFixed(2);
  $("moderateVal").textContent = TH.moderate.toFixed(2);
  $("majorVal").textContent = TH.major.toFixed(2);

  // Banner
  try{
    const b = await loadNWSBanner();
    if (b){
      $("banner").classList.remove("hidden");
      $("bannerText").textContent = `${b.title}: ${b.headline}`;
      $("bannerLink").href = b.url;
    }
  }catch(e){ /* silent */ }

  // Repo datasets
  const repo = await loadRepoJSON();
  renderAnnual(repo.annual);
  renderTopTen(repo.topTen);

  const filterInput = $("filterFt");
  const rerenderEvents = ()=> renderEvents(repo.events, +filterInput.value || TH.minor);
  filterInput.addEventListener("input", rerenderEvents);
  rerenderEvents();

  // Live observations
  const [obs72, obs31, pred72] = await Promise.all([
    loadUSGS("P3D"),
    loadUSGS("P31D"),
    loadNOAA72h()
  ]);

  // Current
  const cur = obs72[obs72.length-1];
  $("currentLevel").textContent = fmt(cur?.ft);
  const c = classify(cur?.ft);
  $("currentClass").textContent = c.label;
  $("currentClass").className = `mt-2 text-sm font-semibold ${c.cls}`;

  // Monthly max (last 31d)
  const mm = computeMaxSince(obs31);
  $("monthlyMax").textContent = fmt(mm.ft);
  $("monthlyMaxWhen").textContent = mm.t ? local(dt(mm.t)) : "—";

  // Today min/max (use 72h buffer)
  const tmm = computeTodayMinMax(obs72);
  $("todayMin").textContent = fmt(tmm.min);
  $("todayMax").textContent = fmt(tmm.max);

  // Near-last (only if >= moderate)
  if (cur?.ft >= TH.moderate){
    const hit = lastWithinTolerance(obs72, cur.ft, 0.2);
    if (hit){
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

  // Chart
  // note: Chart.js time scale needs date adapter; modern browsers handle ISO strings well enough for basic plotting.
  renderChart(obs72, pred72);

  $("updatedAt").textContent = new Date().toLocaleString();
})();

