(() => {
  "use strict";

  // ═══════════════════════════════════════════════════════════════ state
  const state = {
    server: location.protocol.startsWith("http"),
    files: [], filesFiltered: [], filesSortKey: "mtime", filesSortDir: "desc", filesPage: 1, filesPageSize: 100,
    selected: new Set(), lastCount: -1, lastFetch: 0, scanRunning: false,
    entries: [], filtered: [], loaded: [], totalLines: 0, nextId: 1,
    sortKey: "ts", sortDir: "asc", page: 1, pageSize: 50, colFilters: {}, sigFilter: null,
    epSortKey: "count", epSortDir: "desc",
    search: { results: [], fileFilter: null },
  };
  const $ = (id) => document.getElementById(id);
  const els = new Proxy({}, { get: (c, k) => c[k] || (c[k] = $(k)) });

  // ═══════════════════════════════════════════════════════════════ helpers
  const escapeHtml = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  const fmtN = (v) => new Intl.NumberFormat("en-US").format(Number(v || 0));
  const fmtD = (v) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(Number(v || 0));
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  function fmtBytes(b) {
    if (!b) return "0 B";
    const u = ["B", "KB", "MB", "GB", "TB"]; const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
    return `${(b / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
  }
  function fmtLocal(sec) { const d = new Date(sec * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function ago(sec) {
    const s = Date.now() / 1000 - sec;
    if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`; if (s < 86400 * 60) return `${Math.floor(s / 86400)} days ago`;
    return `${Math.floor(s / 86400 / 30)} months ago`;
  }
  function fmtTs(e) {
    if (e.ts === null || e.ts === undefined) return "—";
    const d = new Date(e.ts);
    const t = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
    return e.hasDate ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${t}` : t;
  }
  function fmtSpan(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "—";
    const s = ms / 1000;
    if (s < 60) return `${fmtD(s)} s`; if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86400)}d ${Math.round((s % 86400) / 3600)}h`;
  }
  const fmtDur = (v) => (Number.isFinite(v) ? `${fmtN(Math.round(v))} ms` : "—");
  const durClass = (v) => (!Number.isFinite(v) ? "" : v <= 100 ? "duration-fast" : v <= 500 ? "duration-medium" : "duration-slow");
  const average = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const percentile = (sorted, p) => (sorted.length ? sorted[Math.max(0, Math.min(Math.ceil((p / 100) * sorted.length) - 1, sorted.length - 1))] : 0);
  const baseName = (p) => String(p).split(/[\\/]/).pop();
  const dirName = (p) => { const s = String(p); const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/")); return i > 0 ? s.slice(0, i) : ""; };
  const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  function mask(text) {
    if (!els.maskToggle.checked) return String(text ?? "");
    return String(text ?? "")
      .replace(/\b([23]\d{3})(\d{6})(\d{4})\b/g, "$1••••••$3")
      .replace(/\b(01[0125])(\d{4})(\d{4})\b/g, "$1••••$3");
  }
  function showToast(msg) {
    els.toast.textContent = msg; els.toast.classList.add("show");
    clearTimeout(showToast.t); showToast.t = setTimeout(() => els.toast.classList.remove("show"), 2800);
  }
  function levelBadge(e) {
    const lv = e.level || "info";
    return `<span class="badge lv-${lv}${e.lvInf ? " inferred" : ""}" title="${e.lvInf ? "inferred from the text" : "from the log"}">${lv.toUpperCase()}</span>`;
  }
  function statusBadge(s) {
    if (!Number.isFinite(s)) return "—";
    if (s >= 200 && s < 300) return `<span class="badge success">${s}</span>`;
    if (s >= 500) return `<span class="badge danger">${s}</span>`;
    if (s >= 400) return `<span class="badge warning">${s}</span>`;
    return `<span class="badge">${s}</span>`;
  }
  function csvEscape(v) { return `"${String(v ?? "").replace(/"/g, '""')}"`; }
  function download(text, name) {
    const url = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch { const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
  }
  function makeMatcher(q, caseSensitive) {
    if (!q) return null;
    const m = /^\/(.+)\/([a-z]*)$/.exec(q);
    if (m) { try { const rx = new RegExp(m[1], m[2].includes("i") || !caseSensitive ? "i" : ""); return (s) => rx.test(s); } catch { /* fall through */ } }
    const needle = caseSensitive ? q : q.toLowerCase();
    return caseSensitive ? (s) => s.includes(needle) : (s) => s.toLowerCase().includes(needle);
  }

  // ═══════════════════════════════════════════════════════════════ theme + tabs
  function restoreTheme() {
    let saved = null; try { saved = localStorage.getItem("ulm-theme"); } catch { /* ignore */ }
    const dark = saved === "dark" || (!saved && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    document.body.classList.toggle("dark", dark); els.themeToggle.textContent = dark ? "☀" : "☾";
  }
  els.themeToggle.addEventListener("click", () => {
    const dark = document.body.classList.toggle("dark"); els.themeToggle.textContent = dark ? "☀" : "☾";
    try { localStorage.setItem("ulm-theme", dark ? "dark" : "light"); } catch { /* ignore */ }
    renderChart();
  });
  function showTab(name) {
    document.querySelectorAll(".tab-button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".tab-page").forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${name}`));
    if (name === "analyze") renderChart();
  }
  document.querySelectorAll(".tab-button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  // ═══════════════════════════════════════════════════════════════ FILES TAB
  async function api(path, opts) {
    const r = await fetch(path, opts);
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r;
  }

  async function pollStatus() {
    if (window.ULM_STATIC) return; // static portfolio demo: no local engine
    if (!state.server) return;
    try {
      const st = await (await api("/api/status")).json();
      const s = st.state;
      state.scanRunning = !!s.running;
      els.rootsInfo.textContent = st.roots.join(", ");
      els.excludeInfo.textContent = st.exclude.join(" · ");
      const secs = s.started ? Math.round(((s.finished || Date.now() / 1000) - s.started)) : 0;
      els.scanTitle.textContent = s.running ? "Scanning disk…" : `Index ready — ${fmtN(st.count)} log files`;
      els.scanInfo.textContent = `${fmtN(s.dirs)} folders scanned · ${fmtN(s.found)} files found · ${fmtN(s.denied)} access denied · ${fmtN(s.cloud_only)} cloud-only skipped`
        + (secs ? ` · ${secs}s` : "") + (s.from_cache && !s.running ? " · (from cache — press Rescan to refresh)" : "")
        + (s.finished && !s.running ? ` · finished ${fmtLocal(s.finished)}` : "");
      els.scanCurrent.textContent = s.running ? s.current : "";
      els.scanBar.classList.toggle("indeterminate", !!s.running);
      els.scanBar.classList.toggle("done", !s.running);
      const now = Date.now();
      if (st.count !== state.lastCount && (!s.running || now - state.lastFetch > 5000)) {
        state.lastCount = st.count; state.lastFetch = now; await loadFileList();
      }
    } catch (err) {
      els.scanTitle.textContent = "Engine not reachable";
      els.scanInfo.textContent = "Start the tool with start.bat (python server.py). " + err.message;
    }
    setTimeout(pollStatus, state.scanRunning ? 1500 : 6000);
  }

  async function loadFileList() {
    const data = await (await api("/api/files")).json();
    state.files = data.files.map(([path, size, mtime]) => ({ path, size, mtime, name: baseName(path), dir: dirName(path), lpath: path.toLowerCase(), ext: path.slice(path.lastIndexOf(".")).toLowerCase() }));
    els.tabFilesCount.textContent = fmtN(state.files.length);
    applyFileFilters();
  }

  const LOGLIKE = /(log|trace|error|debug|audit|event|journal|history|\d{4}[-_.]?\d{2}[-_.]?\d{2})/i;
  function applyFileFilters() {
    const q = els.fileSearch.value.trim().toLowerCase();
    const ext = els.fileExt.value, age = Number(els.fileAge.value) || 0;
    const minKb = Number(els.fileMinSize.value) || 0, maxMb = Number(els.fileMaxSize.value) || 0;
    const hideEmpty = els.hideEmpty.checked, logsLike = els.logsLike.checked;
    const now = Date.now() / 1000;
    const terms = q.split(/\s+/).filter(Boolean);
    state.filesFiltered = state.files.filter((f) => {
      if (terms.length && !terms.every((t) => f.lpath.includes(t))) return false;
      if (ext && f.ext !== ext) return false;
      if (age && now - f.mtime > age) return false;
      if (minKb && f.size < minKb * 1024) return false;
      if (maxMb && f.size > maxMb * 1024 * 1024) return false;
      if (hideEmpty && f.size === 0) return false;
      if (logsLike && f.ext !== ".log" && !LOGLIKE.test(f.name)) return false;
      return true;
    });
    sortFiles(); state.filesPage = 1; renderFiles();
  }
  function sortFiles() {
    const k = state.filesSortKey, d = state.filesSortDir === "asc" ? 1 : -1;
    state.filesFiltered.sort((a, b) => (typeof a[k] === "string" ? a[k].localeCompare(b[k], undefined, { numeric: true, sensitivity: "base" }) : a[k] - b[k]) * d);
  }
  function renderFiles() {
    const list = state.filesFiltered, now = Date.now() / 1000;
    const total = list.reduce((s, f) => s + f.size, 0);
    const recent = list.filter((f) => now - f.mtime < 86400);
    const largest = list.reduce((m, f) => (!m || f.size > m.size ? f : m), null);
    const folders = new Map();
    list.forEach((f) => { const g = folders.get(f.dir) || { dir: f.dir, count: 0, size: 0, newest: 0 }; g.count++; g.size += f.size; g.newest = Math.max(g.newest, f.mtime); folders.set(f.dir, g); });
    els.fsCount.textContent = fmtN(list.length);
    els.fsCountSub.textContent = list.length === state.files.length ? "all indexed files" : `of ${fmtN(state.files.length)} indexed`;
    els.fsSize.textContent = fmtBytes(total);
    els.fsSizeSub.textContent = `${fmtN(list.filter((f) => f.ext === ".log").length)} .log · ${fmtN(list.filter((f) => f.ext === ".txt").length)} .txt`;
    els.fsRecent.textContent = fmtN(recent.length);
    els.fsRecentSub.textContent = recent.length ? `${fmtBytes(recent.reduce((s, f) => s + f.size, 0))} written today` : "no recent writes";
    els.fsLargest.textContent = largest ? fmtBytes(largest.size) : "0 B";
    els.fsLargestSub.textContent = largest ? largest.path : "—"; els.fsLargestSub.title = largest ? largest.path : "";
    els.fsFolders.textContent = fmtN(folders.size);

    const topFolders = [...folders.values()].sort((a, b) => b.count - a.count || b.size - a.size).slice(0, 10);
    els.folderSummary.innerHTML = topFolders.length ? topFolders.map((g) => `
      <div class="summary-row clickable" data-dir="${escapeHtml(g.dir)}" title="Filter by this folder">
        <strong class="ellipsis mono small" title="${escapeHtml(g.dir)}">${escapeHtml(g.dir)}</strong>
        <span>${fmtN(g.count)} files · ${fmtBytes(g.size)}</span><span>${ago(g.newest)}</span></div>`).join("")
      : '<p class="empty-state">No files match.</p>';
    els.folderSummary.querySelectorAll("[data-dir]").forEach((r) => r.addEventListener("click", () => { els.fileSearch.value = r.dataset.dir; applyFileFilters(); }));

    const newest = [...list].sort((a, b) => b.mtime - a.mtime).slice(0, 8);
    els.recentList.innerHTML = newest.length ? newest.map((f) => `
      <div class="summary-row clickable" data-path="${escapeHtml(f.path)}" title="Analyze ${escapeHtml(f.path)}">
        <strong class="ellipsis small" title="${escapeHtml(f.path)}">${escapeHtml(f.name)} <span class="muted mono">${escapeHtml(f.dir)}</span></strong>
        <span>${fmtBytes(f.size)}</span><span>${ago(f.mtime)}</span></div>`).join("") : '<p class="empty-state">No files match.</p>';
    els.recentList.querySelectorAll("[data-path]").forEach((r) => r.addEventListener("click", () => analyzePaths([r.dataset.path])));

    const pages = Math.max(1, Math.ceil(list.length / state.filesPageSize));
    if (state.filesPage > pages) state.filesPage = pages;
    const rows = list.slice((state.filesPage - 1) * state.filesPageSize, state.filesPage * state.filesPageSize);
    els.fileResultCount.textContent = `${fmtN(list.length)} files`;
    els.filesPageInfo.textContent = `Page ${state.filesPage} of ${pages}`;
    els.filesPrev.disabled = state.filesPage <= 1; els.filesNext.disabled = state.filesPage >= pages;
    els.filesTableBody.innerHTML = rows.length ? rows.map((f) => `
      <tr class="${state.selected.has(f.path) ? "selected" : ""}">
        <td><input type="checkbox" class="fsel" data-path="${escapeHtml(f.path)}" ${state.selected.has(f.path) ? "checked" : ""} /></td>
        <td><strong>${escapeHtml(f.name)}</strong></td>
        <td class="path-cell" title="${escapeHtml(f.dir)}">${escapeHtml(f.dir)}</td>
        <td>${fmtBytes(f.size)}</td>
        <td title="${fmtLocal(f.mtime)}">${fmtLocal(f.mtime)} <span class="muted small">· ${ago(f.mtime)}</span></td>
        <td><button class="details-button fan" type="button" data-path="${escapeHtml(f.path)}">Analyze</button></td>
      </tr>`).join("") : `<tr><td colspan="6" class="empty-cell">${state.scanRunning ? "Scanning disk…" : "No files match the filters."}</td></tr>`;
    els.filesTableBody.querySelectorAll(".fsel").forEach((c) => c.addEventListener("change", () => {
      c.checked ? state.selected.add(c.dataset.path) : state.selected.delete(c.dataset.path); c.closest("tr").classList.toggle("selected", c.checked); updateSelection();
    }));
    els.filesTableBody.querySelectorAll(".fan").forEach((b) => b.addEventListener("click", () => analyzePaths([b.dataset.path])));
    els.selectAllFiles.checked = rows.length > 0 && rows.every((f) => state.selected.has(f.path));
    updateSelection();
  }
  function updateSelection() { els.analyzeSelected.textContent = `Analyze selected (${fmtN(state.selected.size)})`; }

  const debFiles = debounce(applyFileFilters, 250);
  ["fileSearch", "fileMinSize", "fileMaxSize"].forEach((id) => els[id].addEventListener("input", debFiles));
  ["fileExt", "fileAge", "hideEmpty", "logsLike"].forEach((id) => els[id].addEventListener("change", applyFileFilters));
  els.resetFileFilters.addEventListener("click", () => {
    els.fileSearch.value = ""; els.fileExt.value = ""; els.fileAge.value = ""; els.fileMinSize.value = ""; els.fileMaxSize.value = "";
    els.hideEmpty.checked = true; els.logsLike.checked = false; applyFileFilters();
  });
  document.querySelectorAll("th[data-fsort]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.fsort;
    if (state.filesSortKey === k) state.filesSortDir = state.filesSortDir === "asc" ? "desc" : "asc";
    else { state.filesSortKey = k; state.filesSortDir = k === "size" || k === "mtime" ? "desc" : "asc"; }
    setIndicators("data-fsort", state.filesSortKey, state.filesSortDir); sortFiles(); renderFiles();
  }));
  els.filesPrev.addEventListener("click", () => { state.filesPage--; renderFiles(); });
  els.filesNext.addEventListener("click", () => { state.filesPage++; renderFiles(); });
  els.filesPageSize.addEventListener("change", () => { state.filesPageSize = Number(els.filesPageSize.value); state.filesPage = 1; renderFiles(); });
  els.selectAllFiles.addEventListener("change", () => {
    const rows = state.filesFiltered.slice((state.filesPage - 1) * state.filesPageSize, state.filesPage * state.filesPageSize);
    rows.forEach((f) => (els.selectAllFiles.checked ? state.selected.add(f.path) : state.selected.delete(f.path))); renderFiles();
  });
  els.clearSelection.addEventListener("click", () => { state.selected.clear(); renderFiles(); });
  els.analyzeSelected.addEventListener("click", () => {
    if (!state.selected.size) { showToast("Select one or more files first."); return; }
    analyzePaths([...state.selected]);
  });
  els.rescanButton.addEventListener("click", async () => {
    try { const r = await (await api("/api/rescan", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).json(); showToast(r.started ? "Rescan started." : "A scan is already running."); state.scanRunning = true; }
    catch (e) { showToast("Rescan failed: " + e.message); }
  });

  function setIndicators(attr, key, dir) {
    document.querySelectorAll(`th[${attr}]`).forEach((th) => {
      const ind = th.querySelector(".sort-indicator"); if (!ind) return;
      const active = th.getAttribute(attr) === key;
      ind.textContent = active ? (dir === "asc" ? "↑" : "↓") : "↕"; ind.classList.toggle("active", active);
    });
  }

  // ═══════════════════════════════════════════════════════════════ ANALYZER: loading
  async function analyzePaths(paths) {
    if (!state.server) { showToast("Disk access needs the local engine (start.bat)."); return; }
    showTab("analyze");
    const tail = els.tailSize.value;
    els.fileInfo.classList.remove("hidden");
    let done = 0, added = 0;
    for (const p of paths) {
      if (state.loaded.some((f) => f.key === p)) { done++; continue; }
      els.fileName.textContent = `Reading ${baseName(p)} (${done + 1}/${paths.length})`;
      els.fileMeta.textContent = p;
      els.progressBar.style.width = `${8 + (done / paths.length) * 90}%`;
      await new Promise((r) => setTimeout(r, 0));
      try {
        const r = await api(`/api/read?path=${encodeURIComponent(p)}${tail ? `&tail_mb=${tail}` : ""}`);
        const text = await r.text();
        added += ingest(text, { key: p, name: baseName(p), path: p, size: Number(r.headers.get("X-File-Size")) || text.length, truncated: r.headers.get("X-Truncated") === "1", source: "disk" });
      } catch (e) { showToast(`Cannot read ${baseName(p)}: ${e.message}`); }
      done++;
    }
    finishLoad(added);
  }

  async function loadLocalFiles(files) {
    const valid = [...files].filter((f) => /\.(log|txt)$/i.test(f.name) || f.type === "text/plain" || f.type === "");
    if (!valid.length) { showToast("Please choose .log or .txt files."); return; }
    els.fileInfo.classList.remove("hidden");
    let added = 0;
    for (let i = 0; i < valid.length; i++) {
      const f = valid[i];
      els.fileName.textContent = `Reading ${f.name} (${i + 1}/${valid.length})`;
      els.progressBar.style.width = `${8 + (i / valid.length) * 90}%`;
      await new Promise((r) => setTimeout(r, 0));
      const key = `local:${f.name}:${f.size}`;
      if (state.loaded.some((x) => x.key === key)) continue;
      added += ingest(await f.text(), { key, name: f.name, path: null, size: f.size, truncated: false, source: "local" });
    }
    finishLoad(added);
  }

  function ingest(text, meta) {
    const label = meta.path || meta.name;
    const res = LogParser.parse(text, label);
    res.entries.forEach((e) => { e.id = state.nextId++; });
    state.entries = state.entries.concat(res.entries);
    state.totalLines += res.lines;
    state.loaded.push({ ...meta, label, entries: res.entries.length, lines: res.lines, structured: res.structured });
    return res.entries.length;
  }

  function finishLoad(added) {
    els.progressBar.style.width = "100%";
    const size = state.loaded.reduce((s, f) => s + f.size, 0);
    els.fileName.textContent = state.loaded.length === 1 ? state.loaded[0].name : `${state.loaded.length} files loaded`;
    els.fileMeta.textContent = `${fmtBytes(size)} · ${fmtN(state.entries.length)} entries · ${fmtN(state.totalLines)} lines`;
    els.tabEntriesCount.textContent = fmtN(state.entries.length);
    renderChips(); refreshFilterOptions(); applyFilters();
    showToast(`Parsed ${fmtN(added)} entries.`);
  }

  function renderChips() {
    els.fileChips.classList.toggle("hidden", !state.loaded.length);
    els.fileChips.innerHTML = state.loaded.map((f, i) => `
      <span class="file-chip" title="${escapeHtml(f.label)}${f.truncated ? " (only the end of the file was read)" : ""}">
        <span class="file-chip-name">${escapeHtml(f.name)}</span>
        <span class="file-chip-meta">${fmtN(f.entries)} entries · ${fmtBytes(f.size)}${f.truncated ? " · tail" : ""}${f.structured ? "" : " · plain text"}</span>
        <button class="file-chip-remove" data-i="${i}" type="button" title="Remove">×</button></span>`).join("");
    els.fileChips.querySelectorAll(".file-chip-remove").forEach((b) => b.addEventListener("click", () => {
      const f = state.loaded[Number(b.dataset.i)]; if (!f) return;
      state.entries = state.entries.filter((e) => e.file !== f.label);
      state.totalLines -= f.lines; state.loaded.splice(Number(b.dataset.i), 1);
      els.tabEntriesCount.textContent = fmtN(state.entries.length);
      renderChips(); refreshFilterOptions(); applyFilters();
      if (!state.loaded.length) els.fileInfo.classList.add("hidden");
    }));
  }

  function refreshFilterOptions() {
    const keep = (sel, opts, first) => {
      const cur = sel.value;
      sel.innerHTML = `<option value="">${first}</option>` + opts.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join("");
      if (opts.some(([v]) => v === cur)) sel.value = cur;
    };
    keep(els.sourceFileFilter, state.loaded.map((f) => [f.label, f.name]), "All files");
    const count = (key) => { const m = new Map(); state.entries.forEach((e) => { if (e[key]) m.set(e[key], (m.get(e[key]) || 0) + 1); }); return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300); };
    keep(els.endpointFilter, count("ep").map(([k, c]) => [k, `${k} (${fmtN(c)})`]), "All endpoints");
    keep(els.excFilter, count("exc").map(([k, c]) => [k, `${baseName(k.replace(/\./g, "/"))} (${fmtN(c)})`]), "All");
  }

  // drop zone (same behavior as the original project)
  els.browseButton.addEventListener("click", (e) => { e.stopPropagation(); els.fileInput.click(); });
  els.dropZone.addEventListener("click", (e) => { if (e.target === els.dropZone || e.target.closest(".upload-icon")) els.fileInput.click(); });
  els.fileInput.addEventListener("change", () => { if (els.fileInput.files.length) loadLocalFiles(els.fileInput.files); els.fileInput.value = ""; });
  ["dragenter", "dragover"].forEach((n) => els.dropZone.addEventListener(n, (e) => { e.preventDefault(); els.dropZone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((n) => els.dropZone.addEventListener(n, (e) => { e.preventDefault(); els.dropZone.classList.remove("dragover"); }));
  els.dropZone.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) loadLocalFiles(e.dataTransfer.files); });
  els.clearButton.addEventListener("click", (e) => {
    e.stopPropagation();
    Object.assign(state, { entries: [], filtered: [], loaded: [], totalLines: 0, page: 1, sigFilter: null });
    els.fileInfo.classList.add("hidden"); els.tabEntriesCount.textContent = "0";
    renderChips(); refreshFilterOptions(); applyFilters(); showToast("Loaded log data cleared.");
  });

  // ═══════════════════════════════════════════════════════════════ ANALYZER: filters
  function dtInput(el) {
    if (!el.value) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(el.value);
    if (!m) return null;
    return { ts: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)), tod: +m[4] * 3600 + +m[5] * 60 + +(m[6] || 0) };
  }
  function applyFilters() {
    const match = makeMatcher(els.searchInput.value.trim(), false);
    const lv = els.levelFilter.value, file = els.sourceFileFilter.value, st = els.statusFilter.value;
    const ep = els.endpointFilter.value, exc = els.excFilter.value;
    const minD = els.minDuration.value === "" ? null : Number(els.minDuration.value);
    const from = dtInput(els.fromTime), to = dtInput(els.toTime);
    const sig = state.sigFilter;
    state.filtered = state.entries.filter((e) => {
      if (lv) { if (lv === "problems") { if (!["fatal", "error", "warn"].includes(e.level)) return false; } else if (e.level !== lv) return false; }
      if (file && e.file !== file) return false;
      if (st) {
        if (!Number.isFinite(e.status)) return false;
        if (st !== "any" && Math.floor(e.status / 100) !== Number(st[0])) return false;
      }
      if (ep && e.ep !== ep) return false;
      if (exc && e.exc !== exc) return false;
      if (sig && e.sig !== sig) return false;
      if (minD !== null && !(e.dur >= minD)) return false;
      if (from) { if (e.ts === null) return false; if (e.hasDate ? e.ts < from.ts : e.tod < from.tod) return false; }
      if (to) { if (e.ts === null) return false; if (e.hasDate ? e.ts > to.ts : e.tod > to.tod) return false; }
      if (match && !match(`${e.text} ${e.cid} ${e.file}`)) return false;
      return true;
    });
    sortEntries(); state.page = 1; renderAll();
  }
  const debApply = debounce(applyFilters, 250);
  els.searchInput.addEventListener("input", debApply);
  els.minDuration.addEventListener("input", debApply);
  ["levelFilter", "sourceFileFilter", "statusFilter", "endpointFilter", "excFilter", "fromTime", "toTime"].forEach((id) => els[id].addEventListener("change", applyFilters));
  els.maskToggle.addEventListener("change", renderAll);
  els.resetFilters.addEventListener("click", resetFilters);
  function resetFilters() {
    ["searchInput", "levelFilter", "sourceFileFilter", "statusFilter", "endpointFilter", "excFilter", "minDuration", "fromTime", "toTime"].forEach((id) => (els[id].value = ""));
    state.sigFilter = null; state.colFilters = {};
    document.querySelectorAll("input[data-cf]").forEach((i) => (i.value = ""));
    applyFilters();
  }

  function sortEntries() {
    const k = state.sortKey, d = state.sortDir === "asc" ? 1 : -1;
    const order = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
    state.filtered.sort((a, b) => {
      let l = a[k], r = b[k];
      if (k === "level") { l = order[a.level]; r = order[b.level]; }
      if (k === "ts" && l === r) return (a.id - b.id) * d;
      if (l === null || l === undefined || l === "") return 1;
      if (r === null || r === undefined || r === "") return -1;
      return (typeof l === "string" ? l.localeCompare(r, undefined, { numeric: true, sensitivity: "base" }) : l - r) * d;
    });
  }
  document.querySelectorAll("th[data-sort]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (state.sortKey === k) state.sortDir = state.sortDir === "asc" ? "desc" : "asc"; else { state.sortKey = k; state.sortDir = k === "dur" || k === "status" ? "desc" : "asc"; }
    setIndicators("data-sort", state.sortKey, state.sortDir); sortEntries(); renderTable();
  }));
  document.querySelectorAll("input[data-cf]").forEach((inp) => inp.addEventListener("input", debounce(() => { state.colFilters[inp.dataset.cf] = inp.value.trim().toLowerCase(); state.page = 1; renderTable(); }, 200)));
  function colValue(e, k) {
    if (k === "time") return fmtTs(e).toLowerCase();
    if (k === "dur") return Number.isFinite(e.dur) ? String(e.dur) : "";
    if (k === "status") return Number.isFinite(e.status) ? String(e.status) : "";
    if (k === "msg") return e.msg.toLowerCase();
    return String(e[k] ?? "").toLowerCase();
  }
  function columnFiltered() {
    const act = Object.entries(state.colFilters).filter(([, v]) => v);
    return act.length ? state.filtered.filter((e) => act.every(([k, v]) => colValue(e, k).includes(v))) : state.filtered;
  }

  // ═══════════════════════════════════════════════════════════════ ANALYZER: render
  function renderAll() { renderStats(); renderChart(); renderLevels(); renderDurations(); renderPatterns(); renderExceptions(); renderStatuses(); renderEndpoints(); renderSlowest(); renderTable(); }

  function renderStats() {
    const f = state.filtered, n = f.length;
    const errs = f.filter((e) => e.level === "error" || e.level === "fatal").length;
    const warns = f.filter((e) => e.level === "warn").length;
    const excs = f.filter((e) => e.exc); const excTypes = new Set(excs.map((e) => e.exc));
    const http = f.filter((e) => Number.isFinite(e.status));
    const ok = http.filter((e) => e.status < 400).length;
    const durs = f.map((e) => e.dur).filter(Number.isFinite).sort((a, b) => a - b);
    els.stEntries.textContent = fmtN(n);
    els.stLines.textContent = `${fmtN(state.totalLines)} lines in ${fmtN(state.loaded.length)} file(s)`;
    els.stErrors.textContent = fmtN(errs); els.stErrorRate.textContent = `${n ? fmtD((errs / n) * 100) : 0}% of entries`;
    els.stWarns.textContent = fmtN(warns); els.stWarnRate.textContent = `${n ? fmtD((warns / n) * 100) : 0}% of entries`;
    els.stExc.textContent = fmtN(excs.length); els.stExcTypes.textContent = `${fmtN(excTypes.size)} types`;
    els.stHttp.textContent = http.length ? `${fmtD((ok / http.length) * 100)}%` : "—";
    els.stHttpSub.textContent = http.length ? `${fmtN(http.length)} requests · ${fmtN(http.length - ok)} failed` : "no HTTP data";
    els.stDur.textContent = durs.length ? `${fmtD(average(durs))} / ${fmtD(percentile(durs, 95))}` : "—";
    els.stDurSub.textContent = durs.length ? `ms · max ${fmtN(durs[durs.length - 1])} ms · ${fmtN(durs.length)} timed` : "no durations";
    const timed = f.filter((e) => e.ts !== null);
    if (timed.length) {
      let mn = Infinity, mx = -Infinity; const perSec = new Map();
      timed.forEach((e) => { if (e.ts < mn) mn = e.ts; if (e.ts > mx) mx = e.ts; const s = Math.floor(e.ts / 1000); perSec.set(s, (perSec.get(s) || 0) + 1); });
      let peakS = 0, peakC = 0; perSec.forEach((c, s) => { if (c > peakC) { peakC = c; peakS = s; } });
      const sample = timed.find((e) => Math.floor(e.ts / 1000) === peakS);
      els.stPeak.textContent = `${fmtN(peakC)}/s`;
      els.stPeakTime.textContent = sample ? `at ${fmtTs({ ts: peakS * 1000, hasDate: sample.hasDate })}` : "";
      els.stPeakAvg.textContent = `Avg active: ${fmtD(timed.length / perSec.size)} /s`;
      els.stSpan.textContent = fmtSpan(mx - mn);
      els.stSpanSub.textContent = `${fmtTs({ ts: mn, hasDate: timed[0].hasDate })} → ${fmtTs({ ts: mx, hasDate: timed[0].hasDate })}`;
    } else {
      els.stPeak.textContent = "0"; els.stPeakTime.textContent = "No timestamps"; els.stPeakAvg.textContent = ""; els.stSpan.textContent = "—"; els.stSpanSub.textContent = "—";
    }
  }

  // ---- timeline chart (adapted from the original RPS chart)
  const RES = [1, 5, 10, 30, 60, 300, 900, 1800, 3600, 10800, 21600, 86400, 604800];
  function chartData() {
    const timed = state.filtered.filter((e) => e.ts !== null);
    if (!timed.length) return null;
    let mn = Infinity, mx = -Infinity; timed.forEach((e) => { if (e.ts < mn) mn = e.ts; if (e.ts > mx) mx = e.ts; });
    const span = Math.max(1, (mx - mn) / 1000);
    let res = els.resolution.value === "auto" ? RES.find((r) => span / r <= 400) || 604800 : Number(els.resolution.value);
    let note = "";
    if (span / res > 5000) { res = RES.find((r) => span / r <= 5000) || 604800; note = " (resolution raised to keep the chart readable)"; }
    const step = res * 1000, start = Math.floor(mn / step) * step;
    const count = Math.floor((mx - start) / step) + 1;
    const tot = new Array(count).fill(0), err = new Array(count).fill(0), warn = new Array(count).fill(0);
    timed.forEach((e) => { const i = Math.floor((e.ts - start) / step); tot[i]++; if (e.level === "error" || e.level === "fatal") err[i]++; else if (e.level === "warn") warn[i]++; });
    return { start, step, res, tot, err, warn, hasDate: timed[0].hasDate, note };
  }
  function labelFor(ms, hasDate, res) {
    const d = new Date(ms);
    const t = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${res < 60 ? ":" + pad(d.getUTCSeconds()) : ""}`;
    return hasDate && res >= 3600 ? `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${t}` : t;
  }
  function renderChart() {
    const canvas = els.timelineChart; if (!canvas || els["tab-analyze"].classList.contains("hidden")) return;
    const ctx = canvas.getContext("2d"), dpr = window.devicePixelRatio || 1;
    const w = canvas.parentElement.clientWidth || 800, h = 300;
    canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = w + "px"; canvas.style.height = h + "px"; ctx.scale(dpr, dpr);
    const dark = document.body.classList.contains("dark");
    const c = { bg: dark ? "#131c2d" : "#ffffff", grid: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)", text: dark ? "#9eadc7" : "#677287",
      total: dark ? "#66a2ff" : "#1769e0", fill: dark ? "rgba(102,162,255,0.12)" : "rgba(23,105,224,0.10)", err: dark ? "#ff7474" : "#c93636", warn: dark ? "#ffb85c" : "#b66a00" };
    ctx.fillStyle = c.bg; ctx.fillRect(0, 0, w, h);
    const data = chartData();
    if (!data) {
      ctx.fillStyle = c.text; ctx.font = "14px Inter, sans-serif"; ctx.textAlign = "center";
      ctx.fillText(state.entries.length ? "No timestamps in the current filter" : "No data — load log files first", w / 2, h / 2);
      els.timelineInfo.textContent = "Load log files to see the timeline"; return;
    }
    const { tot, err, warn, start, step, res, hasDate } = data, n = tot.length;
    const pl = 60, pr = 20, pt = 20, pb = 44, cw = w - pl - pr, ch = h - pt - pb;
    const maxV = Math.max(...tot, 1) * 1.15;
    let peakI = 0; tot.forEach((v, i) => { if (v > tot[peakI]) peakI = i; });
    const per = res === 1 ? "second" : res < 60 ? `${res}s` : res < 3600 ? `${res / 60} min` : res < 86400 ? `${res / 3600} h` : `${res / 86400} day`;
    els.timelineInfo.textContent = `Peak: ${fmtN(tot[peakI])} entries per ${per} at ${labelFor(start + peakI * step, hasDate, Math.min(res, 59))} · `
      + `${fmtN(err.reduce((s, v) => s + v, 0))} errors · ${fmtN(warn.reduce((s, v) => s + v, 0))} warnings${data.note}`;
    ctx.strokeStyle = c.grid; ctx.lineWidth = 1; ctx.font = "11px Inter, sans-serif"; ctx.fillStyle = c.text; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let i = 0; i <= 5; i++) { const y = pt + ch - (i / 5) * ch; ctx.beginPath(); ctx.moveTo(pl, y); ctx.lineTo(w - pr, y); ctx.stroke(); ctx.fillText(fmtD((maxV / 5) * i), pl - 8, y); }
    const xOf = (i) => pl + (i / (n - 1 || 1)) * cw, yOf = (v) => pt + ch - (v / maxV) * ch;
    const every = Math.max(1, Math.floor(n / 10));
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.font = "10px Inter, sans-serif";
    for (let i = 0; i < n; i += every) { ctx.fillStyle = c.text; ctx.fillText(labelFor(start + i * step, hasDate, res), xOf(i), pt + ch + 8); }
    function series(arr, color, fill, lw) {
      if (n === 1) { ctx.fillStyle = color; ctx.fillRect(xOf(0) - 3, yOf(arr[0]), 6, pt + ch - yOf(arr[0])); return; }
      ctx.beginPath(); arr.forEach((v, i) => (i ? ctx.lineTo(xOf(i), yOf(v)) : ctx.moveTo(xOf(i), yOf(v))));
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke();
      if (fill) { ctx.lineTo(xOf(n - 1), pt + ch); ctx.lineTo(pl, pt + ch); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); }
    }
    series(tot, c.total, c.fill, 2.2); series(warn, c.warn, null, 1.5); series(err, c.err, null, 1.8);
    const px = xOf(peakI), py = yOf(tot[peakI]);
    ctx.setLineDash([4, 4]); ctx.strokeStyle = c.err; ctx.beginPath(); ctx.moveTo(px, pt); ctx.lineTo(px, pt + ch); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fillStyle = c.total; ctx.fill();

    let tip = document.getElementById("rpsTooltip");
    if (!tip) { tip = document.createElement("div"); tip.id = "rpsTooltip"; tip.className = "rps-tooltip"; document.body.appendChild(tip); }
    canvas.onmousemove = (ev) => {
      const r = canvas.getBoundingClientRect(), mx = ev.clientX - r.left;
      if (mx < pl || mx > pl + cw) { tip.style.opacity = "0"; return; }
      const i = Math.min(n - 1, Math.max(0, Math.round(((mx - pl) / cw) * (n - 1))));
      tip.innerHTML = `<strong>${labelFor(start + i * step, hasDate, Math.min(res, 59))}</strong><br/>Entries: <b>${fmtN(tot[i])}</b><br/>Errors: <b>${fmtN(err[i])}</b><br/>Warnings: <b>${fmtN(warn[i])}</b><br/><span style="opacity:.7">click to zoom to this interval</span>`;
      tip.style.opacity = "1"; tip.style.left = ev.clientX + 14 + "px"; tip.style.top = ev.clientY - 10 + "px";
    };
    canvas.onmouseleave = () => (tip.style.opacity = "0");
    canvas.onclick = (ev) => {
      const r = canvas.getBoundingClientRect(), mx = ev.clientX - r.left; if (mx < pl || mx > pl + cw) return;
      const i = Math.min(n - 1, Math.max(0, Math.round(((mx - pl) / cw) * (n - 1))));
      const a = new Date(start + i * step), b = new Date(start + (i + 1) * step - 1000);
      const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
      els.fromTime.value = iso(a); els.toTime.value = iso(b); applyFilters(); showToast("Zoomed to the selected interval (Reset filters to go back).");
    };
  }
  els.resolution.addEventListener("change", renderChart);
  window.addEventListener("resize", debounce(renderChart, 200));

  function bucketRows(rows, total, cls) {
    const max = Math.max(...rows.map((r) => r.count), 1);
    return rows.map((r) => `<div class="bucket-row${r.click ? " clickable" : ""}" ${r.click ? `data-click="${escapeHtml(r.click)}"` : ""}>
      <span class="bucket-label">${escapeHtml(r.label)}</span><div class="bucket-track"><div class="bucket-fill ${cls ? cls(r) : ""}" style="width:${(r.count / max) * 100}%"></div></div>
      <span class="bucket-value">${fmtN(r.count)} (${fmtD(total ? (r.count / total) * 100 : 0)}%)</span></div>`).join("");
  }
  function renderLevels() {
    const f = state.filtered;
    if (!f.length) { els.levelBuckets.innerHTML = '<p class="empty-state">No data.</p>'; return; }
    const rows = ["fatal", "error", "warn", "info", "debug", "trace"].map((lv) => ({ label: lv.toUpperCase(), count: f.filter((e) => e.level === lv).length, lv, click: lv })).filter((r) => r.count);
    els.levelBuckets.innerHTML = bucketRows(rows, f.length, (r) => `lv-${r.lv}`);
    els.levelBuckets.querySelectorAll("[data-click]").forEach((r) => r.addEventListener("click", () => { els.levelFilter.value = r.dataset.click; applyFilters(); }));
  }
  function renderDurations() {
    const d = state.filtered.map((e) => e.dur).filter(Number.isFinite);
    if (!d.length) { els.durationBuckets.innerHTML = '<p class="empty-state">No durations in the current filter.</p>'; return; }
    const b = [["≤ 10 ms", (v) => v <= 10], ["11–50 ms", (v) => v > 10 && v <= 50], ["51–100 ms", (v) => v > 50 && v <= 100], ["101–500 ms", (v) => v > 100 && v <= 500],
      ["501 ms–1 s", (v) => v > 500 && v <= 1000], ["1–5 s", (v) => v > 1000 && v <= 5000], ["> 5 s", (v) => v > 5000]];
    els.durationBuckets.innerHTML = bucketRows(b.map(([label, t]) => ({ label, count: d.filter(t).length })), d.length);
  }
  function renderPatterns() {
    const groups = new Map();
    state.filtered.forEach((e) => {
      if (e.level !== "error" && e.level !== "fatal") return;
      const g = groups.get(e.sig) || { sig: e.sig, count: 0, first: null, last: null, files: new Set(), sample: e, hasDate: e.hasDate };
      g.count++; g.files.add(e.file);
      if (e.ts !== null) { if (g.first === null || e.ts < g.first) g.first = e.ts; if (g.last === null || e.ts > g.last) g.last = e.ts; }
      groups.set(e.sig, g);
    });
    const top = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 15);
    els.patternList.innerHTML = (state.sigFilter ? `<div class="summary-row clickable" id="clearSig"><strong>Pattern filter active</strong><span>show all</span><span>×</span></div>` : "")
      + (top.length ? top.map((g) => `<div class="pattern-row" data-sig="${escapeHtml(g.sig)}" title="Show only this pattern">
        <span class="pattern-count">${fmtN(g.count)}</span>
        <div><div class="pattern-text">${escapeHtml(mask(g.sig))}</div>
        <div class="pattern-meta">${g.first !== null ? `${escapeHtml(fmtTs({ ts: g.first, hasDate: g.hasDate }))} → ${escapeHtml(fmtTs({ ts: g.last, hasDate: g.hasDate }))} · ` : ""}${g.files.size} file(s)${g.sample.exc ? ` · ${escapeHtml(g.sample.exc)}` : ""}</div></div></div>`).join("")
        : '<p class="empty-state">No errors in the current filter 🎉</p>');
    els.patternList.querySelectorAll("[data-sig]").forEach((r) => r.addEventListener("click", () => { state.sigFilter = r.dataset.sig; applyFilters(); }));
    const cs = document.getElementById("clearSig"); if (cs) cs.addEventListener("click", () => { state.sigFilter = null; applyFilters(); });
  }
  function renderExceptions() {
    const m = new Map(); state.filtered.forEach((e) => { if (e.exc) m.set(e.exc, (m.get(e.exc) || 0) + 1); });
    const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    els.excList.innerHTML = top.length ? top.map(([k, c]) => `<div class="summary-row clickable" data-exc="${escapeHtml(k)}"><strong class="ellipsis mono small" title="${escapeHtml(k)}">${escapeHtml(k)}</strong><span>${fmtN(c)}</span><span>filter</span></div>`).join("")
      : '<p class="empty-state">No exceptions.</p>';
    els.excList.querySelectorAll("[data-exc]").forEach((r) => r.addEventListener("click", () => { els.excFilter.value = r.dataset.exc; applyFilters(); }));
  }
  function renderStatuses() {
    const http = state.filtered.filter((e) => Number.isFinite(e.status));
    if (!http.length) { els.statusList.innerHTML = '<p class="empty-state">No HTTP data.</p>'; return; }
    const m = new Map(); http.forEach((e) => m.set(e.status, (m.get(e.status) || 0) + 1));
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([s, c]) => ({ label: String(s), count: c, s }));
    els.statusList.innerHTML = bucketRows(rows, http.length, (r) => `s${Math.floor(r.s / 100)}`);
  }
  function renderEndpoints() {
    const g = new Map();
    state.filtered.forEach((e) => {
      if (!e.ep) return;
      const x = g.get(e.ep) || { ep: e.ep, count: 0, durs: [], errs: 0 };
      x.count++; if (Number.isFinite(e.dur)) x.durs.push(e.dur); if (e.status >= 500 || e.level === "error" || e.level === "fatal") x.errs++;
      g.set(e.ep, x);
    });
    const rows = [...g.values()].map((x) => { x.durs.sort((a, b) => a - b); return { ...x, avg: x.durs.length ? average(x.durs) : null, p95: x.durs.length ? percentile(x.durs, 95) : null, max: x.durs.length ? x.durs[x.durs.length - 1] : null, errRate: (x.errs / x.count) * 100 }; });
    const k = state.epSortKey, d = state.epSortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => (typeof a[k] === "string" ? a[k].localeCompare(b[k]) : (a[k] ?? -1) - (b[k] ?? -1)) * d);
    els.endpointBody.innerHTML = rows.length ? rows.slice(0, 100).map((x) => `<tr>
      <td class="path-cell" title="${escapeHtml(x.ep)}"><span class="badge primary">${escapeHtml(x.ep.split(" ")[0])}</span> ${escapeHtml(x.ep.split(" ").slice(1).join(" "))}</td>
      <td>${fmtN(x.count)}</td><td class="${durClass(x.avg)}">${fmtDur(x.avg)}</td><td class="${durClass(x.p95)}">${fmtDur(x.p95)}</td><td class="${durClass(x.max)}">${fmtDur(x.max)}</td>
      <td>${x.errs ? `<span class="badge danger">${fmtD(x.errRate)}%</span>` : '<span class="badge success">0%</span>'}</td>
      <td><button class="details-button epf" type="button" data-ep="${escapeHtml(x.ep)}">Filter</button></td></tr>`).join("")
      : '<tr><td colspan="7" class="empty-cell">No HTTP requests detected in the current filter.</td></tr>';
    els.endpointBody.querySelectorAll(".epf").forEach((b) => b.addEventListener("click", () => { els.endpointFilter.value = b.dataset.ep; applyFilters(); }));
  }
  document.querySelectorAll("th[data-esort]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.esort; if (state.epSortKey === k) state.epSortDir = state.epSortDir === "asc" ? "desc" : "asc"; else { state.epSortKey = k; state.epSortDir = k === "ep" ? "asc" : "desc"; }
    setIndicators("data-esort", state.epSortKey, state.epSortDir); renderEndpoints();
  }));

  function renderSlowest() {
    const top = state.filtered.filter((e) => Number.isFinite(e.dur)).sort((a, b) => b.dur - a.dur).slice(0, Number(els.topCount.value));
    els.slowestBody.innerHTML = top.length ? top.map((e, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(fmtTs(e))}</td><td class="${durClass(e.dur)}">${fmtDur(e.dur)}</td>
      <td>${levelBadge(e)}</td><td>${statusBadge(e.status)}</td><td class="msg-cell" title="${escapeHtml(mask(e.msg))}">${escapeHtml(mask(e.ep || e.msg))}</td>
      <td><span class="correlation-id" title="${escapeHtml(e.cid)}">${escapeHtml(e.cid || "—")}</span></td>
      <td><span class="source-file-cell" title="${escapeHtml(e.file)}">${escapeHtml(baseName(e.file))}</span></td>
      <td><button class="details-button" type="button" data-id="${e.id}">Details</button></td></tr>`).join("")
      : '<tr><td colspan="9" class="empty-cell">No durations detected in the current filter.</td></tr>';
    els.slowestBody.querySelectorAll("[data-id]").forEach((b) => b.addEventListener("click", () => openDetails(Number(b.dataset.id))));
  }
  els.topCount.addEventListener("change", renderSlowest);

  function renderTable() {
    const rows = columnFiltered(), pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
    if (state.page > pages) state.page = pages;
    const page = rows.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
    els.resultCount.textContent = `${fmtN(rows.length)} entries` + (state.sigFilter ? " · pattern filter active" : "");
    els.pageInfo.textContent = `Page ${state.page} of ${pages}`;
    els.previousPage.disabled = state.page <= 1; els.nextPage.disabled = state.page >= pages;
    els.entriesBody.innerHTML = page.length ? page.map((e) => `<tr class="${e.level === "error" || e.level === "fatal" ? "row-error" : e.level === "warn" ? "row-warn" : ""}">
      <td>${escapeHtml(fmtTs(e))}</td><td>${levelBadge(e)}</td>
      <td class="msg-cell" title="${escapeHtml(mask(e.msg).slice(0, 500))}">${e.text.includes("\n") ? "⤵ " : ""}${escapeHtml(mask(e.msg).slice(0, 400))}</td>
      <td class="${durClass(e.dur)}">${fmtDur(e.dur)}</td><td>${statusBadge(e.status)}</td>
      <td><span class="correlation-id" title="${escapeHtml(e.cid)}">${escapeHtml(e.cid || "—")}</span></td>
      <td><span class="source-file-cell" title="${escapeHtml(e.file)}:${e.line}">${escapeHtml(baseName(e.file))}:${e.line}</span></td>
      <td><button class="details-button" type="button" data-id="${e.id}">Details</button></td></tr>`).join("")
      : `<tr><td colspan="8" class="empty-cell">${state.entries.length ? "No entries match the current filters." : "Choose log files to start analyzing."}</td></tr>`;
    els.entriesBody.querySelectorAll("[data-id]").forEach((b) => b.addEventListener("click", () => openDetails(Number(b.dataset.id))));
  }
  els.previousPage.addEventListener("click", () => { state.page--; renderTable(); });
  els.nextPage.addEventListener("click", () => { state.page++; renderTable(); });
  els.pageSize.addEventListener("change", () => { state.pageSize = Number(els.pageSize.value); state.page = 1; renderTable(); });

  // ═══════════════════════════════════════════════════════════════ details dialog
  const card = (l, v) => `<div class="detail-card"><span>${escapeHtml(l)}</span><strong>${escapeHtml(v === null || v === undefined || v === "" ? "—" : v)}</strong></div>`;
  function openDetails(id) {
    const e = state.entries.find((x) => x.id === id); if (!e) return;
    const loadedFile = state.loaded.find((f) => f.label === e.file);
    els.dialogEyebrow.textContent = "ENTRY DETAILS";
    els.dialogTitle.textContent = `${(e.level || "").toUpperCase()} • ${fmtTs(e)}`;
    const same = e.cid ? state.entries.filter((x) => x.cid === e.cid).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.id - b.id).slice(0, 300) : [];
    els.dialogContent.innerHTML = `
      <div class="details-grid">${card("Time", fmtTs(e))}${card("Level", (e.level || "") + (e.lvInf ? " (inferred)" : ""))}${card("File", `${e.file}:${e.line}`)}
        ${card("Correlation ID", e.cid)}${card("HTTP", e.method ? `${e.method} ${e.path} ${e.status ?? ""}` : (e.status ?? ""))}${card("Duration", fmtDur(e.dur))}${card("Exception", e.exc)}</div>
      <div class="dialog-actions">
        ${e.cid ? `<button class="button secondary" id="dlgCid" type="button">Filter by this correlation ID</button>` : ""}
        <button class="button ghost" id="dlgSig" type="button">Show same error pattern</button>
        ${loadedFile && loadedFile.source === "disk" ? `<button class="button ghost" id="dlgCtx" type="button">Show surrounding lines in file</button>` : ""}
        ${e.cid ? `<button class="button ghost" id="dlgGlobal" type="button">Search this ID in all logs</button>` : ""}
        <button class="button ghost" id="dlgCopy" type="button">Copy entry</button>
      </div>
      <h3>Full entry</h3><pre class="log-line">${escapeHtml(mask(e.text))}</pre>
      <div id="dlgContext"></div>
      ${same.length > 1 ? `<h3>Same correlation ID (${same.length} entries)</h3><div class="log-lines">${same.map((x) =>
        `<div class="log-line"${x.id === e.id ? ' style="border-left-color: var(--warning)"' : ""}><strong>${escapeHtml(fmtTs(x))}</strong> • ${escapeHtml((x.level || "").toUpperCase())}${Number.isFinite(x.dur) ? ` • ${fmtN(x.dur)} ms` : ""} • ${escapeHtml(baseName(x.file))}:${x.line}\n${escapeHtml(mask(x.msg))}</div>`).join("")}</div>` : ""}`;
    const on = (sel, fn) => { const b = document.getElementById(sel); if (b) b.addEventListener("click", fn); };
    on("dlgCid", () => { els.searchInput.value = e.cid; els.detailsDialog.close(); applyFilters(); });
    on("dlgSig", () => { state.sigFilter = e.sig; els.detailsDialog.close(); applyFilters(); });
    on("dlgCopy", async () => { await copyText(e.text); showToast("Entry copied."); });
    on("dlgGlobal", () => { els.detailsDialog.close(); els.gSearch.value = e.cid; els.gScope.value = "all"; showTab("search"); runGlobalSearch(); });
    on("dlgCtx", () => showContext(e.file, e.line, document.getElementById("dlgContext")));
    els.detailsDialog.showModal();
  }
  async function showContext(path, line, host) {
    host.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const d = await (await api(`/api/context?path=${encodeURIComponent(path)}&line=${line}&n=25`)).json();
      host.innerHTML = `<h3>${escapeHtml(baseName(path))} — lines ${d.start}–${d.start + d.lines.length - 1}</h3><div class="context-box">${d.lines.map((l, i) =>
        `<div class="context-line${d.start + i === line ? " hit" : ""}"><span class="ln">${d.start + i}</span><span>${escapeHtml(mask(l))}</span></div>`).join("")}</div>`;
      const hit = host.querySelector(".hit"); if (hit) hit.scrollIntoView({ block: "center" });
    } catch (err) { host.innerHTML = `<p class="muted">Cannot load context: ${escapeHtml(err.message)}</p>`; }
  }
  els.closeDialog.addEventListener("click", () => els.detailsDialog.close());
  els.detailsDialog.addEventListener("click", (ev) => { if (ev.target === els.detailsDialog) els.detailsDialog.close(); });

  // ═══════════════════════════════════════════════════════════════ export / copy
  els.exportCsvButton.addEventListener("click", () => {
    const rows = columnFiltered(); if (!rows.length) { showToast("There are no filtered entries to export."); return; }
    const head = ["time", "level", "level_inferred", "file", "line", "correlation_id", "method", "path", "endpoint", "http_status", "duration_ms", "exception", "message"];
    const csv = [head, ...rows.map((e) => [fmtTs(e), e.level, e.lvInf, e.file, e.line, e.cid, e.method, e.path, e.ep, e.status ?? "", e.dur ?? "", e.exc, mask(e.text)])]
      .map((r) => r.map(csvEscape).join(",")).join("\n");
    download(csv, `${state.loaded.length === 1 ? state.loaded[0].name.replace(/\.[^.]+$/, "") : "logs-combined"}-filtered.csv`);
    showToast(`Exported ${fmtN(rows.length)} entries.`);
  });
  els.copyIdsButton.addEventListener("click", async () => {
    const ids = [...new Set(columnFiltered().map((e) => e.cid).filter(Boolean))];
    if (!ids.length) { showToast("There are no correlation IDs to copy."); return; }
    await copyText(ids.join("\n")); showToast(`Copied ${fmtN(ids.length)} correlation IDs.`);
  });

  // ═══════════════════════════════════════════════════════════════ GLOBAL SEARCH
  async function runGlobalSearch() {
    const q = els.gSearch.value.trim();
    if (!q) { showToast("Type something to search."); return; }
    if (!state.server) { showToast("Global search needs the local engine (start.bat)."); return; }
    const scope = els.gScope.value;
    let paths = null;
    if (scope === "filtered") paths = state.filesFiltered.map((f) => f.path);
    if (scope === "loaded") paths = state.loaded.filter((f) => f.source === "disk").map((f) => f.path);
    if (paths && !paths.length) { showToast("No files in this scope."); return; }
    els.gInfo.textContent = `Searching ${paths ? fmtN(paths.length) : "all"} files…`;
    els.gGo.disabled = true;
    const t0 = performance.now();
    try {
      const r = await (await api("/api/search", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q, regex: els.gRegex.checked, case: els.gCase.checked, paths, max: Number(els.gMax.value) }) })).json();
      if (r.error) { els.gInfo.textContent = r.error; return; }
      state.search = { results: r.results, fileFilter: null, q };
      els.gInfo.textContent = `Scanned ${fmtN(r.scanned)} of ${fmtN(r.total_files)} files in ${fmtD((performance.now() - t0) / 1000)} s`
        + (r.skipped_large ? ` · ${fmtN(r.skipped_large)} very large files skipped` : "") + (r.errors ? ` · ${fmtN(r.errors)} unreadable` : "")
        + (r.timed_out ? " · stopped at the time limit (narrow the scope)" : "") + (r.truncated ? " · result limit reached" : "");
      renderSearch();
    } catch (e) { els.gInfo.textContent = "Search failed: " + e.message; }
    finally { els.gGo.disabled = false; }
  }
  function highlighter() {
    const q = state.search.q || "";
    try { return new RegExp(els.gRegex.checked ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), els.gCase.checked ? "g" : "gi"); } catch { return null; }
  }
  function renderSearch() {
    const all = state.search.results, ff = state.search.fileFilter;
    const byFile = new Map(); all.forEach((r) => byFile.set(r[0], (byFile.get(r[0]) || 0) + 1));
    els.gFiles.innerHTML = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([p, c]) =>
      `<span class="file-chip result${ff === p ? " selected" : ""}" data-p="${escapeHtml(p)}" title="${escapeHtml(p)}"><span class="file-chip-name">${escapeHtml(baseName(p))}</span><span class="file-chip-meta">${fmtN(c)} hits</span></span>`).join("")
      + (ff ? `<span class="file-chip result" data-p=""><span class="file-chip-name">Show all files</span></span>` : "");
    els.gFiles.querySelectorAll("[data-p]").forEach((c) => c.addEventListener("click", () => { state.search.fileFilter = c.dataset.p || null; renderSearch(); }));
    const rows = (ff ? all.filter((r) => r[0] === ff) : all).slice(0, 2000);
    els.gCount.textContent = `${fmtN(all.length)} matches in ${fmtN(byFile.size)} files`;
    const hl = highlighter();
    els.gBody.innerHTML = rows.length ? rows.map((r, i) => {
      let txt = escapeHtml(mask(r[2]));
      if (hl) { const raw = mask(r[2]); let out = "", last = 0; hl.lastIndex = 0; let m; let guard = 0;
        while ((m = hl.exec(raw)) && guard++ < 50) { if (!m[0]) { hl.lastIndex++; continue; } out += escapeHtml(raw.slice(last, m.index)) + `<mark>${escapeHtml(m[0])}</mark>`; last = m.index + m[0].length; }
        txt = out + escapeHtml(raw.slice(last)); }
      return `<tr><td class="path-cell" title="${escapeHtml(r[0])}">${escapeHtml(r[0])}</td><td>${r[1]}</td><td class="msg-cell" style="max-width:760px" title="${escapeHtml(mask(r[2]).slice(0, 500))}">${txt}</td>
        <td><button class="details-button gctx" type="button" data-i="${i}">Context</button> <button class="details-button gan" type="button" data-p="${escapeHtml(r[0])}">Analyze</button></td></tr>`;
    }).join("") : '<tr><td colspan="4" class="empty-cell">No matches.</td></tr>';
    els.gBody.querySelectorAll(".gctx").forEach((b) => b.addEventListener("click", () => {
      const r = rows[Number(b.dataset.i)];
      els.dialogEyebrow.textContent = "SEARCH MATCH"; els.dialogTitle.textContent = `${baseName(r[0])} : ${r[1]}`;
      els.dialogContent.innerHTML = `<p class="muted mono small">${escapeHtml(r[0])}</p><div id="gCtxHost"></div>`;
      els.detailsDialog.showModal(); showContext(r[0], r[1], document.getElementById("gCtxHost"));
    }));
    els.gBody.querySelectorAll(".gan").forEach((b) => b.addEventListener("click", () => analyzePaths([b.dataset.p])));
  }
  els.gGo.addEventListener("click", runGlobalSearch);
  els.gSearch.addEventListener("keydown", (e) => { if (e.key === "Enter") runGlobalSearch(); });
  els.gAnalyze.addEventListener("click", () => {
    const files = [...new Set(state.search.results.map((r) => r[0]))].slice(0, 30);
    if (!files.length) { showToast("No matches to analyze."); return; }
    analyzePaths(files).then(() => { els.searchInput.value = state.search.q || ""; applyFilters(); });
  });
  els.gExport.addEventListener("click", () => {
    if (!state.search.results.length) { showToast("No results to export."); return; }
    download([["file", "line", "text"], ...state.search.results].map((r) => r.map((v, i) => csvEscape(i === 2 ? mask(v) : v)).join(",")).join("\n"), "log-search-results.csv");
  });

  // ═══════════════════════════════════════════════════════════════ init
  restoreTheme();
  renderAll();
  if (state.server) {
    pollStatus();
    const deep = new URLSearchParams(location.search).getAll("analyze");   // ?analyze=C:\path\file.log
    if (deep.length) analyzePaths(deep);
  } else {
    els.scanTitle.textContent = "Opened as a file — disk scan disabled";
    els.scanInfo.textContent = "Run start.bat to index the disk. You can still drop files in the Analyzer tab.";
    showTab("analyze");
  }
  window.ULM = { loadLocalFiles, showTab };
})();
