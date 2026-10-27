import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { addMarker, moveMarker, removeMarker, renameMarker, setTempo } from "../ops";
import { createEmptyProject, type ShowProject } from "../project";

const edit = (p: ShowProject, recipe: (d: ShowProject) => void) => produce(p, recipe);
const empty = () => createEmptyProject("t");

describe("标记点", () => {
  it("添加：对齐到帧、按时间排序、自动命名", () => {
    let a: string | null = null;
    const p = edit(empty(), (d) => {
      addMarker(d, 5010, "副歌");
      a = addMarker(d, 1000);
    });
    expect(a).not.toBeNull();
    expect(p.markers.map((m) => [m.timeMs, m.label])).toEqual([
      [1000, "M2"],
      [5000, "副歌"],
    ]);
  });

  it("同一帧不重复添加；超出范围被夹住", () => {
    const p = edit(empty(), (d) => {
      expect(addMarker(d, 1000)).not.toBeNull();
      expect(addMarker(d, 1010)).toBeNull();
      addMarker(d, -500);
      addMarker(d, 99_999_999);
    });
    expect(p.markers.map((m) => m.timeMs)).toEqual([0, 1000, p.durationMs]);
  });

  it("移动：重新排序；目标帧被占用时拒绝", () => {
    let id1 = "";
    let id2 = "";
    const p = edit(empty(), (d) => {
      id1 = addMarker(d, 1000) ?? "";
      id2 = addMarker(d, 2000) ?? "";
    });
    const moved = edit(p, (d) => {
      expect(moveMarker(d, id1, 3000)).toBe(true);
      expect(moveMarker(d, id2, 3000)).toBe(false);
      expect(moveMarker(d, "ghost", 10)).toBe(false);
    });
    expect(moved.markers.map((m) => m.id)).toEqual([id2, id1]);
  });

  it("重命名去除空白、空名称忽略；删除", () => {
    let id = "";
    const p = edit(empty(), (d) => {
      id = addMarker(d, 1000) ?? "";
    });
    const renamed = edit(p, (d) => renameMarker(d, id, "  桥段 "));
    expect(renamed.markers[0].label).toBe("桥段");
    expect(edit(renamed, (d) => renameMarker(d, id, "  ")).markers[0].label).toBe("桥段");
    expect(edit(renamed, (d) => removeMarker(d, id)).markers).toEqual([]);
  });
});

describe("setTempo", () => {
  it("数值被夹到合法范围并取整", () => {
    const p = edit(empty(), (d) => setTempo(d, { bpm: 500, offsetMs: 12.6, beatsPerBar: 99 }));
    expect(p.tempo).toEqual({ bpm: 300, offsetMs: 13, beatsPerBar: 16 });
    const q = edit(empty(), (d) => setTempo(d, { bpm: 3, offsetMs: -200, beatsPerBar: 0 }));
    expect(q.tempo).toEqual({ bpm: 20, offsetMs: -200, beatsPerBar: 1 });
    const r = edit(empty(), (d) => setTempo(d, { bpm: 128.46, offsetMs: 0, beatsPerBar: 4 }));
    expect(r.tempo?.bpm).toBe(128.5);
  });

  it("null 清除节拍", () => {
    const p = edit(empty(), (d) => setTempo(d, { bpm: 120, offsetMs: 0, beatsPerBar: 4 }));
    expect(edit(p, (d) => setTempo(d, null)).tempo).toBeNull();
  });
});
