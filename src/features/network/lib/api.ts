import { Channel } from "@tauri-apps/api/core";

import { invoke } from "@/shared/tauri/invoke";
import type {
  ConfigPatch,
  ConfigResult,
  DeviceConfig,
  DeviceStatus,
  Diag,
  FirmwareInfo,
  NetDevice,
  NetDeviceInput,
  NetFile,
  OtaReceipt,
  OtaStatus,
  PlayerStatus,
  ProgramAssign,
  Progress,
  SavedDevice,
  UploadReceipt,
} from "./types";

// 网络设备命令由应用壳注册，命名空间为 `netdev_*`。
// 后端错误统一 reject 为 `{ code, message }`，用 `toNetError` / `errorText` 处理。

// ===================== 设备管理 =====================

/** 列出已保存设备。 */
export function netdevList(): Promise<NetDevice[]> {
  return invoke<NetDevice[]>("netdev_list");
}

/** 新增或更新设备，返回保存后的设备（不含 `hasToken`）。 */
export function netdevSave(input: NetDeviceInput): Promise<SavedDevice> {
  return invoke<SavedDevice>("netdev_save", { input });
}

/** 删除设备（同时清除其 Token）。 */
export function netdevRemove(id: string): Promise<void> {
  return invoke<void>("netdev_remove", { id });
}

/** 设置或清除本地保存的 Token（空串清除）。 */
export function netdevSetToken(id: string, token: string): Promise<void> {
  return invoke<void>("netdev_set_token", { id, token });
}

/** 探测一台尚未保存的设备，用于添加设备时验证连通性与 Token。 */
export function netdevProbe(host: string, port: number, token?: string): Promise<DeviceStatus> {
  return invoke<DeviceStatus>("netdev_probe", { host, port, token: token || null });
}

// ===================== 状态与控制 =====================

/** 读取设备状态。 */
export function netdevStatus(id: string): Promise<DeviceStatus> {
  return invoke<DeviceStatus>("netdev_status", { id });
}

/** 设置工作模式（0~5）。 */
export function netdevSetWorkmode(id: string, mode: number): Promise<void> {
  return invoke<void>("netdev_set_workmode", { id, mode });
}

/** 设备操作：0 复位 / 1 恢复出厂 / 2 自检。 */
export function netdevBoardOp(id: string, op: number): Promise<void> {
  return invoke<void>("netdev_board_op", { id, op });
}

/** 节目操作：0 停止 / 1 暂停 / 2 单次 / 3 循环 / 4 删除。 */
export function netdevProgramOp(id: string, no: number, action: number): Promise<void> {
  return invoke<void>("netdev_program_op", { id, no, action });
}

/** 读取播放器状态。 */
export function netdevPlayer(id: string): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("netdev_player", { id });
}

/** 跳转播放位置（毫秒）。 */
export function netdevSeek(id: string, posMs: number): Promise<void> {
  return invoke<void>("netdev_seek", { id, posMs });
}

/** 设置倍速（×100，25~200）。 */
export function netdevSpeed(id: string, speedX100: number): Promise<void> {
  return invoke<void>("netdev_speed", { id, speedX100 });
}

// ===================== 配置 / 诊断 / 日志 =====================

/** 读取设备配置。 */
export function netdevGetConfig(id: string): Promise<DeviceConfig> {
  return invoke<DeviceConfig>("netdev_get_config", { id });
}

/** 写入配置补丁；带 `httpToken` 时设备接受后后端会同步更新本地凭据。 */
export function netdevPutConfig(id: string, patch: ConfigPatch): Promise<ConfigResult> {
  return invoke<ConfigResult>("netdev_put_config", { id, patch });
}

/** 读取运行期诊断。 */
export function netdevDiag(id: string): Promise<Diag> {
  return invoke<Diag>("netdev_diag", { id });
}

/** 读取最近日志文本。 */
export function netdevLogs(id: string): Promise<string> {
  return invoke<string>("netdev_logs", { id });
}

// ===================== 文件 =====================

/** 列出设备 SD 卡文件。 */
export function netdevListFiles(id: string): Promise<NetFile[]> {
  return invoke<NetFile[]>("netdev_list_files", { id });
}

/** 删除设备文件。 */
export function netdevDeleteFile(id: string, name: string): Promise<void> {
  return invoke<void>("netdev_delete_file", { id, name });
}

/** 重命名设备文件。 */
export function netdevRenameFile(id: string, from: string, to: string): Promise<void> {
  return invoke<void>("netdev_rename_file", { id, from, to });
}

/**
 * 应用一组节目号分配（改号 / 互换 / 拖动排序）。
 * 新固件走设备端原子批量重排（`POST /api/programs/reorder`），要么全部生效要么不改动；
 * 旧固件退回逐条分配，中途失败会尽力回滚。节目号与文件名都不得重复。
 */
export function netdevAssignPrograms(id: string, assignments: readonly ProgramAssign[]): Promise<void> {
  return invoke<void>("netdev_assign_programs", { id, assignments });
}

// ===================== 固件 =====================

/** 读取 OTA 状态。 */
export function netdevOtaStatus(id: string): Promise<OtaStatus> {
  return invoke<OtaStatus>("netdev_ota_status", { id });
}

/** 手动确认当前固件有效。 */
export function netdevOtaConfirm(id: string): Promise<void> {
  return invoke<void>("netdev_ota_confirm", { id });
}

/** 固件预检：读取镜像头，返回版本 / 工程名 / 构建时间。 */
export function netdevInspectFirmware(path: string): Promise<FirmwareInfo> {
  return invoke<FirmwareInfo>("netdev_inspect_firmware", { path });
}

// ===================== 流式传输 =====================

/** 一次进行中的传输：可等待结果，也可取消。 */
export interface TransferHandle<T> {
  /** 传输 id（后端据此登记取消令牌）。 */
  id: string;
  /** 传输结果；取消时以 `code: "cancelled"` reject。 */
  promise: Promise<T>;
  /** 请求取消；传输已结束时无效果。 */
  cancel: () => void;
}

/**
 * 生成传输 id。
 *
 * # Returns
 *
 * 唯一字符串；优先使用 `crypto.randomUUID`，不可用时回退到时间戳加随机数。
 */
export function newTransferId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 启动一次带进度通道的传输类命令。 */
function startTransfer<T>(
  cmd: string,
  args: Record<string, unknown>,
  onProgress: (p: Progress) => void,
): TransferHandle<T> {
  const id = newTransferId();
  const channel = new Channel<Progress>();
  channel.onmessage = onProgress;
  const promise = invoke<T>(cmd, { ...args, transferId: id, onProgress: channel });
  const cancel = () => {
    void invoke<boolean>("netdev_cancel", { transferId: id }).catch(() => undefined);
  };
  return { id, promise, cancel };
}

/**
 * 上传本地文件到设备（流式读盘）。
 *
 * # Arguments
 *
 * * `id` - 设备 id。
 * * `name` - 设备上的文件名。
 * * `path` - 本地文件路径。
 * * `onProgress` - 进度回调。
 */
export function netdevUploadFile(
  id: string,
  name: string,
  path: string,
  onProgress: (p: Progress) => void,
): TransferHandle<UploadReceipt> {
  return startTransfer("netdev_upload_file", { id, name, path }, onProgress);
}

/**
 * 下载设备文件到本地路径。
 *
 * # Arguments
 *
 * * `id` - 设备 id。
 * * `name` - 设备上的文件名。
 * * `dest` - 本地保存路径。
 * * `onProgress` - 进度回调。
 */
export function netdevDownloadFile(
  id: string,
  name: string,
  dest: string,
  onProgress: (p: Progress) => void,
): TransferHandle<void> {
  return startTransfer("netdev_download_file", { id, name, dest }, onProgress);
}

/**
 * 把节目库里的 `.artrec` 上传到设备，返回设备上的文件名。
 *
 * # Arguments
 *
 * * `id` - 设备 id。
 * * `path` - 节目库中的文件路径（必须在录制目录内）。
 * * `onProgress` - 进度回调。
 */
export function netdevUploadRecording(
  id: string,
  path: string,
  onProgress: (p: Progress) => void,
): TransferHandle<string> {
  return startTransfer("netdev_upload_recording", { id, path }, onProgress);
}

/**
 * 推送固件触发 OTA。
 *
 * # Arguments
 *
 * * `id` - 设备 id。
 * * `path` - 本地固件 `.bin` 路径。
 * * `onProgress` - 进度回调。
 */
export function netdevOtaUpload(
  id: string,
  path: string,
  onProgress: (p: Progress) => void,
): TransferHandle<OtaReceipt> {
  return startTransfer("netdev_ota_upload", { id, path }, onProgress);
}
