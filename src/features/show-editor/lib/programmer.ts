import { gapAround, MIN_CUE_MS } from "./cueOps";
import { newId } from "./ids";
import { pixelRefsOf } from "./fixtureRef";
import { fixed } from "./looks";
import type { AttrKey, ColorValue, Look, SceneClip, ShowProject, Track } from "./project";
import { clamp } from "@/shared/lib/math";
import { snapToFrame } from "./time";

/**
 * 编程器（Programmer）：在“同一帧”给多台灯具分别设定值的工作区，类似调光台的编程器。
 *
 * 编程器里的值不属于工程（不进撤销历史、不保存），预览时叠在工程之上（最后、最高优先级），
 * 满意后“记录”成场景片段（一个片段里多台灯各自的外观）或每台灯的外观片段。
 */

/** 编程器内容：灯具 id → 只写出“参与”的层的外观。 */
export type ProgrammerValues = Readonly<Record<string, Look>>;

/** 预览用的临时轨道 id（不会出现在工程里）。 */
export const PROGRAMMER_TRACK_ID = "__programmer__";

/**
 * 编程器是否有内容。
 *
 * @param values 编程器内容。
 * @returns 至少一台灯具写了某个层时为 `true`。
 */
export function hasProgrammerValues(values: ProgrammerValues): boolean {
  return Object.values(values).some((l) => l.intensity || l.color || Object.keys(l.attrs ?? {}).length > 0);
}

/**
 * 给一批灯具设强度（0~100%）。
 *
 * @param values 编程器内容。
 * @param ids 灯具。
 * @param percent 强度。
 * @returns 新内容。
 */
export function programIntensity(values: ProgrammerValues, ids: readonly string[], percent: number): Record<string, Look> {
  const next: Record<string, Look> = { ...values };
  for (const id of ids) next[id] = { ...next[id], intensity: fixed(clamp(percent, 0, 100)) };
  return next;
}

/**
 * 给一批灯具设颜色（意图色）。
 *
 * @param values 编程器内容。
 * @param ids 灯具。
 * @param color 颜色。
 * @returns 新内容。
 */
export function programColor(values: ProgrammerValues, ids: readonly string[], color: ColorValue): Record<string, Look> {
  const next: Record<string, Look> = { ...values };
  for (const id of ids) next[id] = { ...next[id], color: fixed(color) };
  return next;
}

/**
 * 给一批灯具设一个非颜色属性（0~1 DMX 分数）。
 *
 * @param values 编程器内容。
 * @param ids 灯具。
 * @param key 属性。
 * @param fraction 取值。
 * @returns 新内容。
 */
export function programAttr(
  values: ProgrammerValues,
  ids: readonly string[],
  key: AttrKey,
  fraction: number,
): Record<string, Look> {
  const next: Record<string, Look> = { ...values };
  for (const id of ids) {
    const prev = next[id] ?? {};
    next[id] = { ...prev, attrs: { ...prev.attrs, [key]: fixed(clamp(fraction, 0, 1)) } };
  }
  return next;
}

/**
 * 从编程器里去掉一批灯具的某一层（`layer` 省略时去掉全部层，即 grandMA 的 Knockout）。
 *
 * @param values 编程器内容。
 * @param ids 灯具；省略为全部。
 * @param layer 层。
 * @returns 新内容。
 */
export function knockout(
  values: ProgrammerValues,
  ids?: readonly string[],
  layer?: "intensity" | "color" | AttrKey,
): Record<string, Look> {
  const next: Record<string, Look> = { ...values };
  for (const id of ids ?? Object.keys(values)) {
    const look = next[id];
    if (!look) continue;
    if (!layer) {
      delete next[id];
      continue;
    }
    const copy: Look = { ...look, attrs: { ...look.attrs } };
    if (layer === "intensity") delete copy.intensity;
    else if (layer === "color") delete copy.color;
    else delete copy.attrs?.[layer];
    if (copy.attrs && Object.keys(copy.attrs).length === 0) delete copy.attrs;
    if (!copy.intensity && !copy.color && !copy.attrs) delete next[id];
    else next[id] = copy;
  }
  return next;
}

/**
 * 把编程器内容转成场景条目：只保留工程里存在、且有内容的灯具与像素，按工程顺序（每台灯先整灯、再各像素）。
 *
 * @param project 工程（只读）。
 * @param values 编程器内容（键为灯具或像素引用）。
 * @returns 场景条目。
 */
function entriesOf(project: Pick<ShowProject, "fixtures" | "fixtureModels">, values: ProgrammerValues): SceneClip["entries"] {
  return project.fixtures
    .flatMap((f) => [f.id, ...pixelRefsOf(project, f)])
    .filter((id) => {
      const l = values[id];
      return l && (l.intensity || l.color || Object.keys(l.attrs ?? {}).length > 0);
    })
    .map((id) => ({ fixtureId: id, look: structuredClone(values[id]) }));
}

/**
 * 把编程器叠在工程之上：加一条临时的置顶层场景轨道（`onTop`），片段覆盖整个节目。
 *
 * 置顶层的颜色 / 属性在所有其它片段之后应用，所以总是胜出；强度仍是 HTP（与调光台的编程器一致）。
 * 预览与“实时输出”共用：编程器内容不变时编译结果可以复用（拖动播放头不用重新编译）。
 *
 * @param project 工程。
 * @param values 编程器内容。
 * @returns 新工程（编程器为空时原样返回）。
 */
export function withProgrammer(project: ShowProject, values: ProgrammerValues): ShowProject {
  const entries = entriesOf(project, values);
  if (entries.length === 0 || project.durationMs <= 0) return project;
  // 有独奏轨道时引擎只输出独奏轨道：编程器轨道也要独奏，否则看不到
  const soloing = project.tracks.some((t) => t.solo);
  const track: Track = {
    id: PROGRAMMER_TRACK_ID,
    target: { kind: "scene" },
    mute: false,
    solo: soloing,
    lock: true,
    onTop: true,
  };
  const clip: SceneClip = {
    id: "__programmer_clip__",
    kind: "scene",
    trackId: PROGRAMMER_TRACK_ID,
    startMs: 0,
    endMs: project.durationMs,
    brightness: 100,
    fadeInMs: 0,
    fadeOutMs: 0,
    easing: "linear",
    entries,
  };
  return { ...project, tracks: [...project.tracks, track], cues: [...project.cues, clip] };
}

/** 记录的结果。 */
export interface RecordResult {
  /** 新建的片段 */
  cueIds: string[];
  /** 新建的轨道（记录场景时没有场景轨道会自动建一条） */
  trackIds: string[];
  /** 因为位置被占用而跳过的灯具 */
  skipped: string[];
}

/**
 * 把编程器记录成一个场景片段：一个片段里多台灯具各自的外观（同一帧设置多个灯具）。
 *
 * 放在第一条未锁定、且 `startMs` 处有空位的场景轨道上；没有时新建一条。长度不会越过后一个片段。
 *
 * @param draft 工程草稿。
 * @param values 编程器内容。
 * @param startMs 起点（对齐到帧）。
 * @param lengthMs 期望长度。
 * @param trackName 新建场景轨道时用的名字。
 * @returns 结果；编程器为空或放不下时 `cueIds` 为空。
 */
export function recordScene(
  draft: ShowProject,
  values: ProgrammerValues,
  startMs: number,
  lengthMs: number,
  trackName: string,
): RecordResult {
  const result: RecordResult = { cueIds: [], trackIds: [], skipped: [] };
  const entries = entriesOf(draft, values);
  if (entries.length === 0) return result;
  const start = clamp(snapToFrame(startMs), 0, draft.durationMs);
  let track = draft.tracks.find((t) => t.target.kind === "scene" && !t.lock && gapAround(draft, t.id, start) !== null);
  if (!track) {
    track = { id: newId(), target: { kind: "scene" }, mute: false, solo: false, lock: false, name: trackName };
    draft.tracks.push(track);
    result.trackIds.push(track.id);
  }
  const gap = gapAround(draft, track.id, start) ?? [start, start];
  const end = Math.min(snapToFrame(start + lengthMs), gap[1]);
  if (end - start < MIN_CUE_MS) return result;
  const clip: SceneClip = {
    id: newId(),
    kind: "scene",
    trackId: track.id,
    startMs: start,
    endMs: end,
    brightness: 100,
    fadeInMs: 0,
    fadeOutMs: 0,
    easing: "linear",
    entries,
  };
  draft.cues.push(clip);
  result.cueIds.push(clip.id);
  return result;
}

/**
 * 把编程器记录成每台灯具自己轨道上的外观片段。
 *
 * @param draft 工程草稿。
 * @param values 编程器内容。
 * @param startMs 起点（对齐到帧）。
 * @param lengthMs 期望长度。
 * @returns 结果；轨道锁定或起点处已有片段的灯具列在 `skipped`。
 */
export function recordLooks(draft: ShowProject, values: ProgrammerValues, startMs: number, lengthMs: number): RecordResult {
  const result: RecordResult = { cueIds: [], trackIds: [], skipped: [] };
  const start = clamp(snapToFrame(startMs), 0, draft.durationMs);
  for (const { fixtureId, look } of entriesOf(draft, values)) {
    const track = draft.tracks.find((t) => t.target.kind === "fixture" && t.target.id === fixtureId && !t.lock);
    const gap = track ? gapAround(draft, track.id, start) : null;
    const end = gap ? Math.min(snapToFrame(start + lengthMs), gap[1]) : start;
    if (!track || !gap || end - start < MIN_CUE_MS) {
      result.skipped.push(fixtureId);
      continue;
    }
    const id = newId();
    draft.cues.push({
      id,
      kind: "look",
      trackId: track.id,
      startMs: start,
      endMs: end,
      brightness: 100,
      fadeInMs: 0,
      fadeOutMs: 0,
      easing: "linear",
      look,
    });
    result.cueIds.push(id);
  }
  return result;
}

/**
 * 黑场：全部轨道静音（灯具保持默认值，通道锁定 Park 仍然生效）。
 *
 * @param project 工程。
 * @returns 新工程（只改轨道的静音 / 独奏）。
 */
export function blackoutProject(project: ShowProject): ShowProject {
  return { ...project, tracks: project.tracks.map((t) => ({ ...t, mute: true, solo: false })) };
}
