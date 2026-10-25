import { useEffect } from "react";

import { onEvent } from "@/shared/tauri/events";
import { getStatus } from "../lib/api";
import type { PreviewEvent, SendErrorEvent, SenderStatus } from "../lib/types";
import { useSenderStore } from "../stores/useSenderStore";

/**
 * 订阅信号检测器的后端事件（`signal-checker:status` / `error` / `preview`）并取一次初始状态。
 * 在检测器窗口的主视图挂载一次。
 */
export function useSignalCheckerListeners(): void {
  const setStatus = useSenderStore((s) => s.setStatus);
  const pushError = useSenderStore((s) => s.pushError);
  const setPreview = useSenderStore((s) => s.setPreview);

  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [
      onEvent<SenderStatus>("signal-checker:status", setStatus),
      onEvent<SendErrorEvent>("signal-checker:error", pushError),
      onEvent<PreviewEvent>("signal-checker:preview", setPreview),
    ];
    void getStatus()
      .then(setStatus)
      .catch(() => undefined);

    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, [setStatus, pushError, setPreview]);
}
