import { vi } from "vitest";

import type { FixtureModel, FixtureProperty } from "@/features/fixtures";
import type { ShowFileController } from "../../hooks/useShowFile";

/**
 * 测试用的模型与工具：不依赖素材库的真实数据，通道布局与内置标准模型一致。
 */

/**
 * 构造一个通道对象。
 *
 * @param code 英文代码（也作名称）。
 * @param fn 功能。
 * @param channel 起始通道。
 * @param width 位宽（通道数）。
 */
export function prop(code: string, fn: FixtureProperty["function"], channel: number, width: 1 | 2 = 1): FixtureProperty {
  return {
    name: code,
    code,
    function: fn,
    channel,
    width,
    bigEndian: false,
    defaultValue: 0,
    valueDesc: "",
    description: "",
  };
}

/** RGBW 全彩灯：4 个通道。 */
export const RGBW: FixtureModel = {
  id: "1.5.1.4",
  name: "RGBW全彩灯",
  system: "照明",
  productType: "全彩",
  builtin: true,
  properties: [
    prop("Red", "red", 1),
    prop("Green", "green", 2),
    prop("Blue", "blue", 3),
    prop("White", "white", 4),
  ],
};

/** 可调白光灯：1 个通道。 */
export const DIMMER: FixtureModel = {
  id: "1.2.1.2",
  name: "可调白光灯",
  system: "照明",
  productType: "调光",
  builtin: true,
  properties: [prop("Bright", "dimmer", 1)],
};

/** 16 通道摇头灯。 */
export const HEAD16: FixtureModel = {
  id: "2.1.2.1",
  name: "通用16CH摇头灯",
  system: "电动照明",
  productType: "摇头灯",
  builtin: false,
  properties: [
    prop("Pan", "pan", 1, 2),
    prop("Tilt", "tilt", 3, 2),
    prop("Dimmer", "dimmer", 6),
    prop("Reset", "reset", 16),
  ],
};

/** 像素灯条：总调光 + 3 个 RGB 像素；附加模式 `2px` 只有 2 个像素。 */
export const PIXEL_BAR: FixtureModel = {
  id: "ofl:acme/bar",
  name: "灯条",
  system: "OFL",
  productType: "Pixel Bar",
  builtin: false,
  matrix: { cols: 3, rows: 1 },
  properties: [
    prop("Dim", "dimmer", 1),
    ...[1, 2, 3].flatMap((h) => [
      { ...prop(`R${h}`, "red", 2 + (h - 1) * 3), head: h },
      { ...prop(`G${h}`, "green", 3 + (h - 1) * 3), head: h },
      { ...prop(`B${h}`, "blue", 4 + (h - 1) * 3), head: h },
    ]),
  ],
  modes: [
    {
      id: "2px",
      name: "2 像素",
      properties: [prop("Dim", "dimmer", 1), { ...prop("R1", "red", 2), head: 1 }, { ...prop("R2", "red", 3), head: 2 }],
    },
  ],
};

/**
 * 文件操作控制器的替身：所有动作都是 `vi.fn()`，对话框关闭，没有未保存修改。
 *
 * @param over 要覆盖的字段。
 */
export function fakeFile(over: Partial<ShowFileController> = {}): ShowFileController {
  return {
    dirty: false,
    dialog: null,
    saveAsNew: false,
    save: vi.fn(),
    openSaveDialog: vi.fn(),
    saveAsFile: vi.fn(),
    requestNew: vi.fn(),
    requestOpenLibrary: vi.fn(),
    requestOpenFile: vi.fn(),
    requestOpenPath: vi.fn(),
    requestOpenRecent: vi.fn(),
    submitSave: vi.fn(),
    chooseLibraryEntry: vi.fn(),
    answerUnsaved: vi.fn(),
    answerRecover: vi.fn(),
    closeDialog: vi.fn(),
    ...over,
  };
}
