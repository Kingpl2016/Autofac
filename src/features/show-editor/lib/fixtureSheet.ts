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
        });
      }
      return cells;
    };
    const base = { name: f.name, modelName: model?.name ?? f.modelId, address: `U${f.universe} @${f.address}` };
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
