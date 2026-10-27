import { useEffect, useState } from "react";

import type { RecordingStatus } from "../lib/types";
import { useRecordingStore } from "../stores/useRecordingStore";

/** 时间码刷新间隔（毫秒，约 10Hz）。 */
export const CLOCK_TICK_MS = 100;
/** 超过这么久没有收到后端推送就不再外推（毫秒），避免后端卡住时时间码越跑越远。 */
export const CLOCK_FREEZE_MS = 1000;

/** 录制时钟。 */
export interface RecordingClock {
  /** 会话总时长（微秒，跨分段累加；两次推送之间平滑外推） */
  sessionUs: number;
  /** 当前分段内的时长（微秒） */
  partUs: number;
}

/**
 * 后端上报的会话时长。会话时长恒不小于分段时长；旧版后端没有会话时长字段时回落到分段时长。
 *
 * @param s 录制状态。
 */
export function sessionBase(s: RecordingStatus): number {
  return Math.max(s.sessionElapsedUs ?? 0, s.elapsedUs);
}

/** 外推得到的显示值，按录制路径区分（换录制后重新起算）。 */
interface Extrapolated {
  path: string;
  us: number;
}

/**
 * 录制中的平滑时钟：以后端最近一次 `recording:stats` 的会话时长和收到时刻为锚，
 * 每 100ms 外推一次，使时间码不再按 250ms 一跳。
 *
 * - 超过 1 秒没有新推送就停在“锚 + 1 秒”，不无限外推；
 * - 录制中显示值单调不减（新推送略小于外推值时不回跳）；
 * - 未录制时直接返回后端值，不启动定时器。
 */
export function useRecordingClock(): RecordingClock {
  const status = useRecordingStore((s) => s.status);
  const [live, setLive] = useState<Extrapolated | null>(null);

  useEffect(() => {
    if (!status.recording) return;
    const id = window.setInterval(() => {
      const { status: st, statusAt } = useRecordingStore.getState();
      const base = sessionBase(st);
      const ahead = Math.min(Math.max(0, performance.now() - statusAt), CLOCK_FREEZE_MS) * 1000;
      const us = Math.round(base + ahead);
      setLive((prev) =>
        prev && prev.path === st.path && us < prev.us ? prev : { path: st.path, us },
      );
    }, CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, [status.recording]);

  const base = sessionBase(status);
  if (!status.recording) {
    return { sessionUs: base, partUs: status.elapsedUs };
  }
  const sessionUs = live && live.path === status.path ? Math.max(live.us, base) : base;
  const starts = status.partStartsUs ?? [];
  const partStart = starts.length > 0 ? starts[starts.length - 1] : 0;
  return { sessionUs, partUs: Math.max(0, sessionUs - partStart) };
}
