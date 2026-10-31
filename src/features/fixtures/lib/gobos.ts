import type { Capability } from "./types";

/**
 * 内置图案（gobo）：按程序生成的灰度遮罩（255 透光、0 遮光），3D 舞台投射到光束与光斑上。
 *
 * 图案槽位的 `pattern` 字段指定图案：`builtin:<名称>` 为这里的内置图案，64 位十六进制为资源库里导入的图案图片；
 * 省略时按槽位名的关键词自动匹配（中英文），匹配不到的按槽位序号轮流取一个，保证相邻槽位看起来不同。
 * 名称像“开光 / Open”的槽位不投射图案。
 */

/** 内置图案的名称。 */
export const BUILTIN_GOBOS = [
  "dot",
  "dots",
  "ring",
  "rings",
  "star",
  "stars",
  "flower",
  "rays",
  "spiral",
  "bars",
  "grid",
  "cross",
  "triangle",
  "square",
  "honeycomb",
  "breakup",
  "waves",
  "flame",
  "moon",
  "shatter",
] as const;

/** 内置图案的名称。 */
export type BuiltinGobo = (typeof BUILTIN_GOBOS)[number];

/** 内置图案引用的前缀。 */
const BUILTIN_PREFIX = "builtin:";

/**
 * 内置图案的引用（写进 `Capability.pattern`）。
 *
 * @param id 内置图案名。
 * @returns `builtin:<名称>`。
 */
export function builtinGoboRef(id: BuiltinGobo): string {
  return `${BUILTIN_PREFIX}${id}`;
}

/**
 * 解析图案引用。
 *
 * @param ref 引用。
 * @returns 内置图案、资源散列，或不合格时为 `null`。
 */
export function parseGoboRef(ref: string): { builtin: BuiltinGobo } | { hash: string } | null {
  if (ref.startsWith(BUILTIN_PREFIX)) {
    const id = ref.slice(BUILTIN_PREFIX.length);
    return (BUILTIN_GOBOS as readonly string[]).includes(id) ? { builtin: id as BuiltinGobo } : null;
  }
  return /^[0-9a-f]{64}$/.test(ref) ? { hash: ref } : null;
}

/** 关键词 → 内置图案；靠前的先匹配（更具体的放前面）。 */
const KEYWORDS: readonly [RegExp, BuiltinGobo][] = [
  [/beam\s*reduc|缩束|小光/i, "dot"],
  [/concentric|rings|同心/i, "rings"],
  [/stars|starfield|galaxy|星空|星星|繁星/i, "stars"],
  [/star|星/i, "star"],
  [/spiral|swirl|vortex|螺旋|漩涡|旋涡/i, "spiral"],
  [/honeycomb|hex|蜂窝|六边/i, "honeycomb"],
  [/flower|petal|rose|花/i, "flower"],
  [/sun|burst|ray|放射|太阳|光芒/i, "rays"],
  [/grid|mesh|net|网/i, "grid"],
  [/cross|十字/i, "cross"],
  [/triang|三角/i, "triangle"],
  [/square|rect|box|方/i, "square"],
  [/leaf|leaves|tree|forest|breakup|break-up|树|叶|林/i, "breakup"],
  [/wave|water|ocean|sea|水|波|浪/i, "waves"],
  [/flame|fire|火|焰/i, "flame"],
  [/moon|crescent|月/i, "moon"],
  [/shatter|crack|glass|ice|broken|碎|裂|冰|玻璃/i, "shatter"],
  [/bar|line|stripe|线|条|栅/i, "bars"],
  [/ring|circle|环|圈|圆/i, "ring"],
  [/dot|point|点/i, "dots"],
];

/** 名字像“开光”的槽位（不投射图案）。 */
const OPEN = /^\s*(open|no\s*gobo|none|white|开光|开|空|无图案|无)\s*$/i;

/** 匹配不到时按槽位序号轮流取的图案。 */
const FALLBACK_CYCLE: readonly BuiltinGobo[] = ["breakup", "dots", "flower", "rays", "shatter", "spiral", "honeycomb", "waves", "stars", "triangle"];

/**
 * 按槽位名猜一个内置图案。
 *
 * @param label 槽位名。
 * @param slotIndex 槽位序号（0 起，只数图案槽位），匹配不到时用来轮流取图案。
 * @returns 图案引用；开光槽位为 `null`。
 */
export function matchGobo(label: string, slotIndex: number): string | null {
  if (OPEN.test(label)) return null;
  for (const [re, id] of KEYWORDS) if (re.test(label)) return builtinGoboRef(id);
  const n = FALLBACK_CYCLE.length;
  return builtinGoboRef(FALLBACK_CYCLE[((slotIndex % n) + n) % n]);
}

/**
 * 一个能力区间是不是图案槽位（阶梯区间，且不是开光 / 关光 / 无功能 / 抖动等）。
 *
 * @param c 能力区间。
 * @returns 是否为图案槽位。
 */
export function isGoboSlot(c: Capability): boolean {
  if (c.proportional) return false;
  if (c.tag !== undefined && c.tag !== "slot") return false;
  return !OPEN.test(c.label);
}

/**
 * 图案通道里每个能力区间实际投射的图案。
 *
 * @param caps 能力区间（图案通道的）。
 * @returns 与 `caps` 同序：图案引用，或不投射时为 `null`。
 */
export function resolvePatterns(caps: readonly Capability[]): (string | null)[] {
  let slot = 0;
  return caps.map((c) => {
    if (!isGoboSlot(c)) return null;
    const i = slot++;
    if (c.pattern && parseGoboRef(c.pattern)) return c.pattern;
    return matchGobo(c.label, i);
  });
}

// ---------- 遮罩生成 ----------

/** 图案的带符号距离函数：参数为单位圆坐标 `u` / `v`（v 向上）、半径与角度，返回值为负时在透光区域内。 */
type Shape = (u: number, v: number, r: number, a: number) => number;

const TAU = Math.PI * 2;
const fract = (x: number) => x - Math.floor(x);

/** 确定性的伪随机数（mulberry32）。 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 平滑值噪声（格点哈希 + 双三次插值），返回 0~1。 */
function valueNoise(x: number, y: number): number {
  const hash = (i: number, j: number) => fract(Math.sin(i * 127.1 + j * 311.7) * 43758.5453);
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** 预先算好的随机点（星空、碎玻璃）。 */
const STAR_POINTS = (() => {
  const next = rng(7);
  return Array.from({ length: 28 }, () => {
    const r = Math.sqrt(next()) * 0.85;
    const a = next() * TAU;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r, s: 0.03 + next() * 0.05 };
  });
})();
const SHATTER_POINTS = (() => {
  const next = rng(11);
  return Array.from({ length: 18 }, () => ({ x: next() * 2 - 1, y: next() * 2 - 1 }));
})();

/** 各图案的带符号距离（单位圆坐标，v 向上）。 */
const SHAPES: Record<BuiltinGobo, Shape> = {
  dot: (_u, _v, r) => r - 0.35,
  dots: (u, v, r) => {
    let d = r - 0.14;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      d = Math.min(d, Math.hypot(u - Math.cos(a) * 0.6, v - Math.sin(a) * 0.6) - 0.15);
    }
    return d;
  },
  ring: (_u, _v, r) => Math.abs(r - 0.6) - 0.13,
  rings: (_u, _v, r) => (Math.abs(fract(r * 4.5) - 0.5) - 0.22) / 4.5,
  star: (_u, _v, r, a) => (r - (0.36 + 0.5 * Math.pow(Math.abs(Math.cos(2.5 * (a - Math.PI / 2))), 4))) * 0.7,
  stars: (u, v) => {
    let d = Infinity;
    for (const p of STAR_POINTS) d = Math.min(d, Math.hypot(u - p.x, v - p.y) - p.s);
    return d;
  },
  flower: (_u, _v, r, a) => (r - (0.5 + 0.32 * Math.cos(6 * a))) * 0.6,
  rays: (_u, _v, r, a) => Math.max(0.12 - r, (Math.abs(fract((a / TAU) * 12) - 0.5) - 0.24) * ((r * TAU) / 12)),
  spiral: (_u, _v, r, a) => Math.max(0.06 - r, (Math.abs(fract((a / TAU) * 3 + r * 2.2) - 0.5) - 0.22) * 0.5),
  bars: (u) => (Math.abs(fract(u * 3.5 + 0.5) - 0.5) - 0.2) / 3.5,
  grid: (u, v) => (Math.max(Math.abs(fract(u * 3.5 + 0.5) - 0.5), Math.abs(fract(v * 3.5 + 0.5) - 0.5)) - 0.36) / 3.5,
  cross: (u, v) => Math.min(Math.max(Math.abs(u) - 0.14, Math.abs(v) - 0.85), Math.max(Math.abs(v) - 0.14, Math.abs(u) - 0.85)),
  triangle: (u, v) => {
    // 等边三角形（Inigo Quilez 的距离函数），尖朝上
    const k = Math.sqrt(3);
    const s = 0.75;
    let x = Math.abs(u) - s;
    let y = v + s / k;
    if (x + k * y > 0) [x, y] = [(x - k * y) / 2, (-k * x - y) / 2];
    x -= Math.min(Math.max(x, -2 * s), 0);
    return -Math.hypot(x, y) * Math.sign(y);
  },
  square: (u, v) => Math.max(Math.abs(u), Math.abs(v)) - 0.55,
  honeycomb: (u, v) => {
    const k = 5;
    const px = u * k;
    const py = v * k;
    const rx = 1;
    const ry = Math.sqrt(3);
    const mod = (x: number, m: number) => x - m * Math.floor(x / m);
    const ax = mod(px, rx) - rx / 2;
    const ay = mod(py, ry) - ry / 2;
    const bx = mod(px - rx / 2, rx) - rx / 2;
    const by = mod(py - ry / 2, ry) - ry / 2;
    const [gx, gy] = ax * ax + ay * ay < bx * bx + by * by ? [ax, ay] : [bx, by];
    const hx = Math.abs(gx);
    const hy = Math.abs(gy);
    return (Math.max(hx, hx * 0.5 + hy * 0.866) - 0.42) / k;
  },
  breakup: (u, v) => {
    const n = 0.6 * valueNoise(u * 3 + 10, v * 3 + 10) + 0.3 * valueNoise(u * 7 + 3, v * 7 + 5) + 0.1 * valueNoise(u * 15, v * 15);
    return (0.5 - n) * 0.25;
  },
  waves: (u, v) => (Math.abs(fract(v * 3 + 0.18 * Math.sin(u * 7)) - 0.5) - 0.2) / 3,
  flame: (u, v) => {
    const top = -0.7 + 1.5 * Math.pow(Math.max(0, 1 - Math.abs(u) * 1.15), 1.6) * (0.72 + 0.28 * Math.sin(u * 13 + 1));
    return (v - top) * 0.5;
  },
  moon: (u, v) => Math.max(Math.hypot(u, v) - 0.62, -(Math.hypot(u - 0.3, v - 0.14) - 0.52)),
  shatter: (u, v) => {
    let d1 = Infinity;
    let d2 = Infinity;
    for (const p of SHATTER_POINTS) {
      const d = Math.hypot(u - p.x, v - p.y);
      if (d < d1) [d1, d2] = [d, d1];
      else if (d < d2) d2 = d;
    }
    return 0.03 - (d2 - d1) * 0.5;
  },
};

/**
 * 生成一个内置图案的遮罩（灰度，行优先，第一行在图案上方）。
 *
 * 图案外圈裁成圆形光阑；边缘按一个像素宽做抗锯齿。
 *
 * @param id 内置图案名。
 * @param size 边长（像素，夹到 16~1024）。
 * @returns `size × size` 字节，255 透光、0 遮光。
 */
export function goboMask(id: BuiltinGobo, size: number): Uint8Array {
  const n = Math.round(Math.min(1024, Math.max(16, size)));
  const out = new Uint8Array(n * n);
  const shape = SHAPES[id];
  const px = 2 / n;
  const cover = (d: number) => Math.min(1, Math.max(0, 0.5 - d / px));
  for (let y = 0; y < n; y++) {
    const v = 1 - (y + 0.5) * px;
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) * px - 1;
      const r = Math.hypot(u, v);
      if (r > 1) continue;
      const k = cover(shape(u, v, r, Math.atan2(v, u))) * cover(r - 0.97);
      out[y * n + x] = Math.round(k * 255);
    }
  }
  return out;
}
