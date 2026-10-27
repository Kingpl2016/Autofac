// 发送源表单:生成器参数、故障注入、创建/修改对话框。

import { field, h, render } from "../dom.js";
import { parseRanges, percentToFraction } from "../format.js";
import { loadMeta } from "../store.js";

/**
 * 生成器参数表单。
 * @returns {{el: HTMLElement, read: () => object}} read() 返回 params 对象;输入非法时抛 Error。
 */
export function generatorFields(generator, values = {}, recordings = []) {
  const controls = [];
  const box = h("div", { class: "form-grid" });
  const entries = Object.entries(generator.params);
  for (const [key, spec] of entries) {
    if (generator.name === "artrec" && key === "path") {
      const select = h("select", { name: "recording" },
        recordings.length === 0
          ? h("option", { value: "" }, "(录制目录里还没有文件)")
          : recordings.map((r) => h("option", { value: r.name, selected: r.name === values.recording }, r.name)));
      controls.push({ key: "recording", kind: "str", control: select, required: true });
      box.appendChild(field("录制文件", select, "在“录制与回放”里录制或上传"));
      continue;
    }
    const current = key in values ? values[key] : spec.default;
    let control;
    if (spec.kind === "choice") {
      control = h("select", { name: key }, spec.choices.map((c) => h("option", { value: c, selected: c === current }, c)));
    } else if (spec.kind === "bool") {
      control = h("input", { type: "checkbox", name: key, checked: Boolean(current) });
    } else if (spec.kind === "str") {
      control = h("input", { type: "text", name: key, value: current ?? "" });
    } else {
      control = h("input", {
        type: "number",
        name: key,
        value: current,
        min: spec.minimum ?? undefined,
        max: spec.maximum ?? undefined,
        step: spec.kind === "int" ? 1 : "any",
      });
    }
    controls.push({ key, kind: spec.kind, control, spec });
    box.appendChild(
      spec.kind === "bool"
        ? h("div", { class: "field inline" }, control, h("label", { for: (control.id = `gp-${key}-${Math.random().toString(36).slice(2, 7)}`) }, spec.label))
        : field(spec.label, control),
    );
  }
  if (entries.length === 0) box.appendChild(h("p", { class: "muted" }, "这个生成器没有参数"));

  return {
    el: box,
    read() {
      const out = {};
      for (const { key, kind, control, required } of controls) {
        if (kind === "bool") out[key] = control.checked;
        else if (kind === "choice" || kind === "str") {
          if (required && !control.value) throw new Error("请选择录制文件");
          if (control.value !== "" || required) out[key] = control.value;
        } else if (control.value !== "") {
          const n = Number(control.value);
          if (!Number.isFinite(n)) throw new Error(`参数 ${key} 必须是数字`);
          out[key] = kind === "int" ? Math.trunc(n) : n;
        }
      }
      return out;
    },
  };
}

/** 故障注入表单。read() 只返回非默认字段;非法时抛 Error。 */
export function impairmentFields(values = {}) {
  const pct = (name, label) => {
    const input = h("input", { type: "number", name, min: 0, max: 100, step: "any", value: ((values[name] || 0) * 100) || "" });
    return { name, input, el: field(`${label}(%)`, input) };
  };
  const num = (name, label, hint, step = 1) => {
    const input = h("input", { type: "number", name, min: 0, step, value: values[name] || "" });
    return { name, input, el: field(label, input, hint) };
  };
  const loss = pct("loss", "随机丢包");
  const duplicate = pct("duplicate", "重复发包");
  const reorder = pct("reorder", "与下一帧乱序");
  const dropEvery = num("drop_every", "每 N 帧丢一整帧", "0 为关闭");
  const jitter = num("jitter_ms", "时刻抖动上限(ms)", "0~1000", "any");
  const resetEvery = num("seq_reset_every", "每 N 帧复位序号", "0 为关闭");
  const seed = num("seed", "随机种子", "留空为每次不同");
  const seqMode = h("select", { name: "seq_mode" },
    [["normal", "正常递增"], ["none", "恒为 0(不启用序号)"], ["frozen", "冻结不变"]]
      .map(([v, label]) => h("option", { value: v, selected: v === (values.seq_mode || "normal") }, label)));

  const el = h("fieldset", {},
    h("legend", {}, "故障注入(用于测试接收端)"),
    h("div", { class: "form-grid" }, loss.el, duplicate.el, reorder.el, dropEvery.el, jitter.el, field("序号模式", seqMode), resetEvery.el, seed.el));

  return {
    el,
    read() {
      const out = {};
      for (const p of [loss, duplicate, reorder]) {
        const fraction = percentToFraction(p.input.value);
        if (fraction === null) throw new Error("百分比必须在 0~100");
        if (fraction > 0) out[p.name] = fraction;
      }
      for (const p of [dropEvery, resetEvery]) {
        if (p.input.value !== "") {
          const n = Number(p.input.value);
          if (!Number.isInteger(n) || n < 0) throw new Error("N 必须是非负整数");
          if (n > 0) out[p.name] = n;
        }
      }
      if (jitter.input.value !== "") {
        const n = Number(jitter.input.value);
        if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error("抖动上限必须在 0~1000 ms");
        if (n > 0) out.jitter_ms = n;
      }
      if (seqMode.value !== "normal") out.seq_mode = seqMode.value;
      if (seed.input.value !== "") {
        const n = Number(seed.input.value);
        if (!Number.isInteger(n) || n < 0) throw new Error("随机种子必须是非负整数");
        out.seed = n;
      }
      return out;
    },
  };
}

/**
 * 打开创建/修改发送源的对话框。
 * @param ctx 视图上下文
 * @param {object|null} existing 已有信号源的完整描述(GET /api/sources/{id});null 表示新建
 * @param {() => void} onDone 成功后的回调
 */
export async function openSourceDialog(ctx, existing, onDone) {
  const meta = await loadMeta();
  let recordings = [];
  try {
    recordings = await ctx.api.get("/api/recordings");
  } catch {
    // 没有录制文件也能继续
  }
  const editing = existing !== null;
  const cfg = existing ? existing.config : {};
  const dialog = h("dialog", { "aria-labelledby": "src-dlg-title" });
  const error = h("p", { class: "error-text", role: "alert" });

  const protocol = h("select", { name: "protocol", disabled: editing },
    [["artnet", "Art-Net"], ["sacn", "sACN"]].map(([v, label]) => h("option", { value: v, selected: v === (cfg.protocol || "artnet") }, label)));
  const universes = h("input", {
    type: "text", name: "universes", size: 24, disabled: editing,
    value: editing ? cfg.universes.join(",") : "1", placeholder: "如 1-8,20",
  });
  const generatorSelect = h("select", { name: "generator" },
    meta.generators.map((g) => h("option", { value: g.name, selected: g.name === (cfg.generator || "fixed") }, `${g.label}(${g.name})`)));
  const paramsBox = h("div");
  const rate = h("input", { type: "number", name: "rate", min: 0.1, max: 1000, step: "any", value: cfg.rate ?? 44 });
  const channels = h("input", { type: "number", name: "channels", min: 1, max: 512, step: 1, value: cfg.channels ?? 512 });
  const priority = h("input", { type: "number", name: "priority", min: 0, max: 200, step: 1, value: cfg.priority ?? 100 });
  const sourceName = h("input", { type: "text", name: "source_name", maxlength: 63, value: cfg.source_name ?? "artnet-sim" });
  const physical = h("input", { type: "number", name: "physical", min: 0, max: 255, step: 1, value: cfg.physical ?? 0, disabled: editing });
  const targetKind = h("select", { name: "target_kind", disabled: editing },
    [["broadcast", "广播(所选网卡的子网)"], ["multicast", "sACN 组播"], ["custom", "指定 IP"]]
      .map(([v, label]) => h("option", { value: v }, label)));
  const targetIp = h("input", { type: "text", name: "target_ip", size: 16, placeholder: "192.168.1.50", disabled: editing });
  const port = h("input", { type: "number", name: "port", min: 0, max: 65535, step: 1, value: cfg.port ?? 0, disabled: editing });
  const iface = h("select", { name: "interface", disabled: editing },
    h("option", { value: "" }, "自动选择"),
    meta.interfaces.filter((i) => i.usable || i.loopback).map((i) => h("option", { value: i.ip }, `${i.name}  ${i.ip}${i.virtual ? "(虚拟)" : ""}`)));

  if (editing && cfg.target) {
    const t = cfg.target;
    targetKind.value = t === "broadcast" || t === "multicast" ? t : "custom";
    targetIp.value = targetKind.value === "custom" ? t : "";
  }

  let genForm = null;
  const imp = impairmentFields(cfg.impairments || {});

  function rebuildParams() {
    const generator = meta.generators.find((g) => g.name === generatorSelect.value);
    const same = editing && generatorSelect.value === cfg.generator;
    genForm = generatorFields(generator, same ? paramsForValues(cfg.params, generator) : {}, recordings);
    render(paramsBox, genForm.el);
  }
  function paramsForValues(params, generator) {
    if (generator.name !== "artrec") return params || {};
    return { ...params, recording: String(params.path || "").split(/[\\/]/).pop() };
  }
  function syncVisibility() {
    const isSacn = protocol.value === "sacn";
    for (const el of dialog.querySelectorAll("[data-sacn]")) el.classList.toggle("hidden", !isSacn);
    for (const el of dialog.querySelectorAll("[data-artnet]")) el.classList.toggle("hidden", isSacn);
    targetKind.querySelector('option[value="multicast"]').disabled = !isSacn;
    if (!isSacn && targetKind.value === "multicast") targetKind.value = "broadcast";
    targetIp.classList.toggle("hidden", targetKind.value !== "custom");
  }

  generatorSelect.addEventListener("change", rebuildParams);
  protocol.addEventListener("change", syncVisibility);
  targetKind.addEventListener("change", syncVisibility);

  function collect() {
    const body = {};
    const keepsFilePlayback = editing && cfg.generator === "artrec" && generatorSelect.value === "artrec";
    const params = keepsFilePlayback ? {} : genForm.read();
    const impairments = imp.read();
    const r = Number(rate.value);
    const c = Number(channels.value);
    if (!Number.isFinite(r) || r < 0.1 || r > 1000) throw new Error("帧率必须在 0.1~1000");
    if (!Number.isInteger(c) || c < 1 || c > 512) throw new Error("通道数必须是 1~512 的整数");
    body.generator = generatorSelect.value;
    body.rate = r;
    body.channels = c;
    if (protocol.value === "sacn") {
      body.priority = Number(priority.value);
      body.source_name = sourceName.value || "artnet-sim";
    }
    if (editing) {
      const patch = { rate: r, channels: c, impairments };
      if (protocol.value === "sacn") {
        patch.priority = body.priority;
        patch.source_name = body.source_name;
      }
      if (generatorSelect.value !== cfg.generator) {
        if (generatorSelect.value === "artrec") throw new Error("不能在运行中切换到文件回放,请重新创建发送源");
        patch.generator = generatorSelect.value;
        patch.generator_params = params;
      } else if (cfg.generator !== "artrec") {
        patch.generator_params = params;
      }
      return patch;
    }
    const create = {
      protocol: protocol.value,
      generator: body.generator,
      params,
      rate: r,
      channels: c,
      impairments,
    };
    if (universes.value.trim()) create.universes = parseRanges(universes.value, 0, 63999);
    else if (body.generator !== "artrec") throw new Error("请填写 Universe");
    if (protocol.value === "sacn") {
      create.priority = body.priority;
      create.source_name = body.source_name;
    } else {
      create.physical = Number(physical.value) || 0;
    }
    create.target = targetKind.value === "custom" ? targetIp.value.trim() : targetKind.value;
    if (targetKind.value === "custom" && !create.target) throw new Error("请填写目标 IP");
    create.port = Number(port.value) || 0;
    if (iface.value) create.interface = iface.value;
    return create;
  }

  async function submit(event) {
    event.preventDefault();
    error.textContent = "";
    try {
      const body = collect();
      if (editing) {
        await ctx.api.patch(`/api/sources/${encodeURIComponent(existing.id)}`, body);
      } else {
        await ctx.api.post("/api/sources", body);
      }
      dialog.close();
      dialog.remove();
      ctx.toast(editing ? "已保存修改" : "信号源已创建");
      onDone();
    } catch (e) {
      error.textContent = e.message;
    }
  }

  const form = h("form", { onsubmit: submit },
    h("h2", { id: "src-dlg-title" }, editing ? `修改发送源 ${existing.id}` : "新建发送源"),
    h("div", { class: "form-grid" },
      field("协议", protocol),
      field("Universe", universes, "如 1-8,20;回放文件可留空"),
      field("生成器", generatorSelect),
      field("帧率(Hz)", rate),
      field("通道数", channels),
      h("div", { "data-sacn": "" }, field("sACN 优先级", priority, "0~200")),
      h("div", { "data-sacn": "" }, field("sACN 源名称", sourceName)),
      h("div", { "data-artnet": "" }, field("Physical", physical, "区分同一 IP 上的多个输入口")),
      field("目标", targetKind),
      h("div", {}, field("目标 IP", targetIp)),
      field("目标端口", port, "0 为协议默认"),
      field("出口网卡", iface)),
    h("fieldset", {}, h("legend", {}, "生成器参数"), paramsBox),
    imp.el,
    error,
    h("div", { class: "actions" },
      h("button", { type: "button", onclick: () => { dialog.close(); dialog.remove(); } }, "取消"),
      h("button", { type: "submit", class: "primary" }, editing ? "保存" : "创建")));
  dialog.appendChild(form);
  dialog.addEventListener("cancel", () => dialog.remove());
  document.body.appendChild(dialog);
  rebuildParams();
  syncVisibility();
  dialog.showModal();
  (editing ? rate : universes).focus();
}

