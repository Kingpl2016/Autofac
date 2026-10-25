import { useTranslation } from "react-i18next";
import { Circle, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LastScan } from "../hooks/useNetworkScan";

interface ScanStatusBarProps {
  scanning: boolean;
  last: LastScan | null;
  /** 最近一次扫描没有任何节点响应，且用户还没关掉提示 */
  showNoReply: boolean;
  onDismissNoReply: () => void;
}

/**
 * 扫描状态条：左侧“实时”标记，右侧显示扫描进度 / 上次结果；
 * 扫描中底部有一条不确定进度条。无节点响应时在下方展开常驻排查提示。
 * 状态文字放在 `aria-live="polite"` 区域，读屏会播报结果。
 */
export function ScanStatusBar({
  scanning,
  last,
  showNoReply,
  onDismissNoReply,
}: ScanStatusBarProps) {
  const { t, i18n } = useTranslation();

  let status: string;
  if (scanning) {
    status = t("discovery.scanStatusScanning");
  } else if (last) {
    status = t("discovery.scanStatusDone", {
      time: new Date(last.at).toLocaleTimeString(i18n.language.startsWith("zh") ? "zh-CN" : "en"),
      responded: last.responded,
      total: last.total,
      added: last.added,
    });
  } else {
    status = t("discovery.scanStatusIdle");
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative flex min-h-9 flex-wrap items-center gap-x-4 gap-y-1 overflow-hidden rounded-lg border border-border bg-card px-4 text-xs text-muted-foreground">
        <span
          className="inline-flex items-center gap-1.5 text-success"
          title={t("discovery.liveHint")}
        >
          <Circle className="size-2 fill-current" aria-hidden />
          {t("discovery.live")}
        </span>
        <span aria-live="polite" role="status">
          {status}
        </span>
        {scanning && (
          <span
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-primary/15"
          >
            <span className="animate-indeterminate block h-full w-1/3 bg-primary" />
          </span>
        )}
      </div>

      {showNoReply && (
        <div
          role="alert"
          className={cn(
            "flex items-start gap-3 rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-sm",
          )}
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t("discovery.scanNoReplyTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("discovery.scanNoReplyHint")}
            </p>
            <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
              <li>{t("discovery.tipPower")}</li>
              <li>{t("discovery.tipSubnet")}</li>
              <li>{t("discovery.tipFirewall")}</li>
            </ul>
          </div>
          <Button variant="ghost" size="sm" onClick={onDismissNoReply}>
            <X />
            {t("discovery.dismiss")}
          </Button>
        </div>
      )}
    </div>
  );
}
