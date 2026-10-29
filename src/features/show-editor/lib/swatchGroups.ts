import { layoutOf } from "@/features/fixtures";
import { analyzePatch, footprintOf, universeUsage } from "./patch";
import type { PatchAddress, Rgb, ShowProject } from "./project";
import type { SwatchGroupBy } from "../stores/useEditorPrefsStore";

/**
 * 预览色块的分区（纯数据）：按 Universe（默认，区内按地址）、按灯具分组（成员顺序）或按型号。
 * 界面按分区渲染，Shift 连选按“屏幕上的显示顺序”（`visibleOrder`）计算。
 */

/** 分区里的一台灯具。 */
export interface SwatchItem {
  fixtureId: string;
  name: string;
  universe: number;
  /** 起始地址 */
  address: number;
  /** 末尾通道 */
  end: number;
  /** 地址与别的灯具重叠或超出 512 */
  conflict: boolean;
  /** 多重配接的镜像地址 */
  mirrors: readonly PatchAddress[];
  /** 占用的通道里有通道锁定（Park） */
  parked: boolean;
  /** 型号名（搜索用） */
  modelName: string;
}

/** 区内排序：按起始地址（按 Universe 分区时），或按舞台位置（从上到下、从左到右，与舞台监视器一致）。 */
export type SwatchSort = "address" | "stage";

/** 分区选项。 */
export interface SwatchSectionOptions {
  /** 区内排序；默认 `address`（分组区保持成员顺序、型号区保持 Patch 顺序） */
  sort?: SwatchSort;
  /** 灯具在舞台上的位置（按舞台排序时用；没有位置的排在最后） */
  positions?: ReadonlyMap<string, { x: number; y: number }>;
}

/** 一个分区。 */
export interface SwatchSection {
  /** 稳定键，例如 `u:0`、`g:<分组 id>`、`m:<型号 id>`、`ungrouped` */
  key: string;
  /** 标题（Universe 为 `U0`；“未分组”区为空串，由界面本地化） */
  title: string;
  /** 副标题（Universe 名称 / 型号的厂商系列，可为空） */
  subtitle: string;
  /** 区头的识别色（Universe 表里设的颜色） */
  color: Rgb | null;
  /** 按 Universe 分区时：已用通道数 */
  used: number | null;
  /** 有问题的灯具数 */
  conflicts: number;
  /** “未分组”区 */
  ungrouped: boolean;
  items: SwatchItem[];
}

/**
 * 按给定方式分区。
 *
 * - `universe`：每个有灯具（主地址）的 Universe 一区，编号升序，区内按起始地址；
 * - `group`：每个分组一区（成员顺序），一台灯可在多个区；不属于任何分组的灯放在最后的“未分组”区；
 * - `model`：每个型号一区（按型号在 Patch 里首次出现的顺序），区内按 Patch 顺序。
 *
 * @param project 工程（只读）。
 * @param by 分区方式。
 * @returns 分区（没有灯具时为空；空分组不出现）。
 */
export function swatchSections(
  project: Pick<ShowProject, "fixtures" | "fixtureModels" | "groups"> & {
    output: Pick<ShowProject["output"], "universes"> & Partial<Pick<ShowProject["output"], "park">>;
  },
  by: SwatchGroupBy,
  opts: SwatchSectionOptions = {},
): SwatchSection[] {
  const status = analyzePatch(project);
  const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
  const park = project.output.park ?? [];
  const itemOf = new Map<string, SwatchItem>(
    project.fixtures.map((f) => {
      const st = status.get(f.id);
      const width = footprintOf(models.get(f.modelId), f.modeId);
      const end = f.address + width - 1;
      return [
        f.id,
        {
          fixtureId: f.id,
          name: f.name,
          universe: f.universe,
          address: f.address,
          end,
          conflict: (st?.conflictsWith.length ?? 0) > 0 || st?.overflow === true,
          mirrors: f.mirrors ?? [],
          parked: park.some((p) => p.universe === f.universe && p.channel >= f.address && p.channel <= end),
          modelName: models.get(f.modelId)?.name ?? f.modelId,
        },
      ];
    }),
  );
  // 按舞台位置排序：先按 y 再按 x；没有位置的保持原顺序排在最后
  const byStage = (items: SwatchItem[]): SwatchItem[] => {
    if (opts.sort !== "stage" || !opts.positions) return items;
    const pos = opts.positions;
    return items
      .map((it, i) => ({ it, i, p: pos.get(it.fixtureId) }))
      .sort((a, b) => {
        if (!a.p || !b.p) return a.p ? -1 : b.p ? 1 : a.i - b.i;
        return a.p.y - b.p.y || a.p.x - b.p.x || a.i - b.i;
      })
      .map((x) => x.it);
  };
  const section = (
    key: string,
    title: string,
    items: SwatchItem[],
    extra: Partial<Pick<SwatchSection, "subtitle" | "color" | "used" | "ungrouped">> = {},
  ): SwatchSection => ({
    key,
    title,
    subtitle: extra.subtitle ?? "",
    color: extra.color ?? null,
    used: extra.used ?? null,
    conflicts: items.filter((it) => it.conflict).length,
    ungrouped: extra.ungrouped ?? false,
    items,
  });

  if (by === "universe") {
    const usage = universeUsage(project);
    const configs = new Map(project.output.universes.map((u) => [u.universe, u]));
    const universes = [...new Set(project.fixtures.map((f) => f.universe))].sort((a, b) => a - b);
    return universes.map((u) => {
      const items = project.fixtures
        .filter((f) => f.universe === u)
        .map((f) => itemOf.get(f.id) as SwatchItem)
        .sort((a, b) => a.address - b.address || a.name.localeCompare(b.name));
      const cfg = configs.get(u);
      return section(`u:${u}`, `U${u}`, byStage(items), { subtitle: cfg?.label ?? "", color: cfg?.color ?? null, used: usage.get(u) ?? 0 });
    });
  }

  if (by === "group") {
    const grouped = new Set<string>();
    const out: SwatchSection[] = [];
    for (const g of project.groups) {
      const items = g.fixtureIds.flatMap((id) => {
        const it = itemOf.get(id);
        return it ? [it] : [];
      });
      if (items.length === 0) continue;
      for (const it of items) grouped.add(it.fixtureId);
      out.push(section(`g:${g.id}`, g.name, byStage(items)));
    }
    const rest = project.fixtures.filter((f) => !grouped.has(f.id)).map((f) => itemOf.get(f.id) as SwatchItem);
    if (rest.length > 0) out.push(section("ungrouped", "", byStage(rest), { ungrouped: true }));
    return out;
  }

  const byModel = new Map<string, SwatchItem[]>();
  for (const f of project.fixtures) {
    const list = byModel.get(f.modelId) ?? [];
    list.push(itemOf.get(f.id) as SwatchItem);
    byModel.set(f.modelId, list);
  }
  return [...byModel].map(([modelId, items]) => {
      const m = models.get(modelId);
      return section(`m:${modelId}`, m?.name ?? modelId, byStage(items), { subtitle: m?.productType ?? "" });
    });
}

/**
 * 屏幕上的显示顺序（Shift 连选用）：按分区依次排开，跳过折叠的分区，同一台灯只算第一次出现。
 *
 * @param sections 分区。
 * @param collapsed 折叠的分区键。
 * @returns 灯具 id。
 */
export function visibleOrder(sections: readonly SwatchSection[], collapsed: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sections) {
    if (collapsed.has(s.key)) continue;
    for (const it of s.items) {
      if (seen.has(it.fixtureId)) continue;
      seen.add(it.fixtureId);
      out.push(it.fixtureId);
    }
  }
  return out;
}

/**
 * 点选的结果：单击只选这一台，Ctrl / ⌘ 追加或取消，Shift 在显示顺序上从锚点连选到这一台
 * （同时按 Ctrl 时并入原选择）。
 *
 * @param order 显示顺序。
 * @param selected 当前选择。
 * @param anchor 上次点选的灯（Shift 连选的起点）。
 * @param id 点到的灯。
 * @param mods 修饰键。
 * @returns 新的选择。
 */
export function pickSwatch(
  order: readonly string[],
  selected: readonly string[],
  anchor: string | null,
  id: string,
  mods: { shift: boolean; toggle: boolean },
): string[] {
  const a = anchor ? order.indexOf(anchor) : -1;
  const b = order.indexOf(id);
  if (mods.shift && a >= 0 && b >= 0) {
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    return mods.toggle ? [...new Set([...selected, ...range])] : range;
  }
  if (mods.toggle) return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
  return [id];
}

/** 色块筛选：全部、只看选中、只看编程器里有值、只看有冲突。 */
export const SWATCH_FILTERS = ["all", "selected", "programmed", "conflict"] as const;

/** 色块筛选。 */
export type SwatchFilter = (typeof SWATCH_FILTERS)[number];

/**
 * 地址搜索词：`@12`（任意 Universe 的地址 12）或 `1.12` / `1:12`（Universe 1 地址 12）。
 *
 * @param q 已去掉首尾空白的小写搜索词。
 * @returns 解析结果；不是地址写法时为 `null`。
 */
function parseAddressQuery(q: string): { universe: number | null; address: number } | null {
  const at = /^@(\d+)$/.exec(q);
  if (at) return { universe: null, address: Number(at[1]) };
  const ua = /^(\d+)[.:](\d+)$/.exec(q);
  if (ua) return { universe: Number(ua[1]), address: Number(ua[2]) };
  return null;
}

/**
 * 按搜索词与筛选条件过滤分区：空的分区不显示。
 *
 * 搜索词匹配名称、型号（不区分大小写），或地址写法（`@12`、`1.12`：落在灯具占用的通道范围内即命中）。
 *
 * @param sections 分区。
 * @param query 搜索词（空串为不搜索）。
 * @param filter 筛选条件。
 * @param ctx 选中与编程器里有值的灯具 id（已归并到整灯）。
 * @returns 过滤后的分区（分区统计不变，只过滤灯具）。
 */
export function filterSwatchSections(
  sections: readonly SwatchSection[],
  query: string,
  filter: SwatchFilter,
  ctx: { selected: ReadonlySet<string>; programmed: ReadonlySet<string> },
): SwatchSection[] {
  const q = query.trim().toLowerCase();
  const addr = q ? parseAddressQuery(q) : null;
  const matches = (it: SwatchItem) => {
    if (filter === "selected" && !ctx.selected.has(it.fixtureId)) return false;
    if (filter === "programmed" && !ctx.programmed.has(it.fixtureId)) return false;
    if (filter === "conflict" && !it.conflict) return false;
    if (!q) return true;
    if (addr) return (addr.universe === null || addr.universe === it.universe) && addr.address >= it.address && addr.address <= it.end;
    return it.name.toLowerCase().includes(q) || it.modelName.toLowerCase().includes(q);
  };
  if (!q && filter === "all") return [...sections];
  return sections.flatMap((s) => {
    const items = s.items.filter(matches);
    return items.length > 0 ? [{ ...s, items }] : [];
  });
}

/** 色块标签：名称（含地址）、地址、强度百分比、HEX 色值，或不显示。 */
export const SWATCH_LABELS = ["name", "address", "level", "hex", "none"] as const;

/** 色块标签。 */
export type SwatchLabel = (typeof SWATCH_LABELS)[number];

/**
 * 色块下方的标签文字。
 *
 * @param label 标签方式。
 * @param it 灯具。
 * @param rgb 当前颜色。
 * @returns 文字；`none` 时为空串。
 */
export function swatchLabelText(label: SwatchLabel, it: SwatchItem, rgb: Rgb): string {
  switch (label) {
    case "name":
      return it.name;
    case "address":
      return `U${it.universe} @${it.address}`;
    case "level":
      return `${Math.round((Math.max(...rgb) / 255) * 100)}%`;
    case "hex":
      return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    case "none":
      return "";
  }
}

/**
 * 正在频闪的灯具：快门通道当前的 DMX 值落在标注为“频闪”的能力区间里（OFL 的 `ShutterStrobe`）。
 *
 * @param project 工程（只读）。
 * @param frameOf 取某个 Universe 当前的 512 字节；没有输出时为 `null`。
 * @returns 灯具 id。
 */
export function strobingFixtures(
  project: Pick<ShowProject, "fixtures" | "fixtureModels">,
  frameOf: (universe: number) => ArrayLike<number> | null,
): Set<string> {
  const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
  const out = new Set<string>();
  for (const f of project.fixtures) {
    const model = models.get(f.modelId);
    const layout = model ? (layoutOf(model, f.modeId) ?? []) : [];
    const shutter = [...layout].sort((a, b) => (a.head ?? 0) - (b.head ?? 0)).find((p) => p.function === "shutter");
    if (!shutter?.capabilities?.some((c) => c.tag === "strobe")) continue;
    const frame = frameOf(f.universe);
    if (!frame) continue;
    const at = f.address + shutter.channel - 2;
    const hi = frame[at] ?? 0;
    const dmx = shutter.width === 2 ? (shutter.bigEndian ? hi * 256 + (frame[at + 1] ?? 0) : hi + (frame[at + 1] ?? 0) * 256) : hi;
    const cap = shutter.capabilities.find((c) => dmx >= c.range[0] && dmx <= c.range[1]);
    if (cap?.tag === "strobe") out.add(f.id);
  }
  return out;
}
