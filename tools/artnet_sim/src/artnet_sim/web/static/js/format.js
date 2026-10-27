// 纯函数工具:格式化与输入解析。不依赖 DOM,可以用 `node --test` 直接测试。

/**
 * 解析形如 "1-4,8,10-12" 的范围,返回去重、升序的整数数组。
 * 格式不合法或超出 [min, max] 时抛 Error(消息为中文)。
 */
export function parseRanges(text, min = 0, max = 65535) {
  const values = new Set();
  const parts = String(text).split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("范围不能为空");
  for (const part of parts) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) throw new Error(`无法解析范围片段: ${part}`);
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : Number(m[2]);
    if (start > end) throw new Error(`范围起点大于终点: ${part}`);
    if (start < min || end > max) throw new Error(`${part} 超出允许范围 ${min}~${max}`);
    if (end - start > 100000) throw new Error(`范围过大: ${part}`);
    for (let i = start; i <= end; i += 1) values.add(i);
  }
  return [...values].sort((a, b) => a - b);
}

/** 把升序整数数组压缩成 "1-4, 8, 10-12" 形式的简写。 */
export function compactRanges(values) {
  if (!values || values.length === 0) return "";
  const sorted = [...values].sort((a, b) => a - b);
  const out = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i += 1) {
    const v = sorted[i];
    if (v === prev + 1) {
      prev = v;
      continue;
    }
    out.push(start === prev ? String(start) : `${start}-${prev}`);
    start = v;
    prev = v;
  }
  return out.join(", ");
}

/** 数字格式化为固定小数位,非有限数返回 "-"。 */
export function fmtNumber(value, digits = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return value.toFixed(digits);
}

/** 毫秒数格式化,带单位。 */
export function fmtMs(value, digits = 2) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)} ms` : "-";
}

/** 秒数格式化为 "1 分 05 秒" / "12.3 秒"。 */
export function fmtDuration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "-";
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h} 小时 ${String(m).padStart(2, "0")} 分` : `${m} 分 ${String(s).padStart(2, "0")} 秒`;
}

/** 字节数格式化。 */
export function fmtBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

/** Universe 的显示名,如 "Art-Net 12" / "sACN 7"。 */
export function universeLabel(protocol, universe) {
  return `${protocol === "sacn" ? "sACN" : "Art-Net"} ${universe}`;
}

/**
 * 通道值 → 0..1 的亮度比例(用于热力色)。
 * 非线性提亮低值,让 1~20 这样的小值也能看出来。
 */
export function channelIntensity(value) {
  const v = Math.max(0, Math.min(255, value | 0)) / 255;
  return Math.sqrt(v);
}

/** 把数组或 Uint8Array 切成每行 n 个的二维数组。 */
export function chunk(values, n) {
  const rows = [];
  for (let i = 0; i < values.length; i += n) rows.push(Array.from(values.slice(i, i + n)));
  return rows;
}

/** 通道序号(0 起)→ "通道 513"这样的 1 起显示。 */
export function channelName(index) {
  return `通道 ${index + 1}`;
}

/** 校验 0~max 之间的整数输入;非法返回 null。 */
export function toInt(text, min, max) {
  if (text === "" || text === null || text === undefined) return null;
  const n = Number(text);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/** 百分比(0~100)输入转 0~1 的概率;非法返回 null。 */
export function percentToFraction(text) {
  if (text === "" || text === null || text === undefined) return 0;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n / 100;
}

/**
 * 按"起始地址 + 个数"生成连续的端口配置(虚拟节点表单用)。
 * 个数必须是 1~64 的整数,地址范围 0~32767;非法时抛 Error(中文)。
 */
export function buildPorts({ start, count, direction = "output", mergeMode = "htp", protocol = "artnet" }) {
  const first = toInt(start, 0, 32767);
  if (first === null) throw new Error("起始 Port-Address 必须是 0~32767 的整数");
  const n = toInt(count, 1, 64);
  if (n === null) throw new Error("端口数必须是 1~64 的整数");
  if (first + n - 1 > 32767) throw new Error("端口地址超出 32767");
  return Array.from({ length: n }, (_, i) => ({
    direction,
    address: first + i,
    merge_mode: mergeMode,
    protocol,
  }));
}

/**
 * 把数值序列换算成折线的像素坐标(迷你趋势图用)。
 * 返回 [[x, y], ...];y 轴向下,值越大越靠上。序列为空返回 []。
 * floor 为纵轴最小的上限(避免全是 0 时放大噪声)。
 */
export function sparkPoints(values, width, height, floor = 1) {
  if (!values || values.length === 0) return [];
  const top = Math.max(floor, ...values);
  const pad = 2;
  const usableH = Math.max(1, height - pad * 2);
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  return values.map((v, i) => [pad + i * step, pad + usableH * (1 - Math.max(0, v) / top)]);
}

/** 时间戳(秒)→ 本地时间文本;无效返回 "-"。 */
export function fmtTimestamp(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "-";
  return new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

/** 包日志过滤条件 → 查询字符串(空条件不写入)。 */
export function logQuery({ after = 0, limit = 200, protocol = "", universe = "", srcIp = "" } = {}) {
  const query = new URLSearchParams();
  query.set("after", String(after));
  query.set("limit", String(limit));
  if (protocol) query.set("protocol", protocol);
  if (universe !== "" && universe !== null && universe !== undefined) query.set("universe", String(universe));
  if (srcIp) query.set("src_ip", srcIp);
  return query.toString();
}

/** 场景进度 0~1;不知道总时长时返回 null。 */
export function scenarioProgress(status) {
  if (!status || !status.end_time || status.end_time <= 0) return null;
  return Math.max(0, Math.min(1, status.elapsed / status.end_time));
}
