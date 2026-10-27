import { useEffect } from "react";
import { toast } from "sonner";

import i18n from "@/shared/i18n";
import { onEvent } from "@/shared/tauri/events";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { recordingActivity, recordingStatus, recordingTakeRecovered } from "../lib/api";
import { formatDiskBytes, type DiskLevel } from "../../../shared/domain/disk";
import type {
  RecordingResult,
  RecordingStatsEvent,
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

/** `recording:disk` 事件载荷：磁盘空间等级发生变化。 */
interface DiskEvent {
  level: DiskLevel;
  freeBytes: number;
}

/**
 * 订阅录制相关事件（`recording:stats` / `recording:finished` / `recording:disk` / `engine:sources`），
 * 同步到录制 store 与顶部状态条，并在启动时提示异常退出后恢复出的录制。
 * 在应用根挂载一次。
 */
export function useRecordingListeners() {
  const setStatus = useRecordingStore((s) => s.setStatus);
  const setSources = useRecordingStore((s) => s.setSources);
  const setLast = useRecordingStore((s) => s.setLast);
  const applyActivity = useRecordingStore((s) => s.applyActivity);
  const setActivityFull = useRecordingStore((s) => s.setActivityFull);
  const patchStatus = useEngineStatusStore((s) => s.patch);

  useEffect(() => {
    let fetchingActivity = false;
    /** 拉取全量活动时间线（增量无法合并时）；同一时刻只发一次请求。 */
    const refetchActivity = () => {
      if (fetchingActivity) return;
      fetchingActivity = true;
      void recordingActivity()
        .then(setActivityFull)
        .catch(() => {})
        .finally(() => {
          fetchingActivity = false;
        });
    };

    const unlisteners: Array<Promise<() => void>> = [
      onEvent<RecordingStatsEvent>("recording:stats", (p) => {
        const { activity, ...status } = p;
        setStatus(status);
        patchStatus({ recording: status.recording });
        if (activity && !applyActivity(activity)) refetchActivity();
      }),
      onEvent<RecordingResult>("recording:finished", (r) => {
        setLast(r);
        patchStatus({ recording: false });
        if (r.stoppedBy === "disk") {
          // 无人值守时录制被迫停止属于关键事件：不自动消失，直到用户确认
          toast.error(i18n.t("recording.stoppedByDisk"), { duration: Infinity, closeButton: true });
        } else if (r.error) {
          toast.error(i18n.t("recording.finishedWithError", { reason: r.error }));
        }
      }),
      onEvent<DiskEvent>("recording:disk", (e) => {
        // 临界等级由 `recording:finished` 的 stoppedBy 负责提示，这里只处理告警与恢复
        if (e.level === "low") {
          toast.warning(i18n.t("recording.diskLowToast", { free: formatDiskBytes(e.freeBytes) }));
        }
      }),
      onEvent<SourceStat[]>("engine:sources", setSources),
    ];

    // 初始状态与启动恢复提示（页面刷新或应用重启后）
    void recordingStatus()
      .then((s) => {
        setStatus(s);
        patchStatus({ recording: s.recording });
        // 录制进行中才打开（或刷新）界面：一次取回已录部分的时间线
        if (s.recording) refetchActivity();
      })
      .catch(() => {});
    void recordingTakeRecovered()
      .then(notifyRecovered)
      .catch(() => {});

    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, [setStatus, setSources, setLast, applyActivity, setActivityFull, patchStatus]);
}
