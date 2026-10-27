import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Info, OctagonAlert, TriangleAlert, X, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** 告警色调：提示 / 告警 / 错误。 */
export type InlineAlertTone = "info" | "warning" | "destructive";

const TONES: Record<InlineAlertTone, { icon: LucideIcon; className: string }> = {
  info: { icon: Info, className: "border-border bg-surface-1 text-muted-foreground" },
  warning: { icon: TriangleAlert, className: "border-warning/40 bg-warning/10 text-warning" },
  destructive: {
    icon: OctagonAlert,
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  },
};

interface InlineAlertProps {
  tone?: InlineAlertTone;
  children: ReactNode;
  /**
   * 是否用 `role="alert"` 立即打断读屏（只用于需要用户马上知道的异常，例如被迫停止）。
   * 默认用 `role="status"` 礼貌播报。
   */
  assertive?: boolean;
  /** 提供时显示关闭按钮 */
  onDismiss?: () => void;
  className?: string;
}

/**
 * 页内告警条：图标 + 文字 + 状态色边框（不只靠颜色），可选关闭按钮。
 * 统一取代各页面手写的告警段落。
 */
export function InlineAlert({
  tone = "warning",
  children,
  assertive = false,
  onDismiss,
  className,
}: InlineAlertProps) {
  const { t } = useTranslation();
  const { icon: Icon, className: toneClass } = TONES[tone];
  return (
    <div
      role={assertive ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        toneClass,
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <button
          type="button"
          className="-my-1 -mr-1.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md opacity-80 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("common.close")}
          onClick={onDismiss}
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
