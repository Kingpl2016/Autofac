import { useEffect } from "react";

import { deriveAccess, type Access } from "../lib/access";
import type { NetDevice } from "../lib/types";
import { useDeviceSessionStore } from "../stores/useDeviceSessionStore";
import { useDeviceConfig } from "./useDeviceConfig";
import { useDeviceStatus, type DeviceStatusResult } from "./useDeviceStatus";

/** [`useDeviceAccess`] 的返回值。 */
export interface DeviceAccess extends Access {
  /** 状态查询结果（含最近错误） */
  status: DeviceStatusResult;
  /** 设备配置（用于判断 Token 是否已配置；未取到为 `null`） */
  tokenSet: boolean | null;
  /** 用户是否选择了"仍然尝试写操作" */
  forceWrite: boolean;
  /** 切换"仍然尝试写操作" */
  setForceWrite: (force: boolean) => void;
  /** 下发重启 / 升级后调用，进入"重启中"并加快探测 */
  markRebooting: (waitMs?: number) => void;
}

/**
 * 当前设备的可用性（读写权限）与状态快照。
 *
 * 同时负责重启跟踪：设备掉线后重新上线、或超过等待上限时自动结束"重启中"。
 *
 * # Arguments
 *
 * * `device` - 当前设备；没有设备传 `null`。
 *
 * # Returns
 *
 * 可用性、状态查询结果与会话操作。
 */
export function useDeviceAccess(device: NetDevice | null): DeviceAccess {
  const id = device?.id ?? null;
  const entry = useDeviceSessionStore((s) => (id ? s.rebooting[id] : undefined));
  const forceWrite = useDeviceSessionStore((s) => (id ? (s.forceWrite[id] ?? false) : false));
  const rebooting = entry !== undefined;

  const status = useDeviceStatus(id, rebooting);
  const { config } = useDeviceConfig(id, status.online);

  // 重启跟踪：掉线 → 再上线即结束；到时间也结束
  useEffect(() => {
    if (!id || !entry) return;
    const store = useDeviceSessionStore.getState();
    if (!status.online && status.error) store.markSawOffline(id);
    else if (status.online && entry.sawOffline) store.clearRebooting(id);
    const left = entry.until - Date.now();
    if (left <= 0) {
      store.clearRebooting(id);
      return;
    }
    const timer = window.setTimeout(() => useDeviceSessionStore.getState().clearRebooting(id), left);
    return () => window.clearTimeout(timer);
  }, [id, entry, status.online, status.error]);

  const access = deriveAccess({
    hasDevice: id !== null,
    checking: status.isLoading,
    online: status.online,
    error: status.error,
    config,
    rebooting,
    forceWrite,
  });

  return {
    ...access,
    status,
    tokenSet: config ? config.tokenSet : null,
    forceWrite,
    setForceWrite: (force) => {
      if (id) useDeviceSessionStore.getState().setForceWrite(id, force);
    },
    markRebooting: (waitMs) => {
      if (id) useDeviceSessionStore.getState().markRebooting(id, waitMs);
    },
  };
}
