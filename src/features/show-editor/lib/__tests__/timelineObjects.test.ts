import { describe, expect, it } from "vitest";
import { produce } from "immer";

import { addLookCue } from "../cueOps";
import { fixed } from "../looks";
import { addFixtures, addMarker } from "../ops";
import { createEmptyProject, type ShowProject } from "../project";
import { addSection } from "../sections";
import { clearLookKeys, deleteTimelineObject, removeLookKeysAt } from "../timelineObjects";
import { RGBW } from "./testkit";

/** 一个标记、一个段落；外观片段的强度在 0 / 500 / 1000 有关键帧，Pan 在 500 有一帧、1000 有一帧。 */
function base(): { p: ShowProject; cue: string } {
  let cue = "";
  const p = produce(createEmptyProject("t"), (d) => {
    d.durationMs = 20_000;
    addFixtures(d, RGBW, 1);
    addMarker(d, 1000, "副歌");
    addSection(d, 2000, 4000, "主歌");
    cue =
      addLookCue(
        d,
        d.tracks[0].id,
        0,
        {
          intensity: {
            kind: "keys",
            keys: [
              { tMs: 0, value: 0, curve: "linear" },
              { tMs: 500, value: 80, curve: "linear" },
              { tMs: 1000, value: 100, curve: "linear" },
            ],
          },
          color: fixed({ kind: "rgb", rgb: [255, 0, 0] }),
          attrs: {
            pan: {
              kind: "keys",
              keys: [
                { tMs: 500, value: 0.2, curve: "linear" },
                { tMs: 1000, value: 0.8, curve: "linear" },
              ],
            },
          },
        },
        2000,
      ) ?? "";
  });
  return { p, cue };
}

describe("时间线对象的删除", () => {
  it("删除标记点 / 段落返回名字；不存在时为 null", () => {
    const { p } = base();
    let name: string | null = null;
    const q = produce(p, (d) => {
      name = deleteTimelineObject(d, { kind: "marker", id: p.markers[0].id });
    });
    expect(name).toBe("副歌");
    expect(q.markers).toEqual([]);
    const r = produce(p, (d) => {
      name = deleteTimelineObject(d, { kind: "section", id: p.sections[0].id });
    });
    expect(name).toBe("主歌");
    expect(r.sections).toEqual([]);
    produce(p, (d) => {
      name = deleteTimelineObject(d, { kind: "marker", id: "gone" });
    });
    expect(name).toBeNull();
  });

  it("删除某一时刻的关键帧：所有层一起删；只剩一帧的层退回固定值", () => {
    const { p, cue } = base();
    let n = 0;
    const q = produce(p, (d) => {
      n = removeLookKeysAt(d, cue, 500);
    });
    expect(n).toBe(2);
    const look = q.cues[0].kind === "look" ? q.cues[0].look : null;
    expect(look?.intensity).toMatchObject({ kind: "keys", keys: [{ tMs: 0 }, { tMs: 1000 }] });
    expect(look?.attrs?.pan).toEqual({ kind: "value", value: 0.8 });
    expect(look?.color).toEqual(fixed({ kind: "rgb", rgb: [255, 0, 0] }));
    produce(p, (d) => {
      n = removeLookKeysAt(d, cue, 300);
    });
    expect(n).toBe(0);
  });

  it("删除全部关键帧：各层改成第一帧的值；锁定轨道上不动", () => {
    const { p, cue } = base();
    let n = 0;
    const q = produce(p, (d) => {
      n = clearLookKeys(d, cue);
    });
    expect(n).toBe(2);
    const look = q.cues[0].kind === "look" ? q.cues[0].look : null;
    expect(look?.intensity).toEqual({ kind: "value", value: 0 });
    expect(look?.attrs?.pan).toEqual({ kind: "value", value: 0.2 });
    const locked = produce(p, (d) => {
      d.tracks[0].lock = true;
    });
    const same = produce(locked, (d) => {
      n = clearLookKeys(d, cue);
    });
    expect(n).toBe(0);
    expect(same).toBe(locked);
  });
});
