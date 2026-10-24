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

// ---------- state ----------
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && typeof s.edits === "object") return s;
  } catch (e) { /* storage unavailable */ }
  return { data: null, edits: {}, strict: false };
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
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
    // Expected classes from the timetable on every class day, so future ones show up too.
    const start = c.rows.length ? c.rows.reduce((m, r) => (r[0] < m ? r[0] : m), "9999") : classDays[0];
    for (const d of classDays) {
      if (d < start || d > lastTheory || (lab && d > lastLab)) continue;
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
function importFromHash() {
  if (!location.hash.startsWith("#import=")) return;
  const b64 = location.hash.slice(8).replace(/-/g, "+").replace(/_/g, "/");
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const data = JSON.parse(decodeURIComponent(escape(atob(b64))));
    if (applyImport(data)) { sel = todayIso(); toast(`Imported ${data.courses.length} course${data.courses.length > 1 ? "s" : ""}.`); return; }
  } catch (e) { /* fall through */ }
  toast("That import link was incomplete. Run the import again.");
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
    <details ${first ? "" : "open"}>
      <summary>Paste import</summary>
      <textarea id="paste" rows="4" placeholder="Paste what the import copied"></textarea>
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

  let h = `
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
  if (!c) { $("#tab-subj").innerHTML = `<p class="note">Tap a subject to see every class and edit it.</p>${cardsHtml()}`; return; }
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

    <h2>Percentage rule</h2>
    <label class="switch"><input type="checkbox" id="strict" ${state.strict ? "checked" : ""}> Strict 75% (ignore the portal's rounding up)</label>
    <p class="note">The portal rounds up, so 74.2% shows as 75%. Turn this on to keep a safety margin. On duty counts as present, like on the portal.</p>

    <h2>Backup</h2>
    <p class="note">Export here and import on another device to move everything, including your own marks.</p>
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
  if (act === "paste") {
    let data = null;
    try { data = JSON.parse($("#paste").value); } catch (err) { /* handled below */ }
    if (!applyImport(data)) { toast("That doesn't look like an import. Run the import and tap Copy."); return; }
    sel = todayIso(); tab = "day"; render(); window.scrollTo(0, 0);
    toast(`Imported ${data.courses.length} course${data.courses.length > 1 ? "s" : ""}.`);
  }
  if (act === "export") {
    const blob = new Blob([JSON.stringify(state)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `attendance-backup-${todayIso()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  if (act === "clearEdits" && armed(t, "Tap again to clear")) { state.edits = {}; save(); render(); toast("Your marks are cleared. Portal data is kept."); }
  if (act === "reset" && armed(t, "Tap again to remove")) { state = { data: null, edits: {}, strict: state.strict }; M = null; save(); render(); }
});

document.addEventListener("change", e => {
  if (e.target.id === "strict") { state.strict = e.target.checked; save(); renderHeader(); }
  if (e.target.id === "importFile" && e.target.files[0]) {
    e.target.files[0].text().then(txt => {
      const s = JSON.parse(txt);
      if (!s || typeof s.edits !== "object" || !validImport(s.data)) throw new Error();
      state = { data: s.data, edits: s.edits, strict: !!s.strict };
      M = build(state.data); save(); tab = "day"; render(); toast("Backup imported.");
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
window.addEventListener("hashchange", () => { importFromHash(); render(); });

if (state.data && validImport(state.data)) M = build(state.data);
importFromHash();
render();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
