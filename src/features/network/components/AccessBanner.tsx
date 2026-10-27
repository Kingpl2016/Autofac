import { KeyRound, RotateCw, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorText } from "../lib/errors";
import type { DeviceAccess } from "../hooks/useDeviceAccess";

interface AccessBannerProps {
  access: DeviceAccess;
  /** 打开当前设备的编辑对话框（设置 Token） */
  onEditDevice: () => void;
}

/**
 * 设备不可用时显示在内容区顶部的说明横幅：写明原因，并给出下一步操作。
 * 可用（`ok`）时不渲染。
 */
export function AccessBanner({ access, onEditDevice }: AccessBannerProps) {
  const { t } = useTranslation();
  const { state } = access;

  if (state === "ok" || state === "none" || state === "checking") return null;

  let tone = "border-warning/40 bg-warning/10 text-warning";
  let icon: React.ReactNode;
  let title: string;
  let body: string;
  let actions: React.ReactNode = null;

  if (state === "needToken") {
    icon = <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />;
    title = t("network.access.needTokenTitle");
    body = t("network.access.needTokenBody");
    actions = (
      <Button size="sm" onClick={onEditDevice}>
        {t("network.access.setToken")}
      </Button>
    );
  } else if (state === "offline") {
    tone = "border-border bg-surface-1 text-muted-foreground";
    icon = <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden />;
    title = t("network.access.offlineTitle");
    body = access.status.error ? errorText(t, access.status.error) : t("network.access.offlineBody");
    actions = (
      <Button size="sm" variant="outline" onClick={access.status.refetch}>
        {t("network.access.retry")}
      </Button>
    );
  } else if (state === "rebooting") {
    icon = <RotateCw className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />;
    title = t("network.access.rebootingTitle");
    body = t("network.access.rebootingBody");
  } else {
    return null;
  }

  return (
    <div
      role={state === "rebooting" ? "status" : "alert"}
      className={cn("mb-(--density-gutter) flex flex-wrap items-start gap-3 rounded-lg border px-4 py-3", tone)}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-0.5 text-xs">{body}</p>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
