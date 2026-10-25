import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { toast } from "sonner";

import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { usePrefsStore } from "@/shared/stores/prefsStore";
import {
  registerShortcut,
  unregisterShortcut,
} from "@/shared/tauri/globalShortcut";
import { startQuickRecording, stopRecordingWithToast } from "../lib/recordControl";
import { usePlayerStore } from "../stores/usePlayerStore";
import { useRecordingStore } from "../stores/useRecordingStore";

interface HotkeyState {
  recording: boolean;
  playbackLoaded: boolean;
  /** 播放器模式下实时接收已停止，没有东西可录 */
  playerMode: boolean;
  t: TFunction;
}

/**
 * 注册“开始 / 停止录制”的全局快捷键（加速键来自 {@link usePrefsStore} 的
 * `recordHotkeys`，可在设置页修改）。
 *
 * - 开始：未录制、未打开节目且不在播放器模式时，以“快速录制”（全量采集）启动；否则给出提示。
 * - 停止：仅在录制中有效。
 *
 * 加速键变更时自动重注册。在应用根挂载一次。
 */
export function useRecordingHotkeys(): void {
  const { t } = useTranslation();
  const recording = useRecordingStore((s) => s.status.recording);
  const playbackLoaded = usePlayerStore((s) => s.status.loaded);
  const playerMode = useEngineStatusStore((s) => s.appMode === "player");
  const startKey = usePrefsStore((s) => s.recordHotkeys.start);
  const stopKey = usePrefsStore((s) => s.recordHotkeys.stop);

  // 用 ref 持有最新状态，这样处理器闭包稳定，只在加速键变化时才重注册。
  const stateRef = useRef<HotkeyState>({ recording, playbackLoaded, playerMode, t });
  useEffect(() => {
    stateRef.current = { recording, playbackLoaded, playerMode, t };
  });

  useEffect(() => {
    const onStart = () => {
      const s = stateRef.current;
      if (s.recording) return;
      if (s.playerMode) {
        toast.warning(s.t("mode.guardRecord"));
        return;
      }
      if (s.playbackLoaded) {
        toast.warning(s.t("recording.playbackBlocks"));
        return;
      }
      void startQuickRecording(s.t);
    };

    const onStop = () => {
      const s = stateRef.current;
      if (!s.recording) return;
      void stopRecordingWithToast(s.t);
    };

    void registerShortcut(startKey, onStart);
    void registerShortcut(stopKey, onStop);
    return () => {
      void unregisterShortcut(startKey);
      void unregisterShortcut(stopKey);
    };
  }, [startKey, stopKey]);
}
