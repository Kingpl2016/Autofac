import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { addStaticCue } from "../../lib/cueOps";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type ShowProject } from "../../lib/project";
import { RGBW } from "../../lib/__tests__/testkit";
import { applyTimeChanges } from "../applyChanges";

function sample(): { project: ShowProject; first: string; second: string } {
  let first = "";
  let second = "";
  const project = produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 1);
    d.durationMs = 30_000;
    first = addStaticCue(d, d.tracks[0].id, 1000, { lengthMs: 2000 }) ?? "";
    second = addStaticCue(d, d.tracks[0].id, 6000, { lengthMs: 1000 }) ?? "";
  });
  return { project, first, second };
}

const run = (
  project: ShowProject,
  changes: { id: string; startMs: number; endMs: number }[],
  targets: number[] = [],
  thresholdMs = 100,
) =>
  produce(project, (d) => {
    applyTimeChanges(d, project, changes, { targets, thresholdMs });
  });

describe("applyTimeChanges", () => {
  it("没有吸附目标时按放下的位置写入", () => {
    const { project, first } = sample();
    const next = run(project, [{ id: first, startMs: 3010, endMs: 5010 }]);
    expect(next.cues.find((c) => c.id === first)).toMatchObject({ startMs: 3000, endMs: 5000 });
  });

  it("够近就吸附到目标，整体移动时长度不变", () => {
    const { project, first } = sample();
    const next = run(project, [{ id: first, startMs: 3040, endMs: 5040 }], [3000]);
    expect(next.cues.find((c) => c.id === first)).toMatchObject({ startMs: 3000, endMs: 5000 });
  });

  it("拉伸终点吸附到邻居的起点", () => {
    const { project, first } = sample();
    const next = run(project, [{ id: first, startMs: 1000, endMs: 5950 }], [6000]);
    expect(next.cues.find((c) => c.id === first)).toMatchObject({ startMs: 1000, endMs: 6000 });
  });

  it("吸附后会压住别的 Cue 时，退回放下的位置", () => {
    const { project, first } = sample();
    // 目标 6100 落在第二个 Cue 内部：吸附后 [4100, 6100] 与 [6000, 7000] 重叠 → 退回 [4000, 6000]
    const next = run(project, [{ id: first, startMs: 4010, endMs: 6010 }], [6100], 200);
    expect(next.cues.find((c) => c.id === first)).toMatchObject({ startMs: 4010 - 10, endMs: 6000 });
  });

  it("放下的位置本身就不合法时保持原样", () => {
    const { project, first } = sample();
    const next = run(project, [{ id: first, startMs: 5500, endMs: 7500 }], [7000]);
    expect(next.cues.find((c) => c.id === first)).toMatchObject({ startMs: 1000, endMs: 3000 });
  });

  it("忽略工程里不存在的 Cue，并返回生效数量", () => {
    const { project, first } = sample();
    let applied = 0;
    produce(project, (d) => {
      applied = applyTimeChanges(
        d,
        project,
        [
          { id: "ghost", startMs: 0, endMs: 1000 },
          { id: first, startMs: 2000, endMs: 4000 },
        ],
        { targets: [], thresholdMs: 100 },
      );
    });
    expect(applied).toBe(1);
  });
});
