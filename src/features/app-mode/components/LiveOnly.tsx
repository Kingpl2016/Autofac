import type { ReactNode } from "react";

import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { ModeGuardNotice } from "./ModeGuardNotice";

interface LiveOnlyProps {
  children: ReactNode;
}

/**
 * 仅实时模式可用的页面外壳：播放器模式下显示 [`ModeGuardNotice`] 而不是页面本体。
 *
 * 播放器模式下接收任务已拆除、实时状态已清空，这类页面不会有任何数据，
 * 与其显示一片空白，不如说明原因并给出出路。
 */
export function LiveOnly({ children }: LiveOnlyProps) {
  const appMode = useEngineStatusStore((s) => s.appMode);
  return appMode === "player" ? <ModeGuardNotice /> : <>{children}</>;
}
