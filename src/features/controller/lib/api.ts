import { invoke } from "@/shared/tauri/invoke";

/** 核心板连接配置。 */
export interface ControllerConfig {
  host: string;
  tcpPort: number;
  httpPort: number;
  connected: boolean;
}

/** 连接探测结果。 */
export interface ControllerStatus {
  config: ControllerConfig;
  workMode: number | null;
}

/** 文件条目。 */
export interface FileEntry {
  name: string;
  size: number;
  isDir: boolean;
}

// 控制器命令由应用壳注册，命名空间为 `controller_*`（含"节目库→设备"桥接 uploadRecording）。
export const controllerApi = {
  getStatus: () => invoke<ControllerConfig>("controller_get_status"),
  connect: (host: string, tcpPort: number, httpPort: number) =>
    invoke<ControllerStatus>("controller_connect", { host, tcpPort, httpPort }),
  disconnect: () => invoke<void>("controller_disconnect"),
  boardOp: (op: number) => invoke<void>("controller_board_op", { op }),
  setWorkMode: (mode: number) => invoke<void>("controller_set_work_mode", { mode }),
  getWorkMode: () => invoke<number>("controller_get_work_mode"),
  programOp: (programNo: number, action: number) =>
    invoke<void>("controller_program_op", { programNo, action }),
  writeChannels: (
    start: number,
    unitCount: number,
    unitRun: number,
    values: number[],
  ) =>
    invoke<void>("controller_write_channels", { start, unitCount, unitRun, values }),
  readChannels: (start: number, unitCount: number, unitRun: number) =>
    invoke<number[]>("controller_read_channels", { start, unitCount, unitRun }),
  listFiles: () => invoke<FileEntry[]>("controller_list_files"),
  // 下载返回原始字节（ArrayBuffer，走 IPC 二进制通道），避免 JSON 数字数组膨胀。
  downloadFile: (name: string) =>
    invoke<ArrayBuffer>("controller_download_file", { name }),
  // 上传直接传 ArrayBuffer，Tauri 以二进制通道传输，避免 number[] 膨胀。
  uploadFile: (name: string, data: ArrayBuffer) =>
    invoke<void>("controller_upload_file", { name, data }),
  deleteFile: (name: string) => invoke<void>("controller_delete_file", { name }),
  renameFile: (from: string, to: string) =>
    invoke<void>("controller_rename_file", { from, to }),
  // 把节目库里的 `.artrec` 上传到控制器 SD 卡，返回上传后的文件名。
  uploadRecording: (path: string) => invoke<string>("controller_upload_recording", { path }),
};
