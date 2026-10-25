import { useTranslation } from "react-i18next";
import { AlertCircle, Check, Clock, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SaveStatus } from "../hooks/useSettings";

interface SaveStatusBadgeProps {
  status: SaveStatus;
}

/**
 * 自动保存状态徽标：把一过性的 toast 补成一条常驻、可读的状态
 * （待保存 / 保存中 / 已保存 / 失败），满足「反馈可见、不只靠瞬时提示」。
 *
 * 空闲（尚无改动）时不渲染，避免噪声。状态始终「图标 + 文字 + 颜色」三重编码。
 */
export function SaveStatusBadge({ status }: SaveStatusBadgeProps) {
  const { t } = useTranslation();
  if (status === "idle") return null;

  const map = {
    pending: {
      icon: Clock,
      label: t("settings.statusPending"),
      cls: "text-muted-foreground",
      spin: false,
    },
    saving: {
      icon: Loader2,
      label: t("settings.statusSaving"),
      cls: "text-muted-foreground",
      spin: true,
    },
    saved: {
      icon: Check,
      label: t("settings.statusSaved"),
      cls: "text-success",
      spin: false,
    },
    error: {
      icon: AlertCircle,
      label: t("settings.statusError"),
      cls: "text-destructive",
      spin: false,
    },
  } as const;

  const { icon: Icon, label, cls, spin } = map[status];

  return (
    <span
      className={cn("flex items-center gap-1.5 text-xs font-medium", cls)}
      role="status"
      aria-live="polite"
    >
      <Icon className={cn("size-3.5", spin && "animate-spin")} aria-hidden />
      {label}
    </span>
  );
}
