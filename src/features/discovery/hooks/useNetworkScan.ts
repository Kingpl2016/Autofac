import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { create } from "zustand";

import { isTauri } from "@/shared/tauri/invoke";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import {
  getDevices,
  SCAN_ERR_ARTNET_DISABLED,
  SCAN_ERR_IN_PROGRESS,
  scanNetwork,
} from "../lib/api";
import { findNewIps } from "../lib/newDevices";

/** 最近一次扫描的结果摘要（仅内存保存，用于状态条）。 */
export interface LastScan {
  /** 完成时间（epoch 毫秒） */
  at: number;
  /** 本次扫描有响应的 Art-Net 节点数 */
  responded: number;
  /** 扫描结束时已知的 Art-Net 节点总数 */
  total: number;
  /** 本次扫描新发现的设备数 */
  added: number;
}

interface ScanSessionState {
  scanning: boolean;
  last: LastScan | null;
  /** 用户是否已关闭“无节点响应”的排查提示 */
  noReplyDismissed: boolean;
  begin: () => void;
  finish: (last: LastScan) => void;
  abort: () => void;
  dismissNoReply: () => void;
}

/**
 * 扫描会话状态。放在 store 而不是组件里，这样扫描过程中切换页面再回来，
 * 按钮的“扫描中”状态与上次结果仍然正确。不落盘。
 */
export const useScanSession = create<ScanSessionState>((set) => ({
  scanning: false,
  last: null,
  noReplyDismissed: false,
  begin: () => set({ scanning: true, noReplyDismissed: false }),
  finish: (last) => set({ scanning: false, last }),
  abort: () => set({ scanning: false }),
  dismissNoReply: () => set({ noReplyDismissed: true }),
}));

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
    if (!isTauri()) {
      toast.info(t("discovery.scanDesktopOnly"));
      return;
    }

    const describeError = (e: unknown): string => {
      const raw = e instanceof Error ? e.message : String(e);
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
