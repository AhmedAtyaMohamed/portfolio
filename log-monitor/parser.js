/* Universal log parser: works with almost any text log.
 * Detects timestamps (ISO, D/M/Y, M/D/Y, 11-Nov-2026, syslog, time-only with AM/PM), levels
 * (log4net, NLog, Serilog [INF], ASP.NET "fail:", JSON/CLEF), multi-line entries (stack traces),
 * exceptions, HTTP method/path/status, durations, correlation IDs, and IIS/W3C "#Fields" logs.
 * Also keeps full compatibility with the Etisalat API format:
 *   03:27:08.373 PM : [correlation-id] 5ms Total POST /EtisalatAPIService/login 200
 */
(function (root) {
  "use strict";

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const MON = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*";
  const FRAC = "(?:[.,](\\d{1,7}))?";
  const CUR_YEAR = new Date().getFullYear();

  function mk(y, mo, d, h, mi, s, frac, ampm) {
    if (ampm) {
      const p = ampm.toUpperCase();
      if (p === "AM" && h === 12) h = 0;
      if (p === "PM" && h !== 12) h += 12;
    }
    if (h > 23 || mi > 59 || s > 60) return null;
    const ms = frac ? Number((frac + "00").slice(0, 3)) : 0;
    const tod = h * 3600 + mi * 60 + s + ms / 1000;
    if (y === null && mo === null) return { hasDate: false, tod, ts: null };
    if (y === null) y = CUR_YEAR;
    if (mo < 0 || mo > 11 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
    return { hasDate: true, tod, ts: Date.UTC(y, mo, d, h, mi, s, ms) };
  }

  const TS = [
    { re: new RegExp("^\\s*\\[?(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})[T ]+(\\d{1,2}):(\\d{2}):(\\d{2})" + FRAC + "(?:\\s*(?:Z|[+-]\\d{2}:?\\d{2}))?(?:\\s*(AM|PM))?\\]?", "i"),
      f: (m) => mk(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7], m[8]) },
    { re: new RegExp("^\\s*\\[?(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{4})[ T,]+(\\d{1,2}):(\\d{2}):(\\d{2})" + FRAC + "(?:\\s*(AM|PM))?\\]?", "i"),
      f: (m) => {
        const a = +m[1], b = +m[2];
        let day, mon;
        if (a > 12) { day = a; mon = b; } else if (b > 12) { mon = a; day = b; } else if (m[8]) { mon = a; day = b; } else { day = a; mon = b; }
        return mk(+m[3], mon - 1, day, +m[4], +m[5], +m[6], m[7], m[8]);
      } },
    { re: new RegExp("^\\s*\\[?(\\d{1,2})[- /]" + MON + "[- /](\\d{4})[ :T]+(\\d{1,2}):(\\d{2}):(\\d{2})" + FRAC + "\\]?", "i"),
      f: (m) => mk(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1], +m[4], +m[5], +m[6], m[7]) },
    { re: new RegExp("^\\s*\\[?(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\\s+)?" + MON + "\\s+(\\d{1,2}),?\\s+(?:(\\d{4})\\s+)?(\\d{1,2}):(\\d{2}):(\\d{2})" + FRAC + "(?:\\s*(AM|PM))?\\]?", "i"),
      f: (m) => mk(m[3] ? +m[3] : null, MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2], +m[4], +m[5], +m[6], m[7], m[8]) },
    { re: new RegExp("^\\s*\\[?(\\d{1,2}):(\\d{2}):(\\d{2})" + FRAC + "(?:\\s*(AM|PM))?\\]?", "i"),
      f: (m) => mk(null, null, null, +m[1], +m[2], +m[3], m[4], m[5]) },
  ];
  const TS_ANY = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,7}))?/;

  function matchTs(line) {
    for (const p of TS) {
      const m = p.re.exec(line);
      if (m) {
        const t = p.f(m);
        if (t) { t.len = m[0].length; return t; }
      }
    }
    return null;
  }

  const LEVEL_MAP = {
    fatal: "fatal", critical: "fatal", crit: "fatal", emergency: "fatal", alert: "fatal", ftl: "fatal",
    error: "error", err: "error", eror: "error", severe: "error", fail: "error",
    warning: "warn", warn: "warn", wrn: "warn",
    notice: "info", information: "info", info: "info", inf: "info",
    debug: "debug", dbg: "debug", dbug: "debug",
    trace: "trace", trc: "trace", trce: "trace", verbose: "trace", vrb: "trace",
  };
  const LEVEL_UP = /(?:^|[\s\[|:(<{"'=])(FATAL|CRITICAL|CRIT|EMERGENCY|ALERT|ERROR|ERR|EROR|SEVERE|WARNING|WARN|WRN|NOTICE|INFORMATION|INFO|INF|DEBUG|DBG|TRACE|TRC|VERBOSE|VRB|FTL)(?=$|[\s\]|:)>},"'=-])/;
  const LEVEL_BR = /[\[<](Fatal|Critical|Error|Warning|Warn|Information|Info|Debug|Trace|Verbose)[\]>]/i;
  const LEVEL_ASP = /^\s*(info|warn|fail|crit|dbug|trce):/;
  const LEVEL_KV = /\b(?:level|severity|lvl)["']?\s*[:=]\s*["']?([A-Za-z]+)/i;

  function detectLevel(head) {
    const h = head.slice(0, 140);
    let m = LEVEL_ASP.exec(h) || LEVEL_UP.exec(h) || LEVEL_BR.exec(h) || LEVEL_KV.exec(h);
    if (!m) return null;
    return LEVEL_MAP[m[1].toLowerCase()] || null;
  }

  const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const CID_KV = /(?:correlation[-_ ]?id|request[-_ ]?id|trace[-_ ]?id|traceidentifier|x-request-id|corr[-_]?id|operation[-_ ]?id)["'\s:=]+["']?([\w:.\-]{6,})/i;
  const BRACKET_ID = /^\s*[:|\-]?\s*\[([^\]\s]{6,})\]/;
  const HTTP_RE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+["']?((?:https?:\/\/[^\s"']+)|\/[^\s"']*)/;
  const STATUS_AFTER = /^[^\n]{0,90}?(?:\s|"|responded\s+|-\s+|status(?:code)?[:= ]+)([1-5]\d{2})(?=\b|$)/i;
  const STATUS_KV = /\b(?:status(?:\s*code)?|statuscode|http\s*status|sc-status|response\s*code)["'\s:=]+([1-5]\d{2})\b/i;
  const DUR_MS = /(?:^|[\s(\[=:,])(\d+(?:\.\d+)?)\s*(ms|msec|milliseconds)\b/i;
  const DUR_KW = /\b(?:in|took|elapsed(?:ms)?|duration(?:ms)?|time-taken|executiontime)["'\s:=]+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds)?\b/i;
  const EXC_RE = /\b((?:[A-Za-z_][\w]*\.)*[A-Z]\w*(?:Exception|Error))\b(?=[:\s(]|$)/;
  const STACK_RE = /^\s+at\s+[\w.<>`$]+[.(]|^\s*Traceback \(most recent|^\s+--- End of|^\s+File ".*", line \d+/;
  const ERRWORD = /\b(?:exception|error|failed|failure|fatal|unhandled|timeout|timed out|refused|denied)\b/i;
  const WARNWORD = /\b(?:warn|warning|deprecated|retry|retrying)\b/i;

  function normPath(p) {
    let s = p.replace(/^https?:\/\/[^/]+/i, "").split("?")[0].split("#")[0];
    s = s.replace(GUID, "{id}").replace(/\/\d+(?=\/|$)/g, "/{n}").replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, "/{id}");
    return s.toLowerCase() || "/";
  }

  function signature(s) {
    return s.slice(0, 400)
      .replace(new RegExp(GUID.source, "gi"), "<guid>")
      .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "<email>")
      .replace(/https?:\/\/[^\s"']+/g, (u) => u.split("?")[0])
      .replace(/"[^"]{0,300}"/g, '"…"').replace(/'[^']{0,300}'/g, "'…'")
      .replace(/\{[^{}]*\}/g, "{…}").replace(/\[[^\[\]]{12,}\]/g, "[…]")
      .replace(/\b0x[0-9a-f]+\b/gi, "<hex>").replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
      .replace(/\d+(?:[.,:]\d+)*/g, "<n>")
      .replace(/\s+/g, " ").trim().slice(0, 180);
  }

  function makeEntry(file, lineNo, t, head, raw) {
    return {
      id: 0, file, line: lineNo, ts: t ? t.ts : null, tod: t ? t.tod : null, hasDate: !!(t && t.hasDate),
      level: null, lvInf: false, msg: head, extra: null, method: "", path: "", ep: "", status: null,
      dur: null, cid: "", exc: "", sig: "", raw,
    };
  }

  function applyHead(e, head) {
    e.level = detectLevel(head);
    const kv = CID_KV.exec(head);
    const br = BRACKET_ID.exec(head);
    if (kv) e.cid = kv[1];
    else if (br && (br[1].includes("-") || /[0-9a-f]{8}/i.test(br[1])) && !LEVEL_MAP[br[1].toLowerCase()]) e.cid = br[1];
    else { const g = GUID.exec(head); if (g) e.cid = g[0]; }
    const h = HTTP_RE.exec(head);
    if (h) {
      e.method = h[1]; e.path = h[2]; e.ep = `${h[1]} ${normPath(h[2])}`;
      const rest = head.slice(h.index + h[0].length);
      const st = STATUS_AFTER.exec(rest) || STATUS_KV.exec(head);
      if (st) e.status = Number(st[1]);
    } else {
      const st = STATUS_KV.exec(head);
      if (st) e.status = Number(st[1]);
    }
    let d = DUR_MS.exec(head);
    if (d) e.dur = Number(d[1]);
    else if ((d = DUR_KW.exec(head))) {
      const unit = (d[2] || "ms").toLowerCase();
      e.dur = Number(d[1]) * (unit.startsWith("s") ? 1000 : 1);
    }
  }

  function stripPrefix(line, t) {
    let head = t ? line.slice(t.len) : line;
    return head.replace(/^\s*[:|\-,]?\s*/, "");
  }

  function fromJson(obj, file, lineNo, raw) {
    const tsv = obj["@t"] ?? obj.timestamp ?? obj.Timestamp ?? obj.time ?? obj.ts ?? obj["@timestamp"] ?? obj.date ?? obj.TimeStamp;
    let t = null;
    if (typeof tsv === "string" || typeof tsv === "number") {
      const ms = typeof tsv === "number" ? (tsv < 1e12 ? tsv * 1000 : tsv) : Date.parse(tsv);
      if (Number.isFinite(ms)) { const d = new Date(ms); t = { ts: ms, hasDate: true, tod: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds() }; }
    }
    const msg = String(obj["@m"] ?? obj.message ?? obj.Message ?? obj.msg ?? obj["@mt"] ?? obj.MessageTemplate ?? JSON.stringify(obj).slice(0, 400));
    const e = makeEntry(file, lineNo, t, msg, raw);
    applyHead(e, msg);
    const lv = obj["@l"] ?? obj.level ?? obj.Level ?? obj.severity ?? obj.lvl ?? (obj["@t"] ? "information" : null);
    if (lv) e.level = LEVEL_MAP[String(lv).toLowerCase()] || e.level;
    const ex = obj["@x"] ?? obj.exception ?? obj.Exception ?? obj.error;
    if (ex) e.extra = [typeof ex === "string" ? ex : JSON.stringify(ex)];
    e.cid = String(obj.CorrelationId ?? obj.correlationId ?? obj.RequestId ?? obj.requestId ?? obj.TraceId ?? obj.traceId ?? e.cid ?? "");
    const method = obj.RequestMethod ?? obj.method ?? obj.Method;
    const path = obj.RequestPath ?? obj.path ?? obj.Path ?? obj.url;
    if (method && path) { e.method = String(method).toUpperCase(); e.path = String(path); e.ep = `${e.method} ${normPath(e.path)}`; }
    const sc = obj.StatusCode ?? obj.statusCode ?? obj.status;
    if (Number.isFinite(Number(sc)) && Number(sc) >= 100 && Number(sc) < 600) e.status = Number(sc);
    const el = obj.Elapsed ?? obj.elapsed ?? obj.ElapsedMilliseconds ?? obj.duration ?? obj.durationMs;
    if (Number.isFinite(Number(el))) e.dur = Number(el);
    return e;
  }

  function fromW3C(fields, tok, file, lineNo, raw) {
    const g = (n) => { const i = fields.indexOf(n); return i >= 0 && tok[i] !== "-" ? tok[i] : ""; };
    const date = g("date"), time = g("time");
    const t = date && time ? matchTs(`${date} ${time}`) : (time ? matchTs(time) : null);
    const method = g("cs-method"), uri = g("cs-uri-stem"), status = Number(g("sc-status")) || null;
    const e = makeEntry(file, lineNo, t, `${method} ${uri}${g("cs-uri-query") ? "?" + g("cs-uri-query") : ""} ${status ?? ""} ${g("c-ip")}`.trim(), raw);
    e.method = method; e.path = uri; e.ep = method ? `${method} ${normPath(uri)}` : "";
    e.status = status;
    const tt = Number(g("time-taken"));
    e.dur = Number.isFinite(tt) && g("time-taken") ? tt : null;
    e.level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    return e;
  }

  function finalize(e) {
    const full = e.extra ? e.msg + "\n" + e.extra.join("\n") : e.msg;
    const ex = EXC_RE.exec(full);
    if (ex) e.exc = ex[1];
    if (!e.level) {
      e.lvInf = true;
      if (e.status >= 500 || e.exc || (e.extra && e.extra.some((l) => STACK_RE.test(l))) || ERRWORD.test(e.msg)) e.level = "error";
      else if (e.status >= 400 || WARNWORD.test(e.msg)) e.level = "warn";
      else e.level = "info";
    }
    e.sig = signature((e.exc && !e.msg.includes(e.exc) ? e.exc + ": " : "") + e.msg);
    if (e.msg.length > 2000) e.msg = e.msg.slice(0, 2000) + " …";
    e.text = full.length > 20000 ? full.slice(0, 20000) + "\n…(truncated)" : full;
    delete e.extra;
    delete e.raw;
    return e;
  }

  /** Parse a whole file. Returns {entries, lines, structured}. */
  function parse(text, file) {
    const lines = text.split(/\r?\n/);
    let tsCount = 0, nonEmpty = 0;
    for (let i = 0; i < lines.length && nonEmpty < 400; i++) {
      const l = lines[i];
      if (!l.trim()) continue;
      nonEmpty++;
      if (matchTs(l) || (l.trimStart()[0] === "{" && l.trimEnd().endsWith("}")) || l.startsWith("#Fields:") || LEVEL_ASP.test(l)) tsCount++;
    }
    const structured = nonEmpty > 0 && tsCount >= Math.max(2, nonEmpty * 0.05);
    const entries = [];
    let cur = null, fields = null, dayOffset = 0, lastTod = null, lastDated = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      if (line.startsWith("#Fields:")) { fields = line.slice(8).trim().split(/\s+/); continue; }
      if (line[0] === "#" && (fields || /^#(Software|Version|Date|Remark|Start-Date|End-Date):/.test(line))) continue;
      if (fields) {
        const tok = line.trim().split(/\s+/);
        if (tok.length === fields.length) { cur = fromW3C(fields, tok, file, i + 1, line); entries.push(cur); continue; }
      }
      const tl = line.trimStart();
      if (tl[0] === "{" && tl.length < 50000 && line.trimEnd().endsWith("}")) {
        try { const obj = JSON.parse(tl); if (obj && typeof obj === "object") { cur = fromJson(obj, file, i + 1, line); entries.push(cur); continue; } } catch (_) { /* not JSON */ }
      }
      let t = matchTs(line);
      if (!t && structured && TS_ANY.test(line.slice(0, 80)) && !STACK_RE.test(line)) {
        const m = TS_ANY.exec(line.slice(0, 80));
        t = mk(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7]);
        if (t) t.len = 0;
      }
      const isStart = !!t || !structured || LEVEL_ASP.test(line) || /^\[?(FATAL|ERROR|WARN|WARNING|INFO|DEBUG)\b/.test(line);
      if (!isStart && cur) {
        if (!cur.extra) cur.extra = [];
        if (cur.extra.length < 400) cur.extra.push(line);
        continue;
      }
      if (t && !t.hasDate) {
        if (lastTod !== null && t.tod < lastTod - 43200) dayOffset++;     // midnight rollover
        lastTod = t.tod;
        t.ts = (lastDated !== null ? Date.UTC(new Date(lastDated).getUTCFullYear(), new Date(lastDated).getUTCMonth(), new Date(lastDated).getUTCDate()) : 0)
          + dayOffset * 86400000 + Math.round(t.tod * 1000);
      } else if (t && t.hasDate) {
        lastDated = t.ts;
      }
      const head = stripPrefix(line, t);
      cur = makeEntry(file, i + 1, t, head, line);
      applyHead(cur, head);
      entries.push(cur);
    }
    entries.forEach(finalize);
    return { entries, lines: lines.length, structured };
  }

  const api = { parse, signature, matchTs, normPath };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LogParser = api;
})(typeof window !== "undefined" ? window : globalThis);
