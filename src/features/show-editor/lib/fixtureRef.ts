import { layoutOf, type FixtureModel } from "@/features/fixtures";
import { MIN_GROUP_SIZE, type FixtureInstance, type ShowProject } from "./project";

/**
 * 灯具引用：分组成员、灯具轨道与场景条目里的“灯具 id”。
 *
 * - 整灯：灯具实例 id（例如 `f12`）；对多头 / 像素灯，整灯引用包含它的全部像素。
 * - 像素：`灯具id#像素号`（例如 `f12#3`），像素号与物模型通道的 `head` 一致（1 起）。
 *
 * 灯具 id 由 `newId()` 生成（UUID），不含 `#`，所以 `#` 可以无歧义地分隔像素号。
 */

/** 灯具 id 与像素号之间的分隔符。 */
export const PIXEL_SEPARATOR = "#";

/** 解析后的引用。 */
export interface ParsedRef {
  /** 灯具实例 id */
  fixtureId: string;
  /** 像素号；整灯为 `null` */
  head: number | null;
}

/**
 * 解析一个引用。
 *
 * @param ref 引用。
 * @returns 灯具 id 与像素号（像素号不是正整数时按整灯处理）。
 */
export function parseRef(ref: string): ParsedRef {
  const at = ref.lastIndexOf(PIXEL_SEPARATOR);
  if (at <= 0) return { fixtureId: ref, head: null };
  const head = Number(ref.slice(at + 1));
  return Number.isInteger(head) && head > 0 ? { fixtureId: ref.slice(0, at), head } : { fixtureId: ref, head: null };
}

/**
 * 由灯具 id 与像素号拼出引用。
 *
 * @param fixtureId 灯具实例 id。
 * @param head 像素号；省略为整灯。
 * @returns 引用。
 */
export function refOf(fixtureId: string, head?: number | null): string {
  return head ? `${fixtureId}${PIXEL_SEPARATOR}${head}` : fixtureId;
}

/**
 * 引用所属的灯具 id。
 *
 * @param ref 引用。
 * @returns 灯具实例 id。
 */
export function baseOf(ref: string): string {
  return parseRef(ref).fixtureId;
}

/**
 * 是否是像素引用。
 *
 * @param ref 引用。
 */
export function isPixelRef(ref: string): boolean {
  return parseRef(ref).head !== null;
}

/**
 * 模型某个模式里用到的像素号（只有声明了矩阵的模型才有像素）。
 *
 * @param model 模型。
 * @param modeId 模式；省略为默认模式。
 * @returns 升序的像素号；单头灯为空。
 */
export function headsOf(model: FixtureModel | undefined, modeId?: string): number[] {
  if (!model?.matrix) return [];
  const heads = new Set((layoutOf(model, modeId) ?? []).map((p) => p.head ?? 0).filter((h) => h > 0));
  return [...heads].sort((a, b) => a - b);
}

/**
 * 灯具在当前模式下的像素引用。
 *
 * @param project 工程（只读）。
 * @param fixture 灯具。
 * @returns 像素引用（升序）；单头灯为空。
 */
export function pixelRefsOf(project: Pick<ShowProject, "fixtureModels">, fixture: FixtureInstance): string[] {
  const model = project.fixtureModels.find((m) => m.id === fixture.modelId);
  return headsOf(model, fixture.modeId).map((h) => refOf(fixture.id, h));
}

/**
 * 引用是否有效：灯具存在；像素引用的像素号在灯具当前模式里存在。
 *
 * @param project 工程（只读）。
 * @param ref 引用。
 */
export function refExists(project: Pick<ShowProject, "fixtures" | "fixtureModels">, ref: string): boolean {
  const { fixtureId, head } = parseRef(ref);
  const fixture = project.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return false;
  if (head === null) return true;
  const model = project.fixtureModels.find((m) => m.id === fixture.modelId);
  return headsOf(model, fixture.modeId).includes(head);
}

/**
 * 引用的显示名：整灯为灯具名，像素为“灯具名 · P3”。
 *
 * @param project 工程（只读）。
 * @param ref 引用。
 * @returns 显示名；灯具不存在时为空串。
 */
export function refName(project: Pick<ShowProject, "fixtures">, ref: string): string {
  const { fixtureId, head } = parseRef(ref);
  const name = project.fixtures.find((f) => f.id === fixtureId)?.name ?? "";
  return head === null || name === "" ? name : `${name} · P${head}`;
}

/**
 * 清理失效的像素引用（灯具换模式或模型快照更新后像素变少）：从分组里移除、删除像素轨道及其片段、
 * 删除场景条目。分组成员少于 2 个时由调用方按分组不变量处理（见 `ops.ts` 的 `prunePixelRefs`）。
 *
 * @param project 工程（只读）。
 * @param refs 要检查的引用。
 * @returns 失效的引用。
 */
export function staleRefs(project: Pick<ShowProject, "fixtures" | "fixtureModels">, refs: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const r of refs) if (isPixelRef(r) && !refExists(project, r)) out.add(r);
  return out;
}

/**
 * 清理工程里失效的像素引用：从分组里移除（成员少于 [`MIN_GROUP_SIZE`] 的分组连同轨道一并删除）、
 * 删除绑定失效像素的轨道及其片段、删除场景条目。在换模式、更新模型快照、删除灯具之后调用（同一次撤销步骤）。
 *
 * @param draft 工程草稿。
 * @returns 被清理的引用。
 */
export function prunePixelRefs(draft: ShowProject): Set<string> {
  const used = [
    ...draft.groups.flatMap((g) => g.fixtureIds),
    ...draft.tracks.flatMap((t) => (t.target.kind === "fixture" ? [t.target.id] : [])),
    ...draft.cues.flatMap((c) => (c.kind === "scene" ? c.entries.map((e) => e.fixtureId) : [])),
  ];
  const stale = staleRefs(draft, used);
  if (stale.size === 0) return stale;
  const goneTracks = new Set(draft.tracks.filter((t) => t.target.kind === "fixture" && stale.has(t.target.id)).map((t) => t.id));
  for (const g of draft.groups) g.fixtureIds = g.fixtureIds.filter((id) => !stale.has(id));
  const goneGroups = new Set(draft.groups.filter((g) => g.fixtureIds.length < MIN_GROUP_SIZE).map((g) => g.id));
  for (const t of draft.tracks) if (t.target.kind === "group" && goneGroups.has(t.target.id)) goneTracks.add(t.id);
  draft.groups = draft.groups.filter((g) => !goneGroups.has(g.id));
  draft.tracks = draft.tracks.filter((t) => !goneTracks.has(t.id));
  draft.cues = draft.cues.filter((c) => !goneTracks.has(c.trackId));
  for (const c of draft.cues) if (c.kind === "scene") c.entries = c.entries.filter((e) => !stale.has(e.fixtureId));
  return stale;
}
