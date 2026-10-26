import type { Device } from "@/shared/domain/device";

/** 设备数量：在线数与总数。 */
export interface DeviceCounts {
  online: number;
  total: number;
}

/** 转发目的地数量：总数与已启用数。 */
export interface DestinationCounts {
  total: number;
  enabled: number;
}

/**
 * 统计已发现设备的在线数与总数。
 *
 * @param devices 设备列表。
 * @returns 在线数与总数。
 */
export function countDevices(devices: readonly Pick<Device, "online">[]): DeviceCounts {
  return {
    online: devices.filter((d) => d.online).length,
    total: devices.length,
  };
}

/**
 * 统计转发目的地的总数与已启用数。
 *
 * @param destinations 转发目的地列表。
 * @returns 总数与已启用数。
 */
export function countDestinations(
  destinations: readonly { enabled: boolean }[],
): DestinationCounts {
  return {
    total: destinations.length,
    enabled: destinations.filter((d) => d.enabled).length,
  };
}