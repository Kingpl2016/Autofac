import { DMX_CHANNELS, type FixtureModel, type FixtureProperty } from "./types";

/** 模型编号最大长度（与后端一致）。 */
export const MAX_ID_LEN = 64;
/** 单个模型最多的属性数（与后端一致）。 */
export const MAX_PROPERTIES = 64;

/** 校验问题：`code` 对应语言包 `fixtures.validation.<code>`，`params` 为插值参数。 */
export interface FixtureIssue {
  code:
    | "emptyId"
    | "idTooLong"
    | "emptyName"
    | "noProperties"
    | "tooManyProperties"
    | "badWidth"
    | "channelOutOfRange"
    | "defaultOutOfRange"
    | "overlap"
    | "duplicateFunction";
  params?: Record<string, string | number>;
}

/**
 * 属性占用的最后一个通道。
 *
 * @param p 属性。
 */
export function endChannel(p: Pick<FixtureProperty, "channel" | "width">): number {
  return p.channel + p.width - 1;
}

/**
 * 灯具占用的通道数（从通道 1 到最后一个被占用通道）。
 *
 * @param model 模型。
 * @returns 最大结束通道；没有属性时为 0。
 */
export function channelCount(model: Pick<FixtureModel, "properties">): number {
  return model.properties.reduce((max, p) => Math.max(max, endChannel(p)), 0);
}

/** 开关、调光、各色光功能在同一模型里只能出现一次。 */
const UNIQUE_FUNCTIONS: ReadonlySet<string> = new Set([
  "switch",
  "dimmer",
  "red",
  "green",
  "blue",
  "white",
  "coolWhite",
  "warmWhite",
]);

/**
 * 本地校验模型（与后端 `FixtureModel::validate` 同一套规则），用于编辑对话框的即时提示。
 * 最终以后端校验为准。
 *
 * @param model 待校验的模型。
 * @returns 第一个发现的问题；全部通过时为 `null`。
 */
export function validateModel(model: FixtureModel): FixtureIssue | null {
  const id = model.id.trim();
  if (id === "") return { code: "emptyId" };
  if ([...id].length > MAX_ID_LEN) return { code: "idTooLong" };
  if (model.name.trim() === "") return { code: "emptyName" };
  if (model.properties.length === 0) return { code: "noProperties" };
  if (model.properties.length > MAX_PROPERTIES) return { code: "tooManyProperties" };
  for (const p of model.properties) {
    if (p.width !== 1 && p.width !== 2) {
      return { code: "badWidth", params: { code: p.code, width: p.width } };
    }
    if (!Number.isInteger(p.channel) || p.channel < 1 || endChannel(p) > DMX_CHANNELS) {
      return { code: "channelOutOfRange", params: { code: p.code, channel: p.channel } };
    }
    const max = p.width === 2 ? 65535 : 255;
    if (!Number.isInteger(p.defaultValue) || p.defaultValue < 0 || p.defaultValue > max) {
      return { code: "defaultOutOfRange", params: { code: p.code } };
    }
  }
  for (let i = 0; i < model.properties.length; i += 1) {
    for (let j = i + 1; j < model.properties.length; j += 1) {
      const a = model.properties[i];
      const b = model.properties[j];
      if (a.channel <= endChannel(b) && b.channel <= endChannel(a)) {
        return { code: "overlap", params: { a: a.code, b: b.code } };
      }
    }
  }
  for (let i = 0; i < model.properties.length; i += 1) {
    const f = model.properties[i].function;
    if (UNIQUE_FUNCTIONS.has(f) && model.properties.slice(0, i).some((q) => q.function === f)) {
      return { code: "duplicateFunction", params: { function: f } };
    }
  }
  return null;
}
