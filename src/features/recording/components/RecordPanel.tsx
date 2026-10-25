import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useProtocolFlags } from "@/features/settings";
import type { Protocol } from "@/shared/domain/engine";
import { SurfacePanel } from "../../../shared/components/SurfacePanel";
import { RecordConsole } from "./RecordConsole";
import { SourcePicker } from "./SourcePicker";
import { useDiskInfo } from "../hooks/useDiskInfo";
import { usePlayerStore } from "../stores/usePlayerStore";
import { useRecordingStore } from "../stores/useRecordingStore";
import { recordingStart, recordingStop } from "../lib/api";
import {
  buildFileStem,
  expandRanges,
  parseUniverseRanges,
  previewUniverses,
} from "../lib/filter";
import { describeRecordingError } from "../lib/recordControl";
import type { RecordFilter } from "../lib/types";

const FIELD_LABEL = "text-xs font-medium text-muted-foreground";

/**
 * 录制面板：录制舱（节目信息、主控、实时指标、Universe 预览 / 活动）+ 来源设备 + 过滤条件。
 */
export function RecordPanel() {
  const { t } = useTranslation();
  const { sacnEnabled } = useProtocolFlags();
  const universes = useEngineDataStore((s) => s.universes);
  const devices = useEngineDataStore((s) => s.devices);
  const sources = useRecordingStore((s) => s.sources);
  const status = useRecordingStore((s) => s.status);
  const last = useRecordingStore((s) => s.last);
  const setLast = useRecordingStore((s) => s.setLast);

  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [selectedIps, setSelectedIps] = useState<string[]>([]);
  const [exclude, setExclude] = useState(false);
  const [rangeText, setRangeText] = useState("");
  const [extraText, setExtraText] = useState("");
  const [protocols, setProtocols] = useState<Record<Protocol, boolean>>({
    artNet: true,
    sacn: true,
  });
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);

  const recording = status.recording;
  const disk = useDiskInfo(recording);
  const playbackLoaded = usePlayerStore((s) => s.status.loaded);

  const filter = useMemo<RecordFilter>(() => {
    const chosen = (Object.keys(protocols) as Protocol[]).filter((p) => protocols[p]);
    return {
      sources: selectedIps,
      excludeSources: exclude,
      universes: parseUniverseRanges(rangeText),
      // 全选等价于不限制；sACN 关闭时协议过滤界面已隐藏，一律不限制，
      // 避免此前取消勾选 Art-Net 的状态在看不见的地方继续生效
      protocols: !sacnEnabled || chosen.length === 2 ? [] : chosen,
    };
  }, [selectedIps, exclude, rangeText, protocols, sacnEnabled]);

  const extra = useMemo(
    () => expandRanges(parseUniverseRanges(extraText)),
    [extraText],
  );
  const plan = useMemo(
    () => previewUniverses(universes, filter, extra),
    [universes, filter, extra],
  );

  const toggleIp = (ip: string) =>
    setSelectedIps((prev) =>
      prev.includes(ip) ? prev.filter((x) => x !== ip) : [...prev, ip],
    );

  const toggleProtocol = (p: Protocol) =>
    setProtocols((prev) => {
      const next = { ...prev, [p]: !prev[p] };
      // 至少保留一个协议
      return next.artNet || next.sacn ? next : prev;
    });

  const describeError = (e: unknown, fallbackKey: string): string =>
    describeRecordingError(e, t, fallbackKey);

  const handleStart = async () => {
    setBusy("start");
    setLast(null);
    try {
      const res = await recordingStart({
        name: name.trim(),
        notes: notes.trim(),
        fileStem: buildFileStem(new Date(), name),
        filter,
        universes: extra,
      });
      toast.success(t("recording.started", { n: res.plan.accepted.length }));
    } catch (e: unknown) {
      toast.error(describeError(e, "recording.startFailed"));
    } finally {
      setBusy(null);
    }
  };

  const handleStop = async () => {
    setBusy("stop");
    try {
      const res = await recordingStop();
      const frames = res.files.reduce((n, f) => n + f.frames, 0);
      if (frames === 0) toast.warning(t("recording.noData"));
      else toast.success(t("recording.stopped", { n: res.files.length }));
    } catch (e: unknown) {
      toast.error(describeError(e, "recording.stopFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-(--density-gap)">
      <RecordConsole
        status={status}
        last={last}
        busy={busy}
        playbackLoaded={playbackLoaded}
        snapshots={universes}
        plan={plan}
        sourceCount={sources.length}
        disk={disk}
        name={name}
        notes={notes}
        onNameChange={setName}
        onNotesChange={setNotes}
        onStart={() => void handleStart()}
        onStop={() => void handleStop()}
      />

      <div className="grid items-start gap-(--density-gap) lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <SurfacePanel
          title={t("recording.sourcesTitle")}
          actions={
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={exclude} disabled={recording} onCheckedChange={setExclude} />
              {t("recording.excludeMode")}
            </label>
          }
        >
          <p className="mb-3 text-xs text-muted-foreground">
            {selectedIps.length === 0
              ? t("recording.sourcesAll")
              : exclude
                ? t("recording.sourcesExcluding", { n: selectedIps.length })
                : t("recording.sourcesOnly", { n: selectedIps.length })}
          </p>
          <SourcePicker
            sources={sources}
            devices={devices}
            selected={selectedIps}
            onToggle={toggleIp}
            disabled={recording}
          />
        </SurfacePanel>

        <SurfacePanel title={t("recording.filterTitle")}>
          <div className="grid gap-5">
            <div className="grid content-start gap-1.5">
              <Label htmlFor="rec-range" className={FIELD_LABEL}>
                {t("recording.universeFilter")}
              </Label>
              <Input
                id="rec-range"
                className="num"
                value={rangeText}
                disabled={recording}
                placeholder="0-3, 10"
                onChange={(e) => setRangeText(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("recording.universeFilterHint")}</p>
            </div>
            <div className="grid content-start gap-1.5">
              <Label htmlFor="rec-extra" className={FIELD_LABEL}>
                {t("recording.extraUniverses")}
              </Label>
              <Input
                id="rec-extra"
                className="num"
                value={extraText}
                disabled={recording}
                placeholder="5, 8-9"
                onChange={(e) => setExtraText(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("recording.extraUniversesHint")}</p>
            </div>

            {sacnEnabled && (
              <fieldset className="grid gap-2" disabled={recording}>
                <legend className={cn(FIELD_LABEL, "mb-1")}>{t("recording.protocolFilter")}</legend>
                <div className="flex gap-2">
                  {(["artNet", "sacn"] as const).map((p) => (
                    <label
                      key={p}
                      className={cn(
                        "flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-4 text-sm transition-colors",
                        "has-checked:border-primary/60 has-checked:bg-primary/10 has-checked:text-primary",
                        "has-focus-visible:ring-2 has-focus-visible:ring-ring",
                        "has-disabled:cursor-not-allowed has-disabled:opacity-50",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={protocols[p]}
                        onChange={() => toggleProtocol(p)}
                      />
                      {protocols[p] && <Check className="size-4" aria-hidden />}
                      {p === "artNet" ? "Art-Net" : "sACN"}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </div>
        </SurfacePanel>
      </div>
    </div>
  );
}
