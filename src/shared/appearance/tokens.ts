/**
 * 外观 token 白名单与取值校验：防止导入或被手改的设置把任意 CSS 注入页面。
 * token 名与 `globals.css` 里的语义令牌一一对应。状态语义色（成功 / 告警 / 录制 / 在线）刻意不在白名单内，
 * 任何主题和主色都不能改变它们。
 */
import type { TokenMap } from "./types";

/** 颜色 token 名。 */
export const COLOR_TOKEN_NAMES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--input",
  "--surface-1",
  "--surface-2",
  "--surface-3",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
] as const;

/** 强调色色相 token 名（0 到 360 的纯数字）。 */
export const ACCENT_HUE_TOKEN = "--accent-h";
/** 强调色彩度 token 名（0 到 0.4 的纯数字）。 */
export const ACCENT_CHROMA_TOKEN = "--accent-c";
/** 基础圆角 token 名。 */
export const RADIUS_TOKEN = "--radius";
/** 无衬线字体 token 名。 */
export const FONT_SANS_TOKEN = "--font-sans";
/** 等宽字体 token 名。 */
export const FONT_MONO_TOKEN = "--font-mono";
/** 卡片圆角 token 名。 */
export const CARD_RADIUS_TOKEN = "--card-radius";
/** 毛玻璃卡片的模糊半径 token 名。 */
export const CARD_BLUR_TOKEN = "--card-blur";
/** 界面缩放 token 名：不带单位的百分数，如 `105`；`globals.css` 用它换算根字号。 */
export const UI_SCALE_TOKEN = "--ui-scale";
/** 页面边距 token 名。 */
export const DENSITY_GUTTER_TOKEN = "--density-gutter";
/** 区块间距 token 名。 */
export const DENSITY_GAP_TOKEN = "--density-gap";
/** 面板内边距 token 名（分层面板的 padding）。 */
export const PANEL_PAD_TOKEN = "--panel-pad";

/** 界面缩放允许的百分比范围。 */
export const UI_SCALE_LIMITS = { min: 85, max: 125 } as const;

/** 允许写入 `<html>` 的全部 token 名。 */
export const ALLOWED_TOKEN_NAMES: ReadonlySet<string> = new Set<string>([
  ...COLOR_TOKEN_NAMES,
  ACCENT_HUE_TOKEN,
  ACCENT_CHROMA_TOKEN,
  RADIUS_TOKEN,
  CARD_RADIUS_TOKEN,
  CARD_BLUR_TOKEN,
  FONT_SANS_TOKEN,
  FONT_MONO_TOKEN,
  UI_SCALE_TOKEN,
  DENSITY_GUTTER_TOKEN,
  DENSITY_GAP_TOKEN,
  PANEL_PAD_TOKEN,
]);

const COLOR_TOKEN_SET: ReadonlySet<string> = new Set<string>(COLOR_TOKEN_NAMES);

/** 单个取值允许的最大长度。 */
const MAX_VALUE_LENGTH = 300;

const HEX_COLOR = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;
const FUNCTIONAL_COLOR = /^(?:oklch|oklab|hsla?|rgba?)\([\d\sa-z.,%/+-]+\)$/i;
const LENGTH = /^(\d*\.?\d+)(rem|px)$/i;
const NUMBER = /^\d*\.?\d+$/;
const FONT_STACK = /^[\w\s,'"-]+$/;

/** 判断是否为受支持的 CSS 颜色写法（十六进制，或 oklch、oklab、hsl、rgb 函数）。 */
function isSafeColor(value: string): boolean {
  return HEX_COLOR.test(value) || FUNCTIONAL_COLOR.test(value);
}

/** 判断长度值是否合法且不超过上限（rem 或 px）。 */
function isSafeLength(value: string, maxRem: number): boolean {
  const match = LENGTH.exec(value);
  if (!match) return false;
  const amount = Number(match[1]);
  const rem = match[2]?.toLowerCase() === "px" ? amount / 16 : amount;
  return Number.isFinite(rem) && rem <= maxRem;
}

/** 判断是否为落在 [min, max] 内的纯数字。 */
function isNumberInRange(value: string, min: number, max: number): boolean {
  if (!NUMBER.test(value)) return false;
  const n = Number(value);
  return n >= min && n <= max;
}

/**
 * 判断某个 token 的取值是否安全。
 *
 * 按 token 类型分别校验：颜色只接受十六进制与常见颜色函数；圆角与间距只接受有上限的长度；
 * 色相 / 彩度 / 缩放只接受范围内的纯数字；字体只接受字母、数字、空格、逗号、引号与连字符，
 * 拒绝 `url(`、分号、花括号等一切可能逃逸出声明的内容。
 *
 * @param name token 名，如 `--background`。
 * @param value token 取值。
 * @returns 名称在白名单内且取值安全时为 true。
 */
export function isSafeTokenValue(name: string, value: unknown): value is string {
  if (typeof value !== "string" || !ALLOWED_TOKEN_NAMES.has(name)) return false;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_VALUE_LENGTH) return false;
  if (COLOR_TOKEN_SET.has(name)) return isSafeColor(text);
  if (name === ACCENT_HUE_TOKEN) return isNumberInRange(text, 0, 360);
  if (name === ACCENT_CHROMA_TOKEN) return isNumberInRange(text, 0, 0.4);
  if (name === RADIUS_TOKEN || name === CARD_RADIUS_TOKEN) return isSafeLength(text, 2);
  if (name === CARD_BLUR_TOKEN) return isSafeLength(text, 2.5);
  if (name === DENSITY_GUTTER_TOKEN || name === DENSITY_GAP_TOKEN || name === PANEL_PAD_TOKEN) return isSafeLength(text, 4);
  if (name === UI_SCALE_TOKEN) return isNumberInRange(text, UI_SCALE_LIMITS.min, UI_SCALE_LIMITS.max);
  // 字体栈
  return FONT_STACK.test(text);
}

/**
 * 过滤出安全的 token，丢弃名称不在白名单或取值不安全的项。
 *
 * @param input 任意来源（持久化数据、导入文件、插件注册）的数据。
 * @returns 只包含安全项的 token 映射；输入不是对象时返回空映射。
 */
export function sanitizeTokenMap(input: unknown): TokenMap {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (isSafeTokenValue(name, value)) result[name] = value.trim();
  }
  return result;
}
