import { KeyRound, Lock, LockOpen, RotateCw, WifiOff } from "lucide-react";
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
 * 设备不可用 / 只读时显示在内容区顶部的说明横幅：写明原因，并给出下一步操作。
 * 可用（`ok`）且没有覆盖时不渲染。
 */
export function AccessBanner({ access, onEditDevice }: AccessBannerProps) {
  const { t } = useTranslation();
  const { state } = access;

  const overridden = state === "ok" && access.forceWrite && access.tokenSet === false;
  if (state === "ok" && !overridden) return null;
  if (state === "none" || state === "checking") return null;

  let tone = "border-warning/40 bg-warning/10 text-warning";
  let icon = <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />;
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
  } else if (state === "readonly") {
    title = t("network.access.readonlyTitle");
    body = t("network.access.readonlyBody");
    actions = (
      <>
        <Button size="sm" onClick={onEditDevice}>
          {t("network.access.setToken")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => access.setForceWrite(true)}>
          {t("network.access.forceWrite")}
        </Button>
      </>
    );
  } else {
    // 已覆盖只读：提示当前在"尝试写操作"，可随时恢复
    tone = "border-border bg-surface-1 text-muted-foreground";
    icon = <LockOpen className="mt-0.5 size-4 shrink-0" aria-hidden />;
    title = t("network.access.forcedTitle");
    body = t("network.access.forcedBody");
    actions = (
      <Button size="sm" variant="outline" onClick={() => access.setForceWrite(false)}>
        {t("network.access.restoreReadonly")}
      </Button>
    );
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
