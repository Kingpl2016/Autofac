// 虚拟节点:创建、上线/下线、删除,查看端口的合并状态。

import { confirmDialog, openFormDialog } from "../dialog.js";
import { badge, field, h, render, setText, syncKeyed } from "../dom.js";
import { buildPorts } from "../format.js";
import { S } from "../strings.js";

const T = S.nodes;
const DIRECTION_TEXT = { output: "输出", input: "输入", both: "输入+输出" };
const PROTOCOL_TEXT = { artnet: "Art-Net", sacn: "sACN" };

/** 一个端口当前的来源列表,拼成一行文字。 */
function describeSources(port) {
  if (!port.sources || port.sources.length === 0) return "-";
  return port.sources
    .map((s) => {
      if (port.protocol === "sacn") {
        const name = s.name || String(s.cid).slice(0, 8);
        return `${name}@${s.ip} 优先级 ${s.priority}${s.winning ? "(生效)" : ""}`;
      }
      return `${s.ip}${s.physical ? ` #${s.physical}` : ""}`;
    })
    .join(";");
}

function selectOptions(pairs, current) {
  return pairs.map(([value, label]) => h("option", { value, selected: value === current }, label));
}

/** 打开"添加虚拟节点"对话框。 */
function openAddDialog(ctx) {
  const id = h("input", { type: "text", name: "id", maxlength: 64, placeholder: "留空自动生成" });
  const ip = h("input", { type: "text", name: "ip", value: "auto", size: 16 });
  const shortName = h("input", { type: "text", name: "short_name", maxlength: 17, value: "artnet-sim" });
  const longName = h("input", { type: "text", name: "long_name", maxlength: 63, value: "Art-Net Studio simulated node", size: 32 });
  const start = h("input", { type: "number", name: "start", min: 0, max: 32767, step: 1, value: 0 });
  const count = h("input", { type: "number", name: "count", min: 1, max: 64, step: 1, value: 4 });
  const direction = h("select", { name: "direction" }, selectOptions(Object.entries(DIRECTION_TEXT), "output"));
  const merge = h("select", { name: "merge_mode" }, selectOptions([["htp", "HTP(逐通道取大)"], ["ltp", "LTP(取最后到达的)"]], "htp"));
  const protocol = h("select", { name: "protocol" }, selectOptions(Object.entries(PROTOCOL_TEXT), "artnet"));
  const offset = h("select", { name: "sacn_universe_offset" }, selectOptions([["1", "1(Art-Net 0 对应 sACN 1)"], ["0", "0(编号相同)"]], "1"));
  const priority = h("input", { type: "number", name: "acn_priority", min: 0, max: 200, step: 1, value: 100 });

  return openFormDialog({
    title: T.add,
    submitText: S.common.create,
    focus: shortName,
    content: [
      h("div", { class: "form-grid" },
        field("节点 ID", id),
        field("IP 地址", ip, "auto 表示自动选择本机可用地址"),
        field("短名", shortName, "最多 17 字节"),
        field("长名", longName, "最多 63 字节")),
      h("fieldset", {},
        h("legend", {}, "端口(按起始地址连续编号)"),
        h("div", { class: "form-grid" },
          field("起始 Port-Address", start, "0~32767"),
          field("端口数", count, "1~64,每 4 个一组 Bind"),
          field("方向", direction),
          field("合并模式", merge),
          field("输出口接收的协议", protocol),
          field("sACN Universe 偏移", offset),
          field("宣告的 sACN 优先级", priority))),
    ],
    onSubmit: async () => {
      const body = {
        ip: ip.value.trim() || "auto",
        short_name: shortName.value,
        long_name: longName.value,
        ports: buildPorts({
          start: start.value,
          count: count.value,
          direction: direction.value,
          mergeMode: merge.value,
          protocol: protocol.value,
        }),
        sacn_universe_offset: Number(offset.value),
        acn_priority: Number(priority.value),
      };
      if (id.value.trim()) body.id = id.value.trim();
      const created = await ctx.api.post("/api/nodes", body);
      await ctx.live.refresh();
      ctx.toast(`虚拟节点 ${created.id} 已创建(${created.ip})`);
      for (const text of created.warnings || []) ctx.toast(text, "error", 8000);
    },
  });
}

export function mount(root, ctx) {
  const list = h("div", { class: "node-list" });
  const empty = h("p", { class: "empty" }, T.empty);
  const warnings = h("ul", { class: "warnings" });
  const warningsBox = h("section", { class: "notice warn hidden", "aria-label": "节点警告" }, warnings);

  async function act(action, errorPrefix) {
    try {
      await action();
      await ctx.live.refresh();
    } catch (error) {
      ctx.toast(`${errorPrefix}:${error.message}`, "error");
    }
  }

  function createCard(node) {
    const id = node.id;
    const refs = {};
    refs.title = h("h3", {});
    refs.online = h("button", { type: "button", class: "small", onclick: () => {
      act(() => ctx.api.post(`/api/nodes/${encodeURIComponent(id)}/online`, { online: refs.online.dataset.next === "true" }), "切换失败");
    } });
    const remove = h("button", { type: "button", class: "small danger", onclick: async () => {
      if (await confirmDialog(`确定删除虚拟节点 ${id} 吗?它会停止回复 ArtPoll。`, S.common.delete)) {
        act(() => ctx.api.del(`/api/nodes/${encodeURIComponent(id)}`), "删除失败");
      }
    } }, S.common.delete);
    refs.status = h("span");
    refs.info = h("dl", { class: "kv" });
    refs.tbody = h("tbody");
    const table = h("table", {},
      h("caption", { class: "sr-only" }, `${id} 的端口`),
      h("thead", {}, h("tr", {},
        ["port", "direction", "address", "protocol", "merge", "state", "sources", "packets", "actions"]
          .map((k) => h("th", { scope: "col", class: k === "packets" ? "num" : "" }, T[k])))),
      refs.tbody);
    const card = h("section", { class: "card node-card", "aria-label": `虚拟节点 ${id}` },
      h("div", { class: "toolbar" }, refs.title, refs.status, h("span", { class: "spacer" }), refs.online, remove),
      refs.info,
      h("div", { class: "table-wrap" }, table));
    card._refs = refs;
    return card;
  }

  function createPortRow(node, port) {
    const cells = Array.from({ length: 7 }, () => h("td"));
    const monitor = h("button", { type: "button", class: "small", onclick: () => {
      ctx.navigate("monitor", { node: node.id, port: port.index });
    } }, S.sources.monitor);
    const tr = h("tr", {}, h("th", { scope: "row" }), ...cells, h("td", {}, monitor));
    tr._cells = cells;
    tr._head = tr.firstChild;
    tr._monitor = monitor;
    return tr;
  }

  function updatePortRow(tr, node, port) {
    const [direction, address, protocol, merge, state, sources, packets] = tr._cells;
    setText(tr._head, String(port.index + 1));
    setText(direction, DIRECTION_TEXT[port.direction] || port.direction);
    const isInput = port.direction === "input";
    setText(address, isInput ? `${port.in_address}` : `${port.out_address}`);
    setText(protocol, isInput ? "-" : PROTOCOL_TEXT[port.protocol] || port.protocol);
    setText(merge, isInput ? "-" : port.merge_mode.toUpperCase());
    render(state,
      isInput ? badge("-", "") : port.active ? badge(T.active, "ok") : badge(T.idle, "warn"),
      port.merging ? [" ", badge(T.merging, "warn")] : null);
    setText(sources, describeSources(port));
    setText(packets, String(port.packets));
    packets.className = "num";
    tr._monitor.disabled = isInput;
    tr._monitor.setAttribute("aria-label", `监看 ${node.short_name} 端口 ${port.index + 1}`);
  }

  function updateCard(card, node) {
    const r = card._refs;
    setText(r.title, `${node.short_name}(${node.id})`);
    render(r.status, badge(node.online ? T.online : T.offline, node.online ? "ok" : "warn"));
    r.online.textContent = node.online ? T.goOffline : T.goOnline;
    r.online.dataset.next = String(!node.online);

    const counters = Object.entries(node.counters || {})
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join(",");
    const rows = [
      [T.ip, node.ip],
      [T.longName, node.long_name],
      [T.binds, String(node.binds)],
      [T.sync, node.sync_active ? T.syncOn : T.syncOff],
      [T.timecode, node.timecode || "-"],
      [T.counters, counters || "-"],
    ];
    syncKeyed(
      r.info,
      rows.map(([k, v]) => ({ k, v })),
      (row) => row.k,
      () => {
        const dd = h("dd");
        const dt = h("dt");
        const wrap = h("div", { class: "kv-row" }, dt, dd);
        wrap._dt = dt;
        wrap._dd = dd;
        return wrap;
      },
      (wrap, row) => {
        setText(wrap._dt, row.k);
        setText(wrap._dd, row.v);
      },
    );
    syncKeyed(
      r.tbody,
      node.ports,
      (p) => p.index,
      (p) => createPortRow(node, p),
      (tr, p) => updatePortRow(tr, node, p),
    );
  }

  function update() {
    const stats = ctx.live.stats;
    if (!stats) return;
    const snapshot = stats.state.nodes;
    syncKeyed(list, snapshot.nodes, (n) => n.id, createCard, updateCard);
    empty.classList.toggle("hidden", snapshot.nodes.length > 0);
    const notes = [...(snapshot.warnings || [])];
    if (snapshot.reply_errors) notes.push(`有 ${snapshot.reply_errors} 次回复发送失败。`);
    render(warnings, notes.map((t) => h("li", {}, t)));
    warningsBox.classList.toggle("hidden", notes.length === 0);
  }

  render(
    root,
    h("h2", {}, T.title),
    h("p", { class: "muted" }, T.intro),
    h("div", { class: "toolbar" },
      h("button", {
        type: "button",
        class: "primary",
        onclick: () => openAddDialog(ctx),
      }, T.add)),
    warningsBox,
    empty,
    list,
  );
  update();
  return { unmount: ctx.live.subscribe(update) };
}
