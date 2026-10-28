import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { collectSnapTargets } from "../../lib/snap";
import { createEmptyProject } from "../../lib/project";
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC, sliderToZoom, ZOOM_SLIDER_STEPS, zoomToSlider } from "../../lib/zoom";
import { barTicks } from "../timelineLayout";

describe("吸附目标按种类过滤", () => {
  const p = produce(createEmptyProject("t"), (d) => {
    d.durationMs = 10_000;
    d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
    d.markers.push({ id: "m", timeMs: 3333, label: "M" });
  });

  it("关掉的种类不参与，工程起止始终在", () => {
    const none = collectSnapTargets(p, 1234, new Set(), { beats: false, markers: false, edges: false, playhead: false });
    expect(none.sort((a, b) => a - b)).toEqual([0, 10_000]);
    const markers = collectSnapTargets(p, 1234, new Set(), { beats: false, markers: true, edges: false, playhead: true });
    expect(markers).toContain(3333);
    expect(markers).toContain(1234);
    expect(markers).not.toContain(500);
    expect(collectSnapTargets(p, 1234)).toContain(500);
  });
});

describe("小节·拍刻度", () => {
  const tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };

  it("缩得小时只标小节（按步长），放大后每拍标“小节.拍”", () => {
    // 120 BPM：一拍 500 ms；40 px/s 时一拍 20 px、一小节 80 px
    const coarse = barTicks(tempo, 40, 0, 8000);
    expect(coarse.major.map((t) => t.label)).toEqual(["1", "2", "3", "4", "5"]);
    expect(coarse.minor).toContain(500);
    // 200 px/s：一拍 100 px，够宽，每拍都标
    const fine = barTicks(tempo, 200, 0, 2000);
    expect(fine.major.map((t) => t.label)).toEqual(["1.1", "1.2", "1.3", "1.4", "2.1"]);
  });

  it("第一拍偏移：偏移之前没有刻度", () => {
    const ticks = barTicks({ ...tempo, offsetMs: 250 }, 40, 0, 2000);
    expect(ticks.major[0]).toEqual({ ms: 250, label: "1" });
  });
});

describe("缩放滑块", () => {
  it("对数刻度往返一致，两端对应极限", () => {
    expect(sliderToZoom(0)).toBe(MIN_PX_PER_SEC);
    expect(sliderToZoom(ZOOM_SLIDER_STEPS)).toBe(MAX_PX_PER_SEC);
    expect(zoomToSlider(MIN_PX_PER_SEC)).toBe(0);
    expect(zoomToSlider(9999)).toBe(ZOOM_SLIDER_STEPS);
    for (const pos of [10, 37, 50, 88]) expect(zoomToSlider(sliderToZoom(pos))).toBe(pos);
  });
});
