import { describe, expect, it } from "vitest";
import { produce } from "immer";

import { addFixtures } from "../ops";
import { createEmptyProject, type ShowProject } from "../project";
import { channelStrip, stableHue, universeCards } from "../universeView";
import { DIMMER, RGBW } from "./testkit";

/** U0：两台 RGBW（1–4、5–8）+ 一台调光灯（9），第二台 RGBW 有镜像到 U2；U5 只在 Universe 表里登记。 */
function base(): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 2);
    addFixtures(d, DIMMER, 1);
    d.fixtures[1].mirrors = [{ universe: 2, address: 100 }];
    d.output.universes.push({
      universe: 5,
      label: "舞台左",
      color: [255, 0, 0],
      ports: [{ id: "p", protocol: "artNet", mode: "unicast", ip: "10.0.0.5", port: 6454, remoteUniverse: 3, enabled: true }],
    });
  });
}

describe("Universe 视图", () => {
  it("卡片：按编号列出用到的与登记的 Universe，标出占用、灯具数、端口；同型号同色", () => {
    const cards = universeCards(base());
    expect(cards.map((c) => c.universe)).toEqual([0, 2, 5]);
    const [u0, u2, u5] = cards;
    expect(u0).toMatchObject({ used: 9, fixtures: 3, conflicts: 0 });
    expect(u0.segments.map((s) => [s.start, s.end])).toEqual([
      [1, 4],
      [5, 8],
      [9, 9],
    ]);
    expect(u0.segments[0].hue).toBe(u0.segments[1].hue);
    expect(u0.segments[2].hue).toBe(stableHue(DIMMER.id));
    expect(u2.segments).toEqual([expect.objectContaining({ start: 100, end: 103, mirror: true })]);
    expect(u2.fixtures).toBe(0);
    expect(u5).toMatchObject({ label: "舞台左", color: [255, 0, 0], used: 0, ports: [{ protocol: "artNet", target: "10.0.0.5", remote: 3 }] });
  });

  it("冲突的灯具计数；通道格标出起始地址、镜像与重叠", () => {
    const p = produce(base(), (d) => {
      d.fixtures[2].address = 3;
    });
    const u0 = universeCards(p)[0];
    expect(u0.conflicts).toBe(2);
    const cells = channelStrip(u0);
    expect(cells).toHaveLength(512);
    expect(cells[0]).toMatchObject({ channel: 1, head: true, mirror: false });
    expect(cells[2].owners).toHaveLength(2);
    expect(cells[8].owners).toEqual([]);
    const mirror = channelStrip(universeCards(p)[1]);
    expect(mirror[99]).toMatchObject({ head: true, mirror: true });
  });
});
