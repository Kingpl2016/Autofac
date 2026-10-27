// 总览:运行状态、发送负载、抓包控制、告警。

import { badge, field, h, render, setText } from "../dom.js";
import { compactRanges, fmtDuration, fmtMs, fmtNumber, parseRanges } from "../format.js";
import { loadMeta } from "../store.js";
import { S } from "../strings.js";

export function mount(root, ctx) {
  const T = S.overview;
  const refs = {};
  let meta = null;

  const kv = (name) => {
    const dd = h("dd", {}, "-");
    refs[name] = dd;
    return dd;
  };

  // ---- 抓包控制表单 ----
  const ifaceSelect = h("select", { id: "cap-iface" });
  const artnetBox = h("input", { type: "checkbox", id: "cap-artnet", checked: true });
  const sacnBox = h("input", { type: "checkbox", id: "cap-sacn", checked: true });
  const universesInput = h("input", { type: "text", id: "cap-universes", placeholder: "1-8", size: 16 });
  const formError = h("p", { class: "error-text", role: "alert" });

  async function startCapture() {
    formError.textContent = "";
    let universes = [];
    if (universesInput.value.trim()) {
      try {
        universes = parseRanges(universesInput.value, 1, 63999);
      } catch (error) {
        formError.textContent = error.message;
        return;
      }
    }
    try {
      await ctx.api.post("/api/capture/start", {
        artnet: artnetBox.checked,
        sacn: sacnBox.checked,
        interface: ifaceSelect.value || null,
        universes,
      });
      await ctx.live.refresh();
      ctx.toast("抓包已开始");
    } catch (error) {
      formError.textContent = error.message;
    }
  }

  async function stopCapture() {
    try {
      await ctx.api.post("/api/capture/stop");
      await ctx.live.refresh();
      ctx.toast("抓包已停止");
    } catch (error) {
      ctx.toast(error.message, "error");
    }
  }

  refs.startBtn = h("button", { type: "button", class: "primary", onclick: startCapture }, T.start);
  refs.stopBtn = h("button", { type: "button", onclick: stopCapture }, T.stop);

  const warnings = h("ul", { class: "warnings" });
  refs.warnings = warnings;
  refs.warningsBox = h("section", { class: "notice warn hidden", "aria-label": T.warnings },
    h("strong", {}, `${T.warnings}:`), warnings);
  refs.meter = h("div", { class: "meter", role: "img", "aria-label": "发包速率占上限的比例" }, h("span"));

  render(
    root,
    h("h2", {}, T.title),
    refs.warningsBox,
    h("div", { class: "grid" },
      h("section", { class: "card" },
        h("h3", {}, T.run),
        h("dl", { class: "kv" },
          h("dt", {}, T.version), kv("version"),
          h("dt", {}, T.uptime), kv("uptime"),
          h("dt", {}, T.mode), kv("mode"),
          h("dt", {}, T.auth), kv("auth"))),
      h("section", { class: "card" },
        h("h3", {}, T.send),
        h("dl", { class: "kv" },
          h("dt", {}, T.sources), kv("sources"),
          h("dt", {}, T.pps), kv("pps")),
        refs.meter,
        h("dl", { class: "kv", style: "margin-top:8px" },
          h("dt", {}, T.sched), kv("sched"),
          h("dt", {}, T.skipped), kv("skipped")),
        h("p", { class: "hint" }, T.schedHint)),
      h("section", { class: "card" },
        h("h3", {}, T.capture),
        h("dl", { class: "kv" },
          h("dt", {}, T.captureState), kv("capState"),
          h("dt", {}, T.iface), kv("capIface"),
          h("dt", {}, "sACN"), kv("capSacn")),
        h("hr"),
        h("div", { class: "field" }, h("label", { for: "cap-iface" }, T.ifaceLabel), ifaceSelect),
        h("div", { class: "field inline" }, artnetBox, h("label", { for: "cap-artnet" }, "监听 Art-Net")),
        h("div", { class: "field inline" }, sacnBox, h("label", { for: "cap-sacn" }, "监听 sACN")),
        field(T.sacnUniverses, universesInput, T.sacnHint),
        formError,
        h("div", { class: "toolbar" }, refs.startBtn, refs.stopBtn)),
      h("section", { class: "card" },
        h("h3", {}, T.others),
        h("dl", { class: "kv" },
          h("dt", {}, T.nodes), kv("nodes"),
          h("dt", {}, T.recording), kv("recording"),
          h("dt", {}, T.scenario), kv("scenario")))),
  );

  function fillInterfaces() {
    if (!meta) return;
    render(
      ifaceSelect,
      h("option", { value: "" }, S.common.auto),
      meta.interfaces
        .filter((i) => i.usable || i.loopback)
        .map((i) =>
          h("option", { value: i.ip }, `${i.name}  ${i.ip}${i.virtual ? "(虚拟)" : ""}${i.default ? "  ★默认" : ""}`)),
    );
  }

  function update() {
    const stats = ctx.live.stats;
    if (!stats) return;
    const { state } = stats;
    const settings = state.settings;
    setText(refs.version, state.version);
    setText(refs.uptime, fmtDuration(state.uptime_s));
    setText(refs.mode, settings.lan ? S.overview.modeLan : S.overview.modeLocal);
    setText(refs.auth, settings.auth_required ? S.common.yes : S.common.no);

    const running = state.sources.filter((s) => s.state === "running").length;
    setText(refs.sources, `${state.sources.length} 个(运行中 ${running})`);
    setText(refs.pps, `${fmtNumber(settings.current_pps, 0)} / ${settings.max_pps} 包/秒`);
    const ratio = Math.min(1, settings.current_pps / settings.max_pps);
    refs.meter.firstChild.style.width = `${(ratio * 100).toFixed(1)}%`;
    refs.meter.classList.toggle("hot", ratio > 0.8);
    const sched = state.scheduler;
    setText(refs.sched, `${fmtMs(sched.late_p50_ms, 3)} / ${fmtMs(sched.late_p99_ms, 3)} / ${fmtMs(sched.late_max_ms, 3)}`);
    setText(refs.skipped, String(sched.skipped));

    const cap = state.capture;
    render(refs.capState, badge(cap.running ? S.overview.captureRunning : S.overview.captureStopped, cap.running ? "ok" : "warn"));
    setText(refs.capIface, cap.interface ? `${cap.interface} (${cap.interface_ip})` : "-");
    setText(refs.capSacn, cap.sacn ? `已订阅 Universe: ${compactRanges(cap.sacn_universes) || "无"}` : "未启用");
    refs.startBtn.textContent = cap.running ? S.overview.restart : S.overview.start;
    refs.stopBtn.disabled = !cap.running;

    const nodes = state.nodes.nodes;
    setText(refs.nodes, `${nodes.length} 个(在线 ${nodes.filter((n) => n.online).length})`);
    const rec = state.recording;
    setText(refs.recording, rec.recording ? `录制中:${rec.file}(${rec.frames} 帧)` : S.overview.idle);
    const sc = state.scenario;
    setText(refs.scenario, sc.running ? `运行中:${sc.name}(${fmtDuration(sc.elapsed)})` : sc.name ? `上次:${sc.name}` : S.overview.idle);

    const items = [];
    if (cap.error) items.push(cap.error);
    for (const text of cap.join_failures || []) items.push(`sACN 组播加入失败:${text}`);
    if (cap.artnet_port_shared) items.push("Art-Net 端口已被其他程序占用:发往本机的单播只会送给先绑定的一方,广播和组播不受影响。");
    if (cap.sacn_port_shared) items.push("sACN 端口已被其他程序占用:同上。");
    for (const text of state.nodes.warnings || []) items.push(text);
    if (sched.late_p99_ms > 5) items.push("调度迟到偏大(p99 超过 5 ms):系统可能过载,发包时间会不准。");
    if (sched.skipped > 0) items.push(`调度器已因卡顿丢弃 ${sched.skipped} 帧。`);
    render(refs.warnings, items.map((t) => h("li", {}, t)));
    refs.warningsBox.classList.toggle("hidden", items.length === 0);
  }

  const unsubscribe = ctx.live.subscribe(update);
  loadMeta().then((m) => {
    meta = m;
    fillInterfaces();
  }).catch((error) => ctx.toast(error.message, "error"));
  update();
  return { unmount: unsubscribe };
}
