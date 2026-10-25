import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface PageHeaderProps {
  /** 标题 */
  title: string;
  /** 副标题 */
  subtitle?: string;
  /** 右侧操作区 */
  actions?: ReactNode;
  /** 覆盖外层样式（如收紧下边距） */
  className?: string;
}

/**
 * 页面统一页头：标题 + 副标题 + 右侧操作区。
 */
export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        "mb-(--density-gutter) flex items-start justify-between gap-8",
        className,
      )}
    >
      <div>
        {/* tabIndex=-1：路由切换后可被程序聚焦，读屏用户据此知道页面已更换 */}
        <h1 tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </div>
  );
}
