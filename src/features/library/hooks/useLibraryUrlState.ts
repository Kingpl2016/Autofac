import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { parseLibraryParams, writeLibraryParams, type LibraryUrlState } from "../lib/libraryFilters";

/**
 * 节目库页面的可分享状态（搜索词、类别、排序、选中节目）保存在地址栏里：
 * 刷新页面或从录制页“在节目库中查看”跳转过来都能还原。更新用 `replace`，不堆积浏览历史。
 */
export function useLibraryUrlState() {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => parseLibraryParams(params), [params]);
  const update = useCallback(
    (patch: Partial<LibraryUrlState>) =>
      setParams((prev) => writeLibraryParams(prev, patch), { replace: true }),
    [setParams],
  );
  return [state, update] as const;
}
