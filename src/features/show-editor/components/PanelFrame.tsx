import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface PanelFrameProps {
  /** 面板标题（省略 `regionLabel` 时也作为区域的可访问名称） */
  title: string;
  /** 区域的可访问名称（标题随内容变化时，用它保持地标名称稳定） */
  regionLabel?: string;
  /** 标题栏右侧的操作区 */
  actions?: ReactNode;
  /** 内容区是否自己管理滚动（默认由面板滚动） */
  noScroll?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * 编辑器各区域通用的外框：细标题栏 + 内容区，作为带名称的 region 地标。
 */
export function PanelFrame({ title, regionLabel, actions, noScroll, className, children }: PanelFrameProps) {
  return (
    <section
      aria-label={regionLabel ?? title}
      className={cn("flex h-full min-h-0 min-w-0 flex-col bg-surface-2", className)}
    >
      <header className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <h2 className="truncate text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        {actions && <div className="flex items-center gap-1">{actions}</div>}
      </header>
      <div className={cn("min-h-0 flex-1", noScroll ? "overflow-hidden" : "overflow-auto")}>
        {children}
      </div>
    </section>
  );
}
