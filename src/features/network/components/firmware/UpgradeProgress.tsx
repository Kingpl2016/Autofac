import { CircleAlert, CircleCheck, Loader2, MinusCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { cn } from "@/lib/utils";
import { errorText } from "../../lib/errors";
import type { UpgradePhase, UpgradeTarget } from "../../lib/upgrade";
import type { UpgradeStage } from "../../stores/useUpgradeStore";

/** 进行中的阶段顺序，用于显示"第几步 / 共几步"。 */
const ACTIVE_STEPS: readonly UpgradePhase[] = ["uploading", "writing", "rebooting", "verifying"];

interface UpgradeProgressProps {
  stage: UpgradeStage;
  targets: readonly UpgradeTarget[];
  stopRequested: boolean;
  onStop: () => void;
  onReset: () => void;
}

/**
 * 升级进度：每台设备一行，显示阶段（第几步 / 共 4 步）、上传进度条与结果；
 * 失败时给出原因和"设备仍在旧固件上运行"的恢复提示。结束后汇总成功 / 失败 / 跳过数。
 */
export function UpgradeProgress({ stage, targets, stopRequested, onStop, onReset }: UpgradeProgressProps) {
  const { t } = useTranslation();
  const count = (p: UpgradePhase) => targets.filter((x) => x.phase === p).length;

  return (
    <SurfacePanel
      title={t("network.fw.progressTitle")}
      tone={stage === "running" ? "player" : "default"}
      actions={
        stage === "running" ? (
          <Button size="sm" variant="outline" onClick={onStop} disabled={stopRequested || targets.length < 2}>
            {stopRequested ? t("network.fw.stopping") : t("network.fw.stopRest")}
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onReset}>
            {t("network.fw.finish")}
          </Button>
        )
      }
    >
      <ul className="divide-y divide-border">
        {targets.map((x) => (
          <li key={x.id} className="grid gap-1.5 py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-sm font-medium">{x.name}</span>
              {x.fromVersion && <span className="tabular text-xs text-muted-foreground">v{x.fromVersion}</span>}
              <PhaseLabel target={x} />
            </div>
            {x.phase === "uploading" && (
              <div
                role="progressbar"
                aria-label={x.name}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={x.percent ?? undefined}
                className="h-1.5 overflow-hidden rounded-full bg-surface-1"
              >
                <div className="h-full rounded-full bg-primary transition-[width] duration-150" style={{ width: `${x.percent ?? 0}%` }} />
              </div>
            )}
            {x.phase === "failed" && x.error && (
              <p role="alert" className="text-xs text-destructive">
                {errorText(t, x.error)}
                <span className="ml-1 text-muted-foreground">{t("network.fw.failHint")}</span>
              </p>
            )}
          </li>
        ))}
      </ul>

      {stage === "finished" && (
        <p role="status" className="mt-4 border-t border-border pt-3 text-sm">
          {t("network.fw.summary", { ok: count("done"), failed: count("failed"), skipped: count("skipped") })}
        </p>
      )}
    </SurfacePanel>
  );
}

function PhaseLabel({ target }: { target: UpgradeTarget }) {
  const { t } = useTranslation();
  const { phase } = target;
  const stepIndex = ACTIVE_STEPS.indexOf(phase);
  const base = "inline-flex items-center gap-1.5 text-xs font-medium";
  const icon = "size-3.5";

  if (phase === "done") {
    return (
      <span className={cn(base, "text-success")}>
        <CircleCheck className={icon} aria-hidden />
        {t("network.fw.phase.done")}
      </span>
    );
  }
  if (phase === "failed") {
    return (
      <span className={cn(base, "text-destructive")}>
        <CircleAlert className={icon} aria-hidden />
        {t("network.fw.phase.failed")}
      </span>
    );
  }
  if (phase === "skipped" || phase === "queued") {
    return (
      <span className={cn(base, "text-muted-foreground")}>
        <MinusCircle className={icon} aria-hidden />
        {t(`network.fw.phase.${phase}`)}
      </span>
    );
  }
  return (
    <span className={cn(base, "text-primary")}>
      <Loader2 className={cn(icon, "animate-spin motion-reduce:animate-none")} aria-hidden />
      {t("network.fw.stepOf", { n: stepIndex + 1, total: ACTIVE_STEPS.length })} · {t(`network.fw.phase.${phase}`)}
      {phase === "uploading" && target.percent !== null ? ` ${target.percent}%` : ""}
    </span>
  );
}
