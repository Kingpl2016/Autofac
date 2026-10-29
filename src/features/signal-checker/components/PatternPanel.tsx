import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlert, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { StatusPill } from "@/shared/components/StatusPill";
import { cn } from "@/lib/utils";
import { setPattern } from "../lib/api";
import { patternsQuery } from "../lib/queries";
import type { PatternGroup, PatternId, PatternInfo } from "../lib/types";
import { useCheckerFormStore } from "../stores/useCheckerFormStore";
import { useGuardStore } from "../stores/useGuardStore";
import { useSenderStore } from "../stores/useSenderStore";
import { GuardDialog } from "./GuardDialog";
import { SpeedControl } from "./SpeedControl";

/** 分组在界面上的顺序。 */
const GROUP_ORDER: PatternGroup[] = ["basic", "wave", "sweep", "stress"];

/** 图案单选组共用的 `name`，让方向键在全部图案之间移动。 */
const RADIO_NAME = "signal-checker-pattern";

/** 频闪的基础频率（Hz，1× 速度下）：与后端 100ms 亮 / 100ms 灭的周期一致。 */
const STROBE_BASE_HZ = 5;

/**
 * 自动模式：测试图案选择 + 速度。
 *
 * 图案用原生单选按钮（视觉上是卡片）：Tab 只停在当前项，方向键在全部图案间移动并立即选中，
 * 读屏软件按"单选组"朗读，不需要额外的 ARIA。选择立即下发后端，发送中切换也不会重置相位。
 * 图案列表（分组、是否静态、是否闪烁）以后端为准，文案按 `id` 本地化。
 *
 * 闪烁图案有光敏风险：选中时在面板里持续提示；发送中想切到它，且本会话还没确认过，会先弹确认
 * （没在发送时在“开始发送”那一步统一确认）。
 */
export function PatternPanel() {
  const { t } = useTranslation();
  const pattern = useCheckerFormStore((s) => s.pattern);
  const storePattern = useCheckerFormStore((s) => s.setPattern);
  const speed = useCheckerFormStore((s) => s.speed);
  const strobeAcknowledged = useGuardStore((s) => s.strobeAcknowledged);
  const acknowledgeStrobe = useGuardStore((s) => s.acknowledgeStrobe);
  const running = useSenderStore((s) => s.status?.running ?? false);
  const [pendingFlashing, setPendingFlashing] = useState<PatternId | null>(null);
  const catalog = useQuery(patternsQuery);

  const infos = catalog.data ?? [];
  const current = infos.find((p) => p.id === pattern);

  const apply = (id: PatternId) => {
    storePattern(id);
    void setPattern(id).catch(() => undefined);
  };

  const choose = (id: PatternId) => {
    const flashing = infos.find((p) => p.id === id)?.isFlashing ?? false;
    if (flashing && running && !strobeAcknowledged) setPendingFlashing(id);
    else apply(id);
  };

  const confirmFlashing = () => {
    if (pendingFlashing === null) return;
    acknowledgeStrobe();
    apply(pendingFlashing);
    setPendingFlashing(null);
  };

  return (
    <SurfacePanel
      title={
        <span className="inline-flex items-center gap-2">
          <Zap className="size-4" aria-hidden />
          {t("signalChecker.patternsTitle")}
        </span>
      }
      actions={
        running ? <StatusPill tone="playing">{t("signalChecker.sending")}</StatusPill> : undefined
      }
    >
      <div className="grid gap-5">
        {GROUP_ORDER.map((group) => {
          const items = infos.filter((p) => p.group === group);
          if (items.length === 0) return null;
          return (
            <fieldset key={group} className="grid gap-2">
              <legend className="mb-1 text-xs font-medium tracking-wide text-muted-foreground">
                {t(`signalChecker.group.${group}`)}
              </legend>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
                {items.map((info) => (
                  <PatternCard key={info.id} info={info} checked={info.id === pattern} onChoose={choose} />
                ))}
              </div>
            </fieldset>
          );
        })}
        {current?.isFlashing && (
          <p
            role="note"
            className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t("signalChecker.strobeWarning", { hz: +(STROBE_BASE_HZ * speed).toFixed(2) })}
          </p>
        )}
        <SpeedControl disabled={current?.isStatic ?? false} />
      </div>
      <GuardDialog
        reasons={pendingFlashing === null ? null : [{ kind: "strobe" }]}
        variant="switch"
        onConfirm={confirmFlashing}
        onCancel={() => setPendingFlashing(null)}
      />
    </SurfacePanel>
  );
}

interface PatternCardProps {
  info: PatternInfo;
  checked: boolean;
  onChoose: (id: PatternId) => void;
}

/** 一张图案卡片：名称 + 一句话说明，选中时描边加底色（不只靠颜色：同时有 `checked` 语义）。 */
function PatternCard({ info, checked, onChoose }: PatternCardProps) {
  const { t } = useTranslation();
  return (
    <label className="block cursor-pointer">
      <input
        type="radio"
        name={RADIO_NAME}
        className="peer sr-only"
        checked={checked}
        onChange={() => onChoose(info.id)}
      />
      <span
        className={cn(
          "grid h-full gap-1 rounded-lg border border-border bg-surface-1 p-3 transition-colors",
          "hover:border-muted-foreground/50 peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
          "peer-checked:border-primary peer-checked:bg-primary/10",
        )}
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          {t(`signalChecker.patterns.${info.id}.name`)}
          {info.isFlashing && (
            <Badge variant="warning">
              <TriangleAlert className="size-3" aria-hidden />
              {t("signalChecker.patternFlashing")}
            </Badge>
          )}
        </span>
        <span className="text-xs text-muted-foreground">
          {t(`signalChecker.patterns.${info.id}.desc`)}
        </span>
      </span>
    </label>
  );
}
