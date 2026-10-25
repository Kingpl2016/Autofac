import { useEffect } from "react";
import { toast } from "sonner";

import i18n from "@/shared/i18n";
import { onEvent } from "@/shared/tauri/events";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { recordingStatus, recordingTakeRecovered } from "../lib/api";
import type {
  RecordingResult,
  RecordingStatus,
  RecoveryOutcome,
  SourceStat,
} from "../lib/types";
import { useRecordingStore } from "../stores/useRecordingStore";

/** 把启动时的恢复结果转成一条提示。 */
function notifyRecovered(outcomes: RecoveryOutcome[]) {
  const recovered = outcomes.filter((o) => o.kind === "recovered").length;
  const failed = outcomes.filter((o) => o.kind === "failed").length;
  if (recovered > 0) {
    toast.success(i18n.t("recording.recoveredToast", { n: recovered }));
  }
  if (failed > 0) {
    toast.warning(i18n.t("recording.recoverFailedToast", { n: failed }));
  }
}

/**
 * 订阅录制相关事件（`recording:stats` / `recording:finished` / `engine:sources`），
 * 同步到录制 store 与顶部状态条，并在启动时提示异常退出后恢复出的录制。
 * 在应用根挂载一次。
 */
export function useRecordingListeners() {
  const setStatus = useRecordingStore((s) => s.setStatus);
  const setSources = useRecordingStore((s) => s.setSources);
  const setLast = useRecordingStore((s) => s.setLast);
  const patchStatus = useEngineStatusStore((s) => s.patch);

  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [
      onEvent<RecordingStatus>("recording:stats", (p) => {
        setStatus(p);
        patchStatus({ recording: p.recording });
      }),
      onEvent<RecordingResult>("recording:finished", (r) => {
        setLast(r);
        patchStatus({ recording: false });
        if (r.error) {
          toast.error(i18n.t("recording.finishedWithError", { reason: r.error }));
        }
      }),
      onEvent<SourceStat[]>("engine:sources", setSources),
    ];

    // 初始状态与启动恢复提示（页面刷新或应用重启后）
    void recordingStatus()
      .then((s) => {
        setStatus(s);
        patchStatus({ recording: s.recording });
      })
      .catch(() => {});
    void recordingTakeRecovered()
      .then(notifyRecovered)
      .catch(() => {});

    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, [setStatus, setSources, setLast, patchStatus]);
}
