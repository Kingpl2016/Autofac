import { useState } from "react";
import { ArrowDownUp, CircleAlert, CircleCheck, Cpu, Download, RotateCcw, Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { errorText } from "../lib/errors";
import { formatBytes } from "@/shared/lib/format";
import { formatSpeed, percentOf } from "../lib/format";
import { useTransferStore, type TransferItem, type TransferKind } from "../stores/useTransferStore";

interface TransferIndicatorProps {
  /** 设备 id → 显示名，用于标出任务属于哪台设备 */
  deviceNames: Record<string, string>;
}

const KIND_ICON: Record<TransferKind, typeof Upload> = {
  upload: Upload,
  download: Download,
  ota: Cpu,
};

/** 弹层的打开方式：自动打开时不抢焦点，用户点开时焦点进入弹层。 */
type OpenState = false | "auto" | "user";

/**
 * 页头的传输指示器：显示进行中的任务数与总进度，点开是完整的传输队列
 * （进度、速度、取消；失败保留原因并可重试；可清除已结束）。
 *
 * 新任务加入时自动展开一次（不抢焦点）。读取全局传输 store，切换 Tab / 设备甚至离开本页，任务都不会丢。
 */
export function TransferIndicator({ deviceNames }: TransferIndicatorProps) {
  const { t } = useTranslation();
  const items = useTransferStore((s) => s.items);
  const dismiss = useTransferStore((s) => s.dismiss);
  const clearFinished = useTransferStore((s) => s.clearFinished);
  const [open, setOpen] = useState<OpenState>(false);
  const [seen, setSeen] = useState(items.length);

  // 新任务加入时自动展开：在渲染期按数量变化派生，不用 effect 同步状态
  if (items.length !== seen) {
    if (items.length > seen && open === false) setOpen("auto");
    setSeen(items.length);
  }

  if (items.length === 0) return null;

  const running = items.filter((i) => i.state === "running");
  const failed = items.filter((i) => i.state === "failed").length;
  const finished = items.length - running.length;
  const totals = running.reduce(
    (acc, i) => (i.progress && i.progress.total > 0 ? { done: acc.done + i.progress.done, total: acc.total + i.progress.total } : acc),
    { done: 0, total: 0 },
  );
  const pct = percentOf(totals.done, totals.total);
  const summary =
    running.length > 0
      ? t("network.transfer.running", { count: running.length })
      : t("network.transfer.allDone", { count: items.length });

  return (
    <Popover open={open !== false} onOpenChange={(o) => setOpen(o ? "user" : false)}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-2 px-3" aria-label={`${t("network.transfer.title")}: ${summary}`}>
          {running.length > 0 ? (
            <ArrowDownUp className="text-primary" />
          ) : failed > 0 ? (
            <CircleAlert className="text-destructive" />
          ) : (
            <CircleCheck className="text-success" />
          )}
          <span className="max-sm:sr-only">{summary}</span>
          {running.length > 0 && (
            <span className="relative hidden h-1 w-14 overflow-hidden rounded-full bg-surface-1 sm:block" aria-hidden>
              {pct === null ? (
                <span className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary animate-indeterminate" />
              ) : (
                <span className="block h-full origin-left rounded-full bg-primary transition-transform duration-150" style={{ transform: `scaleX(${pct / 100})` }} />
              )}
            </span>
          )}
          {running.length > 0 && pct !== null && <span className="tabular text-xs text-muted-foreground">{pct}%</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(30rem,calc(100vw-2rem))] p-0"
        aria-label={t("network.transfer.title")}
        onOpenAutoFocus={(e) => open === "auto" && e.preventDefault()}
      >
        <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold tracking-tight">{t("network.transfer.title")}</h2>
          <span className="text-xs text-muted-foreground" role="status">
            {summary}
          </span>
          {finished > 0 && (
            <Button variant="ghost" size="sm" className="ml-auto h-8 px-3" onClick={clearFinished}>
              {t("network.transfer.clear")}
            </Button>
          )}
        </header>
        <ul className="max-h-80 divide-y divide-border overflow-y-auto">
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
      </PopoverContent>
    </Popover>
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
              <span className="tabular w-20 text-right text-xs text-muted-foreground">{formatSpeed(p.speedBps)}</span>
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
        {running && p && p.total > 0 && (
          <p className="tabular mt-0.5 text-xs text-muted-foreground">
            {formatBytes(p.done)} / {formatBytes(p.total)}
          </p>
        )}
      </div>
      {running ? (
        <Button variant="outline" size="sm" className="h-8 px-3" onClick={item.cancel}>
          {t("common.cancel")}
        </Button>
      ) : (
        <div className="flex items-center gap-1">
          {onRetry && item.state !== "done" && (
            <Button variant="outline" size="sm" className="h-8 px-3" onClick={onRetry}>
              <RotateCcw />
              {t("network.transfer.retry")}
            </Button>
          )}
          <Button variant="ghost" size="icon" className="size-8" aria-label={t("network.transfer.dismiss")} onClick={onDismiss}>
            <X />
          </Button>
        </div>
      )}
    </li>
  );
}
