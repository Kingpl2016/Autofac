import type { UniverseSnapshot, UniverseSource } from "@/shared/domain/engine";
import { compareIp } from "@/shared/lib/ip";

/** 活动宇宙的展示形式。 */
export type UniverseViewMode = "cards" | "table";


/** 卡片视图最多渲染的宇宙数；超过时提示改用表格。 */
export const UNIVERSE_CARD_LIMIT = 60;

/** 单张卡片最多直接列出的来源数，其余折叠为“+N”。 */
export const CARD_SOURCE_LIMIT = 4;


/**
 * 把 15 位 Port-Address 拆成 `Net:Sub:Uni`。
 *
 * @param universe 15 位 Port-Address。
 * @returns 形如 `0:1:3` 的字符串。
 */
export function portAddress(universe: number): string {
  return `${(universe >> 8) & 0x7f}:${(universe >> 4) & 0x0f}:${universe & 0x0f}`;
}

/**
 * 取要展示的来源列表（按 IP 自然排序）。
 *
 * 优先用引擎给出的逐源统计；没有时（例如回放产生的虚拟宇宙）退回 `sourceIps`，速率记为 0。
 *
 * @param u 宇宙快照。
 * @returns 排好序的来源统计。
 */
export function sourcesOf(u: UniverseSnapshot): UniverseSource[] {
  const list: UniverseSource[] =
    u.sources.length > 0
      ? [...u.sources]
      : u.sourceIps.map((ip) => ({ ip, packets: 0, packetRate: 0 }));
  return list.sort((a, b) => compareIp(a.ip, b.ip));
}

/**
 * 按视图形式截取要渲染的宇宙。
 *
 * @param universes 全部活动宇宙。
 * @param view 展示形式；表格不截取。
 * @param limit 卡片视图的上限，默认 {@link UNIVERSE_CARD_LIMIT}。
 * @returns 要渲染的宇宙与被隐藏的数量。
 */
export function visibleUniverses(
  universes: readonly UniverseSnapshot[],
  view: UniverseViewMode,
  limit: number = UNIVERSE_CARD_LIMIT,
): { items: readonly UniverseSnapshot[]; hidden: number } {
  if (view === "table" || universes.length <= limit) {
    return { items: universes, hidden: 0 };
  }
  return { items: universes.slice(0, limit), hidden: universes.length - limit };
}