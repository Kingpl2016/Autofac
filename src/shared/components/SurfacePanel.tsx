import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface SurfacePanelProps {
  /** 面板标题（二级标题） */
  title?: ReactNode;
  /** 标题右侧操作区 */
  actions?: ReactNode;
  /** 状态着色边框：录制红 / 播放绿 / 播放器模式强调色 */
  tone?: "default" | "recording" | "playing" | "player";
  /** 元素 id（例如作为页内锚点） */
  id?: string;
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
  id,
  className,
  children,
}: SurfacePanelProps) {
  return (
    <section
      id={id}
      // 个性化的卡片样式作用于带 data-surface 的面板；带状态着色的面板保持自己的语义边框
      data-surface={tone === "default" ? "" : undefined}
      className={cn(
        "rounded-xl border border-border bg-surface-2 p-(--panel-pad) transition-shadow",
        tone === "default" && "panel-edge",
        tone === "recording" && "border-recording/50 glow-recording",
        tone === "playing" && "border-success/40 glow-success",
        tone === "player" && "border-primary/40 glow-primary",
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
