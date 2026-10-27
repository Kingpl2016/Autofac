// 场景:运行内置场景或自己编写的 YAML,查看时间线与进度。

import { badge, h, render, setText } from "../dom.js";
import { fmtDuration, fmtNumber, scenarioProgress } from "../format.js";
import { S } from "../strings.js";

const T = S.scenarios;

/** 时间线表格(事件时刻 + 描述)。 */
function timelineTable(timeline) {
  if (!timeline || timeline.length === 0) return h("p", { class: "muted" }, T.noTimeline);
  return h("div", { class: "table-wrap" },
    h("table", {},
      h("caption", { class: "sr-only" }, T.timeline),
      h("thead", {}, h("tr", {}, h("th", { scope: "col", class: "num" }, "时刻(秒)"), h("th", { scope: "col" }, "动作"))),
      h("tbody", {}, timeline.map((e) => h("tr", {}, h("td", { class: "num" }, fmtNumber(e.at, 1)), h("td", {}, e.text))))));
}

export function mount(root, ctx) {
  let running = false;
  const runButtons = [];

  // ---------------------------------------------------------------- 运行状态
  const refs = {
    title: h("h3", {}, T.status),
    state: h("p"),
    meter: h("div", { class: "meter", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": "场景进度" }, h("span")),
    detail: h("p", { class: "muted" }),
    errors: h("ul", { class: "warnings" }),
    log: h("pre", { class: "scenario-log", tabindex: 0, "aria-label": "场景日志" }),
    stop: h("button", { type: "button", class: "danger", onclick: () => stopScenario() }, T.stop),
  };

  async function stopScenario() {
    try {
      await ctx.api.post("/api/scenarios/stop");
      await ctx.live.refresh();
      ctx.toast("场景已停止");
    } catch (error) {
      ctx.toast(error.message, "error");
    }
  }

  async function run(body, errorTarget = null) {
    if (errorTarget) errorTarget.textContent = "";
    try {
      await ctx.api.post("/api/scenarios/run", body);
      await ctx.live.refresh();
      ctx.toast(T.started);
    } catch (error) {
      if (errorTarget) errorTarget.textContent = error.message;
      else ctx.toast(error.message, "error");
    }
  }

  function updateStatus() {
    const stats = ctx.live.stats;
    if (!stats) return;
    const sc = stats.state.scenario;
    running = Boolean(sc.running);
    for (const b of runButtons) b.disabled = running;
    refs.stop.disabled = !running;

    if (!sc.name) {
      render(refs.state, badge(S.overview.idle, ""));
      setText(refs.detail, T.noRun);
      refs.meter.classList.add("hidden");
      refs.errors.replaceChildren();
      setText(refs.log, "");
      return;
    }
    render(refs.state,
      `${sc.name} `,
      sc.running ? badge(T.running, "ok") : sc.error ? badge(T.failed, "bad") : badge(T.finished, ""));
    const ratio = scenarioProgress(sc);
    refs.meter.classList.toggle("hidden", ratio === null);
    if (ratio !== null) {
      refs.meter.firstChild.style.width = `${(ratio * 100).toFixed(1)}%`;
      refs.meter.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    }
    setText(refs.detail,
      `已运行 ${fmtDuration(sc.elapsed)}${sc.end_time ? ` / ${fmtDuration(sc.end_time)}` : ""};事件 ${sc.events_applied} / ${sc.events_total}`);
    const problems = (sc.errors || []).map((e) => `${fmtNumber(e.at, 1)} 秒 ${e.description}:${e.error}`);
    if (sc.error) problems.unshift(sc.error);
    render(refs.errors, problems.map((t) => h("li", {}, t)));
    const text = (sc.log || []).join("\n");
    if (refs.log.textContent !== text) {
      const stick = refs.log.scrollTop + refs.log.clientHeight >= refs.log.scrollHeight - 8;
      refs.log.textContent = text;
      if (stick) refs.log.scrollTop = refs.log.scrollHeight;
    }
  }

  // ---------------------------------------------------------------- 内置场景
  const builtinBox = h("div", { class: "grid" });
  const builtinState = h("p", { class: "muted" }, S.common.loading);
  const editor = h("textarea", { id: "sc-yaml", spellcheck: "false", rows: 16, "aria-describedby": "sc-yaml-hint" });
  const editorResult = h("div", { "aria-live": "polite" });
  const editorError = h("p", { class: "error-text", role: "alert" });

  function runButton(label, handler) {
    const button = h("button", { type: "button", class: "primary", onclick: handler }, label);
    runButtons.push(button);
    button.disabled = running;
    return button;
  }

  function drawBuiltin(list) {
    builtinState.classList.add("hidden");
    render(builtinBox, list.map((item) => {
      if (item.error) {
        return h("section", { class: "card" }, h("h3", {}, item.name), h("p", { class: "error-text" }, item.error));
      }
      const load = h("button", { type: "button", onclick: () => {
        editor.value = item.yaml;
        editorResult.replaceChildren();
        editor.scrollIntoView({ block: "center" });
        editor.focus();
        ctx.toast(`已载入 ${item.name},可以修改后运行`);
      } }, T.loadToEditor);
      return h("section", { class: "card" },
        h("h3", {}, item.title || item.name),
        h("p", { class: "muted" }, item.description || item.summary),
        h("p", { class: "hint" }, item.summary),
        h("p", { class: "hint" }, `${T.sources}:${item.sources.join("、") || "无"};${T.nodes}:${item.nodes.join("、") || "无"}`),
        h("details", {}, h("summary", {}, `${T.timeline}(${item.timeline.length})`), timelineTable(item.timeline)),
        h("div", { class: "toolbar", style: "margin-top:8px" },
          runButton(T.run, () => run({ name: item.name })),
          load));
    }));
  }

  async function loadBuiltin() {
    try {
      drawBuiltin(await ctx.api.get("/api/scenarios"));
    } catch (error) {
      setText(builtinState, error.message);
    }
  }

  // ---------------------------------------------------------------- 自定义 YAML
  async function validate() {
    editorError.textContent = "";
    editorResult.replaceChildren();
    if (!editor.value.trim()) {
      editorError.textContent = T.emptyYaml;
      return;
    }
    try {
      const result = await ctx.api.post("/api/scenarios/validate", { yaml: editor.value });
      if (!result.ok) {
        editorError.textContent = result.error;
        return;
      }
      render(editorResult,
        h("div", { class: "notice ok", role: "status" }, `${T.valid}:${result.summary}`),
        timelineTable(result.timeline));
    } catch (error) {
      editorError.textContent = error.message;
    }
  }

  render(
    root,
    h("h2", {}, T.title),
    h("section", { class: "card", "aria-live": "polite" },
      refs.title, refs.state, refs.meter, refs.detail, refs.errors, refs.log,
      h("div", { class: "toolbar", style: "margin-top:8px" }, refs.stop)),
    h("h3", { style: "margin-top:20px" }, T.builtin),
    builtinState,
    builtinBox,
    h("h3", { style: "margin-top:20px" }, T.custom),
    h("div", { class: "field" },
      h("label", { for: "sc-yaml" }, T.yamlLabel),
      h("p", { class: "hint", id: "sc-yaml-hint" }, T.yamlHint),
      editor),
    editorError,
    h("div", { class: "toolbar" },
      h("button", { type: "button", onclick: validate }, T.validate),
      runButton(T.run, () => run({ yaml: editor.value }, editorError))),
    editorResult,
  );
  updateStatus();
  loadBuiltin().then(updateStatus);
  return { unmount: ctx.live.subscribe(updateStatus) };
}
