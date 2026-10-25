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

// 控制器命令由应用壳注册，命名空间为 `controller_*`；前端统一用散落具名函数（与其它 feature 一致）。

/** 读取核心板连接状态。 */
export function controllerGetStatus(): Promise<ControllerConfig> {
  return invoke<ControllerConfig>("controller_get_status");
}

/** 连接核心板。 */
export function controllerConnect(
  host: string,
  tcpPort: number,
  httpPort: number,
): Promise<ControllerStatus> {
  return invoke<ControllerStatus>("controller_connect", { host, tcpPort, httpPort });
}

/** 断开核心板连接。 */
export function controllerDisconnect(): Promise<void> {
  return invoke<void>("controller_disconnect");
}

/** 整板操作（0 复位 / 1 恢复出厂 / 2 自检）。 */
export function controllerBoardOp(op: number): Promise<void> {
  return invoke<void>("controller_board_op", { op });
}

/** 设置工作模式。 */
export function controllerSetWorkMode(mode: number): Promise<void> {
  return invoke<void>("controller_set_work_mode", { mode });
}

/** 读取当前工作模式。 */
export function controllerGetWorkMode(): Promise<number> {
  return invoke<number>("controller_get_work_mode");
}

/** 节目操作。 */
export function controllerProgramOp(programNo: number, action: number): Promise<void> {
  return invoke<void>("controller_program_op", { programNo, action });
}

/** 写通道值。 */
export function controllerWriteChannels(
  start: number,
  unitCount: number,
  unitRun: number,
  values: number[],
): Promise<void> {
  return invoke<void>("controller_write_channels", { start, unitCount, unitRun, values });
}

/** 读通道值。 */
export function controllerReadChannels(
  start: number,
  unitCount: number,
  unitRun: number,
): Promise<number[]> {
  return invoke<number[]>("controller_read_channels", { start, unitCount, unitRun });
}

/** 列出核心板文件。 */
export function controllerListFiles(): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("controller_list_files");
}

/** 下载文件，返回原始字节（走 IPC 二进制通道，避免 JSON 数字数组膨胀）。 */
export function controllerDownloadFile(name: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("controller_download_file", { name });
}

/** 上传文件（直接传 ArrayBuffer，以二进制通道传输）。 */
export function controllerUploadFile(name: string, data: ArrayBuffer): Promise<void> {
  return invoke<void>("controller_upload_file", { name, data });
}

/** 删除文件。 */
export function controllerDeleteFile(name: string): Promise<void> {
  return invoke<void>("controller_delete_file", { name });
}

/** 重命名文件。 */
export function controllerRenameFile(from: string, to: string): Promise<void> {
  return invoke<void>("controller_rename_file", { from, to });
}

/** 把节目库里的 `.artrec` 上传到核心板 SD 卡，返回上传后的文件名。 */
export function controllerUploadRecording(path: string): Promise<string> {
  return invoke<string>("controller_upload_recording", { path });
}
