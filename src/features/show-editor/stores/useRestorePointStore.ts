import { z } from "zod";
import { create } from "zustand";

import { aiHistoryLibraryPath, aiHistoryRead, aiHistoryWrite } from "@/features/ai";
import { makeRestorePoint, pushPoint, reapplyPoint, restoreBefore, revertPoint, type RestorePoint, type RestoreResult } from "../ai/restorePoints";
import type { ShowProject } from "../lib/project";
import type { DocumentOrigin } from "./useDocumentStore";
import { useProjectStore } from "./useProjectStore";

/**
 * AI 改动的还原点（每个工程最多 20 个，保存在数据目录 `ai-history/restore-<散列>.ai.json`，
 * 与对话记录分开：清空对话不会丢还原点）。还原操作都是一步撤销。
 */

interface RestoreState {
  points: RestorePoint[];
  path: string | null;
  generation: number;
  /**
   * 记下一次 AI 改动（写入后调用）。
   *
   * @param before 写入前的工程。
   * @param after 写入后的工程。
   * @param meta 说明与来源。
   */
  record: (before: ShowProject, after: ShowProject, meta: { summary: string; source: RestorePoint["source"]; sourceId?: string }) => void;
  /** 清空还原点（恢复默认用）。 */
  clear: () => void;
}

/** 文件格式版本。 */
const FILE_VERSION = 1;

const fileSchema = z.object({
  version: z.literal(FILE_VERSION),
  points: z
    .array(
      z.looseObject({
        id: z.string(),
        at: z.number(),
        summary: z.string(),
        source: z.enum(["chat", "draft", "suggestion"]),
        changes: z.array(z.looseObject({ key: z.string(), kind: z.enum(["items", "value"]) })),
        state: z.enum(["applied", "reverted"]),
        sourceId: z.string().optional().catch(undefined),
        cueCount: z.number().catch(0),
      }),
    )
    .catch([]),
});

let timer: ReturnType<typeof setTimeout> | null = null;

/** 写盘（有路径时）。 */
async function flush(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const { path, points } = useRestorePointStore.getState();
  if (!path) return;
  await aiHistoryWrite(path, JSON.stringify({ version: FILE_VERSION, points })).catch(() => undefined);
}

/** 稍后写盘（连续改动合并成一次）。 */
function scheduleSave(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flush(), 800);
}

/** 还原点。 */
export const useRestorePointStore = create<RestoreState>((set, get) => ({
  points: [],
  path: null,
  generation: -1,
  record: (before, after, meta) => {
    const point = makeRestorePoint(before, after, meta);
    if (!point) return;
    set({ points: pushPoint(get().points, point) });
    scheduleSave();
  },
  clear: () => {
    set({ points: [] });
    scheduleSave();
  },
}));

/** 路径的稳定散列（与对话记录相同的算法）。 */
function pathKey(path: string): string {
  const s = path.replace(/\\/g, "/").toLowerCase();
  let h1 = 0x811c_9dc5;
  let h2 = 0x0100_0193;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x0100_0193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x0100_0193 ^ 0x5bd1_e995) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/**
 * 工程的还原点文件路径。
 *
 * @param origin 工程来源。
 * @returns 路径；还没保存过的工程为 `null`。
 */
async function restorePath(origin: DocumentOrigin): Promise<string | null> {
  if (origin.kind === "none") return null;
  return aiHistoryLibraryPath(`restore-${origin.kind}-${pathKey(origin.path)}`);
}

/**
 * 换了工程：先写盘旧工程的还原点，再读入新工程的。
 *
 * @param generation 新工程的代次。
 * @param origin 新工程的来源。
 */
export async function switchRestorePoints(generation: number, origin: DocumentOrigin): Promise<void> {
  if (useRestorePointStore.getState().generation === generation) return;
  await flush();
  const path = await restorePath(origin).catch(() => null);
  useRestorePointStore.setState({ points: [], path, generation });
  if (!path) return;
  const text = await aiHistoryRead(path).catch(() => null);
  if (useRestorePointStore.getState().generation !== generation || !text) return;
  try {
    const parsed = fileSchema.safeParse(JSON.parse(text));
    if (parsed.success) useRestorePointStore.setState({ points: parsed.data.points as unknown as RestorePoint[] });
  } catch {
    // 损坏的文件当作没有还原点
  }
}

/**
 * 同一个工程换了保存位置（第一次保存 / 另存为）：还原点跟着搬过去。
 *
 * @param origin 新来源。
 */
export async function moveRestorePoints(origin: DocumentOrigin): Promise<void> {
  const path = await restorePath(origin).catch(() => null);
  useRestorePointStore.setState({ path });
  if (path && useRestorePointStore.getState().points.length > 0) await flush();
}

/** 把结果写进工程（只替换变了的顶层字段，一步撤销）。 */
function commit(r: RestoreResult): void {
  const store = useProjectStore.getState();
  const base = store.project;
  if (r.next === base) return;
  store.update((d) => {
    for (const key of Object.keys(r.next) as (keyof ShowProject)[]) {
      if (r.next[key] !== base[key]) (d as unknown as Record<string, unknown>)[key] = r.next[key];
    }
  });
}

/** 改还原点的状态。 */
function mark(ids: readonly string[], state: RestorePoint["state"]): void {
  const set = new Set(ids);
  useRestorePointStore.setState((s) => ({ points: s.points.map((p) => (set.has(p.id) ? { ...p, state } : p)) }));
  scheduleSave();
}

/**
 * 只撤回这一次改动（之后又手动改过的部分跳过）。
 *
 * @param id 还原点 id。
 * @returns 结果；还原点不存在或已撤回时为 `null`。
 */
export function revertRestorePoint(id: string): RestoreResult | null {
  const point = useRestorePointStore.getState().points.find((p) => p.id === id);
  if (!point || point.state !== "applied") return null;
  const r = revertPoint(useProjectStore.getState().project, point);
  commit(r);
  mark([id], "reverted");
  return r;
}

/**
 * 恢复到这次改动之前（这一次及之后的 AI 改动全部改回）。
 *
 * @param id 还原点 id。
 * @returns 结果；还原点不存在时为 `null`。
 */
export function restoreBeforePoint(id: string): (RestoreResult & { reverted: string[] }) | null {
  const { points } = useRestorePointStore.getState();
  if (!points.some((p) => p.id === id)) return null;
  const r = restoreBefore(useProjectStore.getState().project, points, id);
  commit(r);
  mark(r.reverted, "reverted");
  return r;
}

/**
 * 重新应用撤回过的改动（之后又改过的部分跳过）。
 *
 * @param id 还原点 id。
 * @returns 结果；还原点不存在或没撤回时为 `null`。
 */
export function reapplyRestorePoint(id: string): RestoreResult | null {
  const point = useRestorePointStore.getState().points.find((p) => p.id === id);
  if (!point || point.state !== "reverted") return null;
  const r = reapplyPoint(useProjectStore.getState().project, point);
  commit(r);
  mark([id], "applied");
  return r;
}

/**
 * 撤回对话里一组工具调用写入的改动（从新到旧，只撤回仍是“已应用”的；之后手动改过的部分跳过）。
 *
 * @param sourceIds 工具调用 id。
 * @returns 撤回的还原点 id（从旧到新）与跳过的处数。
 */
export function revertSources(sourceIds: ReadonlySet<string>): { ids: string[]; skipped: number } {
  const targets = useRestorePointStore
    .getState()
    .points.filter((p) => p.sourceId && sourceIds.has(p.sourceId) && p.state === "applied")
    .reverse();
  let skipped = 0;
  const ids: string[] = [];
  for (const p of targets) {
    const r = revertRestorePoint(p.id);
    if (r) {
      skipped += r.skipped;
      ids.unshift(p.id);
    }
  }
  return { ids, skipped };
}

/**
 * 重新应用一组还原点（从旧到新；撤销“回退”时用）。
 *
 * @param ids 还原点 id。
 */
export function reapplyPoints(ids: readonly string[]): void {
  for (const id of ids) reapplyRestorePoint(id);
}

/** 测试用：立即写盘。 */
export const flushRestorePoints = flush;
