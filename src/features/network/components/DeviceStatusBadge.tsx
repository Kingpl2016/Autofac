import { CircleCheck, KeyRound, Loader2, RotateCw, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { LinkState } from "../lib/access";

const STYLE: Record<LinkState, string> = {
  online: "text-success",
  needToken: "text-warning",
  offline: "text-muted-foreground",
  checking: "text-muted-foreground",
  rebooting: "text-warning",
};

const LABEL: Record<LinkState, string> = {
  online: "network.rail.online",
  needToken: "network.rail.needToken",
  offline: "network.rail.offline",
  checking: "network.rail.checking",
  rebooting: "network.rail.rebooting",
};

interface DeviceStatusBadgeProps {
  state: LinkState;
  className?: string;
}

/**
 * 设备连接状态：图标 + 文字（状态不只靠颜色表达）。
 */
export function DeviceStatusBadge({ state, className }: DeviceStatusBadgeProps) {
  const { t } = useTranslation();
  const cls = "size-3.5 shrink-0";
  const icon =
    state === "online" ? (
      <CircleCheck className={cls} aria-hidden />
    ) : state === "needToken" ? (
      <KeyRound className={cls} aria-hidden />
    ) : state === "offline" ? (
      <WifiOff className={cls} aria-hidden />
    ) : state === "rebooting" ? (
      <RotateCw className={cn(cls, "animate-spin motion-reduce:animate-none")} aria-hidden />
    ) : (
      <Loader2 className={cn(cls, "animate-spin motion-reduce:animate-none")} aria-hidden />
    );
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", STYLE[state], className)}>
      {icon}
      {t(LABEL[state])}
    </span>
  );
}
