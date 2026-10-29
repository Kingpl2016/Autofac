import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { arrangeSheetRows, buildSheet, cellTarget, formatCell, manualEmitters, parseCell, sheetColumns, visibleColumns } from "../fixtureSheet";
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

describe("灯具表的读数、筛选与排序", () => {
  const cell8 = { dmx: 128, max: 255, fraction: 128 / 255, invert: false };
  const cell16 = { dmx: 0x1234, max: 65535, fraction: 0x1234 / 65535, invert: false };

  it("formatCell：百分比、两位小数、8 / 16 位 DMX、十六进制", () => {
    expect(formatCell(cell8, "percent")).toBe("50");
    expect(formatCell(cell8, "percentFine")).toBe("50.20");
    expect(formatCell(cell8, "dmx8")).toBe("128");
    expect(formatCell(cell8, "dmx16")).toBe(String(128 * 257));
    expect(formatCell(cell8, "hex")).toBe("80");
    expect(formatCell(cell16, "dmx8")).toBe("18");
    expect(formatCell(cell16, "dmx16")).toBe(String(0x1234));
    expect(formatCell(cell16, "hex")).toBe("1234");
    // 反向通道：百分比显示属性值，DMX 显示原始值
    expect(formatCell({ dmx: 255, max: 255, fraction: 0 }, "percent")).toBe("0");
    expect(formatCell({ dmx: 255, max: 255, fraction: 0 }, "dmx8")).toBe("255");
  });

  it("parseCell：按读数换成属性值，反向通道撤销反向，超出范围夹取，非法为 null", () => {
    expect(parseCell("50", cell8, "percent")).toBe(0.5);
    expect(parseCell("50%", cell8, "percentFine")).toBe(0.5);
    expect(parseCell("51", cell8, "dmx8")).toBeCloseTo(0.2);
    expect(parseCell("65535", cell16, "dmx16")).toBe(1);
    expect(parseCell("#FF", cell8, "hex")).toBe(1);
    expect(parseCell("0x8000", cell16, "hex")).toBeCloseTo(0x8000 / 65535);
    expect(parseCell("255", { max: 255, invert: true }, "dmx8")).toBe(0);
    expect(parseCell("300", cell8, "dmx8")).toBe(1);
    expect(parseCell("-5", cell8, "percent")).toBe(0);
    expect(parseCell("abc", cell8, "dmx8")).toBeNull();
    expect(parseCell("GG", cell8, "hex")).toBeNull();
    expect(parseCell(" ", cell8, "percent")).toBeNull();
  });

  it("arrangeSheetRows：像素行跟着整灯行一起筛选排序；地址写法搜索", () => {
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, PIXEL_BAR, 1);
      addFixtures(d, RGBW, 1);
      d.fixtures[0].name = "灯条 B";
      d.fixtures[1].name = "灯 A";
      d.fixtures[1].universe = 0;
    });
    const rows = buildSheet(p, () => null, {}, new Set([p.fixtures[0].id]));
    const view = { query: "", filter: "all" as const, sort: "name" as const, selected: new Set<string>(), programmed: new Set<string>() };
    const sorted = arrangeSheetRows(rows, view);
    expect(sorted.map((r) => r.head)).toEqual([null, null, 1, 2, 3]);
    expect(sorted[0].name).toBe("灯 A");
    const addr = `@${p.fixtures[1].address}`;
    expect(arrangeSheetRows(rows, { ...view, query: addr }).map((r) => r.name)).toEqual(["灯 A"]);
    expect(arrangeSheetRows(rows, { ...view, filter: "selected", selected: new Set([p.fixtures[0].id]) })).toHaveLength(4);
    expect(arrangeSheetRows(rows, { ...view, filter: "programmed" })).toEqual([]);
  });

  it("visibleColumns：按属性组隐藏", () => {
    const rows = buildSheet(rig(), () => null, {});
    expect(visibleColumns(sheetColumns(rows), new Set(["color", "control"]))).toEqual(["dimmer", "pan", "tilt"]);
  });
});
