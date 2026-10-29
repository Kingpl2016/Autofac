import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { errorMessage } from "@/shared/lib/errors";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import {
  getDevices,
  SCAN_ERR_ARTNET_DISABLED,
  SCAN_ERR_IN_PROGRESS,
  scanNetwork,
} from "../lib/api";
import { findNewIps } from "../lib/newDevices";
import { useScanSession, type LastScan } from "../stores/useScanSession";

/**
 * 网络扫描：发起 ArtPoll 广播，结束后拉取最新设备列表并统计新增数量。
 *
 * - 成功结果显示在页面的扫描状态条里（不再弹 toast）；
 * - 无节点响应时由状态条给出常驻排查提示；
 * - 失败 / 部分网卡发送失败仍用 toast 提示。
 *
 * @returns `scanning` 是否扫描中；`last` 最近一次结果；`showNoReply` 是否显示排查提示；
 * `scan` 发起扫描；`dismissNoReply` 关闭排查提示。
 */
export function useNetworkScan(): {
  scanning: boolean;
  last: LastScan | null;
  showNoReply: boolean;
  scan: () => Promise<void>;
  dismissNoReply: () => void;
} {
  const { t } = useTranslation();
  const scanning = useScanSession((s) => s.scanning);
  const last = useScanSession((s) => s.last);
  const noReplyDismissed = useScanSession((s) => s.noReplyDismissed);
  const dismissNoReply = useScanSession((s) => s.dismissNoReply);

  const scan = useCallback(async () => {
    const session = useScanSession.getState();
    if (session.scanning) return;

    const describeError = (e: unknown): string => {
      const raw = errorMessage(e);
      if (raw === SCAN_ERR_ARTNET_DISABLED) return t("discovery.scanErrArtnetDisabled");
      if (raw === SCAN_ERR_IN_PROGRESS) return t("discovery.scanErrInProgress");
      return t("discovery.scanFailed", { reason: raw });
    };

    const data = useEngineDataStore.getState();
    const before = new Set(data.devices.map((d) => d.ip));
    session.begin();
    try {
      const result = await scanNetwork();
      // 事件推送可能略晚于扫描结果，这里主动拉一次，保证“新增”统计与列表一致
      let after = useEngineDataStore.getState().devices;
      try {
        const list = await getDevices();
        if (Array.isArray(list)) {
          useEngineDataStore.getState().setDevices(list);
          after = list;
        }
      } catch {
        /* 拉取失败时沿用事件推送的列表 */
      }
      useScanSession.getState().finish({
        at: Date.now(),
        responded: result.responded,
        total: result.totalArtnet,
        added: findNewIps(before, after).length,
      });
      if (result.errors.length > 0) {
        toast.warning(t("discovery.scanPartial", { reason: result.errors.join("; ") }));
      }
    } catch (e: unknown) {
      useScanSession.getState().abort();
      toast.error(describeError(e));
    }
  }, [t]);

  return {
    scanning,
    last,
    showNoReply: !scanning && last !== null && last.responded === 0 && !noReplyDismissed,
    scan,
    dismissNoReply,
  };
}
