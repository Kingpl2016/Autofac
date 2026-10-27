/** @file 卡片指针效果的纯计算与 DOM 写入：聚光灯、高光扫过、倾斜只写 CSS 变量，不触发重排 */

/** 倾斜的最大角度（度） */
export const MAX_TILT_DEG = 6

/** 指针相对卡片的几何信息 */
interface PointerGeometry {
  /** 卡片的位置与尺寸（getBoundingClientRect） */
  rect: { left: number; top: number; width: number; height: number }
  /** 指针的视口坐标 */
  clientX: number
  /** 指针的视口坐标 */
  clientY: number
}

/**
 * 根据指针位置计算要写入卡片的 CSS 变量。
 *
 * @remarks
 * 指针在卡片内的相对位置会被限制在 0~1；卡片尺寸为 0 时返回居中值，避免除零。
 *
 * @param geometry - 指针与卡片的几何信息
 * @returns 变量名到取值的映射
 */
export function computeCardPointerVars({
  rect,
  clientX,
  clientY,
}: PointerGeometry): Record<string, string> {
  const ratioX = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0.5
  const ratioY =
    rect.height > 0 ? Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)) : 0.5
  return {
    '--card-mx': `${Math.round(ratioX * rect.width)}px`,
    '--card-my': `${Math.round(ratioY * rect.height)}px`,
    '--card-gx': `${Math.round(ratioX * 100)}%`,
    // 指针在右侧时，卡片右边向后倾（rotateY 为正），在下方时下边向后倾（rotateX 为负）
    '--card-rx': `${((0.5 - ratioY) * 2 * MAX_TILT_DEG).toFixed(2)}deg`,
    '--card-ry': `${((ratioX - 0.5) * 2 * MAX_TILT_DEG).toFixed(2)}deg`,
  }
}

/** 会被写入卡片的全部变量名，复位时统一清除 */
const POINTER_VAR_NAMES = ['--card-mx', '--card-my', '--card-gx', '--card-rx', '--card-ry'] as const

/**
 * 把指针变量写入卡片，并标记为活动状态。
 *
 * @param card - 卡片元素
 * @param vars - 变量映射
 */
export function applyCardPointerVars(card: HTMLElement, vars: Record<string, string>): void {
  for (const [name, value] of Object.entries(vars)) card.style.setProperty(name, value)
  card.dataset.cardActive = ''
}

/**
 * 清除卡片上的指针变量与活动标记。
 *
 * @param card - 卡片元素
 */
export function resetCardPointerVars(card: HTMLElement): void {
  for (const name of POINTER_VAR_NAMES) card.style.removeProperty(name)
  delete card.dataset.cardActive
}
