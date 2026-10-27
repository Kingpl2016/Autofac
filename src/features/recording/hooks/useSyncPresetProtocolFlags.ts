import { useEffect } from "react";

import { useProtocolFlags } from "@/features/settings";
import { useRecordingPresetStore } from "../stores/useRecordingPresetStore";

/**
 * 把设置里的 sACN 开关同步到录制预设 store，
 * 让顶栏录制按钮与全局快捷键（不在设置查询上下文里使用协议开关）得到与录制页一致的过滤条件。
 * 在录制运行时挂载一次。
 */
export function useSyncPresetProtocolFlags(): void {
  const { sacnEnabled } = useProtocolFlags();
  const setSacnEnabled = useRecordingPresetStore((s) => s.setSacnEnabled);
  useEffect(() => {
    // 注意不能直接 `() => setSacnEnabled(...)`：persist 中间件包装后的 set 会返回写盘的 Promise，
    // 被 React 当成清理函数调用会让整个运行时崩溃
    setSacnEnabled(sacnEnabled);
  }, [sacnEnabled, setSacnEnabled]);
}
