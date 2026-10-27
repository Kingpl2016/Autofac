// 通道监看:选一个 Universe(或虚拟节点端口),实时显示 512 个通道的电平。

import { badge, field, h, render, setText, syncKeyed } from "../dom.js";
import { DmxGrid } from "../dmxgrid.js";
import { channelName, chunk, fmtMs, toInt, universeLabel } from "../format.js";
import { frameMatches, watchKey } from "../frames.js";
import { S } from "../strings.js";

const NO_DATA_AFTER_MS = 2500;
const TABLE_REFRESH_MS = 250;

export function mount(root, ctx) {
  let selected = fromParams(ctx.params);
  let lastFrameAt = 0;
  let tableVisible = false;
  let lastTableDraw = 0;
  let lastData = new Uint8Array(0);

  const canvas = h("canvas", { class: "dmx", role: "img", "aria-label": "512 个通道的电平栅格" });
  const tip = h("div", { class: "dmx-tip hidden", "aria-hidden": "true" });
  const gridWrap = h("div", { class: "grid-wrap" }, canvas, tip);
  const grid = new DmxGrid(canvas, tip);
  const tableBox = h("div", { class: "table-wrap hidden" });
  const streamList = h("ul");
  const nodeList = h("ul");
  const title = h("h3", {}, "未选择");
  const info = h("p", { class: "muted" });
  const noData = h("div", { class: "notice warn hidden", role: "status" });
  const sourcesBody = h("tbody");

  // ---- 手动选择 ----
  const protocolSelect = h("select", { id: "mon-proto" },
    h("option", { value: "artnet" }, "Art-Net"), h("option", { value: "sacn" }, "sACN"));
  const universeInput = h("input", { type: "number", id: "mon-uni", min: 0, max: 63999, step: 1, value: 1 });
  const manualError = h("p", { class: "error-text", role: "alert" });
  const manual = h("form", {
    onsubmit: (event) => {
      event.preventDefault();
      const n = toInt(universeInput.value, 0, 63999);
      if (n === null) {
        manualError.textContent = "Universe 必须是 0~63999 的整数";
        return;
      }
      manualError.textContent = "";
      select({ kind: "universe", protocol: protocolSelect.value, universe: n });
    },
  },
    field("协议", protocolSelect),
    field("Universe", universeInput),
    manualError,
    h("button", { type: "submit" }, "监看"));

  const tableToggle = h("input", {
    type: "checkbox",
    id: "mon-table",
    onchange: () => {
      tableVisible = tableToggle.checked;
      tableBox.classList.toggle("hidden", !tableVisible);
      gridWrap.classList.toggle("hidden", tableVisible);
      if (tableVisible) drawTable();
    },
  });

  function fromParams(params) {
    if (params.node) return { kind: "node", id: params.node, port: Number(params.port) || 0 };
    if (params.universe !== undefined) {
      return { kind: "universe", protocol: params.protocol === "sacn" ? "sacn" : "artnet", universe: Number(params.universe) || 0 };
    }
    return null;
  }

  function select(item) {
    selected = item;
    lastFrameAt = 0;
    lastData = new Uint8Array(0);
    grid.setData(lastData);
    const hash = item
      ? item.kind === "node"
        ? `#/monitor?node=${encodeURIComponent(item.id)}&port=${item.port}`
        : `#/monitor?protocol=${item.protocol}&universe=${item.universe}`
      : "#/monitor";
    history.replaceState(null, "", hash); // 不触发 hashchange,避免整页重建
    ctx.live.watch(item ? [item] : []);
    updateLists();
    updateInfo();
  }

  function isSelected(item) {
    return selected !== null && watchKey(selected) === watchKey(item);
  }

  function updateLists() {
    const stats = ctx.live.stats;
    const streams = stats ? stats.capture.streams : [];
    const universes = new Map();
    for (const s of streams) {
      const key = `${s.protocol}:${s.universe}`;
      const entry = universes.get(key) || { protocol: s.protocol, universe: s.universe, sources: 0, active: false };
      entry.sources += 1;
      entry.active = entry.active || s.active;
      universes.set(key, entry);
    }
    const items = [...universes.values()].sort((a, b) => a.protocol.localeCompare(b.protocol) || a.universe - b.universe);
    syncKeyed(
      streamList,
      items,
      (u) => `${u.protocol}:${u.universe}`,
      (u) => {
        const item = { kind: "universe", protocol: u.protocol, universe: u.universe };
        const button = h("button", { type: "button", onclick: () => select(item) });
        const li = h("li", {}, button);
        li._button = button;
        li._item = item;
        return li;
      },
      (li, u) => {
        setText(li._button, `${universeLabel(u.protocol, u.universe)} · ${u.sources} 个来源${u.active ? "" : "(无数据)"}`);
        li._button.setAttribute("aria-pressed", String(isSelected(li._item)));
      },
    );
    const nodePorts = [];
    for (const node of stats ? stats.state.nodes.nodes : []) {
      for (const p of node.ports) {
        if (p.direction !== "input") nodePorts.push({ node, port: p });
      }
    }
    syncKeyed(
      nodeList,
      nodePorts,
      ({ node, port }) => `${node.id}:${port.index}`,
      ({ node, port }) => {
        const item = { kind: "node", id: node.id, port: port.index };
        const button = h("button", { type: "button", onclick: () => select(item) });
        const li = h("li", {}, button);
        li._button = button;
        li._item = item;
        return li;
      },
      (li, { node, port }) => {
        setText(li._button, `${node.short_name} 端口 ${port.index + 1} · 地址 ${port.out_address}${port.active ? "" : "(无数据)"}`);
        li._button.setAttribute("aria-pressed", String(isSelected(li._item)));
      },
    );
    streamList.classList.toggle("hidden", items.length === 0);
    emptyStreams.classList.toggle("hidden", items.length > 0);
    nodeList.classList.toggle("hidden", nodePorts.length === 0);
    emptyNodes.classList.toggle("hidden", nodePorts.length > 0);
  }

  function updateInfo() {
    const stats = ctx.live.stats;
    if (!selected) {
      setText(title, "未选择");
      setText(info, "从左侧选择一个正在发送的 Universe,或输入编号手动监看。");
      noData.classList.add("hidden");
      sourcesBody.replaceChildren();
      return;
    }
    if (selected.kind === "node") {
      setText(title, `虚拟节点 ${selected.id} · 端口 ${selected.port + 1}`);
      setText(info, "显示该端口合并后的输出。");
      sourcesBody.replaceChildren();
    } else {
      setText(title, universeLabel(selected.protocol, selected.universe));
      const streams = (stats ? stats.capture.streams : []).filter(
        (s) => s.protocol === selected.protocol && s.universe === selected.universe,
      );
      setText(info, streams.length ? `${streams.length} 个来源` : "还没有收到这个 Universe 的数据");
      syncKeyed(
        sourcesBody,
        streams,
        (s) => s.source_id,
        () => {
          const cells = Array.from({ length: 9 }, () => h("td"));
          const tr = h("tr", {}, ...cells);
          tr._cells = cells;
          return tr;
        },
        (tr, s) => {
          const [src, pps, pkts, lost, ooo, dup, jit, pri, st] = tr._cells;
          setText(src, s.protocol === "sacn" ? `${s.source_name || s.cid.slice(0, 8)} (${s.src_ip})` : s.src_ip);
          setText(pps, s.pps.toFixed(1));
          setText(pkts, s.packets);
          setText(lost, s.lost);
          setText(ooo, s.out_of_order);
          setText(dup, s.duplicates);
          setText(jit, fmtMs(s.interval_stddev_ms, 2));
          setText(pri, s.priority === null ? "-" : s.priority);
          render(st, s.terminated ? badge("已结束", "") : s.active ? badge("活跃", "ok") : badge("无数据", "warn"));
          for (const c of [pps, pkts, lost, ooo, dup, jit, pri]) c.className = "num";
        },
      );
    }
    const stale = lastFrameAt === 0 || performance.now() - lastFrameAt > NO_DATA_AFTER_MS;
    const captureOff = stats && !stats.state.capture.running && selected.kind === "universe";
    noData.classList.toggle("hidden", !stale);
    if (stale) {
      noData.textContent = captureOff
        ? "抓包没有运行,监看不到网络数据。请先在“总览”页开始抓包。"
        : "暂无数据:确认发送端在运行、协议与 Universe 编号正确;sACN 还需要在“总览”页订阅该 Universe。";
    }
  }

  function drawTable() {
    const now = performance.now();
    if (now - lastTableDraw < TABLE_REFRESH_MS) return;
    lastTableDraw = now;
    const rows = chunk(lastData, 16);
    render(tableBox, h("table", { class: "chtable" },
      h("caption", { class: "sr-only" }, "通道数值表,每行 16 个通道"),
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "起始"), Array.from({ length: 16 }, (_, i) => h("th", { scope: "col" }, `+${i}`)))),
      h("tbody", {}, rows.map((row, r) =>
        h("tr", {}, h("th", { scope: "row" }, channelName(r * 16)), row.map((v) => h("td", {}, v)))))));
  }

  const offFrame = ctx.live.onFrame((frame) => {
    if (!selected || !frameMatches(frame, selected)) return;
    lastFrameAt = performance.now();
    lastData = frame.data;
    noData.classList.add("hidden"); // 收到数据立刻撤掉"暂无数据"提示,不必等下一次刷新
    canvas.dataset.frames = String((Number(canvas.dataset.frames) || 0) + 1);
    grid.setData(frame.data);
    if (tableVisible) drawTable();
  });

  const emptyStreams = h("p", { class: "muted" }, "暂无正在收到的 Universe");
  const emptyNodes = h("p", { class: "muted" }, "暂无虚拟节点");

  render(
    root,
    h("h2", {}, S.nav.monitor),
    h("div", { class: "monitor" },
      h("div", {},
        h("section", { class: "card picker" },
          h("h3", {}, "收到的 Universe"), emptyStreams, streamList),
        h("section", { class: "card picker", style: "margin-top:12px" },
          h("h3", {}, "虚拟节点端口"), emptyNodes, nodeList),
        h("section", { class: "card", style: "margin-top:12px" }, h("h3", {}, "手动输入"), manual)),
      h("section", { class: "card" },
        title, info, noData,
        h("div", { class: "toolbar" },
          h("div", { class: "field inline" }, tableToggle, h("label", { for: "mon-table" }, "显示为数值表格")),
          h("div", { class: "legend", "aria-hidden": "true" }, "0", h("span", { class: "ramp" }), "255")),
        gridWrap, tableBox,
        h("h3", { style: "margin-top:16px" }, "来源统计"),
        h("div", { class: "table-wrap" }, h("table", {},
          h("thead", {}, h("tr", {}, ["来源", "包/秒", "包数", "丢包", "乱序", "重复", "抖动 σ", "优先级", "状态"]
            .map((t, i) => h("th", { scope: "col", class: i > 0 && i < 8 ? "num" : "" }, t)))),
          sourcesBody)))),
  );

  function onStats() {
    updateLists();
    updateInfo();
  }

  const unsubscribe = ctx.live.subscribe(onStats);
  if (selected) ctx.live.watch([selected]);
  onStats();
  const ticker = setInterval(updateInfo, 1000);
  return {
    unmount() {
      unsubscribe();
      offFrame();
      clearInterval(ticker);
      grid.destroy();
      ctx.live.watch([]);
    },
  };
}
