import { useState } from "react";
import { CircleAlert, CircleCheck, Download, Upload, Cpu, X, ChevronDown, ChevronUp, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorText } from "../lib/errors";
import { formatBytes, formatSpeed, percentOf } from "../lib/format";
import { useTransferStore, type TransferItem, type TransferKind } from "../stores/useTransferStore";

interface TransferTrayProps {
  /** 设备 id → 显示名，用于标出任务属于哪台设备 */
  deviceNames: Record<string, string>;
}

const KIND_ICON: Record<TransferKind, typeof Upload> = {
  upload: Upload,
  download: Download,
  ota: Cpu,
};

/**
 * 页面底部的传输队列抽屉：进行中的任务带进度、速度和取消；失败的保留原因并可重试。
 * 读取全局传输 store，所以切换 Tab / 设备甚至离开本页，任务都不会丢。
 */
export function TransferTray({ deviceNames }: TransferTrayProps) {
  const { t } = useTranslation();
  const items = useTransferStore((s) => s.items);
  const dismiss = useTransferStore((s) => s.dismiss);
  const clearFinished = useTransferStore((s) => s.clearFinished);
  const [open, setOpen] = useState(true);

  if (items.length === 0) return null;
  const running = items.filter((i) => i.state === "running").length;
  const finished = items.length - running;
  const summary =
    running > 0
      ? t("network.transfer.running", { count: running })
      : t("network.transfer.allDone", { count: items.length });

  return (
    <section
      aria-label={t("network.transfer.title")}
      className="sticky bottom-0 z-10 mt-(--density-gutter) rounded-xl border border-border bg-surface-2 shadow-lg panel-edge animate-fade-up"
    >
      <header className="flex items-center gap-3 px-4 py-2">
        <h2 className="text-sm font-semibold tracking-tight">{t("network.transfer.title")}</h2>
        <span className="text-xs text-muted-foreground" role="status">
          {summary}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {finished > 0 && (
            <Button variant="ghost" size="sm" onClick={clearFinished}>
              {t("network.transfer.clear")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            aria-expanded={open}
            aria-label={open ? t("network.transfer.collapse") : t("network.transfer.expand")}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <ChevronDown /> : <ChevronUp />}
          </Button>
        </div>
      </header>

      {open && (
        <ul className="max-h-64 divide-y divide-border overflow-y-auto border-t border-border">
          {items.map((item) => (
            <TransferRow
              key={item.id}
              item={item}
              deviceName={deviceNames[item.deviceId]}
              onDismiss={() => dismiss(item.id)}
              onRetry={
                item.retry
                  ? () => {
                      dismiss(item.id);
                      item.retry?.();
                    }
                  : undefined
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface TransferRowProps {
  item: TransferItem;
  deviceName?: string;
  onDismiss: () => void;
  onRetry?: () => void;
}

function TransferRow({ item, deviceName, onDismiss, onRetry }: TransferRowProps) {
  const { t } = useTranslation();
  const Icon = KIND_ICON[item.kind];
  const p = item.progress;
  const pct = p ? percentOf(p.done, p.total) : null;
  const running = item.state === "running";

  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{item.label}</span>
          {deviceName && <span className="shrink-0 text-xs text-muted-foreground">→ {deviceName}</span>}
        </div>
        {running ? (
          <div className="mt-1.5 flex items-center gap-3">
            <span
              role="progressbar"
              aria-label={item.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct ?? undefined}
              className="relative block h-1.5 flex-1 overflow-hidden rounded-full bg-surface-1"
            >
              {pct === null ? (
                <span className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary animate-indeterminate" />
              ) : (
                <span className="block h-full rounded-full bg-primary transition-[width] duration-150" style={{ width: `${pct}%` }} />
              )}
            </span>
            <span className="tabular w-10 text-right text-xs text-muted-foreground">{pct === null ? "…" : `${pct}%`}</span>
            {p && p.speedBps > 0 && (
              <span className="tabular hidden w-24 text-right text-xs text-muted-foreground sm:block">
                {formatSpeed(p.speedBps)}
              </span>
            )}
            {p && p.total > 0 && (
              <span className="tabular hidden w-28 text-right text-xs text-muted-foreground md:block">
                {formatBytes(p.done)} / {formatBytes(p.total)}
              </span>
            )}
          </div>
        ) : (
          <p
            className={cn(
              "mt-0.5 flex items-center gap-1.5 text-xs",
              item.state === "done" && "text-success",
              item.state === "failed" && "text-destructive",
              item.state === "cancelled" && "text-muted-foreground",
            )}
          >
            {item.state === "done" && <CircleCheck className="size-3.5" aria-hidden />}
            {item.state === "failed" && <CircleAlert className="size-3.5" aria-hidden />}
            {item.state === "done"
              ? t("network.transfer.done")
              : item.state === "cancelled"
                ? t("network.transfer.cancelled")
                : item.error
                  ? errorText(t, item.error)
                  : t("network.transfer.failed")}
          </p>
        )}
      </div>
      {running ? (
        <Button variant="outline" size="sm" onClick={item.cancel}>
          {t("common.cancel")}
        </Button>
      ) : (
        <div className="flex items-center gap-1">
          {onRetry && item.state !== "done" && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RotateCcw />
              {t("network.transfer.retry")}
            </Button>
          )}
          <Button variant="ghost" size="icon" className="size-9" aria-label={t("network.transfer.dismiss")} onClick={onDismiss}>
            <X />
          </Button>
        </div>
      )}
    </li>
  );
}
