import type { ShowProject } from "../lib/project";

/**
 * 短别名：发给模型的上下文里不出现 UUID，一律换成 `F1`、`G2`、`T3`、`C12`、`S1`、`M1`。
 *
 * 别名只由工程内容决定（灯具 / 分组 / 轨道按工程里的顺序，片段按起点、轨道顺序，段落按起点），
 * 同一份工程每次得到同样的别名，模型的回答可以复现，也便于回放测试。
 * 模型在同一批操作里新建的对象用 `new_<名字>` 引用（见 `compile.ts`）。
 */

/** 别名前缀与对象种类。 */
export const ALIAS_KINDS = { F: "fixture", G: "group", T: "track", C: "cue", S: "section", M: "marker" } as const;

/** 别名前缀。 */
export type AliasPrefix = keyof typeof ALIAS_KINDS;

/** 一份工程的别名表。 */
export interface AliasMap {
  /** 别名 → 真实 id */
  toId: ReadonlyMap<string, string>;
  /** 真实 id → 别名（不同种类的 id 互不重复，共用一张表） */
  toAlias: ReadonlyMap<string, string>;
}

/**
 * 为工程生成别名表。
 *
 * @param project 工程（只读）。
 * @returns 别名表。
 */
export function buildAliases(project: Pick<ShowProject, "fixtures" | "groups" | "tracks" | "cues" | "sections" | "markers">): AliasMap {
  const toId = new Map<string, string>();
  const toAlias = new Map<string, string>();
  const put = (prefix: AliasPrefix, ids: readonly string[]) =>
    ids.forEach((id, i) => {
      const alias = `${prefix}${i + 1}`;
      toId.set(alias, id);
      toAlias.set(id, alias);
    });
  put("F", project.fixtures.map((f) => f.id));
  put("G", project.groups.map((g) => g.id));
  put("T", project.tracks.map((t) => t.id));
  const trackIndex = new Map(project.tracks.map((t, i) => [t.id, i]));
  const cues = [...project.cues].sort(
    (a, b) => a.startMs - b.startMs || (trackIndex.get(a.trackId) ?? 0) - (trackIndex.get(b.trackId) ?? 0) || a.endMs - b.endMs,
  );
  put("C", cues.map((c) => c.id));
  put("S", [...project.sections].sort((a, b) => a.startMs - b.startMs).map((s) => s.id));
  put("M", [...project.markers].sort((a, b) => a.timeMs - b.timeMs).map((m) => m.id));
  return { toId, toAlias };
}

/**
 * 按别名取真实 id，并检查种类。
 *
 * @param aliases 别名表。
 * @param alias 别名（大小写不敏感）。
 * @param prefix 期望的种类；省略时不检查。
 * @returns 真实 id；不存在或种类不对时为 `null`。
 */
export function resolveAlias(aliases: AliasMap, alias: string, prefix?: AliasPrefix): string | null {
  const a = alias.trim().toUpperCase();
  if (prefix && !a.startsWith(prefix)) return null;
  return aliases.toId.get(a) ?? null;
}

/**
 * 真实 id 的别名。
 *
 * @param aliases 别名表。
 * @param id 真实 id。
 * @returns 别名；没有时为 `"?"`。
 */
export function aliasOf(aliases: AliasMap, id: string): string {
  return aliases.toAlias.get(id) ?? "?";
}
