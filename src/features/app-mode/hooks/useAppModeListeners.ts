import { useCallback, useEffect } from "react";
import { toast } from "sonner";

import { useTauriEvent } from "@/shared/events/useObservable";
import i18n from "@/shared/i18n";
import { announce } from "@/shared/stores/announcerStore";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { appModeGet, appModeSet } from "../lib/api";
import type { ModeStatus } from "../lib/types";

/** 重试接收的 toast 的固定 id：重复触发时覆盖而不是堆叠。 */
const RECEIVERS_TOAST_ID = "receivers-failed";

/**
 * 把后端推送的模式状态同步到共享状态 store，并处理两类需要用户关注的变化：
 *
 * - 接收重建失败（例如端口被独占）：弹出**不自动消失**的警告，带“重试”按钮；
 * - 播放器模式下发送器状态变化（重连中 / 不可用 / 恢复）：向读屏软件礼貌播报。
 *
 * 在应用根挂载一次。
 */
export function useAppModeListeners() {
  const patch = useEngineStatusStore((s) => s.patch);

  const apply = useCallback(
    (s: ModeStatus) => {
      const prev = useEngineStatusStore.getState();
      patch({ appMode: s.mode, receivers: s.receivers, sender: s.sender });

      if (s.receivers === "failed" && prev.receivers !== "failed") {
        toast.warning(i18n.t("mode.receiversFailed"), {
          id: RECEIVERS_TOAST_ID,
          duration: Infinity,
          closeButton: true,
          action: {
            label: i18n.t("mode.retry"),
            onClick: () => {
              void appModeSet("live").catch(() => {});
            },
          },
        });
      } else if (s.receivers !== "failed" && prev.receivers === "failed") {
        toast.dismiss(RECEIVERS_TOAST_ID);
      }

      if (s.mode === "player" && s.sender !== prev.sender) {
        announce(i18n.t(`mode.sender.${s.sender}`));
      }
    },
    [patch],
  );

  useTauriEvent<ModeStatus>("app:mode", apply);
  useEffect(() => {
    void appModeGet()
      .then(apply)
      .catch(() => {});
  }, [apply]);
}
