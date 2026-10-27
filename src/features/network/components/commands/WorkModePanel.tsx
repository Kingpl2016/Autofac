import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Check, Clapperboard, Lightbulb, ListVideo, Radio, Repeat2, Sparkles, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { netdevSetWorkmode } from "../../lib/api";
import { netKeys } from "../../lib/queryKeys";
import { runCommand } from "../../lib/run";
import { WORK_MODES, type NetDevice } from "../../lib/types";
import type { DeviceAccess } from "../../hooks/useDeviceAccess";

/** 各模式的图标（装饰；名称与说明都是文字）。 */
const MODE_ICON: Record<number, LucideIcon> = {
  0: Sparkles,
  1: Radio,
  2: Repeat2,
  3: Lightbulb,
  4: ListVideo,
  5: Clapperboard,
};

interface WorkModePanelProps {
  device: NetDevice;
  access: DeviceAccess;
}

/**
 * 工作模式：6 张单选卡片（图标 + 名称 + 一句说明），当前模式带对勾。
 *
 * 切换有副作用（会启停转发和回放），所以方向键只移动焦点，点击或 Enter / Space 才应用。
 * 显示值始终来自设备状态，应用失败时自然回到设备的真实模式。
 */
export function WorkModePanel({ device, access }: WorkModePanelProps) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [busy, setBusy] = useState<number | null>(null);
  const current = access.status.status?.workMode ?? null;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, WORK_MODES.findIndex((m) => m === current));
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const tabStop = focusIndex ?? selectedIndex;
  const disabled = busy !== null || !access.canWrite;

  const apply = async (mode: number) => {
    if (mode === current) return;
    setBusy(mode);
    await runCommand(
      t,
      () => netdevSetWorkmode(device.id, mode),
      t("network.control.modeApplied", { mode: t(`network.modes.${mode}`) }),
    );
    // 无论成败都以设备实际状态为准
    await client.invalidateQueries({ queryKey: netKeys.status(device.id) });
    setBusy(null);
  };

  /** 只移动焦点（漫游 tabindex），不应用。 */
  const move = (to: number) => {
    const n = WORK_MODES.length;
    const next = (to + n) % n;
    setFocusIndex(next);
    refs.current[next]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(i - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(WORK_MODES.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <SurfacePanel title={t("network.control.modeTitle")}>
      {current === null && <p className="mb-3 text-xs text-muted-foreground">{t("network.control.modeUnknown")}</p>}
      <div
        role="radiogroup"
        aria-label={t("network.control.modeTitle")}
        aria-busy={busy !== null || undefined}
        className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3"
      >
        {WORK_MODES.map((m, i) => {
          const checked = m === current;
          const Icon = MODE_ICON[m] ?? Sparkles;
          const descId = `net-mode-desc-${device.id}-${m}`;
          return (
            <button
              key={m}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={t(`network.modes.${m}`)}
              aria-describedby={descId}
              tabIndex={i === tabStop ? 0 : -1}
              disabled={disabled}
              onClick={() => {
                setFocusIndex(i);
                void apply(m);
              }}
              onFocus={() => setFocusIndex(i)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                "relative flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-left transition-colors duration-150 motion-reduce:transition-none",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-60",
                checked ? "border-primary/60 bg-primary/10" : "border-border bg-surface-1/40 hover:border-ring/50 hover:bg-surface-3/60",
              )}
            >
              <Icon className={cn("mt-0.5 size-4 shrink-0", checked ? "text-primary" : "text-muted-foreground")} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {t(`network.modes.${m}`)}
                  {busy === m && <span className="text-xs font-normal text-muted-foreground">{t("network.control.modeApplying")}</span>}
                </span>
                <span id={descId} className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  {t(`network.modeShort.${m}`)}
                </span>
              </span>
              {checked && (
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="size-3.5" strokeWidth={3} aria-hidden />
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-muted-foreground" aria-live="polite">
        {current === null ? "" : t(`network.modeDesc.${current}`)}
      </p>
    </SurfacePanel>
  );
}
