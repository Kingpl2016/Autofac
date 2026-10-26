import { useActiveDeviceStore } from "../stores/useActiveDeviceStore";
import type { NetDevice } from "../lib/types";
import { useNetDevices } from "./useNetDevices";

/**
 * 当前选中的设备。
 *
 * 记住的 id 已不存在（设备被删除）或尚未选择时，回退到列表第一台；没有设备时为 `null`。
 *
 * # Returns
 *
 * 当前设备与切换函数。
 */
export function useActiveDevice(): {
  device: NetDevice | null;
  setActive: (id: string | null) => void;
} {
  const { devices } = useNetDevices();
  const activeId = useActiveDeviceStore((s) => s.activeId);
  const setActive = useActiveDeviceStore((s) => s.setActiveId);
  const device = devices.find((d) => d.id === activeId) ?? devices[0] ?? null;
  return { device, setActive };
}
