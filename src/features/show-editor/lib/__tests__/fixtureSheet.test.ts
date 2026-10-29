import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { buildSheet, cellTarget, manualEmitters, sheetColumns } from "../fixtureSheet";
import { fixed } from "../looks";
import { addFixtures } from "../ops";
import { createEmptyProject } from "../project";
import { HEAD16, PIXEL_BAR, RGBW } from "./testkit";

/** 1 台 RGBW（U0 @1）+ 1 台 16CH 摇头灯（U0 @5，Pan 16 位小端）。 */
function rig() {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 1);
    addFixtures(d, HEAD16, 1);
  });
}

describe("灯具表", () => {
  it("按地址从 DMX 帧解码每个功能的值，16 位按字节序合并", () => {
    const p = rig();
    const frame = new Uint8Array(512);
    frame[0] = 255; // RGBW 红
    frame[3] = 51; // 白
    frame[4] = 0x34; // 摇头灯 Pan 低字节（小端在前）
    frame[5] = 0x12;
    frame[9] = 128; // 调光（第 6 通道）
    const rows = buildSheet(p, (u) => (u === 0 ? frame : null), {});
    expect(rows.map((r) => r.address)).toEqual(["U0 @1", "U0 @5"]);
    expect(rows[0].cells.get("red")).toMatchObject({ dmx: 255, max: 255, fraction: 1 });
    expect(rows[0].cells.get("white")?.fraction).toBeCloseTo(0.2);
    expect(rows[1].cells.get("pan")).toMatchObject({ dmx: 0x1234, max: 65535 });
    expect(rows[1].cells.get("dimmer")?.dmx).toBe(128);
    expect(rows[1].cells.get("red")).toBeUndefined();
  });

  it("列按属性组排序：强度 → 颜色 → 位置 → 控制", () => {
    const rows = buildSheet(rig(), () => null, {});
    expect(sheetColumns(rows)).toEqual(["dimmer", "red", "green", "blue", "white", "pan", "tilt", "reset"]);
  });

  it("编程器里有值的层标为已编程", () => {
    const p = rig();
    const [a, b] = p.fixtures.map((f) => f.id);
    const rows = buildSheet(p, () => null, {
      [a]: { color: fixed({ kind: "rgb", rgb: [1, 2, 3] }) },
      [b]: { intensity: fixed(50), attrs: { tilt: fixed(0.5) } },
    });
    expect(rows[0].cells.get("red")?.programmed).toBe(true);
    expect(rows[1].cells.get("dimmer")?.programmed).toBe(true);
    expect(rows[1].cells.get("tilt")?.programmed).toBe(true);
    expect(rows[1].cells.get("pan")?.programmed).toBe(false);
  });

  it("像素灯展开后每个像素一行，显示各自的输出与编程状态；不展开时每台灯一行", () => {
    const p = produce(createEmptyProject("t"), (d) => void addFixtures(d, PIXEL_BAR, 1));
    const id = p.fixtures[0].id;
    const frame = new Uint8Array(512);
    frame[0] = 255; // 总调光
    frame[1] = 200; // 像素 1 红
    frame[8] = 100; // 像素 3 绿（第 9 通道）
    const values = { [`${id}#3`]: { color: fixed({ kind: "rgb" as const, rgb: [0, 255, 0] as [number, number, number] }) } };

    const collapsed = buildSheet(p, () => frame, values);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toMatchObject({ fixtureId: id, head: null, pixels: 3 });
    // 整灯行：总调光 + 第一个像素的代表值
    expect(collapsed[0].cells.get("dimmer")?.dmx).toBe(255);
    expect(collapsed[0].cells.get("red")?.dmx).toBe(200);

    const rows = buildSheet(p, () => frame, values, new Set([id]));
    expect(rows.map((r) => [r.fixtureId, r.head])).toEqual([
      [id, null],
      [`${id}#1`, 1],
      [`${id}#2`, 2],
      [`${id}#3`, 3],
    ]);
    // 像素行只有这个像素的通道
    expect([...rows[3].cells.keys()]).toEqual(["red", "green", "blue"]);
    expect(rows[3].cells.get("green")).toMatchObject({ dmx: 100, programmed: true });
    expect(rows[2].cells.get("green")).toMatchObject({ dmx: 0, programmed: false });
    expect(rows[1].cells.get("red")?.dmx).toBe(200);
  });

  it("单元格写入方式与手动发光体的当前值", () => {
    expect(cellTarget("dimmer")).toEqual({ kind: "intensity" });
    expect(cellTarget("warmWhite")).toEqual({ kind: "emitter", key: "warmWhite" });
    expect(cellTarget("gobo")).toEqual({ kind: "attr", key: "gobo" });
    expect(cellTarget("switch")).toEqual({ kind: "readonly" });
    expect(manualEmitters({ a: { color: fixed({ kind: "manual", values: { red: 0.5 } }) } }, "a")).toEqual({ red: 0.5 });
    expect(manualEmitters({ a: { color: fixed({ kind: "rgb", rgb: [1, 1, 1] }) } }, "a")).toEqual({});
  });
});
