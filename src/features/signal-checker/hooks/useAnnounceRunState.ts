import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { announce } from "@/shared/stores/announcerStore";
import { protocolLabel } from "../lib/errors";
import { useSenderStore } from "../stores/useSenderStore";

/**
 * 发送状态变化时向读屏软件播报：开始（带目标）与停止。
 *
 * 状态每 200ms 推送一次，这里只在 `running` 真正翻转时播报；窗口刚打开收到的第一份状态
 * 只是“现状”，不算变化，不播报。
 */
export function useAnnounceRunState(): void {
  const { t } = useTranslation();
  const running = useSenderStore((s) => s.status?.running);
  const config = useSenderStore((s) => s.status?.config);
  const previous = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    const was = previous.current;
    previous.current = running;
    if (was === undefined || running === undefined || was === running) return;
    if (running && config) {
      announce(
        t("signalChecker.announceStarted", {
          protocol: protocolLabel(config.protocol),
          ip: config.targetIp,
          port: config.port,
        }),
      );
    } else if (!running) {
      announce(t("signalChecker.announceStopped"));
    }
  }, [running, config, t]);
}
