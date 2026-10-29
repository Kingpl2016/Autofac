import { useTranslation } from "react-i18next";
import { Circle, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { intlLocale } from "@/shared/lib/locale";
import type { LastScan } from "../stores/useScanSession";

interface ScanStatusProps {
  scanning: boolean;
  last: LastScan | null;
}

/**
 * 扫描状态胶囊：放在页头“网络扫描”按钮左侧，一行显示“● 实时 · 尚未扫描 / 正在扫描… / 上次扫描结果”。
 * 扫描中胶囊底部有一条不确定进度条。状态文字在 `aria-live="polite"` 区域，读屏会播报结果。
 */
export function ScanStatus({ scanning, last }: ScanStatusProps) {
  const { t, i18n } = useTranslation();

  let status: string;
  if (scanning) {
    status = t("discovery.scanStatusScanning");
  } else if (last) {
    status = t("discovery.scanStatusDone", {
      time: new Date(last.at).toLocaleTimeString(intlLocale(i18n.language)),
      responded: last.responded,
      total: last.total,
      added: last.added,
    });
  } else {
    status = t("discovery.scanStatusIdle");
  }

  return (
    <div className="relative flex h-10 min-w-0 max-w-md items-center gap-2 overflow-hidden rounded-full border border-border bg-card px-3.5 text-xs text-muted-foreground">
      <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-success" title={t("discovery.liveHint")}>
        <Circle className="size-2 fill-current" aria-hidden />
        {t("discovery.live")}
      </span>
      <span className="h-3 w-px shrink-0 bg-border" aria-hidden />
      <span aria-live="polite" role="status" className="truncate">
        {status}
      </span>
      {scanning && (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-primary/15">
          <span className="animate-indeterminate block h-full w-1/3 bg-primary" />
        </span>
      )}
    </div>
  );
}

interface ScanNoReplyAlertProps {
  onDismiss: () => void;
}

/** 最近一次扫描没有任何节点响应时的常驻排查提示（用户关掉前一直显示）。 */
export function ScanNoReplyAlert({ onDismiss }: ScanNoReplyAlertProps) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("discovery.scanNoReplyTitle")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("discovery.scanNoReplyHint")}</p>
        <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
          <li>{t("discovery.tipPower")}</li>
          <li>{t("discovery.tipSubnet")}</li>
          <li>{t("discovery.tipFirewall")}</li>
        </ul>
      </div>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        <X />
        {t("discovery.dismiss")}
      </Button>
    </div>
  );
}
