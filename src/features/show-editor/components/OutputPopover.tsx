import { useTranslation } from "react-i18next";
import { Cable, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PlayerTargetPicker } from "@/features/recording";
import { MAX_GAMMA, MAX_LATENCY_COMP_MS, MIN_GAMMA, setOutput } from "../lib/ops";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";
import { SliderField } from "./SliderField";

/**
 * 工具条上的输出设置：Art-Net / sACN 目标（转发表或指定 IP）、Gamma、灯光延迟补偿。
 *
 * 改动立即写入工程（可撤销），并随工程同步给后端；输出会话运行中也会实时生效。
 */
export function OutputPopover() {
  const { t } = useTranslation();
  const output = useProjectStore((s) => s.project.output);
  const update = useProjectStore((s) => s.update);
  const warnings = usePlaybackStore((s) => s.state?.warnings.length ?? 0);
  const destinations = usePlaybackStore((s) => s.state?.destinations ?? 0);
  const outputting = usePlaybackStore((s) => s.state?.outputting ?? false);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2"
          aria-label={t("editor.output.title")}
        >
          <Cable aria-hidden />
          <span className="text-xs">{t("editor.output.button")}</span>
          {outputting && (
            <span className="size-1.5 rounded-full bg-primary" role="img" aria-label={t("editor.playback.outputting")} />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="grid w-96 gap-4" aria-label={t("editor.output.title")}>
        <h3 className="text-sm font-medium">{t("editor.output.title")}</h3>
        <PlayerTargetPicker
          key={JSON.stringify(output.target)}
          target={output.target}
          destinations={destinations}
          onApply={(target) => update((d) => setOutput(d, { target }))}
        />
        <SliderField
          label={t("editor.output.gamma")}
          numberLabel={t("editor.output.gammaValue")}
          value={output.gamma}
          min={MIN_GAMMA}
          max={MAX_GAMMA}
          step={0.1}
          decimals={1}
          onCommit={(gamma) => update((d) => setOutput(d, { gamma }))}
        />
        <p className="-mt-2 text-xs text-muted-foreground">{t("editor.output.gammaHint")}</p>
        <div className="grid gap-1.5">
          <Label className="text-xs">{t("editor.output.latency")}</Label>
          <div className="flex items-center gap-2">
            <CommitInput
              className="num h-8 w-24 px-2 text-sm"
              inputMode="numeric"
              label={t("editor.output.latency")}
              value={output.latencyCompMs}
              onCommit={(text) => {
                const n = Number(text);
                if (Number.isFinite(n)) update((d) => setOutput(d, { latencyCompMs: n }));
              }}
            />
            <span className="text-xs text-muted-foreground">
              ms（±{MAX_LATENCY_COMP_MS}）
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{t("editor.output.latencyHint")}</p>
        </div>
        {warnings > 0 && (
          <p className="flex items-start gap-2 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t("editor.output.skipped", { count: warnings })}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
