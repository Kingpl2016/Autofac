import type { ShowProject } from "./project";

/**
 * 撤销历史的描述：比较相邻两个工程快照，说出“这一步做了什么”（历史面板用）。
 *
 * 撤销栈只保存工程快照（immer 结构共享），不记录操作名；这里按集合的增删改推断，
 * 一步里改了多类对象时取最有代表性的那一类（片段 > 灯具 > 分组 > …）。
 */

/** 参与比较的集合（按代表性排序）。 */
export const HISTORY_COLLECTIONS = [
  "cues",
  "mediaClips",
  "fixtures",
  "groups",
  "sections",
  "markers",
  "presets",
  "media",
  "mediaTracks",
  "tracks",
] as const;

/** 集合名。 */
export type HistoryCollection = (typeof HISTORY_COLLECTIONS)[number];

/** 其它（非集合）改动的类别。 */
export type HistoryOther = "tempo" | "stage" | "output" | "loop" | "duration" | "info" | "other";

/** 一步的描述。 */
export type HistoryChange =
  | { kind: "collection"; collection: HistoryCollection; op: "added" | "removed" | "changed"; count: number }
  | { kind: HistoryOther };

/**
 * 描述从 `prev` 到 `next` 的改动。
 *
 * @param prev 改动前的工程。
 * @param next 改动后的工程。
 * @returns 描述。
 */
export function describeChange(prev: ShowProject, next: ShowProject): HistoryChange {
  for (const collection of HISTORY_COLLECTIONS) {
    const a = prev[collection] as readonly { id: string }[];
    const b = next[collection] as readonly { id: string }[];
    if (a === b) continue;
    const before = new Map(a.map((x) => [x.id, x]));
    const after = new Set(b.map((x) => x.id));
    const added = b.filter((x) => !before.has(x.id)).length;
    const removed = a.filter((x) => !after.has(x.id)).length;
    // 结构共享：没改的对象引用不变
    const changed = b.filter((x) => before.has(x.id) && before.get(x.id) !== x).length;
    if (added > 0 && removed === 0) return { kind: "collection", collection, op: "added", count: added };
    if (removed > 0 && added === 0) return { kind: "collection", collection, op: "removed", count: removed };
    if (added + removed + changed > 0) {
      return { kind: "collection", collection, op: "changed", count: Math.max(changed, added, removed) };
    }
    // 只是顺序变了：继续看下一类
  }
  if (prev.tempo !== next.tempo) return { kind: "tempo" };
  if (prev.stage !== next.stage) return { kind: "stage" };
  if (prev.output !== next.output) return { kind: "output" };
  if (prev.loopRange !== next.loopRange) return { kind: "loop" };
  if (prev.durationMs !== next.durationMs) return { kind: "duration" };
  if (prev.name !== next.name || prev.notes !== next.notes) return { kind: "info" };
  return { kind: "other" };
}

/**
 * 描述的文案键与插值参数。
 *
 * @param change 描述。
 * @returns `editor.history.*` 下的键与参数。
 */
export function changeLabelKey(change: HistoryChange): { key: string; count?: number } {
  if (change.kind === "collection") return { key: `editor.history.${change.collection}.${change.op}`, count: change.count };
  return { key: `editor.history.${change.kind}` };
}
