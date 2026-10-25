import { useCallback, useEffect, useState } from "react";

import { setViewedUniverses } from "../lib/api";

/**
 * 管理"正在查看"的 Universe 集合，并同步到后端（决定推送哪些通道数据）。
 *
 * @returns 已选集合与增删/批量操作。
 */
export function useViewedUniverses() {
  const [selected, setSelected] = useState<number[]>([]);

  // 同步到后端
  useEffect(() => {
    void setViewedUniverses(selected).catch(() => {});
  }, [selected]);

  const toggle = useCallback((u: number) => {
    setSelected((prev) =>
      prev.includes(u) ? prev.filter((x) => x !== u) : [...prev, u].sort((a, b) => a - b),
    );
  }, []);

  const selectAll = useCallback((all: number[]) => {
    setSelected([...all].sort((a, b) => a - b));
  }, []);

  const clear = useCallback(() => setSelected([]), []);

  return { selected, toggle, selectAll, clear };
}
