import { useCallback, useEffect, useRef, useState } from "react";

/** 点击目录跳转后，这段时间内忽略滚动观察的结果，避免平滑滚动途中高亮来回跳。 */
const JUMP_LOCK_MS = 800;

/**
 * 跟踪当前阅读到的分区：用 `IntersectionObserver` 观察各分区元素，取视口上半部分里
 * 最靠前的一个作为“当前分区”，供左侧目录高亮。
 *
 * # Arguments
 *
 * * `ids` - 按页面顺序排列的分区 DOM id；变化时重新观察。
 *
 * # Returns
 *
 * `[active, select]`：当前分区 id（`ids` 为空时为 `undefined`）与手动选中函数
 * （点击目录时调用，立即高亮并短暂锁定）。
 */
export function useActiveSection(
  ids: readonly string[],
): [string | undefined, (id: string) => void] {
  const [active, setActive] = useState<string | undefined>(ids[0]);
  const lockUntil = useRef(0);
  const key = ids.join("|");

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const order = key === "" ? [] : key.split("|");
    const visible = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        if (performance.now() < lockUntil.current) return;
        const first = order.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      // 只看视口上半部分：分区标题滚到上方时才算“读到这里”
      { rootMargin: "0px 0px -55% 0px", threshold: 0 },
    );
    for (const id of order) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [key]);

  const select = useCallback((id: string) => {
    lockUntil.current = performance.now() + JUMP_LOCK_MS;
    setActive(id);
  }, []);

  // 搜索过滤后原来的分区可能不在了：退回第一个
  const current = active !== undefined && ids.includes(active) ? active : ids[0];
  return [current, select];
}
