/* Runs on the student portal as a bookmarklet after you log in. It reads your
   attendance, every class so far and the academic calendar, then hands them to the app.
   Written without line comments or semicolon-free lines so it survives being
   pasted into a bookmark as a single line. The app turns this function into
   the bookmark, so it works from the downloaded copy too. */
var PORTAL_IMPORT = async function () {
  var APP = "__APP__";
  var MON = "JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC";
  var box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:2147483647;top:16px;left:50%;transform:translateX(-50%);width:min(92vw,420px);background:#111827;color:#fff;font:15px/1.45 -apple-system,system-ui,sans-serif;padding:16px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.45)";
  document.body.appendChild(box);
  var say = function (t) { box.innerHTML = t; };
  var pad = function (n) { return String(n).padStart(2, "0"); };
  var iso = function (s) { var p = s.split("-"); return p[2] + "-" + pad(MON.indexOf(p[1].toUpperCase()) / 3 + 1) + "-" + pad(p[0]); };
  var txt = function (el) { return el ? el.textContent.replace(/\s+/g, " ").trim() : ""; };
  var cells = function (tr) { return Array.from(tr.querySelectorAll("td")).map(txt); };
  try {
    var csrfEl = document.querySelector("input[name=_csrf]");
    var idEl = document.getElementById("authorizedIDX") || document.getElementById("authorizedID");
    if (!csrfEl || !idEl || !idEl.value) throw new Error("Open your student portal and log in first, then tap Import again.");
    var csrf = csrfEl.value, id = idEl.value;
    var post = async function (path, data) {
      var body = new URLSearchParams(Object.assign({}, data, { _csrf: csrf, authorizedID: id, x: new Date().toUTCString() }));
      var r = await fetch(location.origin + "/" + location.pathname.split("/")[1] + "/" + path, { method: "POST", body: body, credentials: "include" });
      if (!r.ok) throw new Error("The portal said " + r.status + " for " + path + ". Log in again and retry.");
      return new DOMParser().parseFromString(await r.text(), "text/html");
    };

    say("Finding your semester…");
    var menu = await post("academics/common/StudentAttendance", { verifyMenu: "true", nocache: "@(new Date().getTime())" });
    var sems = Array.from(menu.querySelectorAll("option")).filter(function (o) {
      return /^[A-Z]{2}\d{6,}$/.test(o.value) && /Semester/i.test(o.textContent) && !/Industry|LLM|LAW|I year|Freshers|Inter|Intra|Tri /i.test(o.textContent);
    });
    if (!sems.length) throw new Error("Couldn't find your current semester.");
    var semId = sems[0].value, semName = txt(sems[0]).replace(/\s*-\s*[A-Z]{2,3}$/, "");

    say("Reading attendance for " + semName + "…");
    var sum = await post("processViewStudentAttendance", { semesterSubId: semId });
    var courses = [];
    Array.from(sum.querySelectorAll("[onclick*=processViewAttendanceDetail]")).forEach(function (a) {
      var m = a.getAttribute("onclick").match(/processViewAttendanceDetail\('([^']+)','([^']+)'\)/);
      var tr = a.closest("tr");
      if (!m || !tr) return;
      var c = cells(tr);
      var k = c.findIndex(function (v) { return /^[A-Z]{3,5}\d{3}[A-Z]?$/.test(v); });
      var nums = c.filter(function (v) { return /^\d+$/.test(v); }).map(Number).slice(-3);
      if (k < 0 || nums.length < 3) return;
      courses.push({ classId: m[1], slot: m[2], code: c[k], name: c[k + 1], type: c[k + 2], att: [nums[0], nums[1]], rows: [] });
    });
    if (!courses.length) throw new Error("No courses found for " + semName + ".");

    for (var i = 0; i < courses.length; i++) {
      var c = courses[i];
      say("Reading every class… " + (i + 1) + " of " + courses.length);
      var d = await post("processViewAttendanceDetail", { classId: c.classId, slotName: c.slot });
      Array.from(d.querySelectorAll("tr")).forEach(function (tr) {
        var x = cells(tr);
        var k = x.findIndex(function (v) { return /^\d\d-[A-Za-z]{3}-\d{4}$/.test(v); });
        if (k < 0) return;
        var st = x[k + 3] || "";
        c.rows.push([iso(x[k]), x[k + 1], /duty/i.test(st) ? "OD" : /present/i.test(st) ? "P" : /absent/i.test(st) ? "A" : st]);
      });
      delete c.classId;
    }

    say("Reading the academic calendar…");
    await post("academics/common/CalendarPreview", { verifyMenu: "true", nocache: "@(new Date().getTime())" });
    var list = await post("getListForSemester", { paramReturnId: "getListForSemester", semSubId: semId, classGroupId: "ALL" });
    var months = (list.documentElement.innerHTML.match(/\d\d-[A-Z]{3}-\d{4}/g) || []).filter(function (v, j, a) { return a.indexOf(v) === j && v.indexOf("01-") === 0; });
    if (!months.length) {
      var first = courses.reduce(function (m, c) { return c.rows.reduce(function (n, r) { return r[0] < n ? r[0] : n; }, m); }, "9999");
      var start = first === "9999" ? new Date() : new Date(first.slice(0, 4), first.slice(5, 7) - 1, 1);
      for (var n = 0; n < 6; n++) {
        var dt = new Date(start.getFullYear(), start.getMonth() + n, 1);
        months.push("01-" + MON.substr(dt.getMonth() * 3, 3) + "-" + dt.getFullYear());
      }
    }
    var cal = [];
    for (var j = 0; j < months.length; j++) {
      var p = months[j].split("-");
      var doc = await post("processViewCalendar", { calDate: months[j], semSubId: semId, classGroupId: "ALL" });
      Array.from(doc.querySelectorAll("td")).forEach(function (td) {
        var sp = Array.from(td.querySelectorAll("span")).map(txt).filter(Boolean);
        if (sp.length < 2 || !/^\d{1,2}$/.test(sp[0])) return;
        cal.push([p[2] + "-" + pad(MON.indexOf(p[1]) / 3 + 1) + "-" + pad(sp[0]), sp[1], sp.slice(2).join(" ")]);
      });
    }
    if (!cal.length) throw new Error("Couldn't read the academic calendar.");

    var json = JSON.stringify({ v: 1, sem: semName, at: new Date().toISOString(), courses: courses, cal: cal });
    var b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    var btn = "display:inline-block;margin:10px 8px 0 0;padding:10px 14px;border-radius:10px;border:0;font:inherit;font-weight:600;text-decoration:none;cursor:pointer";
    var local = APP.indexOf("file:") === 0;
    say("<b>Got " + courses.length + " courses and the calendar.</b><br>" +
      (local ? "" : "<a id=\"att-open\" href=\"" + APP + "#import=" + b64 + "\" target=\"_blank\" style=\"" + btn + ";background:#6366f1;color:#fff\">Open the app</a>") +
      "<button id=\"att-copy\" style=\"" + btn + ";background:#374151;color:#fff\">Copy</button>" +
      "<button id=\"att-close\" style=\"" + btn + ";background:transparent;color:#9ca3af\">Close</button>" +
      "<div style=\"font-size:12.5px;color:#9ca3af;margin-top:8px\">" + (local ? "Tap Copy, then in the app choose Paste import." : "Using the installed app on iPhone? Tap Copy, then in the app choose Paste import.") + "</div>");
    box.querySelector("#att-close").onclick = function () { box.remove(); };
    box.querySelector("#att-copy").onclick = function () {
      var done = function () { box.querySelector("#att-copy").textContent = "Copied ✓"; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(json).then(done, fallback);
      else fallback();
      function fallback() {
        var ta = document.createElement("textarea");
        ta.value = json; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); done(); } catch (e) { }
        ta.remove();
      }
    };
  } catch (e) {
    say("<b>Import failed</b><br>" + String(e.message || e) + "<br><button style=\"margin-top:10px;padding:8px 12px;border-radius:8px;border:0\" onclick=\"this.parentNode.remove()\">Close</button>");
  }
};
