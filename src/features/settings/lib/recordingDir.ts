import type { DiskInfo } from "@/shared/domain/disk";
import { invoke } from "@/shared/tauri/invoke";

/** 对一个候选录制目录的检查结果（对应 `host_core::recording::DirCheck`）。 */
export interface DirCheck {
  /** 被检查的目录（为空入参时是当前生效目录） */
  path: string;
  /** 路径是否已存在 */
  exists: boolean;
  /** 路径是否是目录 */
  isDir: boolean;
  /** 能否在该目录写入（目录未创建时看最近的已存在上级目录） */
  writable: boolean;
  /** 所在卷的剩余空间 */
  disk: DiskInfo;
}

/**
 * 检查候选录制目录（只读探测，不创建目录）。
 *
 * @param path 要检查的目录；省略或为空则检查当前生效的录制目录（含默认目录）。
 */
export function recordingCheckDir(path?: string): Promise<DirCheck> {
  return invoke<DirCheck>("recording_check_dir", { path: path?.trim() || null });
}

/**
 * 在系统文件管理器中打开录制目录（只会打开目录）。
 *
 * @param path 要打开的目录；省略或为空则打开当前生效的录制目录（不存在时先创建）。
 */
export function recordingOpenDir(path?: string): Promise<void> {
  return invoke<void>("recording_open_dir", { path: path?.trim() || null });
}
