import { usePlayerListeners } from "./hooks/usePlayerListeners";
import { useRecordingHotkeys } from "./hooks/useRecordingHotkeys";
import { useRecordingListeners } from "./hooks/useRecordingListeners";
import { useSyncPresetProtocolFlags } from "./hooks/useSyncPresetProtocolFlags";

/** 录制 / 回放的无界面运行时：事件同步、录制预设的协议开关同步与全局快捷键。 */
export function RecordingRuntime() {
  useRecordingListeners();
  usePlayerListeners();
  useSyncPresetProtocolFlags();
  useRecordingHotkeys();
  return null;
}
