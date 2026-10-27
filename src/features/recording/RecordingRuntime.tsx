import { usePlayerListeners } from "./hooks/usePlayerListeners";
import { useRecordingHotkeys } from "./hooks/useRecordingHotkeys";
import { useRecordingListeners } from "./hooks/useRecordingListeners";

/** 录制 / 回放的无界面运行时：事件同步与全局快捷键。 */
export function RecordingRuntime() {
  useRecordingListeners();
  usePlayerListeners();
  useRecordingHotkeys();
  return null;
}
