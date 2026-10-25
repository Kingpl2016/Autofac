import type { ReactNode } from "react";

interface SettingRowProps {
  /** 标签文本 */
  label: string;
  /** 辅助说明 */
  hint?: string;
  /** 右侧控件 */
  children: ReactNode;
}

/**
 * 单行设置项：左侧标签+说明，右侧控件。
 */
export function SettingRow({ label, hint, children }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between gap-8 py-5">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex w-56 shrink-0 justify-end">{children}</div>
    </div>
  );
}
