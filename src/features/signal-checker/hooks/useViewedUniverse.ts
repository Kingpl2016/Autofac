import { useEffect, useState } from "react";

import { setPreview } from "../lib/api";
import { useSenderStore } from "../stores/useSenderStore";

/** 没有状态时的空列表（保持引用稳定，避免无谓的重新渲染）。 */
const NO_UNIVERSES: number[] = [];

/**
 * 管理"正在查看哪个 Universe"，并告诉后端只推送这一路的预览。
 *
 * 选择会随发送范围变化自动纠正：所选 Universe 不在范围内时回落到范围内第一个。
 * 组件卸载时关闭预览推送。
 *
 * # Returns
 *
 * `universe` 当前查看的 Universe（范围为空时为 `null`）、`universes` 可选的全部 Universe、
 * `setUniverse` 切换查看对象。
 */
export function useViewedUniverse() {
  const universes = useSenderStore((s) => s.status?.universes) ?? NO_UNIVERSES;
  const [chosen, setChosen] = useState<number | null>(null);
  const universe = chosen !== null && universes.includes(chosen) ? chosen : (universes[0] ?? null);

  useEffect(() => {
    void setPreview(universe).catch(() => undefined);
    return () => {
      void setPreview(null).catch(() => undefined);
    };
  }, [universe]);

  return { universe, universes, setUniverse: setChosen };
}
