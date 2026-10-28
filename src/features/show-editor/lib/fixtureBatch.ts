import { newId } from "./ids";
import { createGroup } from "./ops";
import { DMX_CHANNELS, MAX_UNIVERSE, type PatchAddress, type ShowProject } from "./project";
import { setFixturePlacement } from "./stageOps";
import { setFixtureMode } from "./universeOps";

/**
 * 多台灯具的批量操作：以一台为准同步设置、按模板重命名、选同型号、编组、补建轨道。
 *
 * 编辑操作在 immer 草稿上执行（一次调用 = 一步撤销）。
 */

/** 可同步的设置项。 */
export const SYNC_FIELDS = ["mode", "height", "rotation", "hanging", "mirrors"] as const;

/** 一项可同步的设置。 */
export type SyncField = (typeof SYNC_FIELDS)[number];

/** 默认同步的设置项（镜像会改输出地址，默认不同步）。 */
export const DEFAULT_SYNC_FIELDS: readonly SyncField[] = ["mode", "height", "rotation", "hanging"];

/** 同步的结果。 */
export interface SyncResult {
  /** 实际修改的灯具数 */
  changed: number;
  /** 因型号不同而跳过模式同步的灯具数 */
  modeSkipped: number;
}

/**
 * 把 `sourceId` 的设置同步到其它灯具。
 *
 * - 模式：只同步到同型号的灯具（不同型号的模式不通用）；
 * - 安装高度、朝向、倒装：直接复制（没有舞台位置的灯会先固定在自动排布位置上）；
 * - 镜像：按相对地址复制（源灯的镜像比源灯地址偏移多少，目标灯的镜像也偏移多少；越界的跳过）。
 *
 * @param d 工程草稿。
 * @param sourceId 作为基准的灯具。
 * @param targetIds 要同步的灯具（含基准灯时忽略它）。
 * @param fields 要同步的设置项。
 * @returns 修改数与跳过数；基准灯不存在时都为 0。
 */
export function syncFixtures(
  d: ShowProject,
  sourceId: string,
  targetIds: readonly string[],
  fields: readonly SyncField[],
): SyncResult {
  const src = d.fixtures.find((f) => f.id === sourceId);
  const result: SyncResult = { changed: 0, modeSkipped: 0 };
  if (!src || fields.length === 0) return result;
  const want = new Set(fields);
  const targets = [...new Set(targetIds)].filter((id) => id !== sourceId && d.fixtures.some((f) => f.id === id));
  if (targets.length === 0) return result;
  const before = new Map(targets.map((id) => [id, JSON.stringify(d.fixtures.find((f) => f.id === id))]));

  if (want.has("mode")) {
    for (const id of targets) {
      const f = d.fixtures.find((x) => x.id === id);
      if (!f) continue;
      if (f.modelId !== src.modelId) result.modeSkipped += 1;
      else setFixtureMode(d, id, src.modeId);
    }
  }
  const placement: Parameters<typeof setFixturePlacement>[2] = {};
  if (want.has("height")) placement.z = src.stage?.z ?? 0;
  if (want.has("rotation")) placement.rotation = src.stage?.rotation ?? 0;
  if (want.has("hanging")) placement.hanging = src.stage?.hanging === true;
  if (Object.keys(placement).length > 0) setFixturePlacement(d, targets, placement);

  if (want.has("mirrors")) {
    const offsets = (src.mirrors ?? []).map((m) => ({ du: m.universe - src.universe, da: m.address - src.address }));
    for (const id of targets) {
      const f = d.fixtures.find((x) => x.id === id);
      if (!f) continue;
      const mirrors: PatchAddress[] = offsets
        .map((o) => ({ universe: f.universe + o.du, address: f.address + o.da }))
        .filter((m) => m.universe >= 0 && m.universe <= MAX_UNIVERSE && m.address >= 1 && m.address <= DMX_CHANNELS);
      if (mirrors.length > 0) f.mirrors = mirrors;
      else delete f.mirrors;
    }
  }

  for (const id of targets) {
    if (before.get(id) !== JSON.stringify(d.fixtures.find((f) => f.id === id))) result.changed += 1;
  }
  return result;
}

/**
 * 按模板批量重命名：`{n}` 替换为序号，`{name}` 替换为原名；模板里没有 `{n}` 时在末尾补上序号。
 *
 * @param d 工程草稿。
 * @param ids 灯具（按给定顺序编号）。
 * @param pattern 名称模板，例如 `前排 {n}`。
 * @param start 起始序号。
 * @returns 改名的灯具数；模板为空时为 0。
 */
export function renameByPattern(d: ShowProject, ids: readonly string[], pattern: string, start = 1): number {
  const tpl = pattern.trim();
  if (tpl === "") return 0;
  const withN = tpl.includes("{n}") ? tpl : `${tpl} {n}`;
  let n = 0;
  for (const [i, id] of [...new Set(ids)].entries()) {
    const f = d.fixtures.find((x) => x.id === id);
    if (!f) continue;
    const name = withN.replaceAll("{n}", String(start + i)).replaceAll("{name}", f.name).trim();
    if (name !== "" && name !== f.name) {
      f.name = name;
      n += 1;
    }
  }
  return n;
}

/**
 * 与给定灯具同型号的全部灯具（按 Patch 顺序）。
 *
 * @param project 工程（只读）。
 * @param ids 参照的灯具。
 * @returns 灯具 id；参照灯不存在时为空。
 */
export function sameModelIds(project: Pick<ShowProject, "fixtures">, ids: readonly string[]): string[] {
  const models = new Set(project.fixtures.filter((f) => ids.includes(f.id)).map((f) => f.modelId));
  return project.fixtures.filter((f) => models.has(f.modelId)).map((f) => f.id);
}

/**
 * 轨道对应的灯具（只取灯具轨道）。
 *
 * @param project 工程（只读）。
 * @param trackIds 轨道。
 * @returns 灯具 id（按轨道顺序、去重）。
 */
export function fixturesOfTracks(project: Pick<ShowProject, "tracks">, trackIds: readonly string[]): string[] {
  const set = new Set(trackIds);
  const out: string[] = [];
  for (const t of project.tracks) {
    if (set.has(t.id) && t.target.kind === "fixture" && !out.includes(t.target.id)) out.push(t.target.id);
  }
  return out;
}

/**
 * 灯具对应的灯具轨道。
 *
 * @param project 工程（只读）。
 * @param fixtureIds 灯具。
 * @returns 轨道 id（按轨道顺序）。
 */
export function tracksOfFixtures(project: Pick<ShowProject, "tracks">, fixtureIds: readonly string[]): string[] {
  const set = new Set(fixtureIds);
  return project.tracks.filter((t) => t.target.kind === "fixture" && set.has(t.target.id)).map((t) => t.id);
}

/**
 * 把灯具编成一组（成员按 Patch 顺序）。
 *
 * @param d 工程草稿。
 * @param name 分组名。
 * @param fixtureIds 成员。
 * @returns 新分组 id；不足 2 台时为 `null`。
 */
export function groupFixtures(d: ShowProject, name: string, fixtureIds: readonly string[]): string | null {
  const set = new Set(fixtureIds);
  return createGroup(
    d,
    name,
    d.fixtures.filter((f) => set.has(f.id)).map((f) => f.id),
  );
}

/**
 * 为没有轨道的灯具补建轨道（旧工程或外部编辑后可能出现）。
 *
 * @param d 工程草稿。
 * @returns 新建的轨道数。
 */
export function ensureFixtureTracks(d: ShowProject): number {
  const has = new Set(d.tracks.flatMap((t) => (t.target.kind === "fixture" ? [t.target.id] : [])));
  let n = 0;
  for (const f of d.fixtures) {
    if (has.has(f.id)) continue;
    d.tracks.push({ id: newId(), target: { kind: "fixture", id: f.id }, mute: false, solo: false, lock: false });
    n += 1;
  }
  return n;
}
