import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { toast } from "sonner";

import { usePrefsStore } from "@/shared/stores/prefsStore";
import {
  registerShortcut,
  unregisterShortcut,
} from "@/shared/tauri/globalShortcut";
import { recordingStart, recordingStop } from "../lib/api";
import { describeRecordingError, quickRecordArgs } from "../lib/recordControl";
import { usePlayerStore } from "../stores/usePlayerStore";
import { useRecordingStore } from "../stores/useRecordingStore";

interface HotkeyState {
  recording: boolean;
  playbackLoaded: boolean;
  t: TFunction;
}

/**
 * 注册“开始 / 停止录制”的全局快捷键（加速键来自 {@link usePrefsStore} 的
 * `recordHotkeys`，可在设置页修改）。
 *
 * - 开始：未录制且未处于回放时，以“快速录制”（全量采集）启动；回放中给出提示。
 * - 停止：仅在录制中有效。
 *
 * 加速键变更时自动重注册。在应用根挂载一次。
 */
export function useRecordingHotkeys(): void {
  const { t } = useTranslation();
  const recording = useRecordingStore((s) => s.status.recording);
  const playbackLoaded = usePlayerStore((s) => s.status.loaded);
  const startKey = usePrefsStore((s) => s.recordHotkeys.start);
  const stopKey = usePrefsStore((s) => s.recordHotkeys.stop);

  // 用 ref 持有最新状态，这样处理器闭包稳定，只在加速键变化时才重注册。
  const stateRef = useRef<HotkeyState>({ recording, playbackLoaded, t });
  useEffect(() => {
    stateRef.current = { recording, playbackLoaded, t };
  });

  useEffect(() => {
    const onStart = () => {
      const s = stateRef.current;
      if (s.recording) return;
      if (s.playbackLoaded) {
        toast.warning(s.t("recording.playbackBlocks"));
        return;
      }
      void recordingStart(quickRecordArgs())
        .then((res) =>
          toast.success(s.t("recording.started", { n: res.plan.accepted.length })),
        )
        .catch((e: unknown) =>
          toast.error(describeRecordingError(e, s.t, "recording.startFailed")),
        );
    };

    const onStop = () => {
      const s = stateRef.current;
      if (!s.recording) return;
      void recordingStop()
        .then((res) => {
          const frames = res.files.reduce((n, f) => n + f.frames, 0);
          if (frames === 0) toast.warning(s.t("recording.noData"));
          else toast.success(s.t("recording.stopped", { n: res.files.length }));
        })
        .catch((e: unknown) =>
          toast.error(describeRecordingError(e, s.t, "recording.stopFailed")),
        );
    };

    void registerShortcut(startKey, onStart);
    void registerShortcut(stopKey, onStop);
    return () => {
      void unregisterShortcut(startKey);
      void unregisterShortcut(stopKey);
    };
  }, [startKey, stopKey]);
}
