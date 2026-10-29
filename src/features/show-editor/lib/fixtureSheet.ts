import {
  ATTRIBUTE_GROUPS,
  CHANNEL_FUNCTIONS,
  groupOf,
  isEmitter,
  layoutOf,
  type ChannelFunction,
  type FixtureProperty,
} from "@/features/fixtures";
import { headsOf, refOf } from "./fixtureRef";
import { paramHead } from "./looks";
import type { AttrKey, EmitterKey, ShowProject } from "./project";
import type { ProgrammerValues } from "./programmer";

/**
 * 灯具表（Fixture Sheet，调光台的电子表格视图）：每台灯一行、每种功能一列，显示播放头时刻的实际输出，
 * 编程器里有值的单元格高亮；编辑单元格写入编程器。
 */

/** 可以作为非颜色属性写入编程器的功能（与 `AttrKey` 一致）。 */
const ATTR_FUNCTIONS: ReadonlySet<ChannelFunction> = new Set<ChannelFunction>([
  "pan",
  "tilt",
  "speed",
  "shutter",
  "colorWheel",
  "colorWheelRotate",
  "cyan",
  "magenta",
  "yellow",
  "colorTemp",
  "gobo",
  "goboRotate",
  "goboShake",
  "prism",
  "prismRotate",
  "frost",
  "focus",
  "zoom",
  "iris",
  "blade",
  "bladeRotate",
  "rotation",
  "macro",
  "reset",
  "fog",
  "effectSpeed",
  "maintenance",
]);

/** 单元格写入编程器的方式。 */
export type CellTarget =
  | { kind: "intensity" }
  | { kind: "emitter"; key: EmitterKey }
  | { kind: "attr"; key: AttrKey }
  | { kind: "readonly" };

/**
 * 功能对应的编程器写入方式。
 *
 * @param fn 功能。
 * @returns 写入方式；开关、其它等功能只读。
 */
export function cellTarget(fn: ChannelFunction): CellTarget {
  if (fn === "dimmer") return { kind: "intensity" };
  if (isEmitter(fn)) return { kind: "emitter", key: fn as EmitterKey };
  if (ATTR_FUNCTIONS.has(fn)) return { kind: "attr", key: fn as AttrKey };
  return { kind: "readonly" };
}

/** 一个单元格。 */
export interface SheetCell {
  fn: ChannelFunction;
  /** 通道对象名 */
  name: string;
  /** 实际输出的 DMX 值（16 位属性为 0~65535） */
  dmx: number;
  /** 该通道的满值（255 或 65535） */
  max: number;
  /** 属性值（0~1，已撤销反向，与编程器 / 外观的取值一致） */
  fraction: number;
  /** 编程器里有这个值 */
  programmed: boolean;
  /** 通道反向（DMX 读数换算属性值时用） */
  invert: boolean;
}

/** 一行：一台灯（整灯），或展开后多头 / 像素灯的一个像素。 */
export interface SheetRow {
  /** 灯具引用：整灯为灯具 id，像素为 `灯具id#n`（与选择、编程器的键一致） */
  fixtureId: string;
  /** 像素号；整灯行为 `null` */
  head: number | null;
  /** 整灯行：这台灯的像素数（单头灯为 0）；像素行为 0 */
  pixels: number;
  /** 灯具名 */
  name: string;
  modelName: string;
  /** `U1 @12` */
  address: string;
  /** Universe 与起始地址（按地址排序用） */
  universe: number;
  startAddress: number;
  /**
   * 功能 → 单元格。整灯行：同一功能有多个通道对象时取整灯本体的，本体没有时取第一个像素的（代表值）；
   * 像素行：只有这个像素的通道。
   */
  cells: Map<ChannelFunction, SheetCell>;
}

/** 某层是否在编程器里。 */
function programmedLayer(values: ProgrammerValues, fixtureId: string, fn: ChannelFunction): boolean {
  const look = values[fixtureId];
  if (!look) return false;
  const target = cellTarget(fn);
  switch (target.kind) {
    case "intensity":
      return look.intensity !== undefined;
    case "emitter":
      return look.color !== undefined;
    case "attr":
      return look.attrs?.[target.key] !== undefined;
    case "readonly":
      return false;
  }
}

/**
 * 生成灯具表。
 *
 * @param project 工程（只读）。
 * @param frameOf 取工程内某个 Universe 当前的 512 字节；没有输出时返回 `null`（按 0 显示）。
 * @param values 编程器内容（键为灯具或像素引用）。
 * @param expanded 展开像素行的灯具 id；省略时只有整灯行（每台灯一行，与 `project.fixtures` 一一对应）。
 * @returns 工程顺序的行：每台灯一行整灯行，展开的灯紧跟各像素行。
 */
export function buildSheet(
  project: Pick<ShowProject, "fixtures" | "fixtureModels">,
  frameOf: (universe: number) => ArrayLike<number> | null,
  values: ProgrammerValues,
  expanded: ReadonlySet<string> = new Set(),
): SheetRow[] {
  const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
  return project.fixtures.flatMap((f) => {
    const model = models.get(f.modelId);
    const layout = model ? (layoutOf(model, f.modeId) ?? []) : [];
    const frame = frameOf(f.universe);
    const heads = headsOf(model, f.modeId);
    /** 由通道对象生成单元格（同一功能只取第一个）。 */
    const cellsOf = (props: readonly FixtureProperty[], ref: string) => {
      const cells = new Map<ChannelFunction, SheetCell>();
      for (const p of props) {
        if (cells.has(p.function)) continue;
        const at = f.address + p.channel - 2;
        const byte = (i: number) => (frame && at + i >= 0 && at + i < 512 ? (frame[at + i] ?? 0) : 0);
        const dmx = p.width === 2 ? (p.bigEndian ? byte(0) * 256 + byte(1) : byte(0) + byte(1) * 256) : byte(0);
        const max = p.width === 2 ? 65535 : 255;
        const raw = dmx / max;
        cells.set(p.function, {
          fn: p.function,
          name: p.name,
          dmx,
          max,
          fraction: p.invert ? 1 - raw : raw,
          programmed: programmedLayer(values, ref, p.function),
          invert: p.invert === true,
        });
      }
      return cells;
    };
    const base = { name: f.name, modelName: model?.name ?? f.modelId, address: `U${f.universe} @${f.address}`, universe: f.universe, startAddress: f.address };
    // 整灯行：整灯本体的通道对象优先（像素头的同名功能不重复成列）
    const ordered = [...layout].sort((a, b) => (a.head ?? 0) - (b.head ?? 0));
    const whole: SheetRow = { ...base, fixtureId: f.id, head: null, pixels: heads.length, cells: cellsOf(ordered, f.id) };
    if (!expanded.has(f.id)) return [whole];
    const pixelRows = heads.map((h): SheetRow => {
      const ref = refOf(f.id, h);
      return { ...base, fixtureId: ref, head: h, pixels: 0, cells: cellsOf(layout.filter((p) => p.head === h), ref) };
    });
    return [whole, ...pixelRows];
  });
}

/**
 * 表格的列：出现过的功能，按属性组（强度 → 颜色 → 位置 → 光束 → 聚焦 → 控制）再按功能表顺序排列。
 *
 * @param rows 灯具表的行。
 * @returns 功能列表。
 */
export function sheetColumns(rows: readonly SheetRow[]): ChannelFunction[] {
  const present = new Set<ChannelFunction>();
  for (const r of rows) for (const fn of r.cells.keys()) present.add(fn);
  const rank = (fn: ChannelFunction) =>
    ATTRIBUTE_GROUPS.indexOf(groupOf(fn)) * 100 + CHANNEL_FUNCTIONS.indexOf(fn);
  return [...present].sort((a, b) => rank(a) - rank(b));
}

/**
 * 编程器里某台灯手动发光体的当前值（只在颜色是“按发光体”时有意义），用于在已有基础上改一路。
 *
 * @param values 编程器内容。
 * @param fixtureId 灯具 id。
 * @returns 发光体 → 0~1。
 */
export function manualEmitters(values: ProgrammerValues, fixtureId: string): Partial<Record<EmitterKey, number>> {
  const color = paramHead(values[fixtureId]?.color);
  return color?.kind === "manual" ? { ...color.values } : {};
}

/**
 * 单元格的读数方式（参考 grandMA3 Fixture Sheet 的 Readout）：
 * 百分比、两位小数的百分比、8 位 DMX（16 位通道取高字节）、16 位 DMX（8 位通道按 ×257 换算）、十六进制。
 */
export const SHEET_READOUTS = ["percent", "percentFine", "dmx8", "dmx16", "hex"] as const;

/** 单元格的读数方式。 */
export type SheetReadout = (typeof SHEET_READOUTS)[number];

/**
 * 按读数方式显示一个单元格。
 *
 * 百分比显示属性值（已撤销反向，与编程器一致）；DMX 与十六进制显示通道上实际输出的原始值。
 *
 * @param cell 单元格。
 * @param mode 读数方式。
 * @returns 显示文字。
 */
export function formatCell(cell: Pick<SheetCell, "dmx" | "max" | "fraction">, mode: SheetReadout): string {
  const wide = cell.max > 255;
  switch (mode) {
    case "percent":
      return String(Math.round(cell.fraction * 100));
    case "percentFine":
      return (cell.fraction * 100).toFixed(2);
    case "dmx8":
      return String(wide ? Math.floor(cell.dmx / 256) : cell.dmx);
    case "dmx16":
      return String(wide ? cell.dmx : cell.dmx * 257);
    case "hex":
      return cell.dmx.toString(16).toUpperCase().padStart(wide ? 4 : 2, "0");
  }
}

/**
 * 把按读数方式输入的文字换成属性值（0~1，已撤销反向，写入编程器用）。
 *
 * 百分比按 0~100；8 位 DMX 按 0~255；16 位 DMX 按 0~65535；十六进制按通道宽度（8 位 0~FF，16 位 0~FFFF，可带 `#` / `0x`）。
 * 超出范围的夹到范围内。
 *
 * @param text 输入。
 * @param cell 单元格（通道宽度与是否反向）。
 * @param mode 读数方式。
 * @returns 属性值；无法解析时为 `null`。
 */
export function parseCell(text: string, cell: Pick<SheetCell, "max" | "invert">, mode: SheetReadout): number | null {
  const s = text.trim().replace(",", ".");
  if (s === "") return null;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const fromRaw = (raw: number) => {
    const r = clamp01(raw);
    return cell.invert ? 1 - r : r;
  };
  if (mode === "percent" || mode === "percentFine") {
    const n = Number(s.replace(/%$/, ""));
    return Number.isFinite(n) ? clamp01(n / 100) : null;
  }
  if (mode === "hex") {
    const h = s.replace(/^(#|0x)/i, "");
    if (!/^[0-9a-f]{1,4}$/i.test(h)) return null;
    return fromRaw(parseInt(h, 16) / (cell.max > 255 ? 65535 : 255));
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return fromRaw(n / (mode === "dmx16" ? 65535 : 255));
}

/** 只看哪些灯：全部、选中的、编程器里有值的（grandMA3 的 Prog Only）。 */
export const SHEET_FILTERS = ["all", "selected", "programmed"] as const;

/** 只看哪些灯。 */
export type SheetFilter = (typeof SHEET_FILTERS)[number];

/** 行的排序：工程顺序、名称、地址。 */
export const SHEET_SORTS = ["project", "name", "address"] as const;

/** 行的排序。 */
export type SheetSort = (typeof SHEET_SORTS)[number];

/** 筛选条件。 */
export interface SheetView {
  /** 搜索词：名称、型号、地址（`U1 @12`、`@12`、`1.12` 都可以） */
  query: string;
  filter: SheetFilter;
  sort: SheetSort;
  /** 选中的引用的所属灯具 id（整灯） */
  selected: ReadonlySet<string>;
  /** 编程器里有值的引用的所属灯具 id（整灯） */
  programmed: ReadonlySet<string>;
}

/** 行的所属灯具 id（像素引用去掉 `#n`）。 */
const baseId = (ref: string) => ref.split("#")[0];

/**
 * 地址搜索：`@12` 为任意 Universe 的地址 12，`1.12` 为 Universe 1 地址 12。
 *
 * @param q 搜索词。
 * @param row 整灯行。
 * @returns 是否按地址命中；不是地址写法时为 `null`。
 */
function addressMatch(q: string, row: SheetRow): boolean | null {
  const at = /^@(\d+)$/.exec(q);
  if (at) return row.startAddress === Number(at[1]);
  const dotted = /^(\d+)\.(\d+)$/.exec(q);
  if (dotted) return row.universe === Number(dotted[1]) && row.startAddress === Number(dotted[2]);
  return null;
}

/**
 * 按搜索 / 筛选 / 排序整理灯具表的行。整灯行和它展开的像素行作为一个整体参与筛选和排序（像素行始终跟在整灯行后）。
 *
 * @param rows {@link buildSheet} 的结果（工程顺序）。
 * @param view 条件。
 * @returns 整理后的行。
 */
export function arrangeSheetRows(rows: readonly SheetRow[], view: SheetView): SheetRow[] {
  const units: SheetRow[][] = [];
  for (const r of rows) {
    if (r.head === null || units.length === 0) units.push([r]);
    else units[units.length - 1].push(r);
  }
  const q = view.query.trim().toLowerCase();
  const kept = units.filter((unit) => {
    const whole = unit[0];
    const id = baseId(whole.fixtureId);
    if (view.filter === "selected" && !view.selected.has(id)) return false;
    if (view.filter === "programmed" && !view.programmed.has(id)) return false;
    if (!q) return true;
    const byAddress = addressMatch(q, whole);
    if (byAddress !== null) return byAddress;
    return [whole.name, whole.modelName, whole.address].some((s) => s.toLowerCase().includes(q));
  });
  if (view.sort === "name") {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    kept.sort((a, b) => collator.compare(a[0].name, b[0].name));
  } else if (view.sort === "address") {
    kept.sort((a, b) => a[0].universe - b[0].universe || a[0].startAddress - b[0].startAddress);
  }
  return kept.flat();
}

/**
 * 按属性组隐藏列。
 *
 * @param columns {@link sheetColumns} 的结果。
 * @param hidden 隐藏的属性组。
 * @returns 剩下的列（顺序不变）。
 */
export function visibleColumns(columns: readonly ChannelFunction[], hidden: ReadonlySet<string>): ChannelFunction[] {
  return columns.filter((fn) => !hidden.has(groupOf(fn)));
}
