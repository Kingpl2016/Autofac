import { useEffect } from "react";

import { useTauriEvent } from "@/shared/events/useObservable";
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

  useTauriEvent<SenderStatus>("signal-checker:status", setStatus);
  useTauriEvent<SendErrorEvent>("signal-checker:error", pushError);
  useTauriEvent<PreviewEvent>("signal-checker:preview", setPreview);

  useEffect(() => {
    void getStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, [setStatus]);
}
