"use strict";

const KEY = "attendance.v3";
const APP_VERSION = "v17"; // keep in step with CACHE in sw.js
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
const fresh = (strict = false) => ({ data: null, edits: {}, calEdits: {}, strict, savedAt: 0 });
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
  // Your own day changes (emergency holidays, extra working days) win over the portal's calendar.
  for (const [d, v] of Object.entries(state.calEdits || {})) cal[d] = { type: v.type, detail: v.detail, own: true, was: cal[d] || null };
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
  // Exam periods: runs of CAT / FAT days in the calendar, plus FAT after the last class day.
  const examOf = d => {
    const text = cal[d].type + " " + cal[d].detail;
    if (/LAB\s*FAT/i.test(text)) return { label: "Lab FAT", lab: true };
    const m = text.match(/CAT\s*-?\s*(I{1,3}|\d)\b/i);
    if (m) return { label: "CAT-" + m[1].toUpperCase(), lab: false };
    if (/\bFAT\b/i.test(cal[d].type)) return { label: "FAT", lab: false };
    return null;
  };
  const exams = [];
  for (const d of dates) {
    const e = examOf(d);
    if (!e) continue;
    const last = exams[exams.length - 1];
    if (last && last.label === e.label && addDays(last.end, 1) === d) last.end = d;
    else exams.push({ ...e, start: d, end: d });
  }
  if (lastTheory && !exams.some(e => !e.lab && e.start > lastTheory)) exams.push({ label: "FAT", lab: false, start: addDays(lastTheory, 1), end: addDays(lastTheory, 1) });
  if (lastLab && !exams.some(e => e.lab && e.start > lastLab)) exams.push({ label: "Lab FAT", lab: true, start: addDays(lastLab, 1), end: addDays(lastLab, 1) });
  exams.sort((a, b) => a.start.localeCompare(b.start));
  return { sem: data.sem, at: data.at, cal, dates, lastTheory, lastLab, orderOf, isClassDay, courses, exams };
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
// Exact percentage with one decimal, so a single class always shows a change.
const exact = (a, t) => (t ? (a * 100) / t : null);
const fmtx = p => (p === null ? "–" : (Math.floor(p * 10 + 1e-9) / 10).toFixed(1) + "%");

// upto: count classes on or before this date. override: { k, st } for "what if".
function stats(c, upto = todayIso(), override) {
  const today = todayIso();
  let A = 0, T = 0, F = 0, FA = 0, unmarked = 0;
  for (const k of c.classes) {
    const st = override && override.k === k ? override.st : statusOf(c, k);
    if (st === "C") continue;
    if (k.date <= upto) {
      if (st === null) {
        if (k.date <= today) { unmarked++; continue; }
        T += k.units; A += k.units; // projecting ahead: assume you attend unplanned classes
        continue;
      }
      T += k.units; if (counts(st)) A += k.units;
    } else if (k.date > today) {
      F += k.units; if (st === "A") FA += k.units;
    }
  }
  const fa = A + F - FA, ft = T + F;
  // Buffer: how many more future classes you can miss on top of what you planned.
  const buffer = (attend, room) => {
    if (!ok(attend, ft)) return -1;
    let n = 0;
    while (n < room && ok(attend - n - 1, ft)) n++;
    return n;
  };
  const canSkip = buffer(fa, F - FA), canSkipNoPlan = buffer(A + F, F);
  let need = 0;
  while (!ok(A + need, T + need) && need < 500) need++;
  return {
    A, T, F, FA, fa, ft, unmarked, need, left: F - FA, canSkip, canSkipNoPlan,
    pct: pct(A, T), exact: exact(A, T), finalPct: pct(fa, ft), finalExact: exact(fa, ft),
  };
}

function overall(upto) {
  let A = 0, T = 0, fa = 0, ft = 0, planned = 0;
  for (const c of M.courses) { const s = stats(c, upto); A += s.A; T += s.T; fa += s.fa; ft += s.ft; planned += s.FA; }
  return { A, T, pct: pct(A, T), exact: exact(A, T), end: exact(fa, ft), planned };
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
// How many classes you can still miss before the next exam and stay at 75% on that day.
const nextExam = c => M.exams.find(e => e.lab === c.lab && e.start > todayIso());
function beforeExam(c, e) {
  const today = todayIso();
  let A = 0, T = 0, F = 0, FA = 0;
  for (const k of c.classes) {
    const st = statusOf(c, k);
    if (st === "C") continue;
    if (k.date <= today) { if (st === null) continue; T += k.units; if (counts(st)) A += k.units; }
    else if (k.date < e.start) { F += k.units; if (st === "A") FA += k.units; }
  }
  const fa = A + F - FA, ft = T + F;
  if (!ok(fa, ft)) return { n: -1, F, pct: pct(fa, ft) };
  let n = 0;
  while (n < F - FA && ok(fa - n - 1, ft)) n++;
  return { n, F, pct: pct(fa, ft) };
}
const shortDate = d => { const x = parse(d); return `${x.getDate()} ${MON[x.getMonth()]}`; };
function examLine(c) {
  const e = nextExam(c);
  if (!e) return "";
  const r = beforeExam(c, e), u = c.perSession;
  const text = r.n < 0 ? `you'd be at ${fmt(r.pct)}, attend all` : !r.F ? "no classes left before it"
    : `can skip ${Math.floor(r.n / u)} of ${Math.round(r.F / u)} ${plural(c, Math.round(r.F / u))}`;
  return `<div class="exam ${r.n < 0 ? "bad" : ""}">Before ${e.label} (${shortDate(e.start)}): ${text}</div>`;
}

// One line about planned future absences, shown apart from the current %.
// Your marks on this subject's future classes.
const plannedOf = c => c.classes.filter(k => k.date > todayIso() && state.edits[editKey(c, k)]);
function planLine(c, s, withClear) {
  const marks = plannedOf(c).length;
  if (!s.FA && !marks) return "";
  const u = c.perSession, n = Math.round(s.FA / u);
  const left = s.canSkip < 0 ? "over the limit" : `buffer ${Math.floor(s.canSkip / u)} left (was ${Math.max(0, Math.floor(s.canSkipNoPlan / u))})`;
  const text = s.FA ? `Planned: ${n} ${n === 1 ? "absence" : "absences"} → ends ${fmt(s.finalPct)} · ${left}` : `${marks} planned ${marks === 1 ? "mark" : "marks"}`;
  return `<div class="plan"><span>${text}</span>${withClear ? `<button class="plan-x" data-clearplan="${esc(c.key)}">Clear planned</button>` : ""}</div>`;
}
const skipShort = (c, s) => (s.canSkip < 0 ? `ends ${fmt(s.finalPct)} ⚠︎` : `can skip ${Math.floor(s.canSkip / c.perSession)}`);

// ---------- import ----------
function validImport(d) {
  return d && Array.isArray(d.courses) && d.courses.length && Array.isArray(d.cal) &&
    d.courses.every(c => c.code && c.slot && Array.isArray(c.rows) && Array.isArray(c.att));
}
function applyImport(data) {
  if (!validImport(data)) return false;
  // Where the portal now has a record, its P / A / OD replaces yours. Your "Off"
  // (class not held) marks are always kept. Either way it's noted in the import history.
  const theirs = new Map();
  for (const c of data.courses) for (const [d, slot, st] of c.rows) theirs.set(`${c.code}|${c.slot}|${d}|${slot}`, st);
  const notes = [];
  for (const k of Object.keys(state.edits)) {
    if (!theirs.has(k)) continue;
    const mine = state.edits[k], portal = theirs.get(k);
    if (mine === "C") { notes.push({ k, mine, portal, kept: true }); continue; }
    if (mine !== portal) notes.push({ k, mine, portal, kept: false });
    delete state.edits[k];
    if (state.editTimes) delete state.editTimes[k];
  }
  state.history = [{ at: Date.now(), notes }, ...(state.history || [])].slice(0, 30);
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
  state = { data: s.data, edits: s.edits || {}, editTimes: s.editTimes || {}, calEdits: s.calEdits || {}, history: s.history || [], strict: !!s.strict, savedAt: s.savedAt || 0, remTime: s.remTime, theme: s.theme };
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
// Kept short (minified, light escaping) because phone browsers choke on very long bookmarks.
const bookmarklet = "javascript:" + ("void (" + PORTAL_IMPORT.toString().replace("__APP__", APP_URL) + ")();")
  .replace(/%/g, "%25").replace(/#/g, "%23").replace(/\n/g, "%0A");
// Phones cut bookmarks off at about 4,900 characters, so the phone bookmark carries
// the import code compressed and unpacks it when tapped (about 3,900 characters).
let phoneBookmark = bookmarklet;
(async () => {
  if (!window.CompressionStream) return;
  const code = new TextEncoder().encode("void (" + PORTAL_IMPORT.toString().replace("__APP__", APP_URL) + ")();");
  const z = new Uint8Array(await streamText(code, new CompressionStream("deflate-raw")).arrayBuffer());
  let bin = "";
  for (const b of z) bin += String.fromCharCode(b);
  phoneBookmark = "javascript:void(new Response(new Blob([Uint8Array.from(atob('" + btoa(bin) +
    "'),c=>c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text().then(eval))";
})();
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
  if (tab === "log") renderLog();
  if (tab === "set") renderSettings();
}

function renderHeader() {
  if (!M) {
    setRing(0, "");
    $("#sem").textContent = "Attendance";
    $("#overall").textContent = "Welcome";
    $("#overallSub").textContent = "Import once from your student portal to get started";
    return;
  }
  const o = overall(todayIso());
  let risky = 0;
  for (const c of M.courses) { const s = stats(c); if (s.canSkip < 0 || Math.floor(s.canSkip / c.perSession) === 0) risky++; }
  $("#sem").textContent = M.sem;
  countTo($("#overall"), o.exact);
  const below = M.courses.some(c => { const x = stats(c); return !ok(x.A, x.T) || x.canSkip < 0; });
  setRing(o.exact, below ? "bad" : "");
  $("#overallSub").innerHTML = `<span>${o.A}/${o.T} attended · ${risky ? `<b>${risky}</b> at the limit` : "all subjects safe"}</span>` +
    `<span class="endchip">${o.planned ? "With your plans" : "If you attend the rest"} → ${fmtx(o.end)}</span>`;
  const n = editsList().length + Object.keys(state.calEdits || {}).length, b = document.querySelector('[data-tab="log"] span');
  if (b) b.innerHTML = `Changes${n ? `<i class="badge">${n}</i>` : ""}`;
}

function importHtml(first) {
  return `
    ${first ? `<h2>Get started</h2><p>Bring in your courses, every class so far and the academic calendar from your student portal. You do this once, then again whenever you want to catch up.</p>` : ""}
    <div class="stepcard">
      <b>On a laptop</b>
      <ol class="steps">
        <li>Drag this button to your bookmarks bar: <a class="bm drag" href="${esc(bookmarklet)}" onclick="return false">⇩ Import attendance</a></li>
        <li>Log in to your student portal.</li>
        <li>Click <b>Import attendance</b> in your bookmarks bar, then <b>Open the app</b>.</li>
      </ol>
    </div>
    <div class="stepcard">
      <b>On a phone</b> <small>(one-time setup)</small>
      <ol class="steps">
        <li><button class="inline" data-act="copyBm">Copy the bookmark</button></li>
        <li>Bookmark any page, then edit that bookmark: name it <b>Import attendance</b> and paste as its address (replace everything there).</li>
        <li>Log in to your student portal. <b>Android:</b> type <i>Import attendance</i> in the address bar and tap the ☆ bookmark. <b>iPhone:</b> open Bookmarks and tap it.</li>
        <li>Tap <b>Open the app</b>. On the iPhone home-screen app, tap <b>Copy</b> instead and paste below.</li>
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

  let h = installHtml() + alertsHtml() + weekStrip() + `<div class="daybody">
    <div class="daynav">
      <div class="date"><b>${sel === today ? "Today · " : ""}${nice(sel)}</b><small>${esc(label)}</small></div>
      ${sel !== today ? `<button class="chip" data-act="today">Today</button>` : ""}
    </div>`;

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
    h += sel <= today
      ? `<p class="note">Overall up to this day: <b>${fmtx(o.exact)}</b> (${o.A}/${o.T})</p>`
      : `<p class="note">Projected by this day: <b>${fmtx(o.exact)}</b>, if you attend everything except your planned absences.</p>`;
  } else {
    h += `<p class="empty">${info && /holiday/i.test(info.type) ? "🎉 " : ""}No classes</p>`;
  }
  if (info && info.own) h += `<div class="alert warn">You changed this day yourself (the portal had: ${esc(info.was ? info.was.type : "nothing")}). Undo it in Changes.</div>`;
  if (info && sel <= M.lastTheory) h += `<button class="link" data-act="dayEdit">Emergency change: holiday, half day, cancelled classes or extra working day…</button>`;

  h += `<h2>Subjects</h2>${cardsHtml()}</div>`;
  $("#tab-day").innerHTML = h;
  flashIds = [];
}

// Seven-day strip (Mon–Sun) around the selected day, with arrows to move a week.
function weekStrip() {
  const d = parse(sel), monday = addDays(sel, -((d.getDay() + 6) % 7)), today = todayIso();
  let h = `<div class="week"><button class="wk-arrow" data-act="prevWeek" aria-label="Previous week">‹</button><div class="wk-days">`;
  for (let i = 0; i < 7; i++) {
    const ds = addDays(monday, i), x = parse(ds), info = M.cal[ds];
    let abs = 0, cls = 0, unm = 0;
    for (const c of M.courses) for (const k of c.classes) if (k.date === ds) {
      cls++;
      const st = statusOf(c, k);
      if (st === "A") abs++;
      if (st === null && ds <= today) unm++;
    }
    const kind = !info ? "off" : /holiday/i.test(info.type) ? "hol" : /CAT|FAT/i.test(info.type) ? "exam" : cls ? "class" : "off";
    const mark = abs ? `<i class="m abs"></i>` : unm ? `<i class="m unm"></i>` : cls ? `<i class="m"></i>` : "";
    h += `<button class="wk ${kind}${ds === sel ? " sel" : ""}${ds === today ? " today" : ""}" data-date="${ds}"><small>${WD[x.getDay()][0]}</small><b>${x.getDate()}</b>${mark}</button>`;
  }
  return h + `</div><button class="wk-arrow" data-act="nextWeek" aria-label="Next week">›</button></div>`;
}

// Prompt to install / bookmark, until installed or dismissed.
let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; if (M && tab === "day") render(); });
window.addEventListener("appinstalled", () => { installEvt = null; render(); });
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
function installHtml() {
  if (standalone() || location.protocol === "file:") return "";
  try { if (localStorage.getItem("installHidden") === "1") return ""; } catch (e) { /* ignore */ }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent), mobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
  const how = installEvt ? `<button class="chip solid" data-act="install">Install app</button>`
    : ios ? `<span>Tap <b>Share</b> <span class="ios-share">⬆︎</span> → <b>Add to Home Screen</b>. It also keeps your data safe.</span>`
    : mobile ? `<span>Browser menu → <b>Install app</b> or <b>Add to Home screen</b>.</span>`
    : `<span>Press <b>${/mac/i.test(navigator.platform) ? "⌘" : "Ctrl"}+D</b> to bookmark, or use the install icon in the address bar.</span>`;
  return `<div class="install"><div class="ii">📲</div><div class="it"><b>Keep this app one tap away</b>${how}</div><button class="x" data-act="hideInstall" aria-label="Dismiss">✕</button></div>`;
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

function examsHtml() {
  const up = M.exams.filter(e => e.end >= todayIso());
  if (!up.length) return "";
  return `<div class="exams">${up.map(e => `<span class="echip${e.lab ? " lab" : ""}">${e.label} · ${shortDate(e.start)}${e.end !== e.start ? `–${shortDate(e.end)}` : ""}</span>`).join("")}</div>`;
}

// Running % across the semester as a tiny area chart, with the 75% line.
function spark(c) {
  const today = todayIso(), pts = [];
  let A = 0, T = 0;
  for (const k of c.classes) {
    if (k.date > today) break;
    const st = statusOf(c, k);
    if (!st || st === "C") continue;
    T += k.units; if (counts(st)) A += k.units;
    pts.push((A * 100) / T);
  }
  if (pts.length < 2) return `<div class="bar"><i style="width:${Math.min(100, pts[0] || 0)}%"></i></div>`;
  const W = 300, H = 44, lo = Math.min(60, ...pts) - 2, hi = 100;
  const y = v => (H - ((v - lo) / (hi - lo)) * H).toFixed(1), x = i => ((i / (pts.length - 1)) * W).toFixed(1);
  const line = pts.map((v, i) => `${i ? "L" : "M"}${x(i)} ${y(v)}`).join("");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path class="area" d="${line}L${W} ${H}L0 ${H}Z"/><line class="min" x1="0" x2="${W}" y1="${y(MIN)}" y2="${y(MIN)}"/>
    <path class="ln" d="${line}" pathLength="1"/><circle class="end" cx="${W}" cy="${y(pts[pts.length - 1])}" r="3.5"/></svg>`;
}

function cardsHtml() {
  let h = `<div class="cards">`;
  // Lowest attendance first, so the subjects that need attention are on top.
  const list = M.courses.map(c => ({ c, s: stats(c) }))
    .sort((a, b) => (a.s.exact === null ? 101 : a.s.exact) - (b.s.exact === null ? 101 : b.s.exact));
  for (const { c, s } of list) {
    const v = verdict(c, s);
    h += `
      <button class="card tone-${v.tone}${flashIds.includes(c.key) ? " flash" : ""}" data-course="${esc(c.key)}">
        <div class="row">
          <div><b>${esc(c.name)}</b><small>${esc(c.code)} · ${esc(c.slot)} · ${s.A}/${s.T} · exact ${fmtx(s.exact)}</small></div>
          <div class="pct">${fmt(s.pct)}</div>
        </div>
        ${spark(c)}
        <div class="verdict">${v.text}</div>
        <small>${v.sub}${s.unmarked ? ` · ${s.unmarked} past ${s.unmarked === 1 ? "class" : "classes"} not marked yet` : ""}</small>
        ${examLine(c)}
        ${planLine(c, s)}
      </button>`;
  }
  return h + `</div>`;
}

function renderSubjects() {
  const c = openCourse && course(openCourse);
  if (!c) { $("#tab-subj").innerHTML = `<div class="rowhead"><p class="note">Tap a subject to see every class and edit it.</p><button class="inline" data-act="share">Share summary</button></div>${examsHtml()}${cardsHtml()}`; return; }
  const s = stats(c), v = verdict(c, s), today = todayIso();
  let h = `
    <button class="link left" data-act="back">‹ All subjects</button>
    <div class="card tone-${v.tone} static">
      <div class="row">
        <div><b>${esc(c.name)}</b><small>${esc(c.code)} · ${esc(c.type || "")} · ${esc(c.slot)}</small></div>
        <div class="pct">${fmt(s.pct)}</div>
      </div>
      <div class="verdict">${v.text}</div>
      <small>${s.A}/${s.T} attended · exact ${fmtx(s.exact)} · portal showed ${c.portal[0]}/${c.portal[1]} at import · ${v.sub}</small>
      ${examLine(c)}
      ${planLine(c, s, true)}
    </div>
    <table class="classes"><thead><tr><th>Date</th><th>Status</th><th>% so far</th></tr></thead><tbody>`;
  // Running % is worked out in date order, then shown with the latest classes on top.
  let A = 0, T = 0;
  const rows = c.classes.map(k => {
    const st = statusOf(c, k);
    if (st && st !== "C") { T += k.units; if (counts(st)) A += k.units; }
    return { k, run: st && st !== "C" ? fmt(pct(A, T)) : "" };
  });
  const row = ({ k, run }) => `<tr class="${k.date > today ? "future" : ""} ${k.date === today ? "todayrow" : ""}">
      <td><button class="dlink" data-date="${k.date}">${nice(k.date)}</button><small>${esc(k.slot)} ${sourceTag(c, k)}</small></td>
      <td>${statusButtons(c, k)}</td>
      <td class="run">${run}</td></tr>`;
  const head = t => `<tr class="mrow"><td colspan="3">${t}</td></tr>`;
  const upcoming = rows.filter(r => r.k.date > today), past = rows.filter(r => r.k.date <= today).reverse();
  if (upcoming.length) h += head(`Upcoming (${upcoming.length})`) + upcoming.map(row).join("");
  let month = "";
  for (const r of past) {
    const m = r.k.date.slice(0, 7);
    if (m !== month) { month = m; const d = parse(r.k.date); h += head(`${MONTH_FULL[d.getMonth()]} ${d.getFullYear()}`); }
    h += row(r);
  }
  h += `</tbody></table>`;
  $("#tab-subj").innerHTML = h;
}

// Every mark you made, newest class first, editable in place.
function editsList() {
  const out = [];
  for (const c of M.courses) for (const k of c.classes) {
    const ek = editKey(c, k);
    if (state.edits[ek]) out.push({ c, k, ek, at: (state.editTimes || {})[ek] || 0 });
  }
  return out.sort((a, b) => (a.k.date + a.k.time).localeCompare(b.k.date + b.k.time));
}
const ago = t => {
  if (!t) return "";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
function renderLog() {
  const today = todayIso(), all = editsList();
  const future = all.filter(x => x.k.date > today), past = all.filter(x => x.k.date <= today).reverse();
  const row = ({ c, k, ek, at }) => `
    <div class="logrow">
      <div class="sinfo">
        <button class="dlink" data-date="${k.date}">${nice(k.date)}</button> <small class="inline-s">${k.time || ""}</small>
        <b>${esc(c.name)}</b>
        <small>${k.portal ? `Portal: ${STATUS[k.portal] || k.portal} → ` : ""}yours: ${STATUS[state.edits[ek]]}${at ? ` · changed ${ago(at)}` : ""}</small>
      </div>
      <div class="logact">${statusButtons(c, k)}<button class="undo" data-undo="${esc(ek)}" title="Undo this change">Undo</button></div>
    </div>`;
  const o = overall(today);
  let h = `<p class="note">Everything you marked yourself. Change it here, or undo it to go back to the portal's record (or blank).</p>`;
  h += `<h2>Planned · future (${future.length})</h2>`;
  const per = M.courses.map(c => [c, plannedOf(c).length]).filter(([, n]) => n);
  const perSubject = per.length > 1 || future.length > 1
    ? `<div class="clearrow">${per.map(([c, n]) => `<button class="chip" data-clearplan="${esc(c.key)}">Clear ${esc(c.name)} (${n})</button>`).join("")}</div>` : "";
  h += future.length ? `<div class="planbox">Your current attendance doesn't include these. With them, the semester ends at <b>${fmtx(o.end)}</b>.</div>${perSubject}${future.map(row).join("")}
    <div class="quick"><button class="danger" data-act="clearPlanned">Undo all planned</button></div>` : `<p class="empty small">No planned absences. Mark a future class Absent to plan one.</p>`;
  h += `<h2>Past changes (${past.length})</h2>`;
  h += past.length ? past.map(row).join("") : `<p class="empty small">No changes to past classes.</p>`;
  const days = Object.keys(state.calEdits || {}).sort();
  h += `<h2>Calendar changes (${days.length})</h2>`;
  h += days.length ? days.map(d => {
    const info = M.cal[d];
    return `<div class="logrow"><div class="sinfo"><button class="dlink" data-date="${d}">${nice(d)}</button>
      <b>${esc(info.type)}${/Day Order/.test(info.detail) ? ` · ${esc(M.orderOf(d))} timetable` : ""}</b>
      <small>Portal: ${esc(info.was ? info.was.type : "nothing")} · changed ${ago(state.calEdits[d].at)}</small></div>
      <div class="logact"><button class="undo" data-calundo="${d}">Undo</button></div></div>`;
  }).join("") : `<p class="empty small">No emergency day changes.</p>`;
  const hist = state.history || [];
  h += `<h2>Import history (${hist.length})</h2>`;
  h += hist.length ? hist.map(ev => {
    const lines = ev.notes.map(n => {
      const [code, cslot, d] = n.k.split("|"), c = course(`${code}|${cslot}`);
      return `<li>${nice(d)} · ${esc(c ? c.name : code)}: ${n.kept
        ? `kept your <b>${STATUS[n.mine]}</b> (portal: ${STATUS[n.portal] || n.portal})`
        : `your ${STATUS[n.mine]} → portal's <b>${STATUS[n.portal] || n.portal}</b>`}</li>`;
    }).join("");
    const t = new Date(ev.at);
    return `<div class="logrow"><div class="sinfo"><b>Imported ${nice(iso(t))}, ${pad(t.getHours())}:${pad(t.getMinutes())}</b>
      ${lines ? `<ul class="hist">${lines}</ul>` : `<small>None of your marks were affected.</small>`}</div></div>`;
  }).join("") : `<p class="empty small">No imports recorded yet.</p>`;
  $("#tab-log").innerHTML = h;
}

function renderCal() {
  const today = todayIso();
  const first = parse(M.dates[0]), last = parse(M.dates[M.dates.length - 1]);
  let h = `<p class="note">Tap a day to see or mark its classes.</p>`;
  const months = [];
  for (let y = first.getFullYear(), m = first.getMonth(); y < last.getFullYear() || (y === last.getFullYear() && m <= last.getMonth()); m === 11 ? (y++, m = 0) : m++) months.push([y, m]);
  // This month first, then the months ahead, then earlier months (newest first).
  const now = today.slice(0, 7), key = ([y, m]) => `${y}-${pad(m + 1)}`;
  const ordered = [...months.filter(x => key(x) >= now), ...months.filter(x => key(x) < now).reverse()];
  if (!ordered.length || key(ordered[0]) !== now) ordered.sort((a, b) => key(b).localeCompare(key(a)));
  let shownEarlier = false;
  for (const [y, m] of ordered) {
    if (!shownEarlier && key([y, m]) < now && ordered.some(x => key(x) >= now)) { h += `<div class="divider">Earlier months</div>`; shownEarlier = true; }
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

    <h2>Theme</h2>
    <div class="themes">${THEMES.map(([id, name, sw]) => `<button class="theme${(state.theme || "ocean") === id ? " on" : ""}" data-theme="${id}"><i style="background:${sw}"></i>${name}</button>`).join("")}</div>

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

    <p class="note">App version <b>${APP_VERSION}</b></p>

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

// ---------- emergency day changes ----------
const FULL_DAY = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday" };
// Classes that would meet on a day following this timetable (ignoring the portal's records).
function classesIf(order) {
  if (!order) return [];
  return M.courses.filter(c => (!c.lab || sel <= M.lastLab) && c.slots.some(s => (SLOT_AT[s] || []).some(x => x.day === order)));
}
// Classes on the selected day, in time order: [{ c, k }].
let sheetClasses = [];
const isMorning = k => (k.time || "00:00") < "13:00";
function openDaySheet() {
  const info = M.cal[sel], own = (state.calEdits || {})[sel];
  const nowNames = M.courses.filter(c => c.classes.some(k => k.date === sel && !k.portal)).map(c => c.name);
  const wd = WD[parse(sel).getDay()], defOrder = FULL_DAY[wd] ? wd : "Mon";
  sheetClasses = [];
  for (const c of M.courses) for (const k of c.classes) if (k.date === sel) sheetClasses.push({ c, k });
  sheetClasses.sort((a, b) => a.k.time.localeCompare(b.k.time));
  const am = sheetClasses.filter(x => isMorning(x.k)).length, pm = sheetClasses.length - am;
  const partial = sheetClasses.length ? `
      <label class="opt"><input type="radio" name="dk" value="am" ${am ? "" : "disabled"}> Morning cancelled <small>(${am} ${am === 1 ? "class" : "classes"} before 1 pm)</small></label>
      <label class="opt"><input type="radio" name="dk" value="pm" ${pm ? "" : "disabled"}> Afternoon cancelled <small>(${pm} ${pm === 1 ? "class" : "classes"} from 1 pm)</small></label>
      <label class="opt"><input type="radio" name="dk" value="pick"> Only these classes were cancelled:</label>
      <div class="picks">${sheetClasses.map((x, i) => `<label class="pick"><input type="checkbox" class="dpick" value="${i}" ${statusOf(x.c, x.k) === "C" ? "checked" : ""}> ${x.k.time || ""} · ${esc(x.c.name)}</label>`).join("")}</div>` : "";
  $("#sheet").innerHTML = `
    <div class="sheetbox" role="dialog" aria-modal="true">
      <h3>Change ${nice(sel)}</h3>
      <p class="note">Right now: <b>${esc(info.type)}</b>${info.detail ? " · " + esc(info.detail.replace(/^\(|\)$/g, "")) : ""}</p>
      <label class="opt"><input type="radio" name="dk" value="hol" checked> Full day: holiday, no classes</label>${partial}
      <label class="opt"><input type="radio" name="dk" value="work"> Working day, following the
        <select id="dorder">${Object.keys(FULL_DAY).map(d => `<option value="${d}" ${d === defOrder ? "selected" : ""}>${FULL_DAY[d]}</option>`).join("")}</select> timetable</label>
      ${own ? `<label class="opt"><input type="radio" name="dk" value="undo"> Undo my change (back to the portal's calendar)</label>` : ""}
      <div class="stern" id="dimpact"></div>
      <label class="field">Type <b>CHANGE</b> to confirm <input id="dconfirm" autocomplete="off" autocapitalize="characters" placeholder="CHANGE"></label>
      <div class="quick"><button data-act="sheetClose">Cancel</button><button class="dangerbtn" data-act="dayApply" id="dapply" disabled>Apply</button></div>
    </div>`;
  $("#sheet").hidden = false;
  $("#sheet").dataset.now = JSON.stringify(nowNames);
  updateImpact();
}
// The classes a half-day or "only these" choice would mark Off.
function sheetTargets(kind) {
  if (kind === "am") return sheetClasses.filter(x => isMorning(x.k));
  if (kind === "pm") return sheetClasses.filter(x => !isMorning(x.k));
  if (kind === "pick") return [...document.querySelectorAll(".dpick:checked")].map(b => sheetClasses[+b.value]);
  return [];
}
function updateImpact() {
  const kind = (document.querySelector("input[name=dk]:checked") || {}).value;
  const nowNames = JSON.parse($("#sheet").dataset.now || "[]");
  document.querySelectorAll(".dpick").forEach(b => (b.disabled = kind !== "pick"));
  let what;
  if (["am", "pm", "pick"].includes(kind)) {
    const t = sheetTargets(kind);
    what = t.length ? `<b>${t.length} ${t.length === 1 ? "class" : "classes"}</b> (${t.map(x => esc(x.c.name)).join(", ")}) will be marked <b>Off</b>: not held, not counted.` : "Tick at least one class.";
  } else if (kind === "hol") what = nowNames.length ? `<b>${nowNames.length} ${nowNames.length === 1 ? "class" : "classes"}</b> on this day (${nowNames.map(esc).join(", ")}) will be <b>removed</b>.` : "No classes are scheduled on this day, so only the calendar changes.";
  else if (kind === "work") { const add = classesIf($("#dorder").value).map(c => c.name); what = `This day will have <b>${add.length} ${add.length === 1 ? "class" : "classes"}</b> (${add.map(esc).join(", ") || "none"}), replacing what's there now.`; }
  else what = "This day goes back to exactly what the portal's calendar says.";
  $("#dimpact").innerHTML = `<b>⚠ Only do this if your college has officially announced it.</b>
    <ul><li>${what}</li>
    <li>Your current %, "can skip" numbers and end-of-semester % change for <b>every subject</b>.</li>
    <li>It stays even when you import again. Classes the portal has already recorded still count as recorded.</li>
    <li>If you get it wrong, your numbers will be wrong until you undo it (in Changes).</li></ul>`;
  const empty = ["am", "pm", "pick"].includes(kind) && !sheetTargets(kind).length;
  $("#dapply").disabled = empty || $("#dconfirm").value.trim().toUpperCase() !== "CHANGE";
}
function applyDayChange() {
  const kind = (document.querySelector("input[name=dk]:checked") || {}).value;
  if (["am", "pm", "pick"].includes(kind)) {
    // Part of the day: mark those classes Off (kept across imports, listed in Changes).
    const t = sheetTargets(kind);
    $("#sheet").hidden = true;
    if (kind === "pick") {
      // Unticked classes that were Off go back to normal.
      const picked = new Set(t.map(x => x.k));
      const back = sheetClasses.filter(x => !picked.has(x.k) && statusOf(x.c, x.k) === "C").map(x => [x.c, x.k, null]);
      change([...t.map(x => [x.c, x.k, "C"]), ...back]);
    } else change(t.map(x => [x.c, x.k, "C"]));
    return;
  }
  state.calEdits = state.calEdits || {};
  if (kind === "hol") state.calEdits[sel] = { type: "Holiday", detail: "(Declared by you)", at: Date.now() };
  if (kind === "work") { const o = $("#dorder").value; state.calEdits[sel] = { type: "Instructional Day", detail: `(${FULL_DAY[o]} Day Order · declared by you)`, at: Date.now() }; }
  if (kind === "undo") delete state.calEdits[sel];
  const before = overall(todayIso());
  M = build(state.data);
  save();
  $("#sheet").hidden = true;
  render();
  const after = overall(todayIso());
  toast(`${nice(sel)} is now ${kind === "hol" ? "a holiday" : kind === "work" ? "a working day" : "back to the portal's calendar"}.<br>Now: ${fmtx(before.exact)} → <b>${fmtx(after.exact)}</b> · Semester end: ${fmtx(before.end)} → <b>${fmtx(after.end)}</b>`);
}

// ---------- themes ----------
const THEMES = [
  ["aurora", "Aurora", "linear-gradient(135deg,#3b2fd6,#c026d3)"],
  ["midnight", "Midnight", "linear-gradient(135deg,#0b1533,#2f56d9)"],
  ["ocean", "Ocean", "linear-gradient(135deg,#1d4ed8,#06b6d4)"],
  ["nebula", "Nebula", "linear-gradient(135deg,#4c1d95,#d946ef)"],
  ["graphite", "Graphite", "linear-gradient(135deg,#1e293b,#64748b)"],
  ["paper", "Paper", "linear-gradient(135deg,#111,#555)"],
];
function applyTheme() {
  const t = (state.theme || "ocean") === "aurora" ? "" : state.theme || "ocean";
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}

// ---------- motion ----------
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const mondayOf = d => addDays(d, -((parse(d).getDay() + 6) % 7));
// Moving to another day: glide inside the same week, slide when the week changes.
function moveTo(d) {
  if (d === sel) return;
  const fwd = d > sel, same = mondayOf(d) === mondayOf(sel);
  go(() => { sel = d; tab = "day"; render(); }, same ? (fwd ? "dnext" : "dprev") : (fwd ? "next" : "prev"));
}
// Smooth cross-fade between screens where the browser supports it.
function go(fn, dir) {
  if (!document.startViewTransition || calm()) { fn(); return; }
  document.documentElement.dataset.dir = dir || "";
  document.startViewTransition(fn);
}
function setRing(p, tone) {
  const fg = $("#ringFg");
  if (!fg) return;
  fg.style.strokeDashoffset = 100 - Math.max(0, Math.min(100, p || 0));
  $(".top").dataset.tone = tone;
}
let shownPct = null, countRaf = 0;
function countTo(el, target) {
  if (target === null) { el.textContent = "–"; shownPct = null; return; }
  const from = shownPct === null ? (calm() ? target : Math.max(0, target - 12)) : shownPct, t0 = performance.now(), dur = 650;
  cancelAnimationFrame(countRaf);
  const tick = now => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmtx(from + (target - from) * e);
    if (k < 1) countRaf = requestAnimationFrame(tick); else shownPct = target;
  };
  countRaf = requestAnimationFrame(tick);
}
const buzz = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { /* ignore */ } };
// Small confetti burst when a subject climbs back to the limit.
function confetti() {
  if (calm()) return;
  const cv = $("#fx"), cx = cv.getContext("2d"), dpr = devicePixelRatio || 1;
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; cx.scale(dpr, dpr);
  const colors = ["#22c55e", "#6366f1", "#f59e0b", "#ec4899", "#06b6d4"];
  const ps = Array.from({ length: 90 }, () => ({
    x: innerWidth / 2, y: innerHeight * 0.35, vx: (Math.random() - 0.5) * 9, vy: -Math.random() * 9 - 3,
    s: 4 + Math.random() * 4, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, c: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  const draw = now => {
    cx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of ps) {
      p.vy += 0.25; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      cx.save(); cx.translate(p.x, p.y); cx.rotate(p.r); cx.fillStyle = p.c; cx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); cx.restore();
    }
    if (now - t0 < 1600) requestAnimationFrame(draw); else cx.clearRect(0, 0, innerWidth, innerHeight);
  };
  requestAnimationFrame(draw);
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
  const o0 = overall(today);
  state.editTimes = state.editTimes || {};
  for (const [c, k, st] of updates) {
    const ek = editKey(c, k);
    if (!st || st === k.portal) { delete state.edits[ek]; delete state.editTimes[ek]; }
    else { state.edits[ek] = st; state.editTimes[ek] = Date.now(); }
  }
  save();
  const seen = new Set(), lines = [];
  let future = false;
  for (const [c, k] of updates) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    const a = before.get(c.key), z = stats(c), u = c.perSession;
    if (k.date > today) {
      future = true;
      const b0 = a.canSkip < 0 ? "–" : Math.floor(a.canSkip / u), b1 = z.canSkip < 0 ? "over limit" : Math.floor(z.canSkip / u);
      lines.push(`${esc(c.name)} (planned): ends ${fmtx(a.finalExact)} → <b>${fmtx(z.finalExact)}</b> · buffer ${b0} → ${b1}`);
    } else {
      lines.push(`${esc(c.name)}: ${fmtx(a.exact)} → <b>${fmtx(z.exact)}</b> · ${skipShort(c, z)}`);
    }
  }
  const o1 = overall(today);
  flashIds = [...seen];
  buzz(updates.some(([, , st]) => st === "A") ? [12, 40, 12] : 10);
  if ([...seen].some(key => { const c = course(key); return c && !ok(before.get(key).A, before.get(key).T) && ok(stats(c).A, stats(c).T); })) confetti();
  render();
  toast(lines.join("<br>") + (future
    ? `<br>Now: ${fmtx(o1.exact)} (unchanged) · Semester end: ${fmtx(o0.end)} → <b>${fmtx(o1.end)}</b>`
    : `<br>Overall: ${fmtx(o0.exact)} → <b>${fmtx(o1.exact)}</b>`));
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
  if (t.dataset.tab) {
    if (t.dataset.tab === tab && !(tab === "subj" && openCourse)) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    go(() => { tab = t.dataset.tab; if (tab === "subj") openCourse = null; render(); window.scrollTo(0, 0); }, "fade");
    return;
  }
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
  if (t.dataset.theme) { state.theme = t.dataset.theme; applyTheme(); save(); render(); return; }
  if (t.dataset.clearplan) {
    const c = course(t.dataset.clearplan);
    if (!c || !armed(t, "Tap again to clear")) return;
    const ups = plannedOf(c).map(k => [c, k, null]);
    if (ups.length) change(ups);
    return;
  }
  if (t.dataset.calundo) {
    const before = overall(todayIso());
    delete state.calEdits[t.dataset.calundo];
    M = build(state.data); save(); render();
    const after = overall(todayIso());
    toast(`${nice(t.dataset.calundo)} is back to the portal's calendar.<br>Now: ${fmtx(before.exact)} → <b>${fmtx(after.exact)}</b> · Semester end: ${fmtx(before.end)} → <b>${fmtx(after.end)}</b>`);
    return;
  }
  if (t.dataset.undo) {
    for (const c of M.courses) for (const k of c.classes) if (editKey(c, k) === t.dataset.undo) { change([[c, k, null]]); return; }
    return;
  }
  if (t.dataset.course) {
    const key = t.dataset.course;
    go(() => { openCourse = key; tab = "subj"; render(); window.scrollTo(0, 0); }, "next");
    return;
  }
  if (t.dataset.date) {
    const d = t.dataset.date;
    if (t.closest(".week") && tab === "day") { moveTo(d); return; }
    go(() => { sel = d; tab = "day"; render(); window.scrollTo(0, 0); }, d > sel ? "next" : d < sel ? "prev" : "fade");
    return;
  }
  const act = t.dataset.act;
  if (act === "dayEdit") openDaySheet();
  if (act === "sheetClose") $("#sheet").hidden = true;
  if (act === "dayApply" && !t.disabled) applyDayChange();
  if (act === "prev") moveTo(addDays(sel, -1));
  if (act === "next") moveTo(addDays(sel, 1));
  if (act === "prevWeek") go(() => { sel = addDays(sel, -7); render(); }, "prev");
  if (act === "nextWeek") go(() => { sel = addDays(sel, 7); render(); }, "next");
  if (act === "today") moveTo(todayIso());
  if (act === "install" && installEvt) { installEvt.prompt(); installEvt.userChoice.finally(() => { installEvt = null; render(); }); }
  if (act === "hideInstall") { try { localStorage.setItem("installHidden", "1"); } catch (e) { /* ignore */ } render(); }
  if (act === "back") go(() => { openCourse = null; render(); }, "prev");
  if (act === "copyBm") {
    copyText(phoneBookmark).then(() => toast(`Bookmark copied (${phoneBookmark.length} characters). Paste it as the bookmark's address.`), () => toast("Couldn't copy."));
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
  if (act === "clearEdits" && armed(t, "Tap again to clear")) { state.edits = {}; state.editTimes = {}; save(); render(); toast("Your marks are cleared. Portal data is kept."); }
  if (act === "clearPlanned" && armed(t, "Tap again to undo all planned")) {
    const ups = editsList().filter(x => x.k.date > todayIso()).map(x => [x.c, x.k, null]);
    if (ups.length) change(ups);
  }
  if (act === "reset" && armed(t, "Tap again to remove")) { state = fresh(state.strict); M = null; save(); render(); }
});

document.addEventListener("input", e => {
  if (e.target.id === "dconfirm") updateImpact();
});
document.addEventListener("change", e => {
  if (e.target.name === "dk" || e.target.id === "dorder" || e.target.classList.contains("dpick")) updateImpact();
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

// Swipe left / right on the Today tab to change day.
let touch = null;
document.addEventListener("touchstart", e => {
  if (tab !== "day" || !M || e.touches.length !== 1 || e.target.closest(".seg, .week, input, textarea, .sheet")) { touch = null; return; }
  touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
}, { passive: true });
document.addEventListener("touchend", e => {
  if (!touch) return;
  const dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6 && Date.now() - touch.t < 600) {
    moveTo(addDays(sel, dx < 0 ? 1 : -1));
  }
  touch = null;
}, { passive: true });

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
  applyTheme();
  if (state.data) M = build(state.data);
  if (!M) {
    // localStorage was cleared: fall back to the IndexedDB copy.
    try {
      const json = await idb("readonly", st => st.get(KEY));
      const s = json && JSON.parse(json);
      if (validState(s) && s.data) { state = s; M = build(s.data); localStorage.setItem(KEY, json); applyTheme(); }
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
  // A new version takes over straight away: reload once and say so.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    try { sessionStorage.setItem("justUpdated", "1"); } catch (e) { /* ignore */ }
    location.reload();
  });
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(reg => {
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
  }).catch(() => {});
  try { if (sessionStorage.getItem("justUpdated")) { sessionStorage.removeItem("justUpdated"); setTimeout(() => toast(`Updated ✓ (${APP_VERSION})`), 400); } } catch (e) { /* ignore */ }
}
