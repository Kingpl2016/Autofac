import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useProtocolFlags } from "@/features/settings";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { RecordMonitor } from "./RecordMonitor";
import { RecordSetup } from "./RecordSetup";
import { TransportBar } from "./TransportBar";
import { useDiskInfo } from "../hooks/useDiskInfo";
import { previewUniverses } from "../lib/filter";
import { startRecording, stopRecordingWithToast } from "../lib/recordControl";
import {
  describePreset,
  presetExtraUniverses,
  presetToFilter,
  renderNameTemplate,
} from "../lib/recordingPreset";
import { useRecordingPreset } from "../stores/useRecordingPresetStore";
import { useRecordingStore } from "../stores/useRecordingStore";

/**
 * 录制工作区：上方是走带条（状态、时间码、固定指标、预设摘要与主按钮），
 * 下方是录制设置（编辑当前录制预设）与实时监看。
 *
 * 过滤条件与名称模板存在持久化的“当前录制预设”里，与顶栏录制按钮、全局快捷键共用；
 * 这里只持有仅本次有效的备注与按钮的忙碌状态。
 */
export function RecordPanel() {
  const { t } = useTranslation();
  const { sacnEnabled } = useProtocolFlags();
  const universes = useEngineDataStore((s) => s.universes);
  const devices = useEngineDataStore((s) => s.devices);
  const sources = useRecordingStore((s) => s.sources);
  const status = useRecordingStore((s) => s.status);
  const last = useRecordingStore((s) => s.last);
  const preset = useRecordingPreset();

  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);

  const recording = status.recording;
  const disk = useDiskInfo(recording);

  const plan = useMemo(
    () =>
      previewUniverses(universes, presetToFilter(preset, sacnEnabled), presetExtraUniverses(preset)),
    [universes, preset, sacnEnabled],
  );
  const nextName = renderNameTemplate(preset.nameTemplate, preset.nextIndex);
  const presetParts = describePreset(preset, sacnEnabled, t);

  const handleStart = async () => {
    setBusy("start");
    try {
      const ok = await startRecording(t, { notes, sacnEnabled });
      if (ok) setNotes("");
    } finally {
      setBusy(null);
    }
  };

  const handleStop = async () => {
    setBusy("stop");
    try {
      await stopRecordingWithToast(t);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="@container grid gap-(--density-gap)">
      <TransportBar
        status={status}
        last={last}
        busy={busy}
        disk={disk}
        sourceCount={sources.length}
        activeCount={universes.length}
        plannedCount={plan.accepted.length}
        presetParts={presetParts}
        nextName={nextName}
        onStart={() => void handleStart()}
        onStop={() => void handleStop()}
      />

      {/* 主区足够宽（容器 ≥ 64rem）时设置与监看并排，否则上下排列 */}
      <div className="grid items-start gap-(--density-gap) @5xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <RecordSetup
          sources={sources}
          devices={devices}
          sacnEnabled={sacnEnabled}
          recording={recording}
          notes={notes}
          onNotesChange={setNotes}
          nextName={nextName}
        />
        <RecordMonitor status={status} snapshots={universes} plan={plan} />
      </div>
    </div>
  );
}
