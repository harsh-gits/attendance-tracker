"use strict";

const KEY = "attendance.v3";
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_NAMES = { Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu", Friday: "Fri", Saturday: "Sat" };
const STATUS = { P: "Present", A: "Absent", OD: "On duty", C: "Not held" };
const MIN = CONFIG.minPercent;

// ---------- dates ----------
const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const todayIso = () => iso(new Date());
const nice = s => { const d = parse(s); return `${WD[d.getDay()]}, ${d.getDate()} ${MON[d.getMonth()]}`; };
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

// ---------- slot grid: slot name -> where and when it meets ----------
const SLOT_AT = {};
for (const [day, row] of Object.entries(CONFIG.slots.theory)) {
  row.split(/\s+/).forEach((s, i) => {
    if (s !== "-") (SLOT_AT[s] = SLOT_AT[s] || []).push({ day, time: CONFIG.slots.theoryTimes[i] });
  });
}
for (const [day, [am, pm]] of Object.entries(CONFIG.slots.lab)) {
  for (let k = 0; k < 6; k++) {
    SLOT_AT["L" + (am + k)] = [{ day, time: CONFIG.slots.labTimes[k] }];
    SLOT_AT["L" + (pm + k)] = [{ day, time: CONFIG.slots.labTimes[6 + k] }];
  }
}
const timeOf = (slot, day) => ((SLOT_AT[slot.split("+")[0]] || []).find(x => x.day === day) || {}).time || "";

// ---------- storage ----------
// Saved in both localStorage and IndexedDB, and marked persistent, so the
// browser keeps it until you change it.
const fresh = (strict = false) => ({ data: null, edits: {}, strict, savedAt: 0 });
const validState = s => !!s && typeof s.edits === "object" && (!s.data || validImport(s.data));
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (validState(s)) return s;
  } catch (e) { /* storage unavailable */ }
  return fresh();
}
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("no IndexedDB"));
    const open = indexedDB.open("attendance", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", mode), req = fn(tx.objectStore("kv"));
      tx.oncomplete = () => { open.result.close(); resolve(req.result); };
      tx.onerror = () => reject(tx.error);
    };
  });
}
function save() {
  state.savedAt = Date.now();
  const json = JSON.stringify(state);
  try { localStorage.setItem(KEY, json); } catch (e) { /* storage unavailable */ }
  idb("readwrite", st => st.put(json, KEY)).catch(() => {});
  refreshLink();
}

let state = load();
let M = null;          // everything derived from the imported data
let sel = todayIso();
let tab = "day";
let openCourse = null; // course shown in the Subjects tab
let flashIds = [];

// ---------- building the class list ----------
// Calendar rows from the portal look like ["2026-10-10", "Instructional Day", "(Instructional Day Order - Friday Day Order)"].
function build(data) {
  const cal = {};
  for (const [d, type, detail] of data.cal) cal[d] = { type, detail: detail || "" };
  const dates = Object.keys(cal).sort();
  const isClassDay = d => cal[d] && /^Instructional Day/i.test(cal[d].type);
  const classDays = dates.filter(isClassDay);
  const lastTheory = dates.find(d => /LID for theory/i.test(cal[d].detail)) || classDays[classDays.length - 1] || "";
  const lastLab = dates.find(d => /LID for lab/i.test(cal[d].detail)) || lastTheory;
  const orderOf = d => {
    const m = cal[d] && cal[d].detail.match(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) Day Order/i);
    return m ? DAY_NAMES[m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()] : WD[parse(d).getDay()];
  };

  const courses = data.courses.map(c => {
    const slots = c.slot.split("+");
    const lab = slots.some(s => /^L\d+$/.test(s));
    const course = { key: `${c.code}|${c.slot}`, code: c.code, name: c.name, type: c.type, slot: c.slot, slots, lab, portal: c.att, classes: [] };
    const byKey = new Map();
    for (const [date, slot, st] of c.rows) {
      byKey.set(`${date}|${slot}`, { date, slot, units: slot.split("+").length, portal: st, time: timeOf(slot, orderOf(date)) });
    }
    // Expected classes from the timetable, so future ones show up too. Days up to the
    // portal's last record are left exactly as the portal has them.
    const lastRecord = c.rows.reduce((m, r) => (r[0] > m ? r[0] : m), "");
    for (const d of classDays) {
      if (d <= lastRecord || d > lastTheory || (lab && d > lastLab)) continue;
      const order = orderOf(d);
      const hits = slots.filter(s => (SLOT_AT[s] || []).some(x => x.day === order));
      if (!hits.length) continue;
      const groups = lab ? [hits.join("+")] : hits;
      for (const slot of groups) {
        const k = `${d}|${slot}`;
        if (!byKey.has(k)) byKey.set(k, { date: d, slot, units: slot.split("+").length, portal: null, time: timeOf(slot, order) });
      }
    }
    course.classes = [...byKey.values()].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    course.perSession = Math.max(1, ...course.classes.map(x => x.units));
    return course;
  });
  return { sem: data.sem, at: data.at, cal, dates, lastTheory, lastLab, orderOf, isClassDay, courses };
}

const editKey = (c, k) => `${c.key}|${k.date}|${k.slot}`;
const statusOf = (c, k) => state.edits[editKey(c, k)] || k.portal || null;
const course = key => M.courses.find(c => c.key === key);

// ---------- maths ----------
// The portal rounds the percentage up, so 74.1% shows (and counts) as 75%.
function pct(a, t) {
  if (!t) return null;
  return state.strict ? Math.floor((a * 1000) / t) / 10 : Math.ceil((a * 100) / t - 1e-9);
}
function ok(a, t) {
  return !t || (state.strict ? a * 100 >= MIN * t : Math.ceil((a * 100) / t - 1e-9) >= MIN);
}
const fmt = p => (p === null ? "–" : (state.strict ? p.toFixed(1) : p) + "%");
const counts = st => st === "P" || st === "OD";

// upto: count classes on or before this date. override: { k, st } for "what if".
function stats(c, upto = todayIso(), override) {
  const today = todayIso();
  let A = 0, T = 0, F = 0, FA = 0, unmarked = 0;
  for (const k of c.classes) {
    const st = override && override.k === k ? override.st : statusOf(c, k);
    if (st === "C") continue;
    if (k.date <= upto) {
      if (st === null) { if (k.date <= today) unmarked++; continue; }
      T += k.units; if (counts(st)) A += k.units;
    } else if (k.date > today) {
      F += k.units; if (st === "A") FA += k.units;
    }
  }
  const fa = A + F - FA, ft = T + F;
  let canSkip = -1;
  if (ok(fa, ft)) { canSkip = 0; while (canSkip < F - FA && ok(fa - canSkip - 1, ft)) canSkip++; }
  let need = 0;
  while (!ok(A + need, T + need) && need < 500) need++;
  return { A, T, F, FA, unmarked, pct: pct(A, T), finalPct: pct(fa, ft), canSkip, need, left: F - FA };
}

function overall(upto) {
  let A = 0, T = 0;
  for (const c of M.courses) { const s = stats(c, upto); A += s.A; T += s.T; }
  return { A, T, pct: pct(A, T) };
}

const plural = (c, n) => (c.lab ? (n === 1 ? "lab" : "labs") : (n === 1 ? "class" : "classes"));
function verdict(c, s) {
  if (s.canSkip < 0) {
    return { tone: "bad", text: `Ends below ${MIN}% (${fmt(s.finalPct)})`, sub: s.FA ? "Undo some planned absences to fix this" : "Even if you attend everything left" };
  }
  const n = Math.floor(s.canSkip / c.perSession), need = Math.ceil(s.need / c.perSession);
  const now = ok(s.A, s.T) ? "" : ` · Below ${MIN}% now: attend the next ${need} ${plural(c, need)}`;
  return {
    tone: n === 0 ? "warn" : "good",
    text: n === 0 ? `Can't skip any more ${plural(c, 2)}` : `Can skip ${n} more ${plural(c, n)}`,
    sub: (s.left || s.FA ? `Ends at ${fmt(s.finalPct)} if you attend the rest` : "No classes left") + now,
  };
}
const skipShort = (c, s) => (s.canSkip < 0 ? `ends ${fmt(s.finalPct)} ⚠︎` : `can skip ${Math.floor(s.canSkip / c.perSession)}`);

// ---------- import ----------
function validImport(d) {
  return d && Array.isArray(d.courses) && d.courses.length && Array.isArray(d.cal) &&
    d.courses.every(c => c.code && c.slot && Array.isArray(c.rows) && Array.isArray(c.att));
}
function applyImport(data) {
  if (!validImport(data)) return false;
  // The portal is the source of truth: drop your own marks on classes it now has.
  const have = new Set();
  for (const c of data.courses) for (const [d, slot] of c.rows) have.add(`${c.code}|${c.slot}|${d}|${slot}`);
  for (const k of Object.keys(state.edits)) if (have.has(k)) delete state.edits[k];
  state.data = data;
  M = build(data);
  save();
  return true;
}

// ---------- personal link and moving data in ----------
const b64urlEncode = bytes => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlDecode = str => Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), ch => ch.charCodeAt(0));
const streamText = (bytes, tf) => new Response(new Blob([bytes]).stream().pipeThrough(tf));

// "z" = compressed JSON, "j" = plain JSON (browsers without CompressionStream).
async function pack(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if (window.CompressionStream) return "z" + b64urlEncode(new Uint8Array(await streamText(bytes, new CompressionStream("deflate-raw")).arrayBuffer()));
  return "j" + b64urlEncode(bytes);
}
async function unpack(str) {
  const bytes = b64urlDecode(str.slice(1));
  if (str[0] === "z") return JSON.parse(await streamText(bytes, new DecompressionStream("deflate-raw")).text());
  return JSON.parse(new TextDecoder().decode(bytes));
}

let myLink = "";
function refreshLink() {
  if (!state.data) { myLink = ""; return; }
  pack(state).then(p => (myLink = APP_URL + "#data=" + p)).catch(() => (myLink = ""));
}

function restore(s) {
  state = { data: s.data, edits: s.edits || {}, strict: !!s.strict, savedAt: s.savedAt || 0, remTime: s.remTime };
  M = build(state.data);
  save();
}

let pendingRestore = null;
// Takes a portal import, a personal link or a backup, as a link or pasted text.
async function takeIn(text) {
  text = (text || "").trim();
  let obj = null;
  const m = text.match(/#(import|data)=([A-Za-z0-9_-]+)/);
  try {
    if (m && m[1] === "data") obj = await unpack(m[2]);
    else if (m) obj = JSON.parse(new TextDecoder().decode(b64urlDecode(m[2])));
    else obj = JSON.parse(text);
  } catch (e) { return "bad"; }
  if (validImport(obj)) { applyImport(obj); sel = todayIso(); return "import"; }
  if (validState(obj) && obj.data) {
    if (!M || (obj.savedAt || 0) >= (state.savedAt || 0)) { restore(obj); sel = todayIso(); return "restored"; }
    pendingRestore = obj;
    return "older";
  }
  return "bad";
}
function reportTake(r) {
  if (r === "import") toast(`Imported ${M.courses.length} course${M.courses.length > 1 ? "s" : ""}.`);
  if (r === "restored") toast("Your data is back.");
  if (r === "bad") toast("That isn't an import or a personal link. Try again from the portal.");
}
async function handleHash() {
  if (!/^#(import|data)=/.test(location.hash)) return null;
  const text = location.hash;
  history.replaceState(null, "", location.pathname + location.search);
  return takeIn(text);
}

const APP_URL = location.href.split("#")[0].split("?")[0].replace(/index\.html$/, "");
const bookmarklet = "javascript:" + encodeURIComponent("(" + PORTAL_IMPORT.toString().replace("__APP__", APP_URL) + ")();");
const ZIP_URL = "https://github.com/harsh-gits/attendance-tracker/archive/refs/heads/main.zip";

// ---------- rendering ----------
const $ = q => document.querySelector(q);

function render() {
  const setup = !M;
  document.body.classList.toggle("setup", setup);
  renderHeader();
  if (setup) tab = "day";
  document.querySelectorAll(".tab").forEach(el => el.classList.toggle("active", el.id === "tab-" + tab));
  document.querySelectorAll("nav.tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  if (setup) { $("#tab-day").innerHTML = importHtml(true); return; }
  if (tab === "day") renderDay();
  if (tab === "subj") renderSubjects();
  if (tab === "cal") renderCal();
  if (tab === "set") renderSettings();
}

function renderHeader() {
  if (!M) {
    $("#sem").textContent = "Attendance";
    $("#overall").textContent = "Welcome";
    $("#overallSub").textContent = "Import once from your student portal to get started";
    return;
  }
  const o = overall(todayIso());
  let risky = 0;
  for (const c of M.courses) { const s = stats(c); if (s.canSkip < 0 || Math.floor(s.canSkip / c.perSession) === 0) risky++; }
  $("#sem").textContent = M.sem;
  $("#overall").textContent = fmt(o.pct);
  $("#overallSub").textContent = `${o.A}/${o.T} attended · ${risky ? risky + " subject" + (risky > 1 ? "s" : "") + " at the limit" : "all subjects safe"}`;
}

function importHtml(first) {
  return `
    ${first ? `<h2>Get started</h2><p>Bring in your courses, every class so far and the academic calendar from your student portal. You do this once, then again whenever you want to catch up.</p>` : ""}
    <div class="stepcard">
      <b>On a laptop</b>
      <ol class="steps">
        <li>Drag this button to your bookmarks bar: <a class="bm drag" href="${bookmarklet}" onclick="return false">⇩ Import attendance</a></li>
        <li>Log in to your student portal.</li>
        <li>Click <b>Import attendance</b> in your bookmarks bar, then <b>Open the app</b>.</li>
      </ol>
    </div>
    <div class="stepcard">
      <b>On a phone</b> <small>(one-time setup, about a minute)</small>
      <ol class="steps">
        <li><button class="inline" data-act="copyBm">Copy the import code</button></li>
        <li>Bookmark any page, then edit that bookmark: name it <b>Import attendance</b> and paste the code as its address.</li>
        <li>Log in to your student portal. <b>Android:</b> type <i>Import attendance</i> in the address bar and tap the bookmark. <b>iPhone:</b> open Bookmarks and tap it.</li>
        <li>Tap <b>Open the app</b>. If you use the installed app on iPhone, tap <b>Copy</b> instead and paste below.</li>
      </ol>
    </div>
    ${first ? `<div class="stepcard"><b>Already set up on another device?</b><p class="note">Open your personal link here (Settings → My link on the other device), or copy it and tap Paste.</p></div>` : ""}
    ${navigator.clipboard && navigator.clipboard.readText ? `<button class="primary" data-act="pasteClip">Paste from clipboard</button>` : ""}
    <details ${first ? "" : "open"}>
      <summary>Or paste it here</summary>
      <textarea id="paste" rows="4" placeholder="Paste the import or your personal link"></textarea>
      <button class="primary" data-act="paste">Import</button>
    </details>
    <p class="note">Your data stays on this device.${location.protocol === "file:" ? " You're using the downloaded copy, so after importing tap <b>Copy</b> and paste here." : ""}</p>`;
}

function statusButtons(c, k) {
  const st = statusOf(c, k);
  return `<div class="seg" data-key="${esc(c.key)}" data-date="${k.date}" data-slot="${esc(k.slot)}">` +
    ["P", "A", "OD", "C"].map(s => `<button data-st="${s}" class="${st === s ? "on" : ""}" title="${STATUS[s]}">${s === "C" ? "Off" : s}</button>`).join("") +
    `</div>`;
}
function sourceTag(c, k) {
  const e = state.edits[editKey(c, k)];
  if (e && k.portal && e !== k.portal) return `<span class="tag edit">edited · portal: ${STATUS[k.portal] || k.portal}</span>`;
  if (e) return `<span class="tag edit">your mark</span>`;
  if (k.portal) return `<span class="tag">portal</span>`;
  return k.date <= todayIso() ? `<span class="tag none">not on portal yet</span>` : "";
}

function renderDay() {
  const today = todayIso(), info = M.cal[sel];
  const label = !info ? "Outside the semester calendar"
    : [info.type, info.detail.replace(/^\(|\)$/g, "")].filter(Boolean).join(" · ");
  const sessions = [];
  for (const c of M.courses) for (const k of c.classes) if (k.date === sel) sessions.push({ c, k });
  sessions.sort((a, b) => a.k.time.localeCompare(b.k.time));

  let h = alertsHtml() + `
    <div class="daynav">
      <button class="icon" data-act="prev" aria-label="Previous day">‹</button>
      <div class="date"><b>${sel === today ? "Today · " : ""}${nice(sel)}</b><small>${esc(label)}</small></div>
      <button class="icon" data-act="next" aria-label="Next day">›</button>
    </div>
    ${sel !== today ? `<button class="link" data-act="today">Back to today</button>` : ""}`;

  if (sessions.length) {
    h += `<div class="sessions">`;
    for (const { c, k } of sessions) {
      const st = statusOf(c, k);
      let hint = "";
      if (st !== "C") {
        const alt = st === "A" ? "P" : "A", w = stats(c, todayIso(), { k, st: alt });
        hint = `${alt === "A" ? "If absent" : "If present"}: ${sel <= today ? fmt(w.pct) : "ends " + fmt(w.finalPct)} · ${skipShort(c, w)}`;
      }
      h += `
        <div class="sess st-${st || "none"}">
          <div class="sinfo">
            <b>${esc(c.name)}</b>
            <small>${k.time || ""}${k.units > 1 ? ` · ${k.units} slots` : ""} · ${esc(k.slot)} ${sourceTag(c, k)}</small>
            ${hint ? `<small class="hint">${hint}</small>` : ""}
          </div>
          ${statusButtons(c, k)}
        </div>`;
    }
    h += `</div>
      <div class="quick">
        <button data-all="P">All present</button>
        <button data-all="A">All absent</button>
        <button data-all="">Clear my marks</button>
      </div>`;
    const o = overall(sel);
    h += `<p class="note">Overall up to this day: <b>${fmt(o.pct)}</b> (${o.A}/${o.T})</p>`;
  } else {
    h += `<p class="empty">${info && /holiday/i.test(info.type) ? "🎉 " : ""}No classes</p>`;
  }

  h += `<h2>Subjects</h2>${cardsHtml()}`;
  $("#tab-day").innerHTML = h;
  flashIds = [];
}

function alertsHtml() {
  if (pendingRestore) {
    return `<div class="alert warn">That link has older data than this app.
      <div class="quick"><button data-act="restoreOld">Replace anyway</button><button data-act="keepMine">Keep mine</button></div></div>`;
  }
  const today = todayIso(), bad = [], edge = [];
  let unmarked = 0, first = "";
  for (const c of M.courses) {
    const s = stats(c);
    if (s.canSkip < 0 || !ok(s.A, s.T)) bad.push(c.name);
    else if (s.left && Math.floor(s.canSkip / c.perSession) === 0) edge.push(c.name);
    for (const k of c.classes) {
      if (k.date <= today && statusOf(c, k) === null) { unmarked++; if (!first || k.date < first) first = k.date; }
    }
  }
  let h = "";
  if (bad.length) h += `<div class="alert bad"><b>Below ${MIN}% risk:</b> ${bad.map(esc).join(", ")}. Attend every class.</div>`;
  if (edge.length) h += `<div class="alert warn"><b>At the limit:</b> ${edge.map(esc).join(", ")}. Don't skip any more.</div>`;
  if (unmarked && first !== sel) h += `<div class="alert info">${unmarked} past ${unmarked === 1 ? "class isn't" : "classes aren't"} marked yet. <button class="inline" data-date="${first}">Mark them</button></div>`;
  return h;
}

function summaryText() {
  const today = todayIso(), o = overall(today);
  const lines = M.courses.map(c => {
    const s = stats(c);
    return `• ${c.name}: ${fmt(s.pct)} · ${s.canSkip < 0 ? "at risk" : `can skip ${Math.floor(s.canSkip / c.perSession)}`}`;
  });
  return `Attendance · ${M.sem} · ${nice(today)}\nOverall: ${fmt(o.pct)} (${o.A}/${o.T})\n${lines.join("\n")}`;
}

function cardsHtml() {
  let h = `<div class="cards">`;
  for (const c of M.courses) {
    const s = stats(c), v = verdict(c, s);
    h += `
      <button class="card tone-${v.tone}${flashIds.includes(c.key) ? " flash" : ""}" data-course="${esc(c.key)}">
        <div class="row">
          <div><b>${esc(c.name)}</b><small>${esc(c.code)} · ${esc(c.slot)} · ${s.A}/${s.T}</small></div>
          <div class="pct">${fmt(s.pct)}</div>
        </div>
        <div class="bar"><i style="width:${Math.min(100, s.pct || 0)}%"></i><span style="left:${MIN}%"></span></div>
        <div class="verdict">${v.text}</div>
        <small>${v.sub}${s.unmarked ? ` · ${s.unmarked} past ${s.unmarked === 1 ? "class" : "classes"} not marked yet` : ""}</small>
      </button>`;
  }
  return h + `</div>`;
}

function renderSubjects() {
  const c = openCourse && course(openCourse);
  if (!c) { $("#tab-subj").innerHTML = `<div class="rowhead"><p class="note">Tap a subject to see every class and edit it.</p><button class="inline" data-act="share">Share summary</button></div>${cardsHtml()}`; return; }
  const s = stats(c), v = verdict(c, s), today = todayIso();
  let h = `
    <button class="link left" data-act="back">‹ All subjects</button>
    <div class="card tone-${v.tone} static">
      <div class="row">
        <div><b>${esc(c.name)}</b><small>${esc(c.code)} · ${esc(c.type || "")} · ${esc(c.slot)}</small></div>
        <div class="pct">${fmt(s.pct)}</div>
      </div>
      <div class="verdict">${v.text}</div>
      <small>${s.A}/${s.T} attended · portal showed ${c.portal[0]}/${c.portal[1]} at import · ${v.sub}</small>
    </div>
    <table class="classes"><thead><tr><th>Date</th><th>Status</th><th>% so far</th></tr></thead><tbody>`;
  let A = 0, T = 0, month = "";
  for (const k of c.classes) {
    const st = statusOf(c, k);
    if (st && st !== "C") { T += k.units; if (counts(st)) A += k.units; }
    const m = k.date.slice(0, 7);
    if (m !== month) { month = m; const d = parse(k.date); h += `<tr class="mrow"><td colspan="3">${MONTH_FULL[d.getMonth()]} ${d.getFullYear()}</td></tr>`; }
    const future = k.date > today;
    h += `<tr class="${future ? "future" : ""} ${k.date === today ? "todayrow" : ""}">
      <td><button class="dlink" data-date="${k.date}">${nice(k.date)}</button><small>${esc(k.slot)} ${sourceTag(c, k)}</small></td>
      <td>${statusButtons(c, k)}</td>
      <td class="run">${st && st !== "C" ? fmt(pct(A, T)) : ""}</td></tr>`;
  }
  h += `</tbody></table>`;
  $("#tab-subj").innerHTML = h;
}

function renderCal() {
  const today = todayIso();
  const first = parse(M.dates[0]), last = parse(M.dates[M.dates.length - 1]);
  let h = `<p class="note">Tap a day to see or mark its classes.</p>`;
  for (let y = first.getFullYear(), m = first.getMonth(); y < last.getFullYear() || (y === last.getFullYear() && m <= last.getMonth()); m === 11 ? (y++, m = 0) : m++) {
    h += `<h2>${MONTH_FULL[m]} ${y}</h2><div class="grid">` + WD.map(w => `<div class="wd">${w[0]}</div>`).join("");
    const firstDay = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();
    for (let i = 0; i < firstDay; i++) h += `<div></div>`;
    for (let d = 1; d <= days; d++) {
      const ds = `${y}-${pad(m + 1)}-${pad(d)}`, info = M.cal[ds];
      const kind = !info ? "off" : M.isClassDay(ds) ? "class" : /holiday/i.test(info.type) ? "holiday" : /CAT|FAT|exam/i.test(info.type) ? "exam" : "off";
      let abs = 0, unmarked = 0;
      for (const c of M.courses) for (const k of c.classes) {
        if (k.date !== ds) continue;
        const st = statusOf(c, k);
        if (st === "A") abs++;
        if (st === null && ds <= today) unmarked++;
      }
      const dot = abs ? `<em class="abs">${abs}✗</em>` : unmarked ? `<em class="unm">?</em>` : kind === "class" ? `<em class="dot"></em>` : "";
      const order = M.isClassDay(ds) && M.orderOf(ds) !== WD[parse(ds).getDay()] ? " order" : "";
      h += `<button class="day ${kind}${order}${ds === today ? " today" : ""}${ds === sel ? " sel" : ""}" data-date="${ds}" title="${esc(info ? info.type + " " + info.detail : "")}">${d}${dot}</button>`;
    }
    h += `</div>`;
  }
  h += `<div class="legend"><span><em class="dot"></em> class day</span><span><em class="abs">✗</em> absent</span><span><em class="unm">?</em> not marked</span><span class="hol">holiday</span><span class="exm">exams</span></div>`;
  $("#tab-cal").innerHTML = h;
}

function renderSettings() {
  const at = M.at ? new Date(M.at) : null;
  $("#tab-set").innerHTML = `
    <h2>Update from the portal</h2>
    <p class="note">Last import: ${at ? `${nice(iso(at))}, ${pad(at.getHours())}:${pad(at.getMinutes())}` : "unknown"}. Importing again replaces the portal data and keeps your marks on classes it doesn't have yet.</p>
    ${importHtml(false)}

    <h2>My link</h2>
    <p class="note">Your personal link has all your data packed inside. Open it in any browser or on any device and everything is back, no import needed. Save it somewhere safe (notes, or a message to yourself), and make a new one after big changes. Anyone with it can see your attendance.</p>
    <div class="quick">
      <button data-act="copyLink">Copy my link</button>
      ${navigator.share ? `<button data-act="shareLink">Save or send it</button>` : ""}
    </div>

    <h2>Daily reminder</h2>
    <p class="note">Adds a reminder to your calendar app to mark attendance on each class day left this semester.</p>
    <label class="field">Remind me at <input type="time" id="remTime" value="${state.remTime || "18:00"}"></label>
    <div class="quick">
      <button data-act="ics">iPhone / Outlook calendar</button>
      <button data-act="gcal">Google Calendar</button>
    </div>
    <p class="note">Google Calendar repeats every weekday until the last class day, so it doesn't skip holidays.</p>

    <h2>Percentage rule</h2>
    <label class="switch"><input type="checkbox" id="strict" ${state.strict ? "checked" : ""}> Strict 75% (ignore the portal's rounding up)</label>
    <p class="note">The portal rounds up, so 74.2% shows as 75%. Turn this on to keep a safety margin. On duty counts as present, like on the portal.</p>

    <h2>Backup file</h2>
    <p class="note">The same as your personal link, but saved as a file.</p>
    <div class="quick">
      <button data-act="export">Export</button>
      <label class="btn">Import backup<input type="file" id="importFile" accept="application/json,.json" hidden></label>
    </div>
    <div class="quick">
      <button data-act="clearEdits" class="danger">Clear my marks</button>
      <button data-act="reset" class="danger">Remove everything</button>
    </div>

    <h2>Install</h2>
    <p class="note"><b>iPhone:</b> Safari → Share → Add to Home Screen.<br><b>Android / laptop:</b> Chrome → menu → Install app.<br><b>Offline copy for a computer:</b> <a href="${ZIP_URL}">download the zip</a>, unzip it and open <i>index.html</i>.</p>`;
}

// ---------- reminders ----------
function remindDays() {
  const today = todayIso();
  return M.dates.filter(d => d >= today && d <= M.lastTheory && M.isClassDay(d));
}
function downloadIcs() {
  const days = remindDays();
  if (!days.length) { toast("No class days left this semester."); return; }
  const hm = (state.remTime || "18:00").replace(":", "");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//attendance//reminder//EN", "CALSCALE:GREGORIAN"];
  for (const d of days) {
    lines.push("BEGIN:VEVENT", `UID:attendance-${d}`, `DTSTAMP:${stamp}`, `DTSTART:${d.replace(/-/g, "")}T${hm}00`, "DURATION:PT10M",
      "SUMMARY:Mark today's attendance", `DESCRIPTION:${APP_URL}`, `URL:${APP_URL}`,
      "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Mark today's attendance", "TRIGGER:PT0M", "END:VALARM", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/calendar" }));
  a.download = "attendance-reminders.ics";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Reminders for ${days.length} class days. Open the file to add them to your calendar.`);
}
function openGoogleCalendar() {
  const days = remindDays();
  if (!days.length) { toast("No class days left this semester."); return; }
  const [h, m] = (state.remTime || "18:00").split(":").map(Number);
  const end = new Date(2000, 0, 1, h, m + 10);
  const d0 = days[0].replace(/-/g, "");
  const url = "https://calendar.google.com/calendar/render?action=TEMPLATE" +
    "&text=" + encodeURIComponent("Mark today's attendance") +
    "&details=" + encodeURIComponent(APP_URL) +
    `&dates=${d0}T${pad(h)}${pad(m)}00/${d0}T${pad(end.getHours())}${pad(end.getMinutes())}00` +
    "&recur=" + encodeURIComponent(`RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=${M.lastTheory.replace(/-/g, "")}T235959Z`);
  window.open(url, "_blank", "noopener");
}

// ---------- events ----------
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.innerHTML = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
}

// updates: [[course, classItem, status|null]]
function change(updates) {
  const today = todayIso();
  const before = new Map(updates.map(([c]) => [c.key, stats(c)]));
  for (const [c, k, st] of updates) {
    const ek = editKey(c, k);
    if (!st || st === k.portal) delete state.edits[ek]; else state.edits[ek] = st;
  }
  save();
  const seen = new Set(), lines = [];
  for (const [c, k] of updates) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    const a = before.get(c.key), z = stats(c);
    lines.push(`${esc(c.name)}: ${k.date > today ? `ends ${fmt(a.finalPct)} → ${fmt(z.finalPct)}` : `${fmt(a.pct)} → <b>${fmt(z.pct)}</b>`} · ${skipShort(c, z)}`);
  }
  flashIds = [...seen];
  render();
  toast(lines.join("<br>") + `<br>Overall: <b>${fmt(overall(today).pct)}</b>`);
}

function armed(t, label) {
  if (t.dataset.armed) return true;
  t.dataset.armed = "1";
  t.textContent = label;
  return false;
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text; document.body.appendChild(ta); ta.select();
  document.execCommand("copy"); ta.remove();
  return Promise.resolve();
}

document.addEventListener("click", e => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.tab) { tab = t.dataset.tab; if (tab === "subj") openCourse = null; render(); window.scrollTo(0, 0); return; }
  if (t.dataset.st) {
    const seg = t.closest(".seg"), c = course(seg.dataset.key);
    const k = c.classes.find(x => x.date === seg.dataset.date && x.slot === seg.dataset.slot);
    change([[c, k, statusOf(c, k) === t.dataset.st ? null : t.dataset.st]]);
    return;
  }
  if (t.dataset.all !== undefined) {
    const ups = [];
    for (const c of M.courses) for (const k of c.classes) if (k.date === sel) ups.push([c, k, t.dataset.all || null]);
    if (ups.length) change(ups);
    return;
  }
  if (t.dataset.course) { openCourse = t.dataset.course; tab = "subj"; render(); window.scrollTo(0, 0); return; }
  if (t.dataset.date) { sel = t.dataset.date; tab = "day"; render(); window.scrollTo(0, 0); return; }
  const act = t.dataset.act;
  if (act === "prev") { sel = addDays(sel, -1); render(); }
  if (act === "next") { sel = addDays(sel, 1); render(); }
  if (act === "today") { sel = todayIso(); render(); }
  if (act === "back") { openCourse = null; render(); }
  if (act === "copyBm") {
    copyText(bookmarklet).then(() => toast("Import code copied. Now make the bookmark."), () => toast("Couldn't copy. Long-press the button on a laptop instead."));
  }
  if (act === "paste" || act === "pasteClip") {
    const got = act === "paste" ? Promise.resolve($("#paste").value) : navigator.clipboard.readText();
    got.then(takeIn).then(r => {
      if (r !== "bad") { tab = "day"; window.scrollTo(0, 0); }
      render(); reportTake(r);
    }, () => toast("Couldn't read the clipboard. Paste into the box instead."));
  }
  if (act === "restoreOld") { restore(pendingRestore); pendingRestore = null; render(); toast("Replaced with the data from the link."); }
  if (act === "keepMine") { pendingRestore = null; render(); }
  if (act === "copyLink") {
    if (!myLink) { toast("Still preparing your link, try again in a second."); refreshLink(); return; }
    copyText(myLink).then(() => toast("Your personal link is copied. Save it somewhere safe."), () => toast("Couldn't copy the link."));
  }
  if (act === "shareLink" && myLink) navigator.share({ title: "My attendance", url: myLink }).catch(() => {});
  if (act === "share") {
    const text = summaryText();
    if (navigator.share) navigator.share({ text }).catch(() => {});
    else copyText(text).then(() => toast("Summary copied."));
  }
  if (act === "ics") downloadIcs();
  if (act === "gcal") openGoogleCalendar();
  if (act === "export") {
    const blob = new Blob([JSON.stringify(state)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `attendance-backup-${todayIso()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  if (act === "clearEdits" && armed(t, "Tap again to clear")) { state.edits = {}; save(); render(); toast("Your marks are cleared. Portal data is kept."); }
  if (act === "reset" && armed(t, "Tap again to remove")) { state = fresh(state.strict); M = null; save(); render(); }
});

document.addEventListener("change", e => {
  if (e.target.id === "strict") { state.strict = e.target.checked; save(); renderHeader(); }
  if (e.target.id === "remTime" && e.target.value) { state.remTime = e.target.value; save(); }
  if (e.target.id === "importFile" && e.target.files[0]) {
    e.target.files[0].text().then(txt => {
      const s = JSON.parse(txt);
      if (!validState(s) || !s.data) throw new Error();
      restore(s); tab = "day"; render(); toast("Backup imported.");
    }).catch(() => toast("That file isn't a valid backup."));
  }
});

// Roll over to the new day if the app stays open past midnight.
let lastToday = todayIso();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  const now = todayIso();
  if (now !== lastToday) { if (sel === lastToday) sel = now; lastToday = now; }
  if (M) render();
});
window.addEventListener("hashchange", () => {
  handleHash().then(r => { if (r) { tab = "day"; render(); reportTake(r); } });
});

async function start() {
  if (state.data) M = build(state.data);
  if (!M) {
    // localStorage was cleared: fall back to the IndexedDB copy.
    try {
      const json = await idb("readonly", st => st.get(KEY));
      const s = json && JSON.parse(json);
      if (validState(s) && s.data) { state = s; M = build(s.data); localStorage.setItem(KEY, json); }
    } catch (e) { /* nothing saved */ }
  } else {
    idb("readwrite", st => st.put(JSON.stringify(state), KEY)).catch(() => {});
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const r = await handleHash();
  render();
  if (r) reportTake(r);
  refreshLink();
}
start();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
