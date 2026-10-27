import { headCount, isUniqueFunction } from "./functions";
import { DMX_CHANNELS, type FixtureModel, type FixtureProperty } from "./types";

/** 模型编号最大长度（与后端一致）。 */
export const MAX_ID_LEN = 64;
/** 单个模式最多的通道对象数（与后端一致）。 */
export const MAX_PROPERTIES = 256;
/** 单个模型最多的附加模式数（与后端一致）。 */
export const MAX_MODES = 16;
/** 多头矩阵最多的像素数（与后端一致）。 */
export const MAX_HEADS = 512;
/** 单个通道对象最多的能力区间数（与后端一致）。 */
export const MAX_CAPABILITIES = 64;

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
    | "duplicateFunction"
    | "badCapability"
    | "badMode"
    | "badMatrix"
    | "headOutOfRange";
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
 * 一个通道布局占用的通道数（从通道 1 到最后一个被占用通道）。
 *
 * @param props 通道布局。
 * @returns 最大结束通道；为空时为 0。
 */
export function footprint(props: readonly Pick<FixtureProperty, "channel" | "width">[]): number {
  return props.reduce((max, p) => Math.max(max, endChannel(p)), 0);
}

/**
 * 灯具在默认模式下占用的通道数。
 *
 * @param model 模型。
 * @returns 最大结束通道；没有属性时为 0。
 */
export function channelCount(model: Pick<FixtureModel, "properties">): number {
  return footprint(model.properties);
}

/**
 * 校验一个通道对象的能力区间：在位宽内、起止不颠倒、升序且互不重叠。
 *
 * @param p 通道对象。
 * @returns 合法时为 `true`。
 */
function capabilitiesOk(p: FixtureProperty): boolean {
  const caps = p.capabilities ?? [];
  if (caps.length > MAX_CAPABILITIES) return false;
  const max = p.width === 2 ? 65535 : 255;
  let prevEnd = -1;
  for (const c of caps) {
    const [lo, hi] = c.range;
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || lo > hi || hi > max) return false;
    if (lo <= prevEnd) return false;
    if (c.physical && !c.physical.every(Number.isFinite)) return false;
    prevEnd = hi;
  }
  return true;
}

/**
 * 校验一个通道布局（与后端 `validate_layout` 同一套规则）。
 *
 * @param props 通道布局。
 * @param heads 模型的像素头数量。
 * @returns 第一个发现的问题；全部通过时为 `null`。
 */
export function validateLayout(props: readonly FixtureProperty[], heads: number): FixtureIssue | null {
  if (props.length === 0) return { code: "noProperties" };
  if (props.length > MAX_PROPERTIES) return { code: "tooManyProperties" };
  for (const p of props) {
    if (p.width !== 1 && p.width !== 2) {
      return { code: "badWidth", params: { code: p.code, width: p.width } };
    }
    if (!Number.isInteger(p.channel) || p.channel < 1 || endChannel(p) > DMX_CHANNELS) {
      return { code: "channelOutOfRange", params: { code: p.code, channel: p.channel } };
    }
    const max = p.width === 2 ? 65535 : 255;
    const badValue = (v: number) => !Number.isInteger(v) || v < 0 || v > max;
    if (badValue(p.defaultValue) || (p.highlightValue !== undefined && badValue(p.highlightValue))) {
      return { code: "defaultOutOfRange", params: { code: p.code } };
    }
    if ((p.head ?? 0) > heads) return { code: "headOutOfRange", params: { code: p.code } };
    if (!capabilitiesOk(p)) return { code: "badCapability", params: { code: p.code } };
  }
  for (let i = 0; i < props.length; i += 1) {
    for (let j = i + 1; j < props.length; j += 1) {
      const a = props[i];
      const b = props[j];
      if (a.channel <= endChannel(b) && b.channel <= endChannel(a)) {
        return { code: "overlap", params: { a: a.code, b: b.code } };
      }
    }
  }
  for (let i = 0; i < props.length; i += 1) {
    const p = props[i];
    if (
      isUniqueFunction(p.function) &&
      props.slice(0, i).some((q) => q.function === p.function && (q.head ?? 0) === (p.head ?? 0))
    ) {
      return { code: "duplicateFunction", params: { function: p.function } };
    }
  }
  return null;
}

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
  if (model.matrix) {
    const { cols, rows } = model.matrix;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols * rows > MAX_HEADS) {
      return { code: "badMatrix" };
    }
  }
  const modes = model.modes ?? [];
  if (modes.length > MAX_MODES) return { code: "badMode", params: { id: "" } };
  for (let i = 0; i < modes.length; i += 1) {
    const m = modes[i];
    if (m.id.trim() === "" || modes.slice(0, i).some((o) => o.id === m.id)) {
      return { code: "badMode", params: { id: m.id } };
    }
  }
  const heads = headCount(model);
  const base = validateLayout(model.properties, heads);
  if (base) return base;
  for (const m of modes) {
    const issue = validateLayout(m.properties, heads);
    if (issue) return issue;
  }
  return null;
}
