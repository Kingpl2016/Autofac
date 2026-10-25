import { invoke } from "@/shared/tauri/invoke";

import type { AppSettings, NetworkInterface } from "./types";

/** 读取当前配置。 */
export function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}

/** 保存配置，返回规范化后的最终配置。 */
export function saveSettings(settings: AppSettings): Promise<AppSettings> {
  return invoke<AppSettings>("save_settings", { settings });
}

/** 从 JSON 文本导入配置。 */
export function importSettings(json: string): Promise<AppSettings> {
  return invoke<AppSettings>("import_settings", { json });
}

/** 导出当前配置为 JSON 文本。 */
export function exportSettings(): Promise<string> {
  return invoke<string>("export_settings");
}

/** 枚举本机网络接口。 */
export function listNetworkInterfaces(): Promise<NetworkInterface[]> {
  return invoke<NetworkInterface[]>("list_network_interfaces");
}

/** 默认配置（非 Tauri 预览环境下的回退值）。 */
export const DEFAULT_SETTINGS: AppSettings = {
  network: { mode: "single", interface: "0.0.0.0", multiNic: [] },
  protocol: {
    artnetEnabled: true,
    artnetPort: 6454,
    sacnEnabled: true,
    sacnPort: 5568,
    sacnUniverses: [1],
  },
  display: {
    uiUpdateRate: 30,
    universeFormat: "decimal1",
    channelFormat: "decimal1",
    valueFormat: "decimal",
  },
  merge: { mode: "htp", sourceTimeoutMs: 2500 },
  recording: {
    directory: "",
    compression: "zstd",
    zstdLevel: 3,
    splitMinutes: 0,
  },
  update: { channel: "stable" },
};
