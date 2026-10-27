// 抓包分析:数据流统计(丢包/乱序/抖动/趋势)与包日志。

import { openInfoDialog } from "../dialog.js";
import { badge, field, h, render, setText, syncKeyed } from "../dom.js";
import { fmtMs, fmtNumber, logQuery, toInt } from "../format.js";
import { createSpark, drawSpark } from "../spark.js";
import { streamKey } from "../store.js";
import { S } from "../strings.js";

const T = S.capture;
const LOG_POLL_MS = 1000;
const LOG_MAX_ROWS = 300;
const PROTOCOL_TEXT = { artnet: "Art-Net", sacn: "sACN", unknown: "未知" };

const COLUMNS = [
  ["protocol", ""], ["universe", "num"], ["source", ""], ["priority", "num"], ["state", ""],
  ["packets", "num"], ["pps", "num"], ["lost", "num"], ["ooo", "num"], ["dup", "num"], ["resets", "num"],
  ["mean", "num"], ["stddev", "num"], ["p99", "num"], ["max", "num"], ["ppsTrend", ""], ["jitterTrend", ""], ["actions", ""],
];

export function mount(root, ctx) {
  // ---------------------------------------------------------------- 数据流表
  const streamBody = h("tbody");
  const streamTable = h("table", {},
    h("caption", { class: "sr-only" }, T.streams),
    h("thead", {}, h("tr", {}, COLUMNS.map(([key, cls]) => h("th", { scope: "col", class: cls }, T.cols[key])))),
    streamBody);
  const streamEmpty = h("p", { class: "empty" }, T.noStreams);
  const stoppedNotice = h("div", { class: "notice warn hidden", role: "status" }, T.stopped);
  const totals = h("p", { class: "muted" });

  function createStreamRow(stream) {
    const cells = Array.from({ length: COLUMNS.length }, () => h("td"));
    const ppsSpark = createSpark("发包速率趋势");
    const jitterSpark = createSpark("间隔抖动趋势");
    cells[COLUMNS.length - 3] = h("td", {}, ppsSpark);
    cells[COLUMNS.length - 2] = h("td", {}, jitterSpark);
    const monitor = h("button", { type: "button", class: "small", onclick: () => {
      ctx.navigate("monitor", { protocol: stream.protocol, universe: stream.universe });
    } }, S.sources.monitor);
    cells[COLUMNS.length - 1] = h("td", {}, monitor);
    cells[0].className = "nowrap";
    const tr = h("tr", {}, ...cells);
    tr._cells = cells;
    tr._ppsSpark = ppsSpark;
    tr._jitterSpark = jitterSpark;
    tr._monitor = monitor;
    return tr;
  }

  function updateStreamRow(tr, s) {
    const c = tr._cells;
    const sourceText = s.protocol === "sacn" ? `${s.source_name || s.cid.slice(0, 8)} (${s.src_ip})` : s.src_ip;
    setText(c[0], PROTOCOL_TEXT[s.protocol] || s.protocol);
    setText(c[1], s.universe);
    setText(c[2], sourceText);
    setText(c[3], s.priority === null || s.priority === undefined ? "-" : s.priority);
    render(c[4],
      s.terminated ? badge(T.terminated, "") : s.active ? badge(T.active, "ok") : badge(T.silent, "warn"),
      s.preview ? [" ", badge(T.preview, "")] : null);
    setText(c[5], s.packets);
    setText(c[6], fmtNumber(s.pps, 1));
    setText(c[7], s.lost);
    setText(c[8], s.out_of_order);
    setText(c[9], s.duplicates);
    setText(c[10], s.resets);
    setText(c[11], fmtMs(s.interval_mean_ms));
    setText(c[12], fmtMs(s.interval_stddev_ms));
    setText(c[13], fmtMs(s.interval_p99_ms));
    setText(c[14], fmtMs(s.interval_max_ms));
    for (const [i, [, cls]] of COLUMNS.entries()) if (cls && i < c.length) c[i].className = cls;
    const history = ctx.live.history.get(streamKey(s)) || [];
    drawSpark(tr._ppsSpark, history.map((p) => p.pps), { floor: 1, label: `发包速率趋势,当前 ${fmtNumber(s.pps, 1)} 包/秒` });
    drawSpark(tr._jitterSpark, history.map((p) => p.jitter), { floor: 0.5, label: `间隔抖动趋势,当前 ${fmtMs(s.interval_stddev_ms)}` });
    tr._monitor.setAttribute("aria-label", `监看 ${PROTOCOL_TEXT[s.protocol]} ${s.universe}`);
  }

  // ---------------------------------------------------------------- 包日志
  const logBody = h("tbody");
  const logEmpty = h("p", { class: "empty" }, T.logEmpty);
  const logInfo = h("p", { class: "muted" });
  const protocolSel = h("select", { id: "log-proto" },
    [["", "全部"], ["artnet", "Art-Net"], ["sacn", "sACN"]].map(([v, label]) => h("option", { value: v }, label)));
  const universeIn = h("input", { type: "number", id: "log-uni", min: 0, max: 63999, step: 1 });
  const srcIn = h("input", { type: "text", id: "log-src", size: 16, placeholder: "如 192.168.1.20" });
  const filterError = h("p", { class: "error-text", role: "alert" });
  const pauseBtn = h("button", { type: "button", onclick: () => togglePause() }, T.pauseLog);
  let lastNumber = 0;
  let logPaused = false;
  let polling = false;
  let timer = null;
  let gone = false;

  function readFilter() {
    filterError.textContent = "";
    let universe = "";
    if (universeIn.value !== "") {
      const n = toInt(universeIn.value, 0, 63999);
      if (n === null) {
        filterError.textContent = "Universe 必须是 0~63999 的整数";
        return null;
      }
      universe = n;
    }
    return { protocol: protocolSel.value, universe, srcIp: srcIn.value.trim() };
  }

  async function showDetail(number) {
    try {
      const detail = await ctx.api.get(`/api/capture/log/${number}`);
      openInfoDialog(`${T.packet} #${detail.number}`, h("div", {},
        h("p", {}, `${PROTOCOL_TEXT[detail.protocol] || detail.protocol} · ${detail.kind} · 来自 ${detail.src}`),
        h("div", { class: "table-wrap" },
          h("table", {},
            h("caption", { class: "sr-only" }, "报文字段"),
            h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "字段"), h("th", { scope: "col" }, "值"))),
            h("tbody", {}, detail.fields.map((f) => h("tr", {}, h("th", { scope: "row" }, f.name), h("td", {}, String(f.value))))))),
        h("h3", { style: "margin-top:12px" }, "原始字节(前 700 字节)"),
        h("pre", { class: "hex", tabindex: 0 }, detail.hex)));
    } catch (error) {
      ctx.toast(error.message, "error");
    }
  }

  function addLogRow(p) {
    const open = h("button", { type: "button", class: "small", onclick: () => showDetail(p.number) }, String(p.number));
    open.setAttribute("aria-label", `查看第 ${p.number} 个包的详情`);
    const tr = h("tr", {},
      h("td", { class: "num" }, open),
      h("td", { class: "num" }, p.t.toFixed(3)),
      h("td", {}, p.src),
      h("td", {}, PROTOCOL_TEXT[p.protocol] || p.protocol),
      h("td", { class: "num" }, p.universe === null || p.universe === undefined ? "-" : String(p.universe)),
      h("td", { class: "num" }, String(p.length)),
      h("td", {}, p.summary));
    logBody.insertBefore(tr, logBody.firstChild); // 最新的在最上面
  }

  async function pollLog(reset = false) {
    if (polling || gone) return;
    const filter = readFilter();
    if (!filter) return;
    polling = true;
    try {
      if (reset) {
        lastNumber = 0;
        logBody.replaceChildren();
      }
      const result = await ctx.api.get(`/api/capture/log?${logQuery({ after: lastNumber, limit: 200, ...filter })}`);
      if (gone) return;
      for (const p of result.packets) {
        addLogRow(p);
        lastNumber = Math.max(lastNumber, p.number);
      }
      // 即使过滤后没有新包,也要把游标推进到总数,避免下次重复扫描
      if (result.packets.length === 0 && result.total > lastNumber && !filter.protocol && filter.universe === "" && !filter.srcIp) {
        lastNumber = result.total;
      }
      while (logBody.children.length > LOG_MAX_ROWS) logBody.lastChild.remove();
      logPaused = result.paused;
      pauseBtn.textContent = logPaused ? T.resumeLog : T.pauseLog;
      setText(logInfo, `${T.logTotal} ${result.total} 个,界面保留最近 ${LOG_MAX_ROWS} 条${logPaused ? ";记录已暂停" : ""}`);
      logEmpty.classList.toggle("hidden", logBody.children.length > 0);
      logTable.classList.toggle("hidden", logBody.children.length === 0);
    } catch (error) {
      setText(logInfo, error.message);
    } finally {
      polling = false;
    }
  }

  async function togglePause() {
    try {
      await ctx.api.post("/api/capture/log/pause", { paused: !logPaused });
      await pollLog();
    } catch (error) {
      ctx.toast(error.message, "error");
    }
  }

  async function clearAll() {
    try {
      await ctx.api.post("/api/capture/clear");
      lastNumber = 0;
      logBody.replaceChildren();
      await ctx.live.refresh();
      await pollLog(true);
      ctx.toast(T.cleared);
    } catch (error) {
      ctx.toast(error.message, "error");
    }
  }

  const logTable = h("table", { class: "hidden" },
    h("caption", { class: "sr-only" }, T.logTitle),
    h("thead", {}, h("tr", {}, T.logCols.map((label, i) => h("th", { scope: "col", class: [0, 1, 4, 5].includes(i) ? "num" : "" }, label)))),
    logBody);

  // ---------------------------------------------------------------- 更新
  function update() {
    const stats = ctx.live.stats;
    if (!stats) return;
    const { state, capture } = stats;
    const streams = capture.streams || [];
    syncKeyed(streamBody, streams, streamKey, createStreamRow, updateStreamRow);
    streamEmpty.classList.toggle("hidden", streams.length > 0);
    streamTable.parentElement.classList.toggle("hidden", streams.length === 0);
    stoppedNotice.classList.toggle("hidden", state.capture.running);
    const kinds = Object.entries(capture.totals.kinds || {}).map(([k, v]) => `${k}: ${v}`).join(",");
    setText(totals, `${T.totals}:${kinds || "无"}${capture.totals.unknown ? `;无法识别 ${capture.totals.unknown}` : ""}${capture.totals.dropped_streams ? `;超出跟踪上限而忽略的数据流 ${capture.totals.dropped_streams}` : ""}`);
  }

  const form = h("form", {
    class: "filters",
    onsubmit: (event) => {
      event.preventDefault();
      pollLog(true);
    },
  },
    h("div", { class: "form-grid" },
      field("协议", protocolSel),
      field("Universe", universeIn, "留空为全部"),
      field("来源 IP", srcIn, "留空为全部")),
    filterError,
    h("div", { class: "toolbar" },
      h("button", { type: "submit" }, T.applyFilter), pauseBtn));

  render(
    root,
    h("h2", {}, T.title),
    stoppedNotice,
    h("div", { class: "toolbar" },
      h("button", { type: "button", class: "danger", onclick: clearAll }, T.clear)),
    totals,
    streamEmpty,
    h("div", { class: "table-wrap" }, streamTable),
    h("h3", { style: "margin-top:20px" }, T.logTitle),
    form,
    logInfo,
    logEmpty,
    h("div", { class: "table-wrap log-wrap" }, logTable),
  );
  update();
  pollLog(true);
  timer = setInterval(() => pollLog(), LOG_POLL_MS);
  const unsubscribe = ctx.live.subscribe(update);
  return {
    unmount() {
      gone = true;
      clearInterval(timer);
      unsubscribe();
    },
  };
}
