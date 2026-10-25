import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface SurfacePanelProps {
  /** 面板标题（二级标题） */
  title?: ReactNode;
  /** 标题右侧操作区 */
  actions?: ReactNode;
  /** 状态着色边框：录制红 / 播放绿 */
  tone?: "default" | "recording" | "playing";
  className?: string;
  children: ReactNode;
}

/**
 * 分层面板：取代 `p-8` 的 `Card`，使用 `--panel-pad` 紧凑留白与 `surface-2` 底色。
 */
export function SurfacePanel({
  title,
  actions,
  tone = "default",
  className,
  children,
}: SurfacePanelProps) {
  return (
    <section
      className={cn(
        "rounded-xl border border-border bg-surface-2 p-(--panel-pad) transition-shadow",
        tone === "default" && "panel-edge",
        tone === "recording" && "border-recording/50 glow-recording",
        tone === "playing" && "border-success/40 glow-success",
        className,
      )}
    >
      {(title || actions) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
