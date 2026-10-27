import type { Cue, ShowProject } from "../lib/project";
import type { TimelineRow } from "./TimelineAdapter";

/** 每条轨道的行高（像素），需与轨道头的高度一致。 */
export const ROW_HEIGHT = 44;

/** 标尺区高度（像素，库固定为 2rem = 32px）。 */
export const RULER_HEIGHT = 32;

/** 时间线左侧留白（像素，库的 `startLeft`）。 */
export const START_LEFT = 20;

/** 库里所有 Cue 块共用的效果 id。 */
export const CUE_EFFECT_ID = "cue";

/**
 * 毫秒转秒（库的时间单位）。
 *
 * @param ms 毫秒。
 */
export function msToSec(ms: number): number {
  return ms / 1000;
}

/**
 * 秒转毫秒，四舍五入到整数。
 *
 * @param sec 秒。
 */
export function secToMs(sec: number): number {
  return Math.round(sec * 1000);
}

/**
 * 按工程生成库需要的“轨道行”数据。
 *
 * 每个 Cue 带上同轨左右邻居划出的活动范围（`minStart` / `maxEnd`），
 * 这样拖动 / 拉伸时库自己就会把它限制在空隙之内，轨道上的 Cue 永远不会重叠。
 * 锁定的轨道上的 Cue 不能移动和拉伸。
 *
 * @param project 工程（只读）。
 * @param selected 被选中的 Cue id。
 * @returns 与 `project.tracks` 顺序一致的行。
 */
export function buildRows(
  project: Pick<ShowProject, "tracks" | "cues" | "durationMs">,
  selected: ReadonlySet<string>,
): TimelineRow[] {
  const byTrack = new Map<string, Cue[]>();
  for (const c of project.cues) {
    const list = byTrack.get(c.trackId) ?? [];
    list.push(c);
    byTrack.set(c.trackId, list);
  }
  return project.tracks.map((track) => {
    const cues = (byTrack.get(track.id) ?? []).sort((a, b) => a.startMs - b.startMs);
    return {
      id: track.id,
      rowHeight: ROW_HEIGHT,
      actions: cues.map((c, i) => ({
        id: c.id,
        start: msToSec(c.startMs),
        end: msToSec(c.endMs),
        effectId: CUE_EFFECT_ID,
        selected: selected.has(c.id),
        movable: !track.lock,
        flexible: !track.lock,
        minStart: i > 0 ? msToSec(cues[i - 1].endMs) : 0,
        maxEnd: msToSec(i < cues.length - 1 ? cues[i + 1].startMs : project.durationMs),
      })),
    };
  });
}

/** 一个 Cue 的起止时间发生了变化。 */
export interface CueTimeChange {
  id: string;
  startMs: number;
  endMs: number;
}

/**
 * 对比库回传的行数据和工程，找出起止时间变化了的 Cue。
 *
 * @param project 工程（只读）。
 * @param rows 库在一次拖动 / 拉伸结束后回传的行。
 * @returns 变化列表；没有变化时为空数组。
 */
export function diffRows(project: Pick<ShowProject, "cues">, rows: readonly TimelineRow[]): CueTimeChange[] {
  const current = new Map(project.cues.map((c) => [c.id, c]));
  const changes: CueTimeChange[] = [];
  for (const row of rows) {
    for (const action of row.actions) {
      const cue = current.get(action.id);
      if (!cue) continue;
      const startMs = secToMs(action.start);
      const endMs = secToMs(action.end);
      if (startMs !== cue.startMs || endMs !== cue.endMs) changes.push({ id: cue.id, startMs, endMs });
    }
  }
  return changes;
}

/**
 * 标尺刻度文字：整秒显示为 `m:ss`，一小时以上为 `h:mm:ss`。
 *
 * @param sec 刻度对应的秒。
 */
export function rulerLabel(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * 工程时长对应的刻度数（向上取整，至少 1），用来固定时间线的总长度。
 *
 * @param durationMs 工程时长。
 */
export function scaleCountFor(durationMs: number): number {
  return Math.max(1, Math.ceil(durationMs / 1000));
}
