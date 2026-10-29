import { useTargetCapabilities } from "../hooks/useTargetCapabilities";
import { EffectLibrarySection } from "./EffectLibrarySection";

/**
 * 素材库的“特效”标签：属性特效库（配置文件加载，插入后仍可改参数的外观片段，可叠加、按拍）。
 *
 * 原来的 8 种经典 RGB 特效（呼吸、彩虹、追逐、擦除、渐变、脉冲、闪烁、频闪）在库里都有对应的可配置特效；
 * 旧工程里的经典特效片段照常播放，可在 Cue 属性里一键转换为可配置特效。
 */
export function EffectsTab() {
  const caps = useTargetCapabilities();
  return (
    <div className="flex flex-col gap-4 p-2">
      <EffectLibrarySection caps={caps} />
    </div>
  );
}
