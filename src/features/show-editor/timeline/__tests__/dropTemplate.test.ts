import { describe, expect, it, vi } from "vitest";

import { BUILTIN_TEMPLATES } from "../../lib/cueTemplates";
import { dropTemplate, templateStyle } from "../dropTemplate";
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
const red = BUILTIN_TEMPLATES.find((t) => t.id === "red")!;

describe("templateStyle", () => {
  it("复制模板的颜色、亮度和淡入淡出（不共享数组）", () => {
    const style = templateStyle(red);
    expect(style).toMatchObject({ brightness: 100, fadeInMs: 0, fadeOutMs: 0 });
    expect(style.rgb).toEqual([255, 0, 0]);
    expect(style.color).toEqual({ kind: "rgb", rgb: [255, 0, 0] });
    expect(style.color).not.toBe(red.color);
    // 色温模板保持色温，显示色为近似 RGB
    const warm = templateStyle(BUILTIN_TEMPLATES.find((t) => t.id === "k3200")!);
    expect(warm.color).toEqual({ kind: "kelvin", kelvin: 3200 });
    expect(warm.rgb?.[0]).toBe(255);
  });
});

describe("dropTemplate", () => {
  it("在对应轨道和时间新建 Cue", () => {
    const addAt = vi.fn().mockReturnValue("new");
    // x=220 → 减去左侧留白 20 → 200px → 2 秒；y 落在第 2 行
    const result = dropTemplate(viewport, { x: 220, y: ROW_HEIGHT + 4 }, tracks, red, addAt);
    expect(result).toEqual({ kind: "added", cueId: "new", trackId: "t2" });
    expect(addAt).toHaveBeenCalledWith("t2", 2000, expect.objectContaining({ rgb: [255, 0, 0] }));
  });

  it("放在时间线之外或没有轨道的位置：不新建", () => {
    const addAt = vi.fn();
    expect(dropTemplate(viewport, { x: -5, y: 10 }, tracks, red, addAt)).toEqual({ kind: "miss" });
    expect(dropTemplate(viewport, { x: 50, y: ROW_HEIGHT * 5 }, tracks, red, addAt)).toEqual({ kind: "miss" });
    expect(dropTemplate(null, { x: 50, y: 10 }, tracks, red, addAt)).toEqual({ kind: "miss" });
    expect(addAt).not.toHaveBeenCalled();
  });

  it("位置被占用时报告放不下", () => {
    const result = dropTemplate(viewport, { x: 100, y: 5 }, tracks, red, () => null);
    expect(result).toEqual({ kind: "noRoom", trackId: "t1" });
  });
});
