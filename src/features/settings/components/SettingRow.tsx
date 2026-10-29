import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { useRowFilter } from "../hooks/useSettingsFilter";

interface SettingRowProps {
  /** 标签文本 */
  label: string;
  /** 辅助说明 */
  hint?: string;
  /** 右侧控件 */
  children: ReactNode;
}

/**
 * 单行设置项：左侧标签 + 说明，右侧控件；窄屏时控件换到标签下方。
 * 行内边距自带（卡片不再包一层 padding），悬停时轻微提亮，方便在长列表里定位当前行。
 * 搜索时不匹配的行不渲染，匹配的行用主色淡底标出。
 */
export function SettingRow({ label, hint, children }: SettingRowProps) {
  const { visible, highlighted } = useRowFilter(label, hint);
  if (!visible) return null;
  return (
    <div
      data-slot="setting-row"
      data-match={highlighted || undefined}
      className={cn(
        "flex flex-col gap-2 px-5 py-3.5 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center sm:justify-between sm:gap-8",
        highlighted && "bg-primary/5",
      )}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex shrink-0 sm:w-60 sm:justify-end">{children}</div>
    </div>
  );
}
