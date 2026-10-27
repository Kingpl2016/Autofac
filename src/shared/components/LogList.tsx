import { Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { LogEntry, LogLevel } from "@/shared/stores/logStore";

/** 各级别的圆点颜色与标签颜色（文字标签始终存在，不只靠颜色区分）。 */
const LEVEL: Record<LogLevel, { dot: string; label: string }> = {
  info: { dot: "bg-muted-foreground/60", label: "text-muted-foreground" },
  warn: { dot: "bg-warning", label: "text-warning" },
  error: { dot: "bg-destructive", label: "text-destructive" },
};

/** 按当前界面语言格式化日志时间。 */
function formatTime(ts: number, language: string): string {
  const locale = language.startsWith("zh") ? "zh-CN" : "en-US";
  return new Date(ts).toLocaleTimeString(locale, { hour12: false });
}

interface LogListProps {
  /** 日志条目，按时间从旧到新；组件内部倒序显示（最新在最上面） */
  entries: readonly LogEntry[];
  className?: string;
}

/**
 * 系统日志列表：每行是 时间 / 级别徽标 / 内容，错误与警告行带淡色底，空时给出提示。
 * 底部状态条与仪表盘共用。
 */
export function LogList({ entries, className }: LogListProps) {
  const { t, i18n } = useTranslation();

  if (entries.length === 0) {
    return (
      <div className={cn("flex flex-col items-center justify-center gap-2 text-muted-foreground", className)}>
        <Terminal className="size-5 opacity-60" aria-hidden />
        <p className="text-xs">{t("statusBar.logEmpty")}</p>
      </div>
    );
  }

  return (
    <ul aria-label={t("statusBar.systemLog")} className={cn("font-mono text-xs", className)}>
      {entries
        .slice()
        .reverse()
        .map((e) => (
          <li
            key={e.id}
            className={cn(
              "grid grid-cols-[4.5rem_4.25rem_minmax(0,1fr)] items-baseline gap-x-3 rounded-md px-2 py-1 transition-colors hover:bg-surface-3/60",
              e.level === "error" && "bg-destructive/10",
              e.level === "warn" && "bg-warning/10",
            )}
          >
            <time dateTime={new Date(e.ts).toISOString()} className="tabular text-muted-foreground">
              {formatTime(e.ts, i18n.language)}
            </time>
            <span className={cn("inline-flex items-center gap-1.5 font-semibold uppercase", LEVEL[e.level].label)}>
              <span className={cn("size-1.5 shrink-0 rounded-full", LEVEL[e.level].dot)} aria-hidden />
              {e.level}
            </span>
            <span className="min-w-0 break-words text-foreground">{e.message}</span>
          </li>
        ))}
    </ul>
  );
}
