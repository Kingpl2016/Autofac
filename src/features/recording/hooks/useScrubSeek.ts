import { useCallback, useEffect, useRef, useState } from "react";

/** 拖动时向后端发送 seek 的最小间隔（毫秒）。 */
export const SEEK_THROTTLE_MS = 60;

/** `useScrubSeek` 的返回值。 */
export interface ScrubSeek {
  /** 拖动中的本地位置（微秒）；未拖动时为 `null`，显示应回到后端上报的位置。 */
  dragPos: number | null;
  /** 拖动中：更新本地位置，并节流地发出 seek（保证最后一次位置一定会发出）。 */
  scrub: (posUs: number) => void;
  /**
   * 结束拖动：立即发出最终位置（省略时取最后一次拖动的位置）并清除本地位置；
   * 未在拖动时什么也不做。
   */
  commit: (posUs?: number) => void;
  /** 放弃拖动（例如指针被取消）：清除本地位置与待发送的 seek，不再发出。 */
  cancel: () => void;
}

/**
 * 进度条 / 时间线拖动跳转的共用逻辑：本地位置覆盖、60ms 节流 + 尾随调用、松手提交。
 *
 * 拖动期间显示以本地位置为准，播放头紧跟指针；松手后回到后端上报的位置，
 * 避免“后端还没回传、播放头先跳回旧位置”的闪烁。
 *
 * @param onSeek 实际的跳转函数（微秒）。
 */
export function useScrubSeek(onSeek: (posUs: number) => void): ScrubSeek {
  const [dragPos, setDragPos] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const lastSeekAt = useRef(0);
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekRef = useRef(onSeek);
  useEffect(() => {
    seekRef.current = onSeek;
  });

  const clearTrailing = () => {
    if (trailing.current) {
      clearTimeout(trailing.current);
      trailing.current = null;
    }
  };
  useEffect(() => clearTrailing, []);

  const scrub = useCallback((posUs: number) => {
    dragRef.current = posUs;
    setDragPos(posUs);
    clearTrailing();
    const now = performance.now();
    if (now - lastSeekAt.current >= SEEK_THROTTLE_MS) {
      lastSeekAt.current = now;
      seekRef.current(posUs);
    } else {
      trailing.current = setTimeout(() => {
        trailing.current = null;
        lastSeekAt.current = performance.now();
        seekRef.current(posUs);
      }, SEEK_THROTTLE_MS);
    }
  }, []);

  const commit = useCallback((posUs?: number) => {
    if (dragRef.current === null) return;
    const final = posUs ?? dragRef.current;
    clearTrailing();
    dragRef.current = null;
    lastSeekAt.current = performance.now();
    seekRef.current(final);
    setDragPos(null);
  }, []);

  const cancel = useCallback(() => {
    clearTrailing();
    dragRef.current = null;
    setDragPos(null);
  }, []);

  return { dragPos, scrub, commit, cancel };
}
