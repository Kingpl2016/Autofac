/** 屏幕取色（浏览器 EyeDropper API，Chromium 系的 WebView2 支持，WebKit 暂不支持）。 */

/** EyeDropper 的最小类型描述（TypeScript 的 DOM 库里还没有）。 */
interface EyeDropperLike {
  /** 打开取色器，用户点击屏幕任意位置后返回颜色；按 Esc 取消时 reject。 */
  open: () => Promise<{ sRGBHex: string }>;
}

type EyeDropperCtor = new () => EyeDropperLike;

function eyeDropperCtor(): EyeDropperCtor | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;
}

/**
 * 当前环境是否支持屏幕取色（不支持时界面应隐藏取色按钮）。
 *
 * @returns 支持时为 `true`。
 */
export function canPickScreenColor(): boolean {
  return eyeDropperCtor() !== undefined;
}

/**
 * 打开屏幕取色器。
 *
 * @returns 取到的颜色（`#rrggbb`）；用户取消或环境不支持时为 `null`。
 */
export async function pickScreenColor(): Promise<string | null> {
  const Ctor = eyeDropperCtor();
  if (!Ctor) return null;
  try {
    return (await new Ctor().open()).sRGBHex;
  } catch {
    return null;
  }
}
