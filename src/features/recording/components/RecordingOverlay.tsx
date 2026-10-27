import { usePrefsStore } from "@/shared/stores/prefsStore";
import { useRecordingStore } from "../stores/useRecordingStore";

/**
 * 录制光晕：录制进行中时窗口四周出现录制色的呼吸光晕，任何页面、余光里都能看出“正在录制”。
 *
 * - 纯装饰：`pointer-events-none` 不挡操作，`aria-hidden` 不打扰读屏（录制状态由顶栏按钮表达）；
 * - 颜色只用 `--recording` 语义令牌；减少动画时保持静态常亮；
 * - 可在设置里关闭（`prefsStore.recordingGlow`）。
 */
export function RecordingOverlay() {
  const recording = useRecordingStore((s) => s.status.recording);
  const enabled = usePrefsStore((s) => s.recordingGlow);
  if (!recording || !enabled) return null;
  return (
    <div
      data-testid="recording-overlay"
      className="rec-glow-frame animate-rec-breathe pointer-events-none fixed inset-0 z-50"
      aria-hidden
    />
  );
}
