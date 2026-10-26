import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

/** 图例里的色块 / 线条样本。 */
function Swatch({ className, dashed }: { className?: string; dashed?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block shrink-0", dashed ? "h-px w-5" : "h-3 w-1 rounded-sm", className)}
      style={
        dashed
          ? {
              backgroundImage:
                "repeating-linear-gradient(90deg, var(--muted-foreground) 0 3px, transparent 3px 6px)",
            }
          : undefined
      }
    />
  );
}

/**
 * 图例：节点种类（色条）、边的两种状态（实线 = 有信号，虚线 = 无信号或已停用）、
 * 停用与延迟标记。
 */
export function FlowLegend() {
  const { t } = useTranslation();
  return (
    <ul
      aria-label={t("signalFlow.legend.label")}
      className="flex flex-wrap items-center gap-x-4 gap-y-1 pb-2 text-xs text-muted-foreground"
    >
      <li className="flex items-center gap-1.5">
        <Swatch className="bg-warning" /> {t("signalFlow.legend.player")}
      </li>
      <li className="flex items-center gap-1.5">
        <Swatch className="bg-chart-2" /> {t("signalFlow.legend.source")}
      </li>
      <li className="flex items-center gap-1.5">
        <Swatch className="bg-primary" /> {t("signalFlow.legend.universe")}
      </li>
      <li className="flex items-center gap-1.5">
        <Swatch className="bg-chart-3" /> {t("signalFlow.legend.destination")}
      </li>
      <li className="flex items-center gap-1.5">
        <span className="h-px w-5 bg-primary" aria-hidden /> {t("signalFlow.active")}
      </li>
      <li className="flex items-center gap-1.5">
        <Swatch dashed /> {t("signalFlow.disabled")}
      </li>
      <li className="flex items-center gap-1.5">
        <span className="rounded bg-destructive/15 px-1 text-[10px] font-medium text-destructive">
          {t("signalFlow.node.off")}
        </span>
        {t("signalFlow.legend.off")}
      </li>
      <li className="flex items-center gap-1.5">
        <span className="tabular rounded border border-border px-1 text-[10px]">30ms</span>
        {t("signalFlow.legend.delay")}
      </li>
    </ul>
  );
}