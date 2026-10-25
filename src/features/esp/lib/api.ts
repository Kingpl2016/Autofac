import { invoke } from "@/shared/tauri/invoke";

/** 核心板连接配置。 */
export interface EspConfig {
  host: string;
  tcpPort: number;
  httpPort: number;
  connected: boolean;
}

/** 连接探测结果。 */
export interface EspStatus {
  config: EspConfig;
  workMode: number | null;
}

/** 文件条目。 */
export interface FileEntry {
  name: string;
  size: number;
  isDir: boolean;
}

export const espApi = {
  getStatus: () => invoke<EspConfig>("esp_get_status"),
  connect: (host: string, tcpPort: number, httpPort: number) =>
    invoke<EspStatus>("esp_connect", { host, tcpPort, httpPort }),
  disconnect: () => invoke<void>("esp_disconnect"),
  boardOp: (op: number) => invoke<void>("esp_board_op", { op }),
  setWorkMode: (mode: number) => invoke<void>("esp_set_work_mode", { mode }),
  getWorkMode: () => invoke<number>("esp_get_work_mode"),
  programOp: (programNo: number, action: number) =>
    invoke<void>("esp_program_op", { programNo, action }),
  writeChannels: (
    start: number,
    unitCount: number,
    unitRun: number,
    values: number[],
  ) => invoke<void>("esp_write_channels", { start, unitCount, unitRun, values }),
  readChannels: (start: number, unitCount: number, unitRun: number) =>
    invoke<number[]>("esp_read_channels", { start, unitCount, unitRun }),
  listFiles: () => invoke<FileEntry[]>("esp_list_files"),
  // 下载返回原始字节（ArrayBuffer，走 IPC 二进制通道），避免 JSON 数字数组膨胀。
  downloadFile: (name: string) => invoke<ArrayBuffer>("esp_download_file", { name }),
  // 上传直接传 ArrayBuffer，Tauri 以二进制通道传输，避免 number[] 膨胀。
  uploadFile: (name: string, data: ArrayBuffer) =>
    invoke<void>("esp_upload_file", { name, data }),
  deleteFile: (name: string) => invoke<void>("esp_delete_file", { name }),
  renameFile: (from: string, to: string) =>
    invoke<void>("esp_rename_file", { from, to }),
};
