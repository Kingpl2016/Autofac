import type { FixtureModel } from "@/features/fixtures";
import { newId } from "./ids";
import { footprintOf, nextFreeSlot } from "./patch";
import {
  DMX_CHANNELS,
  MAX_UNIVERSE,
  type FixtureGroup,
  type FixtureInstance,
  type MediaRef,
  type OutputSettings,
  type ShowProject,
  type Tempo,
  type Track,
} from "./project";
import { MAX_BPM, MIN_BPM } from "./tempo";
import { clamp, snapToFrame } from "./time";

/**
 * 对工程的纯编辑操作。
 *
 * 所有函数都直接修改传入的 `draft`，调用方在 immer 的 `produce` / store 的 `set` 里使用，
 * 因此每次调用都会产生一个新的不可变快照，撤销重做按快照回退。
 */

/** 一次最多添加的灯具数量。 */
export const MAX_ADD_COUNT = 128;

/** 分组的最少成员数。 */
export const MIN_GROUP_SIZE = 2;

/**
 * 轨道显示名：取自它绑定的灯具或分组。
 *
 * @param project 工程（只读）。
 * @param track 轨道。
 * @returns 灯具 / 分组名；对象已不存在时为空串。
 */
export function trackName(project: Pick<ShowProject, "fixtures" | "groups">, track: Track): string {
  const target = track.target;
  switch (target.kind) {
    case "fixture":
      return project.fixtures.find((f) => f.id === target.id)?.name ?? "";
    case "group":
      return project.groups.find((g) => g.id === target.id)?.name ?? "";
    case "scene":
      return track.name ?? "";
  }
}

/**
 * 轨道驱动的灯具（分组按成员顺序；场景轨道为其片段涉及的灯具并集，按首次出现排序）。
 *
 * @param project 工程（只读）。
 * @param track 轨道。
 * @returns 灯具实例 id 列表（只含工程里存在的灯具）。
 */
export function trackFixtureIds(
  project: Pick<ShowProject, "fixtures" | "groups" | "cues">,
  track: Track,
): string[] {
  const known = new Set(project.fixtures.map((f) => f.id));
  const target = track.target;
  let ids: string[];
  switch (target.kind) {
    case "fixture":
      ids = [target.id];
      break;
    case "group":
      ids = project.groups.find((g) => g.id === target.id)?.fixtureIds ?? [];
      break;
    case "scene": {
      const seen = new Set<string>();
      ids = [];
      for (const c of project.cues) {
        if (c.trackId !== track.id || c.kind !== "scene") continue;
        for (const e of c.entries) {
          if (!seen.has(e.fixtureId)) {
            seen.add(e.fixtureId);
            ids.push(e.fixtureId);
          }
        }
      }
      break;
    }
  }
  return ids.filter((id) => known.has(id));
}

/**
 * 把模型快照放进工程；已有同编号快照时以最新定义覆盖。
 *
 * @param draft 工程草稿。
 * @param model 素材库里的模型。
 */
function upsertModel(draft: ShowProject, model: FixtureModel): void {
  const copy = structuredClone(model);
  const index = draft.fixtureModels.findIndex((m) => m.id === model.id);
  if (index >= 0) draft.fixtureModels[index] = copy;
  else draft.fixtureModels.push(copy);
}

/** 删掉没有任何灯具使用的模型快照，保持工程文件精简。 */
function pruneModels(draft: ShowProject): void {
  const used = new Set(draft.fixtures.map((f) => f.modelId));
  draft.fixtureModels = draft.fixtureModels.filter((m) => used.has(m.id));
}

/**
 * 添加若干个同一模型的灯具，自动分配地址并为每个灯具创建一条轨道。
 *
 * 地址从最后一个灯具所在的 Universe 起，首次适配；放不下的整个 Universe 范围内都找不到时，
 * 停止添加（返回已添加的部分）。
 *
 * @param draft 工程草稿。
 * @param model 要添加的模型。
 * @param count 数量，夹在 `1..=`[`MAX_ADD_COUNT`]。
 * @returns 新增灯具的 id（按添加顺序）。
 */
export function addFixtures(draft: ShowProject, model: FixtureModel, count: number): string[] {
  upsertModel(draft, model);
  const footprint = footprintOf(model);
  const total = clamp(Math.floor(count), 1, MAX_ADD_COUNT);
  const existing = draft.fixtures.filter((f) => f.modelId === model.id).length;
  const added: string[] = [];
  for (let i = 0; i < total; i += 1) {
    const last = draft.fixtures.at(-1);
    const slot = nextFreeSlot(draft, footprint, last?.universe ?? 0);
    if (!slot) break;
    const fixture: FixtureInstance = {
      id: newId(),
      name: `${model.name} ${existing + i + 1}`,
      modelId: model.id,
      universe: slot.universe,
      address: slot.address,
    };
    draft.fixtures.push(fixture);
    draft.tracks.push({
      id: newId(),
      target: { kind: "fixture", id: fixture.id },
      mute: false,
      solo: false,
      lock: false,
    });
    added.push(fixture.id);
  }
  return added;
}

/**
 * 删除一个轨道及其上的全部 Cue。
 *
 * @param draft 工程草稿。
 * @param trackId 轨道 id。
 */
function removeTrack(draft: ShowProject, trackId: string): void {
  draft.tracks = draft.tracks.filter((t) => t.id !== trackId);
  draft.cues = draft.cues.filter((c) => c.trackId !== trackId);
}

/**
 * 删除分组及其轨道（含轨道上的 Cue）。
 *
 * @param draft 工程草稿。
 * @param groupId 分组 id。
 */
export function removeGroup(draft: ShowProject, groupId: string): void {
  for (const t of draft.tracks.filter((x) => x.target.kind === "group" && x.target.id === groupId)) {
    removeTrack(draft, t.id);
  }
  draft.groups = draft.groups.filter((g) => g.id !== groupId);
}

/**
 * 删除灯具：连同它的轨道、Cue，并从分组里移除；成员删空的分组一并删除。
 *
 * @param draft 工程草稿。
 * @param ids 要删除的灯具 id。
 */
export function removeFixtures(draft: ShowProject, ids: readonly string[]): void {
  const gone = new Set(ids);
  for (const t of draft.tracks.filter((x) => x.target.kind === "fixture" && gone.has(x.target.id))) {
    removeTrack(draft, t.id);
  }
  draft.fixtures = draft.fixtures.filter((f) => !gone.has(f.id));
  for (const g of draft.groups) g.fixtureIds = g.fixtureIds.filter((id) => !gone.has(id));
  // 分组的不变量：至少 2 个成员，否则分组及其轨道一并删除
  for (const g of draft.groups.filter((x) => x.fixtureIds.length < MIN_GROUP_SIZE)) {
    removeGroup(draft, g.id);
  }
  pruneModels(draft);
}

/**
 * 重命名灯具。
 *
 * @param draft 工程草稿。
 * @param id 灯具 id。
 * @param name 新名称（首尾空白会去除；为空则忽略）。
 */
export function renameFixture(draft: ShowProject, id: string, name: string): void {
  const trimmed = name.trim();
  const fixture = draft.fixtures.find((f) => f.id === id);
  if (fixture && trimmed !== "") fixture.name = trimmed;
}

/**
 * 修改灯具的 DMX 地址；超出范围的值会被夹回合法范围（Universe 0~2047，地址 1~512）。
 *
 * @param draft 工程草稿。
 * @param id 灯具 id。
 * @param universe 新 Universe。
 * @param address 新起始地址。
 */
export function setFixtureAddress(
  draft: ShowProject,
  id: string,
  universe: number,
  address: number,
): void {
  const fixture = draft.fixtures.find((f) => f.id === id);
  if (!fixture) return;
  fixture.universe = clamp(Math.floor(universe) || 0, 0, MAX_UNIVERSE);
  fixture.address = clamp(Math.floor(address) || 1, 1, DMX_CHANNELS);
}

/**
 * 把若干灯具编成一组，并为分组创建一条轨道。
 *
 * @param draft 工程草稿。
 * @param name 分组名（界面传入本地化后的默认名）；为空时退化为 `G<序号>`。
 * @param fixtureIds 成员灯具 id（按给定顺序，忽略不存在的和重复的）。
 * @returns 新分组的 id；有效成员不足 2 个时不创建并返回 `null`。
 */
export function createGroup(
  draft: ShowProject,
  name: string,
  fixtureIds: readonly string[],
): string | null {
  const valid = new Set(draft.fixtures.map((f) => f.id));
  const members = [...new Set(fixtureIds)].filter((id) => valid.has(id));
  if (members.length < MIN_GROUP_SIZE) return null;
  const group: FixtureGroup = {
    id: newId(),
    name: name.trim() || `G${draft.groups.length + 1}`,
    fixtureIds: members,
  };
  draft.groups.push(group);
  draft.tracks.push({
    id: newId(),
    target: { kind: "group", id: group.id },
    mute: false,
    solo: false,
    lock: false,
  });
  return group.id;
}

/**
 * 在 `timeMs` 处添加一个标记点。
 *
 * @param draft 工程草稿。
 * @param timeMs 时间（毫秒），夹在 `[0, durationMs]` 并对齐到帧。
 * @param label 标签（界面传入本地化后的默认名）；为空时退化为 `M<序号>`。
 * @returns 新标记的 id；同一时间点（同一帧）已有标记时不重复添加，返回 `null`。
 */
export function addMarker(draft: ShowProject, timeMs: number, label = ""): string | null {
  const time = clamp(snapToFrame(timeMs), 0, draft.durationMs);
  if (draft.markers.some((m) => m.timeMs === time)) return null;
  const marker = { id: newId(), timeMs: time, label: label.trim() || `M${draft.markers.length + 1}` };
  draft.markers.push(marker);
  draft.markers.sort((a, b) => a.timeMs - b.timeMs);
  return marker.id;
}

/**
 * 移动标记点。
 *
 * @param draft 工程草稿。
 * @param id 标记 id。
 * @param timeMs 新时间（毫秒），夹在 `[0, durationMs]` 并对齐到帧。
 * @returns 是否移动成功；目标帧已有别的标记时拒绝。
 */
export function moveMarker(draft: ShowProject, id: string, timeMs: number): boolean {
  const marker = draft.markers.find((m) => m.id === id);
  if (!marker) return false;
  const time = clamp(snapToFrame(timeMs), 0, draft.durationMs);
  if (draft.markers.some((m) => m.id !== id && m.timeMs === time)) return false;
  marker.timeMs = time;
  draft.markers.sort((a, b) => a.timeMs - b.timeMs);
  return true;
}

/**
 * 重命名标记点。
 *
 * @param draft 工程草稿。
 * @param id 标记 id。
 * @param label 新标签（首尾空白会去除；为空则忽略）。
 */
export function renameMarker(draft: ShowProject, id: string, label: string): void {
  const trimmed = label.trim();
  const marker = draft.markers.find((m) => m.id === id);
  if (marker && trimmed !== "") marker.label = trimmed;
}

/**
 * 删除标记点。
 *
 * @param draft 工程草稿。
 * @param id 标记 id。
 */
export function removeMarker(draft: ShowProject, id: string): void {
  draft.markers = draft.markers.filter((m) => m.id !== id);
}

/**
 * 设置（或清除）节拍。数值会被夹到合法范围：BPM 20~300，每小节 1~16 拍。
 *
 * @param draft 工程草稿。
 * @param tempo 新节拍；`null` 表示不使用节拍网格。
 */
export function setTempo(draft: ShowProject, tempo: Tempo | null): void {
  draft.tempo = tempo
    ? {
        bpm: clamp(Math.round(tempo.bpm * 10) / 10, MIN_BPM, MAX_BPM),
        offsetMs: Math.round(tempo.offsetMs),
        beatsPerBar: clamp(Math.round(tempo.beatsPerBar), 1, 16),
      }
    : null;
}

/** 节目总时长的上限（毫秒）：24 小时，与工程文件校验一致。 */
export const MAX_DURATION_MS = 24 * 3600 * 1000;

/**
 * 把音视频素材引用加入素材库。已引用同一路径的素材不会重复加入。
 *
 * @param draft 工程草稿。
 * @param media 素材引用（`id` 由调用方生成）。
 * @returns 实际加入的素材 id；该路径已经被引用时为 `null`。
 */
export function addMedia(draft: ShowProject, media: MediaRef): string | null {
  if (draft.media.some((m) => m.path === media.path)) return null;
  const { id, kind, path, name, durationMs } = media;
  draft.media.push({ id, kind, path, name, durationMs });
  return media.id;
}

/**
 * 从素材库移除素材引用，连同时间线上用到它的片段（不会删除磁盘上的文件）。
 *
 * @param draft 工程草稿。
 * @param id 素材 id。
 */
export function removeMedia(draft: ShowProject, id: string): void {
  draft.media = draft.media.filter((m) => m.id !== id);
  draft.mediaClips = draft.mediaClips.filter((c) => c.mediaId !== id);
}

/**
 * 重新链接素材（原文件被移动或删除后指向新文件）。更新路径、名称、类型与时长；
 * 新文件更短时裁短用到它的片段（裁完不足 100 ms 的片段删除）。类型变了（音频 ↔ 视频）时，
 * 片段移到同类的新轨道上由调用方处理，这里只删除类型不符的片段。
 *
 * @param draft 工程草稿。
 * @param id 素材 id。
 * @param next 新文件的信息。
 * @returns 是否成功；素材不存在，或新路径已被另一个素材引用时为 `false`。
 */
export function relinkMedia(
  draft: ShowProject,
  id: string,
  next: Pick<MediaRef, "path" | "name" | "kind" | "durationMs">,
): boolean {
  const media = draft.media.find((m) => m.id === id);
  if (!media) return false;
  if (draft.media.some((m) => m.id !== id && m.path === next.path)) return false;
  Object.assign(media, next);
  const trackKind = new Map(draft.mediaTracks.map((t) => [t.id, t.kind]));
  draft.mediaClips = draft.mediaClips.filter((c) => {
    if (c.mediaId !== id) return true;
    if (trackKind.get(c.trackId) !== next.kind) return false;
    c.durationMs = Math.min(c.durationMs, next.durationMs - c.inMs);
    c.fadeInMs = Math.min(c.fadeInMs, Math.max(0, c.durationMs));
    c.fadeOutMs = Math.min(c.fadeOutMs, Math.max(0, c.durationMs - c.fadeInMs));
    return c.durationMs >= 100;
  });
  return true;
}

/**
 * 让节目总时长至少覆盖到某个时刻（导入比节目更长的音乐时自动延长）。
 *
 * @param draft 工程草稿。
 * @param endMs 需要覆盖到的时刻（毫秒）。
 * @returns 是否延长了节目时长。
 */
export function ensureDuration(draft: ShowProject, endMs: number): boolean {
  const wanted = Math.min(MAX_DURATION_MS, Math.ceil(endMs));
  if (wanted <= draft.durationMs) return false;
  draft.durationMs = wanted;
  return true;
}
/** Gamma 的取值范围。 */
export const MIN_GAMMA = 1;
export const MAX_GAMMA = 3;

/** 输出延迟补偿的取值范围（毫秒）。 */
export const MAX_LATENCY_COMP_MS = 1000;

/**
 * 修改输出设置。数值会被夹到合法范围：Gamma 1.0~3.0（保留 1 位小数），延迟补偿 ±1000 ms。
 *
 * @param draft 工程草稿。
 * @param patch 要修改的字段；省略的字段保持不变。
 */
export function setOutput(draft: ShowProject, patch: Partial<OutputSettings>): void {
  const next = { ...draft.output, ...patch };
  draft.output = {
    ...next,
    gamma: clamp(Math.round(next.gamma * 10) / 10, MIN_GAMMA, MAX_GAMMA),
    latencyCompMs: clamp(Math.round(next.latencyCompMs), -MAX_LATENCY_COMP_MS, MAX_LATENCY_COMP_MS),
  };
}
/**
 * 设置 A-B 循环区间（入点 / 出点）。区间被夹到节目内；终点不大于起点时视为清除。
 *
 * @param draft 工程草稿。
 * @param range 新区间；`null` 清除。
 */
export function setLoopRange(draft: ShowProject, range: { startMs: number; endMs: number } | null): void {
  if (!range) {
    draft.loopRange = null;
    return;
  }
  const startMs = clamp(Math.round(range.startMs), 0, draft.durationMs);
  const endMs = clamp(Math.round(range.endMs), 0, draft.durationMs);
  draft.loopRange = endMs > startMs ? { startMs, endMs } : null;
}

/**
 * 设置入点或出点：另一端缺省时取节目起点 / 终点；入点晚于出点时交换。
 *
 * @param draft 工程草稿。
 * @param edge `in` 入点或 `out` 出点。
 * @param atMs 时刻（毫秒）。
 */
export function setLoopEdge(draft: ShowProject, edge: "in" | "out", atMs: number): void {
  const current = draft.loopRange ?? { startMs: 0, endMs: draft.durationMs };
  const next = edge === "in" ? { startMs: atMs, endMs: current.endMs } : { startMs: current.startMs, endMs: atMs };
  if (next.startMs > next.endMs) [next.startMs, next.endMs] = [next.endMs, next.startMs];
  setLoopRange(draft, next);
}

/** 轨道高度档位的循环顺序。 */
export const TRACK_HEIGHT_ORDER = ["compact", "normal", "tall"] as const;

/**
 * 设置轨道的显示方式（折叠 / 高度档位）。默认值（不折叠、普通高度）不写入工程，保持文件精简。
 *
 * @param draft 工程草稿。
 * @param trackId 轨道 id。
 * @param view 要改的字段。
 */
export function setTrackView(
  draft: ShowProject,
  trackId: string,
  view: { collapsed?: boolean; height?: (typeof TRACK_HEIGHT_ORDER)[number] },
): void {
  const track = draft.tracks.find((t) => t.id === trackId);
  if (!track) return;
  if (view.collapsed !== undefined) {
    if (view.collapsed) track.collapsed = true;
    else delete track.collapsed;
  }
  if (view.height !== undefined) {
    if (view.height === "normal") delete track.height;
    else track.height = view.height;
  }
}

/**
 * 设置轨道的静音 / 独奏 / 锁定开关。
 *
 * @param draft 工程草稿。
 * @param trackId 轨道 id。
 * @param flag 要设置的开关。
 * @param value 开关的新状态。
 */
export function setTrackFlag(
  draft: ShowProject,
  trackId: string,
  flag: "mute" | "solo" | "lock",
  value: boolean,
): void {
  const track = draft.tracks.find((t) => t.id === trackId);
  if (track) track[flag] = value;
}

/**
 * 重命名分组。
 *
 * @param draft 工程草稿。
 * @param id 分组 id。
 * @param name 新名称（首尾空白会去除；为空则忽略）。
 */
export function renameGroup(draft: ShowProject, id: string, name: string): void {
  const trimmed = name.trim();
  const group = draft.groups.find((g) => g.id === id);
  if (group && trimmed !== "") group.name = trimmed;
}

/**
 * 调整分组成员的先后顺序（特效沿灯具推进时按这个顺序）。
 *
 * @param draft 工程草稿。
 * @param groupId 分组 id。
 * @param from 要移动的成员当前下标。
 * @param to 目标下标。越界时夹在合法范围内。
 */
export function moveGroupMember(draft: ShowProject, groupId: string, from: number, to: number): void {
  const group = draft.groups.find((g) => g.id === groupId);
  if (!group || from < 0 || from >= group.fixtureIds.length) return;
  const target = clamp(to, 0, group.fixtureIds.length - 1);
  const [id] = group.fixtureIds.splice(from, 1);
  group.fixtureIds.splice(target, 0, id);
}

/**
 * 从分组里移除一个成员；成员少于 2 个时整个分组被删除。
 *
 * @param draft 工程草稿。
 * @param groupId 分组 id。
 * @param fixtureId 要移除的成员。
 */
export function removeGroupMember(draft: ShowProject, groupId: string, fixtureId: string): void {
  const group = draft.groups.find((g) => g.id === groupId);
  if (!group) return;
  group.fixtureIds = group.fixtureIds.filter((id) => id !== fixtureId);
  if (group.fixtureIds.length < MIN_GROUP_SIZE) removeGroup(draft, groupId);
}
