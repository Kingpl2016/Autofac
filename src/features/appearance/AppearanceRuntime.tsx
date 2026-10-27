import { useBackgroundPause } from "./hooks/useBackgroundPause";
import { useCardPointerEffects } from "./hooks/useCardPointerEffects";

/** 外观的无界面运行时：页面不可见时暂停动态背景、卡片的指针跟随悬停效果。 */
export function AppearanceRuntime() {
  useBackgroundPause();
  useCardPointerEffects();
  return null;
}