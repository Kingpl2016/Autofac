import { describe, expect, it, vi } from "vitest";

import { dropOnTimeline } from "../dropTemplate";
import type { Track } from "../../lib/project";
import type { TimelineViewport } from "../geometry";
import { ROW_HEIGHT } from "../timelineData";
import { rowLayout } from "../timelineLayout";

const tracks: Track[] = [
  { id: "t1", target: { kind: "fixture", id: "f1" }, mute: false, solo: false, lock: false },
  { id: "t2", target: { kind: "fixture", id: "f2" }, mute: false, solo: false, lock: false },
];
const viewport: TimelineViewport = {
  rect: { left: 0, top: 0, width: 1000, height: 200 },
  scrollLeft: 0,
  scrollTop: 0,
  pxPerSec: 100,
  rows: rowLayout(tracks),
};

describe("dropOnTimeline", () => {
  it("在对应轨道和时间新建 Cue", () => {
    const add = vi.fn().mockReturnValue("new");
    // x=220 → 减去左侧留白 20 → 200px → 2 秒；y 落在第 2 行
    const result = dropOnTimeline(viewport, { x: 220, y: ROW_HEIGHT + 4 }, tracks, add);
    expect(result).toEqual({ kind: "added", cueId: "new", trackId: "t2" });
    expect(add).toHaveBeenCalledWith("t2", 2000);
  });

  it("放在时间线之外或没有轨道的位置：不新建", () => {
    const add = vi.fn();
    expect(dropOnTimeline(viewport, { x: -5, y: 10 }, tracks, add)).toEqual({ kind: "miss" });
    expect(dropOnTimeline(viewport, { x: 50, y: ROW_HEIGHT * 5 }, tracks, add)).toEqual({ kind: "miss" });
    expect(dropOnTimeline(null, { x: 50, y: 10 }, tracks, add)).toEqual({ kind: "miss" });
    expect(add).not.toHaveBeenCalled();
  });

  it("位置被占用时报告放不下", () => {
    const result = dropOnTimeline(viewport, { x: 100, y: 5 }, tracks, () => null);
    expect(result).toEqual({ kind: "noRoom", trackId: "t1" });
  });
});
