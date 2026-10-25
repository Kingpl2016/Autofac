import { invoke } from "@/shared/tauri/invoke";
import type { Device } from "@/shared/domain/device";

/** 网络扫描结果摘要（对应 Rust `runtime::ScanSummary`）。 */
export interface ScanSummary {
  /** 尝试广播的目标地址数量 */
  targets: number;
  /** 成功发出的 ArtPoll 包数量 */
  sent: number;
  /** 本次扫描期间有响应的 Art-Net 节点数 */
  responded: number;
  /** 扫描结束时已知的 Art-Net 节点总数 */
  totalArtnet: number;
  /** 部分目标发送失败的原因 */
  errors: string[];
}

/** 后端扫描错误码：Art-Net 未启用或接收端口绑定失败。 */
export const SCAN_ERR_ARTNET_DISABLED = "artnet_disabled";
/** 后端扫描错误码：已有扫描在进行。 */
export const SCAN_ERR_IN_PROGRESS = "scan_in_progress";

/** 读取当前全部已发现设备。 */
export function getDevices(): Promise<Device[]> {
  return invoke<Device[]>("get_devices");
}

/** 清除所有离线设备记录，返回清理后的设备列表。 */
export function clearOfflineDevices(): Promise<Device[]> {
  return invoke<Device[]>("clear_offline_devices");
}

/**
 * 发起一次主动网络扫描（向各网卡子网广播 ArtPoll 并等待回复）。
 * 约 1.5 秒后返回摘要。
 */
export function scanNetwork(): Promise<ScanSummary> {
  return invoke<ScanSummary>("scan_network");
}

/** 为设备设置自定义名。 */
export function setDeviceName(ip: string, name: string): Promise<void> {
  return invoke<void>("set_device_name", { ip, name });
}
