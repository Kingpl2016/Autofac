// 录制与回放:从抓到的信号录制 .artrec,管理文件,把文件作为发送源回放。

import { confirmDialog, openFormDialog } from "../dialog.js";
import { badge, field, h, render, setText } from "../dom.js";
import { compactRanges, fmtBytes, fmtDuration, fmtTimestamp, parseRanges } from "../format.js";
import { S } from "../strings.js";

const T = S.recordings;

/** 打开"回放这个文件"对话框:创建一个 artrec 发送源。 */
function openReplayDialog(ctx, recording) {
  const protocol = h("select", { name: "protocol" },
    [["artnet", "Art-Net"], ["sacn", "sACN"]].map(([v, label]) => h("option", { value: v }, label)));
  const offset = h("input", { type: "number", name: "universe_offset", min: 0, max: 63999, step: 1, value: 0 });
  const loop = h("input", { type: "checkbox", name: "loop", checked: true });
  const speed = h("input", { type: "number", name: "speed", min: 0.01, max: 100, step: "any", value: 1 });
  const start = h("input", { type: "number", name: "start", min: 0, step: "any", value: 0 });
  const rate = h("input", { type: "number", name: "rate", min: 0.1, max: 1000, step: "any", value: 44 });
  const targetKind = h("select", { name: "target_kind" },
    [["broadcast", "广播"], ["multicast", "sACN 组播"], ["custom", "指定 IP"]].map(([v, label]) => h("option", { value: v }, label)));
  const targetIp = h("input", { type: "text", name: "target_ip", size: 16, placeholder: "192.168.1.50" });
  const port = h("input", { type: "number", name: "port", min: 0, max: 65535, step: 1, value: 0 });
  const loopId = "replay-loop";
  loop.id = loopId;

  let offsetTouched = false;
  offset.addEventListener("input", () => {
    offsetTouched = true;
  });
  const sync = () => {
    const isSacn = protocol.value === "sacn";
    targetKind.querySelector('option[value="multicast"]').disabled = !isSacn;
    if (!isSacn && targetKind.value === "multicast") targetKind.value = "broadcast";
    // 用户没有手动改过偏移时,按协议给出合适的默认值(sACN 没有 Universe 0)
    if (!offsetTouched) offset.value = isSacn && (recording.universes || []).includes(0) ? 1 : 0;
    targetIp.disabled = targetKind.value !== "custom";
  };
  protocol.addEventListener("change", sync);
  targetKind.addEventListener("change", sync);
  sync();

  return openFormDialog({
    title: `回放 ${recording.name}`,
    submitText: T.startReplay,
    focus: protocol,
    content: [
      h("p", { class: "muted" }, `文件包含 Universe:${compactRanges(recording.universes || []) || "-"}。回放会创建一个发送源,可在“发送源”页暂停或停止。`),
      h("div", { class: "form-grid" },
        field("协议", protocol),
        field("Universe 偏移", offset, "给文件里的编号统一加上这个值"),
        field("倍速", speed),
        field("起始位置(秒)", start),
        field("帧率(Hz)", rate),
        field("目标", targetKind),
        field("目标 IP", targetIp),
        field("目标端口", port, "0 为协议默认")),
      h("div", { class: "field inline" }, loop, h("label", { for: loopId }, "循环播放")),
    ],
    onSubmit: async () => {
      const r = Number(rate.value);
      if (!Number.isFinite(r) || r < 0.1 || r > 1000) throw new Error("帧率必须在 0.1~1000");
      const sp = Number(speed.value);
      if (!Number.isFinite(sp) || sp <= 0) throw new Error("倍速必须大于 0");
      const target = targetKind.value === "custom" ? targetIp.value.trim() : targetKind.value;
      if (!target) throw new Error("请填写目标 IP");
      const body = {
        protocol: protocol.value,
        generator: "artrec",
        params: {
          recording: recording.name,
          loop: loop.checked,
          speed: sp,
          start: Number(start.value) || 0,
          universe_offset: Number(offset.value) || 0,
        },
        rate: r,
        target,
        port: Number(port.value) || 0,
      };
      const created = await ctx.api.post("/api/sources", body);
      await ctx.live.refresh();
      ctx.toast(`已开始回放,发送源 ${created.id}`);
      ctx.navigate("sources");
    },
  });
}

export function mount(root, ctx) {
  const refs = {};
  let wasRecording = null;
  let files = [];
  let gone = false;

  // ---------------------------------------------------------------- 录制
  const nameIn = h("input", { type: "text", id: "rec-name", maxlength: 100, placeholder: "留空按时间自动命名" });
  const universesIn = h("input", { type: "text", id: "rec-uni", size: 20, placeholder: "留空录制当前活跃的" });
  const artnetBox = h("input", { type: "checkbox", id: "rec-artnet", checked: true });
  const sacnBox = h("input", { type: "checkbox", id: "rec-sacn", checked: true });
  const diffBox = h("input", { type: "checkbox", id: "rec-diff" });
  const rawBox = h("input", { type: "checkbox", id: "rec-raw" });
  const formError = h("p", { class: "error-text", role: "alert" });
  refs.startBtn = h("button", { type: "button", class: "primary", onclick: () => startRecording() }, T.start);
  refs.stopBtn = h("button", { type: "button", onclick: () => stopRecording() }, T.stop);

  async function startRecording() {
    formError.textContent = "";
    const protocols = [];
    if (artnetBox.checked) protocols.push("artnet");
    if (sacnBox.checked) protocols.push("sacn");
    if (protocols.length === 0) {
      formError.textContent = "至少选择一种协议";
      return;
    }
    const body = { protocols, diff: diffBox.checked, no_compress: rawBox.checked };
    if (nameIn.value.trim()) body.name = nameIn.value.trim();
    if (universesIn.value.trim()) {
      try {
        body.universes = parseRanges(universesIn.value, 0, 63999);
      } catch (error) {
        formError.textContent = error.message;
        return;
      }
    }
    try {
      await ctx.api.post("/api/recordings/start", body);
      await ctx.live.refresh();
      ctx.toast("开始录制");
    } catch (error) {
      formError.textContent = error.message;
    }
  }

  async function stopRecording() {
    try {
      await ctx.api.post("/api/recordings/stop");
      await ctx.live.refresh();
      await loadFiles();
      ctx.toast("录制已停止");
    } catch (error) {
      ctx.toast(error.message, "error");
    }
  }

  refs.status = h("dl", { class: "kv" });
  refs.notice = h("div", { class: "notice warn hidden", role: "status" });
  refs.last = h("p", { class: "muted" });

  // ---------------------------------------------------------------- 文件
  const tbody = h("tbody");
  const empty = h("p", { class: "empty" }, T.empty);
  const fileInput = h("input", { type: "file", id: "rec-upload", accept: ".artrec" });
  const uploadError = h("p", { class: "error-text", role: "alert" });

  async function loadFiles() {
    try {
      const list = await ctx.api.get("/api/recordings");
      if (gone) return;
      files = list;
      drawFiles();
    } catch (error) {
      ctx.toast(error.message, "error");
    }
  }

  async function upload() {
    uploadError.textContent = "";
    const file = fileInput.files[0];
    if (!file) {
      uploadError.textContent = "请先选择一个 .artrec 文件";
      return;
    }
    try {
      const info = await ctx.api.upload("/api/recordings/upload", file);
      fileInput.value = "";
      ctx.toast(`已上传 ${info.name}`);
      await loadFiles();
    } catch (error) {
      uploadError.textContent = error.message;
    }
  }

  async function remove(name) {
    if (!(await confirmDialog(`确定删除录制文件 ${name} 吗?此操作不能撤销。`, S.common.delete))) return;
    try {
      await ctx.api.del(`/api/recordings/${encodeURIComponent(name)}`);
      ctx.toast(`已删除 ${name}`);
      await loadFiles();
    } catch (error) {
      ctx.toast(error.message, "error");
    }
  }

  function drawFiles() {
    empty.classList.toggle("hidden", files.length > 0);
    table.parentElement.classList.toggle("hidden", files.length === 0);
    render(tbody, files.map((f) => {
      const download = h("a", {
        class: "btn small",
        href: `/api/recordings/${encodeURIComponent(f.name)}/download`,
        download: f.name,
      }, T.download);
      download.setAttribute("aria-label", `下载 ${f.name}`);
      const replay = h("button", { type: "button", class: "small", disabled: Boolean(f.error), onclick: () => openReplayDialog(ctx, f) }, T.replay);
      replay.setAttribute("aria-label", `回放 ${f.name}`);
      const del = h("button", { type: "button", class: "small danger", onclick: () => remove(f.name) }, S.common.delete);
      del.setAttribute("aria-label", `删除 ${f.name}`);
      return h("tr", {},
        h("th", { scope: "row" }, f.name),
        h("td", { class: "num" }, fmtBytes(f.size)),
        h("td", {}, fmtTimestamp(f.modified)),
        h("td", { class: "num" }, f.error ? "-" : fmtDuration(f.duration_s)),
        h("td", { class: "num" }, f.error ? "-" : String(f.frames)),
        h("td", { class: "mono" }, f.error ? badge(f.error, "bad") : compactRanges(f.universes)),
        h("td", { class: "actions-cell" }, replay, " ", download, " ", del));
    }));
  }

  const table = h("table", {},
    h("caption", { class: "sr-only" }, T.files),
    h("thead", {}, h("tr", {}, T.cols.map((label, i) => h("th", { scope: "col", class: [1, 3, 4].includes(i) ? "num" : "" }, label)))),
    tbody);

  // ---------------------------------------------------------------- 状态更新
  function update() {
    const stats = ctx.live.stats;
    if (!stats) return;
    const { state } = stats;
    const rec = state.recording;
    const captureOn = state.capture.running;

    refs.startBtn.disabled = rec.recording || !captureOn;
    refs.stopBtn.disabled = !rec.recording;
    refs.startBtn.title = captureOn ? "" : "请先在“总览”页开始抓包";

    render(refs.status,
      h("dt", {}, T.state), h("dd", {}, rec.recording ? badge(T.recordingNow, "ok") : badge(S.overview.idle, "")),
      rec.recording ? [
        h("dt", {}, T.file), h("dd", {}, rec.file),
        h("dt", {}, T.frames), h("dd", {}, String(rec.frames)),
        h("dt", {}, T.elapsed), h("dd", {}, fmtDuration(rec.elapsed_s)),
        h("dt", {}, T.universes), h("dd", {}, compactRanges(rec.universes) || "-"),
      ] : null);

    const notes = [];
    if (!captureOn && !rec.recording) notes.push("抓包没有运行:请先到“总览”页开始抓包,才能录制。");
    if (rec.over_limit && rec.over_limit.length) {
      notes.push(`Universe ${compactRanges(rec.over_limit)} 超过 .artrec 格式的上限 2047,不会被写入文件。`);
    }
    if (rec.error) notes.push(`录制出错:${rec.error}`);
    refs.notice.textContent = notes.join(" ");
    refs.notice.classList.toggle("hidden", notes.length === 0);

    const last = rec.last;
    if (last && !rec.recording) {
      const parts = [`上次录制:${last.path ? last.path.split(/[\\/]/).pop() : "(失败)"}`, `${last.frames} 帧`, fmtBytes(last.bytes_written)];
      if (last.queue_drops) parts.push(`队列满而丢弃 ${last.queue_drops} 个包`);
      const skipped = Object.keys(last.skipped_over_limit || {});
      if (skipped.length) parts.push(`因超过 2047 而跳过的 Universe:${compactRanges(skipped.map(Number))}`);
      if (last.error) parts.push(`错误:${last.error}`);
      setText(refs.last, parts.join(";"));
    } else {
      setText(refs.last, "");
    }

    // 录制结束(无论是手动停止还是别处停止)后刷新文件列表
    if (wasRecording === true && !rec.recording) loadFiles();
    wasRecording = rec.recording;
  }

  render(
    root,
    h("h2", {}, T.title),
    h("div", { class: "grid" },
      h("section", { class: "card" },
        h("h3", {}, T.record),
        refs.status,
        refs.notice,
        refs.last,
        h("hr"),
        field("文件名", nameIn, "自动补 .artrec"),
        field("Universe", universesIn, "如 1-8,20"),
        h("div", { class: "field inline" }, artnetBox, h("label", { for: "rec-artnet" }, "录制 Art-Net")),
        h("div", { class: "field inline" }, sacnBox, h("label", { for: "rec-sacn" }, "录制 sACN")),
        h("div", { class: "field inline" }, diffBox, h("label", { for: "rec-diff" }, "使用差分帧(文件更小)")),
        h("div", { class: "field inline" }, rawBox, h("label", { for: "rec-raw" }, "不压缩")),
        formError,
        h("div", { class: "toolbar" }, refs.startBtn, refs.stopBtn)),
      h("section", { class: "card" },
        h("h3", {}, T.upload),
        field("选择 .artrec 文件", fileInput),
        uploadError,
        h("div", { class: "toolbar" }, h("button", { type: "button", onclick: upload }, T.uploadBtn)),
        h("p", { class: "hint" }, T.uploadHint))),
    h("h3", { style: "margin-top:20px" }, T.files),
    empty,
    h("div", { class: "table-wrap" }, table),
  );
  update();
  loadFiles();
  const unsubscribe = ctx.live.subscribe(update);
  return {
    unmount() {
      gone = true;
      unsubscribe();
    },
  };
}
