import { Skeleton } from "@/components/ui/skeleton";
import { OctagonAlert, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { cn } from "@/lib/utils";
import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import { useDiag } from "../../hooks/useDiag";
import { heapContiguity, sortTasks, sparkPoints, stackLevel, type DiagSample } from "../../lib/diag";
import { errorText } from "../../lib/errors";
import { formatBytes } from "../../lib/format";
import type { NetDevice } from "../../lib/types";

interface DiagPanelProps {
  device: NetDevice;
  access: DeviceAccess;
  /** 诊断分段当前是否可见（不可见时停止轮询） */
  active: boolean;
}

/**
 * 诊断：堆内存、CPU、各任务栈余量与 DMX UART 健康度。
 * 栈余量越小越危险，所以任务表按余量升序排；等级用文字加图标表达，不只靠颜色。
 */
export function DiagPanel({ device, access, active }: DiagPanelProps) {
  const { t } = useTranslation();
  const { diag, samples, error, isLoading } = useDiag(device.id, active && access.canRead);

  if (isLoading || (!diag && !error)) {
    return <Skeleton aria-busy="true" className="h-64 rounded-xl bg-surface-2" />;
  }
  if (!diag) {
    return (
      <SurfacePanel title={t("network.diag.title")}>
        <p className="text-sm text-muted-foreground">{errorText(t, error)}</p>
      </SurfacePanel>
    );
  }

  const heapSeries = samples.map((s) => s.heapFree);
  const cpuSeries = samples.map((s: DiagSample) => s.cpuPermille / 10);
  const cpuNow = cpuSeries.at(-1) ?? 0;
  const contiguity = heapContiguity(diag.heap.free, diag.heap.largestBlock);
  const fragmented = contiguity < 0.4;
  const tasks = sortTasks(diag.tasks);

  return (
    <div className="grid gap-(--density-gutter)">
      {diag.dmxUart && diag.dmxUart.txTimeouts > 0 && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive">
          <OctagonAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p className="text-sm font-semibold">{t("network.diag.txTimeoutsTitle", { count: diag.dmxUart.txTimeouts })}</p>
            <p className="text-xs">{t("network.diag.txTimeoutsBody")}</p>
          </div>
        </div>
      )}

      <div className="grid gap-(--density-gutter) sm:grid-cols-2 xl:grid-cols-4">
        <Tile label={t("network.diag.heapFree")} value={formatBytes(diag.heap.free)}>
          <Spark values={heapSeries} label={t("network.diag.heapTrend")} />
        </Tile>
        <Tile label={t("network.diag.heapMin")} value={formatBytes(diag.heap.minFree)} note={t("network.diag.heapMinNote")} />
        <Tile label={t("network.diag.heapLargest")} value={formatBytes(diag.heap.largestBlock)}>
          <div
            role="progressbar"
            aria-label={t("network.diag.contiguity")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(contiguity * 100)}
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-1"
          >
            <div className={cn("h-full rounded-full", fragmented ? "bg-warning" : "bg-primary")} style={{ width: `${Math.round(contiguity * 100)}%` }} />
          </div>
          <p className={cn("mt-1 text-xs", fragmented ? "text-warning" : "text-muted-foreground")}>
            {fragmented ? <TriangleAlert className="mr-1 inline size-3" aria-hidden /> : null}
            {t(fragmented ? "network.diag.fragmented" : "network.diag.contiguous", { pct: Math.round(contiguity * 100) })}
          </p>
        </Tile>
        <Tile label={t("network.diag.psram")} value={formatBytes(diag.heap.psramFree)} />
      </div>

      <SurfacePanel
        title={t("network.diag.cpu")}
        actions={<span className="tabular text-sm font-medium">{cpuNow.toFixed(1)}%</span>}
      >
        <Spark values={cpuSeries} label={t("network.diag.cpuTrend")} min={0} max={100} tall />
      </SurfacePanel>

      <SurfacePanel title={t("network.diag.tasks")}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <caption className="sr-only">{t("network.diag.tasksCaption")}</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">{t("network.diag.colTask")}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t("network.diag.colCore")}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t("network.diag.colPrio")}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t("network.diag.colStack")}</th>
                <th scope="col" className="py-2 pl-3 font-medium">{t("network.diag.colCpu")}</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const level = stackLevel(task.stackMin);
                const cpu = (task.cpuPermille ?? 0) / 10;
                return (
                  <tr key={task.name} className="border-b border-border last:border-b-0">
                    <th scope="row" className="py-2 pr-3 text-left font-medium">{task.name}</th>
                    <td className="tabular px-3 py-2 text-right text-muted-foreground">{task.core ?? "—"}</td>
                    <td className="tabular px-3 py-2 text-right text-muted-foreground">{task.prio}</td>
                    <td className="px-3 py-2 text-right">
                      <span
                        className={cn(
                          "tabular inline-flex items-center justify-end gap-1.5",
                          level === "danger" && "font-medium text-destructive",
                          level === "low" && "font-medium text-warning",
                        )}
                      >
                        {level !== "ok" && <TriangleAlert className="size-3.5" aria-hidden />}
                        {formatBytes(task.stackMin)}
                        {level !== "ok" && <span className="text-xs">{t(`network.diag.stack.${level}`)}</span>}
                      </span>
                    </td>
                    <td className="py-2 pl-3">
                      <div className="flex items-center gap-2">
                        <div
                          role="progressbar"
                          aria-label={`${task.name} CPU`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(cpu)}
                          className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-1"
                        >
                          <div className="h-full rounded-full bg-chart-2" style={{ width: `${Math.min(100, cpu)}%` }} />
                        </div>
                        <span className="tabular w-12 text-right text-xs text-muted-foreground">{cpu.toFixed(1)}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SurfacePanel>
    </div>
  );
}

function Tile({
  label,
  value,
  note,
  children,
}: {
  label: string;
  value: string;
  note?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface-2 p-(--panel-pad) panel-edge">
      <h3 className="text-xs text-muted-foreground">{label}</h3>
      <p className="tabular mt-1 text-xl font-semibold tracking-tight">{value}</p>
      {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
      {children}
    </section>
  );
}

/** 迷你折线：只用语义色（`text-chart-1` + `currentColor`），带文字化的可访问名称。 */
function Spark({
  values,
  label,
  min,
  max,
  tall,
}: {
  values: readonly number[];
  label: string;
  min?: number;
  max?: number;
  tall?: boolean;
}) {
  const w = 240;
  const h = tall ? 56 : 32;
  const points = sparkPoints(values, w, h, min, max);
  if (!points) return <div className={cn("mt-2", tall ? "h-14" : "h-8")} aria-hidden />;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn("mt-2 w-full text-chart-1", tall ? "h-14" : "h-8")}
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
