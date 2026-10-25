import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Circle, Loader2, Square, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { isTauri } from "@/shared/tauri/invoke";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useProtocolFlags } from "@/features/settings";
import type { Protocol } from "@/shared/domain/engine";
import { SourcePicker } from "./SourcePicker";
import { RecordStats } from "./RecordStats";
import { usePlayerStore } from "../hooks/usePlayerStore";
import { useRecordingStore } from "../hooks/useRecordingStore";
import { recordingStart, recordingStop } from "../lib/api";
import {
  buildFileStem,
  expandRanges,
  parseUniverseRanges,
  previewUniverses,
} from "../lib/filter";
import {
  PLAYER_ERR_PLAYBACK_ACTIVE,
  REC_ERR_ALREADY,
  REC_ERR_NOT_RECORDING,
  REC_ERR_NO_UNIVERSES,
  type RecordFilter,
} from "../lib/types";

/** 把任意异常规整为字符串。 */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 列表过长时截断显示。 */
function summarize(list: number[], max = 12): string {
  return list.length <= max
    ? list.join(", ")
    : `${list.slice(0, max).join(", ")} … (+${list.length - max})`;
}

/**
 * 录制面板：选择来源设备 / Universe / 协议过滤，预览将录制的 Universe，开始与停止录制。
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

  const describeError = (e: unknown, fallbackKey: string): string => {
    const raw = messageOf(e);
    if (raw === REC_ERR_NO_UNIVERSES) return t("recording.errNoUniverses");
    if (raw === REC_ERR_ALREADY) return t("recording.errAlready");
    if (raw === PLAYER_ERR_PLAYBACK_ACTIVE) return t("recording.errPlaybackActive");
    if (raw === REC_ERR_NOT_RECORDING) return t("recording.errNotRecording");
    return t(fallbackKey, { reason: raw });
  };

  const handleStart = async () => {
    if (!isTauri()) {
      toast.info(t("recording.desktopOnly"));
      return;
    }
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
    <div className="grid gap-(--density-gutter) xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="grid gap-(--density-gutter)">
        <Card>
          <CardHeader>
            <CardTitle>{t("recording.settingsCard")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid content-start gap-1.5">
                <Label htmlFor="rec-name">{t("recording.name")}</Label>
                <Input
                  id="rec-name"
                  value={name}
                  disabled={recording}
                  placeholder={t("recording.namePlaceholder")}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="grid content-start gap-1.5">
                <Label htmlFor="rec-notes">{t("recording.notes")}</Label>
                <Input
                  id="rec-notes"
                  value={notes}
                  disabled={recording}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>

            <section className="grid gap-2" aria-labelledby="rec-sources">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="rec-sources" className="text-sm font-medium">
                  {t("recording.sourcesTitle")}
                </h3>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={exclude}
                    disabled={recording}
                    onCheckedChange={setExclude}
                  />
                  {t("recording.excludeMode")}
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
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
            </section>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid content-start gap-1.5">
                <Label htmlFor="rec-range">{t("recording.universeFilter")}</Label>
                <Input
                  id="rec-range"
                  className="tabular"
                  value={rangeText}
                  disabled={recording}
                  placeholder="0-3, 10"
                  onChange={(e) => setRangeText(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("recording.universeFilterHint")}
                </p>
              </div>
              <div className="grid content-start gap-1.5">
                <Label htmlFor="rec-extra">{t("recording.extraUniverses")}</Label>
                <Input
                  id="rec-extra"
                  className="tabular"
                  value={extraText}
                  disabled={recording}
                  placeholder="5, 8-9"
                  onChange={(e) => setExtraText(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("recording.extraUniversesHint")}
                </p>
              </div>
            </div>

            {sacnEnabled && (
              <fieldset className="grid gap-2" disabled={recording}>
                <legend className="mb-1 text-sm font-medium">
                  {t("recording.protocolFilter")}
                </legend>
                <div className="flex gap-5 text-sm">
                  {(["artNet", "sacn"] as const).map((p) => (
                    <label key={p} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={protocols[p]}
                        onChange={() => toggleProtocol(p)}
                      />
                      {p === "artNet" ? "Art-Net" : "sACN"}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="grid gap-4 pt-8">
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant={plan.accepted.length > 0 ? "default" : "warning"}>
                {plan.accepted.length > 0
                  ? t("recording.previewCount", { n: plan.accepted.length })
                  : t("recording.previewNone")}
              </Badge>
              {plan.accepted.length > 0 && (
                <span className="tabular text-xs text-muted-foreground">
                  {summarize(plan.accepted)}
                </span>
              )}
            </div>
            {plan.rejectedOutOfRange.length > 0 && (
              <p className="flex items-start gap-2 text-xs text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {t("recording.rejectedOutOfRange", {
                  list: summarize(plan.rejectedOutOfRange, 8),
                })}
              </p>
            )}
            {plan.rejectedOverCapacity.length > 0 && (
              <p className="flex items-start gap-2 text-xs text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {t("recording.rejectedOverCapacity", {
                  list: summarize(plan.rejectedOverCapacity, 8),
                })}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t("recording.fixedSetNote")}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid content-start gap-(--density-gutter)">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {recording ? (
                <>
                  <Circle
                    className="size-3 animate-pulse fill-recording text-recording"
                    aria-hidden
                  />
                  {t("recording.recording")}
                </>
              ) : (
                t("recording.idle")
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {recording ? (
              <Button
                variant="destructive"
                onClick={() => void handleStop()}
                disabled={busy === "stop"}
                aria-busy={busy === "stop"}
              >
                {busy === "stop" ? <Loader2 className="animate-spin" /> : <Square />}
                {busy === "stop" ? t("recording.saving") : t("recording.stop")}
              </Button>
            ) : (
              <Button
                onClick={() => void handleStart()}
                disabled={busy === "start" || playbackLoaded}
                aria-busy={busy === "start"}
                className="bg-recording text-recording-foreground hover:bg-recording/90"
              >
                {busy === "start" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Circle className="fill-current" />
                )}
                {t("recording.start")}
              </Button>
            )}
            {playbackLoaded && (
              <p className="text-xs text-warning">{t("recording.playbackBlocks")}</p>
            )}
            <RecordStats status={status} active={recording} last={last} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
