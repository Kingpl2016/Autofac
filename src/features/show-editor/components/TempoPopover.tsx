import { useTranslation } from "react-i18next";
import { Music2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { alignBeatToPlayhead, tapTempoNow } from "../hooks/editorActions";
import { setTempo } from "../lib/ops";
import type { Tempo } from "../lib/project";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";

/** 没有节拍设置时，编辑字段使用的初始值。 */
const DEFAULT_TEMPO: Tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };

/**
 * 工具条上的节拍设置：BPM、第一拍偏移、每小节拍数，以及敲击节拍 / 对齐到播放头 / 清除。
 *
 * 设置后时间线显示节拍网格，并且 Cue 拖动时会吸附到拍点。
 */
export function TempoPopover() {
  const { t } = useTranslation();
  const tempo = useProjectStore((s) => s.project.tempo);
  const update = useProjectStore((s) => s.update);
  const shown = tempo ?? DEFAULT_TEMPO;

  const edit = (changes: Partial<Tempo>) => update((d) => setTempo(d, { ...(d.tempo ?? DEFAULT_TEMPO), ...changes }));
  const numeric = (apply: (n: number) => Partial<Tempo>) => (text: string) => {
    const n = Number(text);
    if (Number.isFinite(n)) edit(apply(n));
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2"
          aria-label={t("editor.tempo.title")}
        >
          <Music2 aria-hidden />
          <span className="num text-xs">{tempo ? `${tempo.bpm} BPM` : t("editor.tempo.none")}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="grid gap-3" aria-label={t("editor.tempo.title")}>
        <h3 className="text-sm font-medium">{t("editor.tempo.title")}</h3>
        <div className="grid grid-cols-3 gap-2">
          <div className="grid gap-1">
            <Label className="text-xs">{t("editor.tempo.bpm")}</Label>
            <CommitInput
              className="num h-8 px-2 text-sm"
              inputMode="numeric"
              label={t("editor.tempo.bpm")}
              value={shown.bpm}
              onCommit={numeric((bpm) => ({ bpm }))}
            />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">{t("editor.tempo.offset")}</Label>
            <CommitInput
              className="num h-8 px-2 text-sm"
              inputMode="numeric"
              label={t("editor.tempo.offset")}
              value={shown.offsetMs}
              onCommit={numeric((offsetMs) => ({ offsetMs }))}
            />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">{t("editor.tempo.beatsPerBar")}</Label>
            <CommitInput
              className="num h-8 px-2 text-sm"
              inputMode="numeric"
              label={t("editor.tempo.beatsPerBar")}
              value={shown.beatsPerBar}
              onCommit={numeric((beatsPerBar) => ({ beatsPerBar }))}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            aria-keyshortcuts="T"
            onClick={() => tapTempoNow(performance.now())}
          >
            {t("editor.tempo.tap")}
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8" onClick={alignBeatToPlayhead}>
            {t("editor.tempo.align")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8"
            disabled={!tempo}
            onClick={() => update((d) => setTempo(d, null))}
          >
            {t("editor.tempo.clear")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("editor.tempo.hint")}</p>
      </PopoverContent>
    </Popover>
  );
}
