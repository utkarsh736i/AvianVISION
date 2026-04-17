/* =============================================================
   dashboard.js — Synaptic Monitor Dashboard Scripts
   Sections:
     1.  API configuration  ← edit this to connect your FastAPI
     2.  Alert thresholds   ← tune these per your hardware
     3.  App state
     4.  Chart helpers
     5.  Chart initialisation
     6.  Demo data generator (used when USE_DEMO = true)
     7.  Data fetch / API polling
     8.  Alert system
     9.  Status badge helpers
     10. Data push (updates DOM + charts)
     11. Machine health updater
     12. Connection state indicator
     13. Clock & uptime
     14. Boot / intervals
     15. Mobile tab switcher
   ============================================================= */


/* ── 1. API CONFIGURATION ─────────────────────────────────── */
/**
 * Set USE_DEMO = false and update API_BASE with your FastAPI
 * server URL (or Ngrok tunnel) to switch to real sensor data.
 *
 * Expected JSON from GET /sensors/latest:
 * {
 *   "temperature":  72.4,    // float, °C
 *   "vibration":    41.2,    // float, mm/s
 *   "ldr":          620,     // float, lux
 *   "humidity":     58.3,    // float, %RH
 *   "ambient_temp": 29.1     // float, °C
 * }
 */
const USE_DEMO = true;
const API_BASE = 'http://localhost:8000';   // ← replace with your Ngrok URL

// API endpoint builders
const EP = {
  latest:  ()        => `${API_BASE}/sensors/latest`,
  history: (s, n=50) => `${API_BASE}/sensors/history?sensor=${s}&limit=${n}`,
  status:  ()        => `${API_BASE}/machines/status`,
  alerts:  ()        => `${API_BASE}/alerts`,
};


/* ── 2. ALERT THRESHOLDS ──────────────────────────────────── */
/**
 * Tweak these values to match your machine specifications.
 * warn  = yellow badge + warning alert
 * crit  = red badge + critical alert + flashing card border
 * LDR uses lo_warn / hi_warn (too dark OR too bright)
 */
const THRESH = {
  temperature: { warn: 75,  crit: 85   },
  vibration:   { warn: 60,  crit: 80   },
  ldr:         { lo_warn: 80, hi_warn: 920 },
  humidity:    { warn: 70,  crit: 82   },
};


/* ── 3. APP STATE ─────────────────────────────────────────── */
const MAX_PTS = 50;           // maximum data points kept per chart series
const startMs = Date.now();   // used to calculate uptime

let totalPts = 0;             // total data points received since page load
let alerts   = [];            // active alert objects { type, msg, time }
let phase    = 0;             // phase counter for demo sine-wave data

// Rolling history arrays — shared across chart update and render
const H = {
  labels: [],   // time labels (HH:MM:SS strings)
  temp:   [],   // temperature readings
  vib:    [],   // vibration readings
  ldr:    [],   // LDR / light readings
  hum:    [],   // humidity readings
  atemp:  [],   // ambient temperature readings
};

// Session min/max trackers per sensor
const S = {
  temp: { min: Infinity, max: -Infinity },
  vib:  { min: Infinity, max: -Infinity },
  ldr:  { min: Infinity, max: -Infinity },
  env:  { min: Infinity, max: -Infinity },
};


/* ── 4. CHART HELPERS ─────────────────────────────────────── */
// Hardcoded hex values are required because Chart.js cannot
// resolve CSS custom properties from the DOM.
const GRID_CLR  = '#1b2a40';
const TICK_CLR  = '#3a5070';
const TICK_FONT = { family: "'JetBrains Mono'", size: 10 };

// Shared base options applied to every chart
const LINE_OPT = {
  responsive:          true,
  maintainAspectRatio: false,
  animation:           { duration: 350 },
  plugins: {
    legend:  { display: false },
    tooltip: {
      mode:            'index',
      intersect:       false,
      backgroundColor: '#0e1525',
      borderColor:     '#1b2a40',
      borderWidth:     1,
      titleColor:      '#7a92b0',
      bodyColor:       '#e2e8f0',
      titleFont:       TICK_FONT,
      bodyFont:        TICK_FONT,
    },
  },
  elements: {
    point: { radius: 0, hoverRadius: 4 },
    line:  { tension: 0.38, borderWidth: 1.8 },
  },
  scales: {
    x: { display: false },
  },
};

/**
 * Build a y-axis config object with grid lines matching the dark theme.
 * @param {number} min - y-axis minimum value
 * @param {number} max - y-axis maximum value
 */
function yAxis(min, max) {
  return {
    grid:   { color: GRID_CLR, lineWidth: .5 },
    ticks:  { color: TICK_CLR, font: TICK_FONT, maxTicksLimit: 5 },
    border: { display: false },
    min,
    max,
  };
}

/**
 * Create a single-dataset line chart.
 * @param {string} id        - canvas element ID
 * @param {string} color     - hex stroke colour
 * @param {number} fillAlpha - fill opacity (0–1)
 * @param {number} yMin      - y-axis minimum
 * @param {number} yMax      - y-axis maximum
 */
function makeChart(id, color, fillAlpha, yMin, yMax) {
  return new Chart(document.getElementById(id), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        data:            [],
        borderColor:     color,
        // Convert alpha to a 2-character hex suffix (e.g. 0.09 → '17')
        backgroundColor: color + Math.round(fillAlpha * 255).toString(16).padStart(2, '0'),
        fill:            true,
      }],
    },
    options: {
      ...LINE_OPT,
      scales: { x: { display: false }, y: yAxis(yMin, yMax) },
    },
  });
}

/**
 * Create a dual-dataset line chart (used for Humidity + Ambient Temp).
 * Each dataset uses its own y-axis (y and y1).
 * @param {string} id        - canvas element ID
 * @param {string} c1        - colour for dataset 1 (humidity)
 * @param {string} c2        - colour for dataset 2 (ambient temp, dashed)
 * @param {number} yMin      - primary y-axis minimum
 * @param {number} yMax      - primary y-axis maximum
 */
function makeChart2(id, c1, c2, yMin, yMax) {
  return new Chart(document.getElementById(id), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          data:            [],
          borderColor:     c1,
          backgroundColor: c1 + '17',
          fill:            true,
          yAxisID:         'y',
        },
        {
          data:            [],
          borderColor:     c2,
          backgroundColor: 'transparent',
          fill:            false,
          yAxisID:         'y1',
          borderDash:      [4, 3],
          borderWidth:     1.4,
        },
      ],
    },
    options: {
      ...LINE_OPT,
      scales: {
        x:  { display: false },
        y:  { ...yAxis(yMin, yMax) },
        y1: {
          position: 'right',
          grid:     { display: false },
          ticks:    { color: TICK_CLR, font: TICK_FONT, maxTicksLimit: 4 },
          border:   { display: false },
          min: 0, max: 50,
        },
      },
    },
  });
}


/* ── 5. CHART INITIALISATION ──────────────────────────────── */
const chTemp = makeChart ('chTemp', '#00c9a7', 0.09, 20,   100);
const chVib  = makeChart ('chVib',  '#f59e0b', 0.09, 0,    110);
const chLdr  = makeChart ('chLdr',  '#4f8ef7', 0.09, 0,    1000);
const chEnv  = makeChart2('chEnv',  '#34d399', '#a78bfa', 0, 100);


/* ── 6. DEMO DATA GENERATOR ───────────────────────────────── */
/**
 * Returns a simulated sensor reading object.
 * Values oscillate using sine waves so the charts look realistic.
 * Called every 2 s when USE_DEMO = true.
 */
function demoData() {
  phase += 0.06;
  const t = phase;
  return {
    temperature:  +(62 + 12 * Math.sin(t * .7) + 5 * Math.sin(t * 2.1) + (Math.random() - .5) * 4).toFixed(1),
    vibration:    +(35 + 20 * Math.sin(t * 1.3) + 10 * Math.cos(t * .5) + (Math.random() - .5) * 8).toFixed(1),
    ldr:          +(450 + 300 * Math.sin(t * .4) + (Math.random() - .5) * 60).toFixed(0),
    humidity:     +(55 + 14 * Math.sin(t * .35) + (Math.random() - .5) * 4).toFixed(1),
    ambient_temp: +(28 + 4 * Math.sin(t * .25) + (Math.random() - .5) * 1.5).toFixed(1),
  };
}


/* ── 7. DATA FETCH / API POLLING ──────────────────────────── */
/**
 * Fetch the latest sensor data from FastAPI (or return demo data).
 * On network failure, marks the UI as disconnected and returns null.
 */
async function fetchData() {
  if (USE_DEMO) return demoData();

  try {
    const res = await fetch(EP.latest(), { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setConn(true);
    return await res.json();
  } catch (err) {
    setConn(false);
    console.warn('[Synaptic Monitor] API error:', err.message);
    return null;
  }
}


/* ── 8. ALERT SYSTEM ──────────────────────────────────────── */
/**
 * Check latest readings against thresholds and push new alert items.
 * Alerts are prepended (most recent first) and capped at 25.
 */
function checkThresh(data) {
  const now = new Date().toLocaleTimeString();
  const add = (type, msg) => alerts.unshift({ type, msg, time: now });

  // Temperature
  if (data.temperature >= THRESH.temperature.crit)
    add('critical', `Temp critical: ${data.temperature}°C`);
  else if (data.temperature >= THRESH.temperature.warn)
    add('warning', `Temp elevated: ${data.temperature}°C`);

  // Vibration
  if (data.vibration >= THRESH.vibration.crit)
    add('critical', `Vibration critical: ${data.vibration} mm/s`);
  else if (data.vibration >= THRESH.vibration.warn)
    add('warning', `Vibration elevated: ${data.vibration} mm/s`);

  // LDR (bidirectional)
  if (data.ldr < THRESH.ldr.lo_warn)
    add('warning', `Low light: ${data.ldr} lux`);
  if (data.ldr > THRESH.ldr.hi_warn)
    add('info', `High light: ${data.ldr} lux`);

  // Humidity
  if (data.humidity >= THRESH.humidity.crit)
    add('critical', `Humidity critical: ${data.humidity}%`);
  else if (data.humidity >= THRESH.humidity.warn)
    add('warning', `Humidity elevated: ${data.humidity}%`);

  alerts = alerts.slice(0, 25);
  renderAlerts();
}

/**
 * Render the alert list into both the desktop sidebar panel
 * and the mobile alerts tab (they have different element IDs).
 * Also turns the Alerts bottom-nav button red when alerts exist.
 */
function renderAlerts() {
  const html = alerts.length
    ? alerts.map(a =>
        `<div class="ai ${a.type}">
          <div class="ai-msg">${a.msg}</div>
          <div class="ai-time">${a.time}</div>
        </div>`
      ).join('')
    : '<div class="no-alerts">— No active alerts —</div>';

  // Update both desktop and mobile alert panels
  ['alList', 'alList-d'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  });

  ['alCount', 'alCount-d'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = alerts.length;
  });

  // Highlight the alerts tab button when there are active alerts
  const navBtn = document.getElementById('bnav-alerts');
  if (navBtn) navBtn.style.color = alerts.length ? 'var(--red)' : '';
}


/* ── 9. STATUS BADGE HELPERS ──────────────────────────────── */
/**
 * Determine status string from a sensor value + threshold config.
 * @returns {'ok'|'warn'|'crit'}
 */
function statusOf(val, t) {
  return val >= t.crit ? 'crit' : val >= t.warn ? 'warn' : 'ok';
}

function statusLabel(s) {
  return s === 'crit' ? 'CRIT' : s === 'warn' ? 'WARN' : 'OK';
}

/**
 * Apply the correct status class and label to a metric card + badge.
 * @param {string} mcId   - metric card element ID
 * @param {string} bdId   - badge element ID
 * @param {string} status - 'ok' | 'warn' | 'crit'
 */
function applyCard(mcId, bdId, status) {
  const mc = document.getElementById(mcId);
  const bd = document.getElementById(bdId);

  mc.classList.remove('warn', 'crit');
  bd.classList.remove('ok', 'warn', 'crit');

  if (status !== 'ok') mc.classList.add(status);
  bd.classList.add(status);
  bd.textContent = statusLabel(status);
}


/* ── 10. DATA PUSH ────────────────────────────────────────── */
/**
 * Append a new data point to the rolling history arrays.
 * Drops the oldest item when the array exceeds MAX_PTS.
 */
function push(arr, v) {
  arr.push(v);
  if (arr.length > MAX_PTS) arr.shift();
}

/**
 * Update the session min/max tracker for a sensor key.
 */
function updateStats(key, v) {
  if (v < S[key].min) S[key].min = v;
  if (v > S[key].max) S[key].max = v;
}

/**
 * Main update function. Called on every poll cycle.
 * Updates metric cards, chart data, badges, alerts, and machine health.
 *
 * @param {Object|null} data - sensor reading object (or null on API error)
 */
function update(data) {
  if (!data) return;

  totalPts++;
  const lbl = new Date().toLocaleTimeString();

  // Push to history
  push(H.labels, lbl);
  push(H.temp,   data.temperature);
  push(H.vib,    data.vibration);
  push(H.ldr,    data.ldr);
  push(H.hum,    data.humidity);
  push(H.atemp,  data.ambient_temp);

  // Track session min/max
  updateStats('temp', data.temperature);
  updateStats('vib',  data.vibration);
  updateStats('ldr',  data.ldr);
  updateStats('env',  data.humidity);

  // Metric card values
  document.getElementById('vl-temp').textContent = data.temperature.toFixed(1);
  document.getElementById('vl-vib').textContent  = data.vibration.toFixed(1);
  document.getElementById('vl-ldr').textContent  = Math.round(data.ldr);
  document.getElementById('vl-env').textContent  = data.humidity.toFixed(1);

  // Session min/max labels
  document.getElementById('mn-temp').textContent = S.temp.min.toFixed(1);
  document.getElementById('mx-temp').textContent = S.temp.max.toFixed(1);
  document.getElementById('mn-vib').textContent  = S.vib.min.toFixed(1);
  document.getElementById('mx-vib').textContent  = S.vib.max.toFixed(1);
  document.getElementById('mn-ldr').textContent  = Math.round(S.ldr.min);
  document.getElementById('mx-ldr').textContent  = Math.round(S.ldr.max);
  document.getElementById('mn-env').textContent  = S.env.min.toFixed(1);
  document.getElementById('mx-env').textContent  = S.env.max.toFixed(1);

  // Chart current-value labels
  document.getElementById('cv-temp').textContent = data.temperature.toFixed(1) + ' °C';
  document.getElementById('cv-vib').textContent  = data.vibration.toFixed(1)   + ' mm/s';
  document.getElementById('cv-ldr').textContent  = Math.round(data.ldr)        + ' lux';
  document.getElementById('cv-env').textContent  = data.humidity.toFixed(1)    + ' %RH';

  // Status badges
  applyCard('mc-temp', 'bd-temp', statusOf(data.temperature, THRESH.temperature));
  applyCard('mc-vib',  'bd-vib',  statusOf(data.vibration,   THRESH.vibration));
  applyCard('mc-env',  'bd-env',  statusOf(data.humidity,    THRESH.humidity));

  // LDR is bidirectional (warn if too low OR too high)
  const ldrSt = (data.ldr < THRESH.ldr.lo_warn || data.ldr > THRESH.ldr.hi_warn) ? 'warn' : 'ok';
  applyCard('mc-ldr', 'bd-ldr', ldrSt);

  // Push data to charts (using 'none' prevents slow animation on every update)
  const L = [...H.labels];
  chTemp.data.labels              = L;
  chTemp.data.datasets[0].data    = [...H.temp];
  chTemp.update('none');

  chVib.data.labels               = L;
  chVib.data.datasets[0].data     = [...H.vib];
  chVib.update('none');

  chLdr.data.labels               = L;
  chLdr.data.datasets[0].data     = [...H.ldr];
  chLdr.update('none');

  chEnv.data.labels               = L;
  chEnv.data.datasets[0].data     = [...H.hum];
  chEnv.data.datasets[1].data     = [...H.atemp];
  chEnv.update('none');

  // Side effects
  checkThresh(data);
  updateMachines(data);

  document.getElementById('fPts').textContent = totalPts.toLocaleString();
}


/* ── 11. MACHINE HEALTH UPDATER ───────────────────────────── */
/**
 * Derive machine health scores from live sensor readings and update
 * both the desktop sidebar and the mobile Machines tab.
 *
 * In production, replace the derived scores with a call to the API:
 *   const machines = await fetch(EP.status()).then(r => r.json());
 *   // expects: [{ id:"A", health:87, note:"Operating normally" }, ...]
 */
function updateMachines(data) {
  // Normalised sensor factors (0 = bad, 1 = good)
  const tf = Math.max(0, 1 - (data.temperature - 50) / 65);
  const vf = Math.max(0, 1 - data.vibration / 130);

  const machines = [
    { id: 'A', h: Math.round(72 + 22 * tf + (Math.random() - .5) * 3) },
    { id: 'B', h: Math.round(45 + 32 * vf + (Math.random() - .5) * 4) },
    { id: 'C', h: Math.round(82 + 14 * tf + (Math.random() - .5) * 2) },
    { id: 'D', h: Math.round(18 + 24 * vf + (Math.random() - .5) * 4) },
  ];

  machines.forEach(({ id, h }) => {
    const v    = Math.max(3, Math.min(100, h));
    const cls  = v > 68 ? 'g'        : v > 40 ? 'w'              : 'b';
    const col  = v > 68 ? '#00c9a7'  : v > 40 ? '#f59e0b'         : '#f87171';
    const note = v > 68 ? 'Operating normally' : v > 40 ? '⚠ Monitor closely' : '⛔ Maintenance required';

    // Update both desktop ('-d' suffix) and mobile (no suffix) panels
    ['', '-d'].forEach(suffix => {
      const hb = document.getElementById(`hb-${id}${suffix}`);
      const hp = document.getElementById(`hp-${id}${suffix}`);
      const hs = document.getElementById(`hs-${id}${suffix}`);
      if (!hb) return;  // panel may not exist in the current tab
      hb.style.width  = v + '%';
      hb.className    = `hfill ${cls}`;
      hp.textContent  = v + '%';
      hp.style.color  = col;
      hs.textContent  = note;
    });
  });
}


/* ── 12. CONNECTION STATE INDICATOR ───────────────────────── */
/**
 * Update the header connection dot and text based on API reachability.
 * @param {boolean} ok - true = connected, false = disconnected
 */
function setConn(ok) {
  document.getElementById('cdot').className    = 'cdot' + (ok ? '' : ' off');
  document.getElementById('ctext').textContent = ok ? 'Connected' : 'Disconnected';
}


/* ── 13. CLOCK & UPTIME ───────────────────────────────────── */
/**
 * Update the header clock, date, and session uptime counter.
 * Called every second.
 */
function tick() {
  const now = new Date();

  document.getElementById('hdrTime').textContent = now.toLocaleTimeString();
  document.getElementById('hdrDate').textContent = now.toLocaleDateString(
    undefined,
    { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }
  );

  // Uptime HH:MM:SS
  const s  = Math.floor((Date.now() - startMs) / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  document.getElementById('fUptime').textContent = `${hh}:${mm}:${ss}`;
}


/* ── 14. BOOT & INTERVALS ─────────────────────────────────── */
// Start clock immediately
tick();
setInterval(tick, 1000);

// Fetch & render first data point immediately, then every 2 s
async function poll() {
  update(await fetchData());
}
poll();
setInterval(poll, 2000);


/* ── 15. MOBILE TAB SWITCHER ──────────────────────────────── */
/**
 * Switch between Overview / Charts / Machines / Alerts tabs on mobile.
 * On desktop this function is a no-op (all sections remain visible).
 *
 * Called from onclick attributes in dashboard.html:
 *   onclick="switchTab('charts', this)"
 *
 * @param {string} tab - 'overview' | 'charts' | 'machines' | 'alerts'
 * @param {HTMLElement} btn - the bottom-nav button that was clicked
 */
function switchTab(tab, btn) {
  const isMobile = window.innerWidth <= 768;

  // Always update active button highlight
  document.querySelectorAll('.bnav-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  // On desktop, all sections are always visible — nothing to toggle
  if (!isMobile) return;

  // Map tab names to section element IDs
  const sections = {
    charts:   'tab-charts',
    machines: 'tab-machines',
    alerts:   'tab-alerts',
  };

  if (tab === 'overview') {
    // Overview shows all sections stacked
    Object.values(sections).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('active');
    });
  } else {
    // Show only the selected section
    Object.values(sections).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active');
    });
    const target = sections[tab];
    if (target) document.getElementById(target).classList.add('active');
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}