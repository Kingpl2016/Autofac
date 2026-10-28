import { describe, expect, it } from "vitest";
import { produce } from "immer";

import { changeLabelKey, describeChange } from "../history";
import { addFixtures, setTempo } from "../ops";
import { createEmptyProject } from "../project";
import { RGBW } from "./testkit";

const base = produce(createEmptyProject("t"), (d) => void addFixtures(d, RGBW, 3));

describe("撤销历史描述", () => {
  it("集合的增 / 删 / 改，按代表性取一类", () => {
    const added = produce(base, (d) => void addFixtures(d, RGBW, 2));
    expect(describeChange(base, added)).toEqual({ kind: "collection", collection: "fixtures", op: "added", count: 2 });
    const removed = produce(added, (d) => void d.fixtures.splice(0, 1));
    expect(describeChange(added, removed)).toEqual({ kind: "collection", collection: "fixtures", op: "removed", count: 1 });
    const renamed = produce(base, (d) => void (d.fixtures[1].name = "新名字"));
    expect(describeChange(base, renamed)).toMatchObject({ collection: "fixtures", op: "changed", count: 1 });
    // 同时加了轨道和片段：片段更有代表性
    const both = produce(base, (d) => {
      d.tracks.push({ id: "t", target: { kind: "scene" }, mute: false, solo: false, lock: false });
      d.cues.push({ id: "c", kind: "scene", trackId: "t", startMs: 0, endMs: 1000, brightness: 100, fadeInMs: 0, fadeOutMs: 0, easing: "linear", entries: [] });
    });
    expect(describeChange(base, both)).toMatchObject({ collection: "cues", op: "added" });
  });

  it("其它改动：节拍、舞台、输出、循环、时长、工程信息；只改顺序时看下一类", () => {
    expect(describeChange(base, produce(base, (d) => setTempo(d, { bpm: 128, offsetMs: 0, beatsPerBar: 4 })))).toEqual({ kind: "tempo" });
    expect(describeChange(base, produce(base, (d) => void (d.stage.width = 20))).kind).toBe("stage");
    expect(describeChange(base, produce(base, (d) => void (d.output.gamma = 2.2))).kind).toBe("output");
    expect(describeChange(base, produce(base, (d) => void (d.loopRange = { startMs: 0, endMs: 10 }))).kind).toBe("loop");
    expect(describeChange(base, produce(base, (d) => void (d.durationMs = 1))).kind).toBe("duration");
    expect(describeChange(base, produce(base, (d) => void (d.name = "新"))).kind).toBe("info");
    const reordered = produce(base, (d) => void d.fixtures.reverse());
    expect(describeChange(base, reordered).kind).toBe("other");
  });

  it("文案键", () => {
    expect(changeLabelKey({ kind: "collection", collection: "cues", op: "added", count: 3 })).toEqual({ key: "editor.history.cues.added", count: 3 });
    expect(changeLabelKey({ kind: "tempo" })).toEqual({ key: "editor.history.tempo" });
  });
});
