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
  project: Pick<ShowProject, "fixtures" | "fixtureModels" | "groups"> & { output: Pick<ShowProject["output"], "universes"> },
  by: SwatchGroupBy,
): SwatchSection[] {
  const status = analyzePatch(project);
  const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
  const itemOf = new Map<string, SwatchItem>(
    project.fixtures.map((f) => {
      const st = status.get(f.id);
      const width = footprintOf(models.get(f.modelId), f.modeId);
      return [
        f.id,
        {
          fixtureId: f.id,
          name: f.name,
          universe: f.universe,
          address: f.address,
          end: f.address + width - 1,
          conflict: (st?.conflictsWith.length ?? 0) > 0 || st?.overflow === true,
          mirrors: f.mirrors ?? [],
        },
      ];
    }),
  );
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
      return section(`u:${u}`, `U${u}`, items, { subtitle: cfg?.label ?? "", color: cfg?.color ?? null, used: usage.get(u) ?? 0 });
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
      out.push(section(`g:${g.id}`, g.name, items));
    }
    const rest = project.fixtures.filter((f) => !grouped.has(f.id)).map((f) => itemOf.get(f.id) as SwatchItem);
    if (rest.length > 0) out.push(section("ungrouped", "", rest, { ungrouped: true }));
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
      return section(`m:${modelId}`, m?.name ?? modelId, items, { subtitle: m?.productType ?? "" });
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
