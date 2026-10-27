import { setCueTimes } from "../lib/cueOps";
import type { ShowProject } from "../lib/project";
import { snapSpan } from "../lib/snap";
import type { CueTimeChange } from "./timelineData";

/** 把拖动结果写入工程时的吸附设置。 */
export interface SnapSettings {
  /** 可吸附的时间点；传空数组等于不吸附 */
  targets: readonly number[];
  /** 吸附距离（毫秒） */
  thresholdMs: number;
}

/**
 * 把一次拖动 / 拉伸得到的 Cue 时间变化写入工程草稿。
 *
 * 先尝试吸附后的位置；吸附后会与同轨其他 Cue 重叠（或越界）时，退回用户实际放下的位置；
 * 放下的位置本身也不合法则保持原样。
 *
 * @param draft 工程草稿。
 * @param original 拖动前的工程快照（用来判断是移动还是拉伸）。
 * @param changes 库回传的时间变化。
 * @param snap 吸附设置。
 * @returns 实际生效的变化数量。
 */
export function applyTimeChanges(
  draft: ShowProject,
  original: Pick<ShowProject, "cues">,
  changes: readonly CueTimeChange[],
  snap: SnapSettings,
): number {
  let applied = 0;
  for (const change of changes) {
    const before = original.cues.find((c) => c.id === change.id);
    if (!before) continue;
    const wanted = { startMs: change.startMs, endMs: change.endMs };
    const snapped =
      snap.targets.length > 0 ? snapSpan(wanted, before, snap.targets, snap.thresholdMs) : wanted;
    if (
      setCueTimes(draft, change.id, snapped.startMs, snapped.endMs) ||
      setCueTimes(draft, change.id, wanted.startMs, wanted.endMs)
    ) {
      applied += 1;
    }
  }
  return applied;
}
