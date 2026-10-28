import { vi } from "vitest";

import type { FixtureModel, FixtureProperty } from "@/features/fixtures";
import type { ShowFileController } from "../../hooks/useShowFile";

/**
 * 测试用的模型与工具：不依赖素材库的真实数据，通道布局与内置标准模型一致。
 */

function prop(code: string, fn: FixtureProperty["function"], channel: number, width: 1 | 2 = 1): FixtureProperty {
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
