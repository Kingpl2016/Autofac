import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Eraser, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import { cn } from "@/lib/utils";
import { useSettingsQuery } from "@/features/settings";
import { ChannelGrid } from "@/features/universes";
import { checkerKeys } from "../lib/queries";
import { useUniverseFrame } from "../hooks/useUniverseFrame";
import { useViewedUniverse } from "../hooks/useViewedUniverse";
import { clearManual, setAllChannels, setChannel } from "../lib/api";
import { describeError } from "../lib/errors";
import { CHANNELS } from "../lib/types";
import { useCheckerFormStore } from "../stores/useCheckerFormStore";
import { UniverseSelect } from "./UniverseSelect";

/** 快捷值。 */
const QUICK_VALUES = [0, 64, 128, 192, 255] as const;

/**
 * 把输入框文本解析成 `min..=max` 内的整数。
 *
 * # Returns
 *
 * 合法的整数；空、非整数或越界时为 `null`（输入框标为无效，相关按钮置灰）。
 */
function parseInRange(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

/**
 * 手动模式：逐通道设值。
 *
 * - 先选 Universe，再选通道和数值，点“设置”写入；也可以把整个 Universe 设成同一个值或清除；
 * - 下方的栅格是该 Universe 当前的输出（读回），点色块可选中通道；
 * - 输入框用文本状态：清空重输时不会被强行改回 1，输入不合法就地标为无效，对应按钮置灰。
 */
export function ManualPanel() {
  const { t } = useTranslation();
  const ids = { universe: useId(), channel: useId(), value: useId() };
  const client = useQueryClient();
  const protocol = useCheckerFormStore((s) => s.draft.protocol);
  const { universe, universes, setUniverse } = useViewedUniverse();
  const frame = useUniverseFrame(universe);
  const settings = useSettingsQuery();
  const valueFormat = settings.data?.display.valueFormat ?? "decimal";

  const [channelText, setChannelText] = useState("1");
  const [valueText, setValueText] = useState("255");
  const [error, setError] = useState<string | null>(null);

  const channel = parseInRange(channelText, 1, CHANNELS);
  const value = parseInRange(valueText, 0, 255);

  /**
   * 执行一次写入，然后立刻重取栅格数据（不等下一帧预览）。
   *
   * 重取前先取消正在进行的读回：它是在写入之前发出的，结果会是旧数据；
   * 不取消的话，react-query 会直接复用那次进行中的请求，栅格就读不到刚写的值。
   */
  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
      await client.cancelQueries({ queryKey: checkerKeys.frame });
      await client.invalidateQueries({ queryKey: checkerKeys.frame });
    } catch (e: unknown) {
      setError(describeError(e, t, protocol));
    }
  };

  const canWrite = universe !== null && value !== null;
  const canSetChannel = canWrite && channel !== null;

  return (
    <SurfacePanel title={t("signalChecker.manualTitle")}>
      <p className="mb-4 text-xs text-muted-foreground">{t("signalChecker.manualNote")}</p>

      <div className="grid grid-cols-3 gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor={ids.universe}>{t("signalChecker.universe")}</Label>
          <UniverseSelect id={ids.universe} universes={universes} value={universe} onChange={setUniverse} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={ids.channel}>{t("signalChecker.channel")}</Label>
          <Input
            id={ids.channel}
            className="tabular"
            inputMode="numeric"
            autoComplete="off"
            value={channelText}
            aria-invalid={channel === null ? true : undefined}
            onChange={(e) => setChannelText(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={ids.value}>{t("signalChecker.value")}</Label>
          <Input
            id={ids.value}
            className="tabular"
            inputMode="numeric"
            autoComplete="off"
            value={valueText}
            aria-invalid={value === null ? true : undefined}
            onChange={(e) => setValueText(e.target.value)}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <input
          type="range"
          min={0}
          max={255}
          step={1}
          value={value ?? 0}
          aria-label={t("signalChecker.valueSlider")}
          className="h-6 min-w-48 flex-1 accent-primary"
          onChange={(e) => setValueText(e.target.value)}
        />
        <span className="tabular w-20 text-right text-xs text-muted-foreground">
          {value !== null && t("signalChecker.valuePercent", { pct: Math.round((value / 255) * 100) })}
        </span>
      </div>

      <div role="group" aria-label={t("signalChecker.quickValues")} className="mt-3 flex flex-wrap gap-2">
        {QUICK_VALUES.map((v) => (
          <Button
            key={v}
            variant="outline"
            size="sm"
            className={cn("tabular min-w-14", value === v && "border-primary bg-primary/10")}
            aria-pressed={value === v}
            onClick={() => setValueText(String(v))}
          >
            {v}
          </Button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          disabled={!canSetChannel}
          onClick={() => void run(() => setChannel(universe!, channel!, value!))}
        >
          {t("signalChecker.setChannel", { channel: channel ?? "?" })}
        </Button>
        <Button
          variant="secondary"
          disabled={!canWrite}
          onClick={() => void run(() => setAllChannels(universe!, value!))}
        >
          {t("signalChecker.setAll", { value: value ?? "?" })}
        </Button>
        <Button
          variant="outline"
          disabled={universe === null}
          onClick={() => void run(() => clearManual(universe!))}
        >
          <Eraser aria-hidden />
          {t("signalChecker.clearUniverse")}
        </Button>
        <Button variant="ghost" onClick={() => void run(() => clearManual(null))}>
          <Trash2 aria-hidden />
          {t("signalChecker.clearAll")}
        </Button>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <p className="mb-2 mt-5 text-xs text-muted-foreground">{t("signalChecker.gridHint")}</p>
      {universe !== null && (
        <ChannelGrid
          universe={universe}
          valueFormat={valueFormat}
          data={frame}
          selectedChannel={channel ?? undefined}
          onChannelClick={(ch) => setChannelText(String(ch))}
        />
      )}
    </SurfacePanel>
  );
}
