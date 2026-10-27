// 发送源列表:创建、修改、暂停/恢复/冻结/停止。

import { badge, h, render, setText, syncKeyed } from "../dom.js";
import { compactRanges, fmtNumber } from "../format.js";
import { S } from "../strings.js";
import { openSourceDialog } from "./sourceform.js";

const T = S.sources;

const STATE_BADGE = {
  running: ["运行中", "ok"],
  paused: ["静默停发", "warn"],
  stopped: ["已停止", ""],
};

export function mount(root, ctx) {
  const tbody = h("tbody");
  const empty = h("p", { class: "empty" }, T.empty);

  async function run(action, errorPrefix) {
    try {
      await action();
      await ctx.live.refresh();
    } catch (error) {
      ctx.toast(`${errorPrefix}:${error.message}`, "error");
    }
  }

  const sourceAction = (id, action, extra = {}) =>
    run(() => ctx.api.post(`/api/sources/${encodeURIComponent(id)}/action`, { action, ...extra }), "操作失败");

  async function edit(id) {
    try {
      const full = await ctx.api.get(`/api/sources/${encodeURIComponent(id)}`);
      await openSourceDialog(ctx, full, () => ctx.live.refresh());
    } catch (error) {
      ctx.toast(error.message, "error");
    }
  }

  function createRow(source) {
    const id = source.id;
    const refs = {};
    const btn = (text, handler, cls = "small") => h("button", { type: "button", class: cls, onclick: handler }, text);
    refs.pause = btn(T.pause, () => sourceAction(id, refs.pause.dataset.next));
    refs.freeze = btn(T.freeze, () => sourceAction(id, refs.freeze.dataset.next));
    const tr = h("tr", {},
      h("th", { scope: "row" }, id),
      (refs.protocol = h("td")),
      (refs.universes = h("td", { class: "mono" })),
      (refs.generator = h("td")),
      (refs.rate = h("td", { class: "num" })),
      (refs.state = h("td")),
      (refs.frames = h("td", { class: "num" })),
      (refs.packets = h("td", { class: "num" })),
      (refs.faults = h("td")),
      h("td", { class: "actions-cell" },
        btn(T.modify, () => edit(id)),
        " ",
        btn(T.monitor, () => {
          const s = latest(id);
          if (s) ctx.navigate("monitor", { protocol: s.protocol, universe: s.universes[0] });
        }),
        " ",
        refs.pause,
        " ",
        refs.freeze,
        " ",
        btn(T.stop, () => sourceAction(id, "stop"), "small danger")));
    tr._refs = refs;
    return tr;
  }

  function latest(id) {
    const stats = ctx.live.stats;
    return stats ? stats.state.sources.find((s) => s.id === id) : null;
  }

  function updateRow(tr, source) {
    const r = tr._refs;
    setText(r.protocol, source.protocol === "sacn" ? "sACN" : "Art-Net");
    setText(r.universes, compactRanges(source.universes));
    setText(r.generator, source.generator);
    setText(r.rate, fmtNumber(source.rate, 1));
    const [label, kind] = STATE_BADGE[source.state] || [source.state, ""];
    render(r.state, badge(label, kind), source.frozen ? [" ", badge("画面冻结", "warn")] : null);
    setText(r.frames, source.frames);
    setText(r.packets, source.packets);
    const faults = [];
    if (source.dropped) faults.push(`丢 ${source.dropped}`);
    if (source.duplicated) faults.push(`重复 ${source.duplicated}`);
    if (source.reordered) faults.push(`乱序 ${source.reordered}`);
    if (source.send_errors) faults.push(`发送失败 ${source.send_errors}`);
    setText(r.faults, faults.join(",") || "-");
    const paused = source.state === "paused";
    r.pause.textContent = paused ? T.resume : T.pause;
    r.pause.dataset.next = paused ? "resume" : "pause";
    r.pause.disabled = source.state === "stopped";
    r.freeze.textContent = source.frozen ? T.unfreeze : T.freeze;
    r.freeze.dataset.next = source.frozen ? "unfreeze" : "freeze";
  }

  function update() {
    const stats = ctx.live.stats;
    if (!stats) return;
    const sources = stats.state.sources;
    syncKeyed(tbody, sources, (s) => s.id, createRow, updateRow);
    empty.classList.toggle("hidden", sources.length > 0);
    table.classList.toggle("hidden", sources.length === 0);
  }

  const table = h("table", {},
    h("caption", { class: "sr-only" }, T.title),
    h("thead", {}, h("tr", {},
      ["id", "protocol", "universes", "generator", "rate", "state", "frames", "packets", "faults", "actions"]
        .map((k) => h("th", { scope: "col", class: ["rate", "frames", "packets"].includes(k) ? "num" : "" }, T[k])))),
    tbody);

  render(
    root,
    h("h2", {}, T.title),
    h("div", { class: "toolbar" },
      h("button", {
        type: "button",
        class: "primary",
        onclick: () => openSourceDialog(ctx, null, () => ctx.live.refresh()).catch((e) => ctx.toast(e.message, "error")),
      }, T.create)),
    empty,
    h("div", { class: "table-wrap" }, table),
  );
  update();
  return { unmount: ctx.live.subscribe(update) };
}
