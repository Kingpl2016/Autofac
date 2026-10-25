import { useTranslation } from "react-i18next";

import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { formatLastSeen } from "../lib/format";

interface LastSeenProps {
  /** 设备最后活动的逻辑时间（毫秒） */
  lastSeenMs: number;
}

/**
 * 相对时间文本。自己订阅引擎运行时长，这样每秒的时钟变化只重渲这个叶子，
 * 不会带动整张表的所有行。
 */
export function LastSeen({ lastSeenMs }: LastSeenProps) {
  const { i18n } = useTranslation();
  // 设备的 lastSeenMs 与引擎运行时长同一时间基准
  const nowMs = useEngineDataStore((s) => s.stats.uptimeSec) * 1000;
  return <>{formatLastSeen(lastSeenMs, nowMs, i18n.language)}</>;
}
