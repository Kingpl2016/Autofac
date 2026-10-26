import { toNetError, type NetError } from "./errors";
import type { DeviceStatus, OtaReceipt } from "./types";

/** 单台设备的升级阶段。 */
export type UpgradePhase =
  | "queued"
  | "uploading"
  | "writing"
  | "rebooting"
  | "verifying"
  | "done"
  | "failed"
  | "skipped";

/** 单台设备的升级状态。 */
export interface UpgradeTarget {
  id: string;
  name: string;
  phase: UpgradePhase;
  /** 上传百分比（0~100），未知为 `null` */
  percent: number | null;
  error: NetError | null;
  /** 升级前的固件版本，用于结果对比 */
  fromVersion: string | null;
}

/** 版本比较结果（相对设备当前版本）。 */
export type VersionRelation = "newer" | "same" | "older" | "unknown";

/** 重启后等待设备回来的最长时间（毫秒）。 */
export const BOOT_WAIT_MS = 90_000;
/** 探测间隔（毫秒）。 */
export const BOOT_POLL_MS = 2000;
/** 一直没观察到掉线时，至少等这么久才把"在线"当作已重启（兜底，避免误判重启前的短暂在线）。 */
export const MIN_BOOT_WAIT_MS = 20_000;

/**
 * 比较固件版本（点分数字，缺位按 0 补齐；带非数字后缀如 `1.4.2-rc1` 时只比较数字部分）。
 *
 * # Arguments
 *
 * * `next` - 将要安装的版本。
 * * `current` - 设备当前版本。
 *
 * # Returns
 *
 * `next` 相对 `current` 是更新、相同、更旧，或无法解析（`unknown`）。
 */
export function compareVersion(next: string, current: string): VersionRelation {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+(?:\.\d+)*)/.exec(v.trim());
    return m ? m[1].split(".").map(Number) : null;
  };
  const a = parse(next);
  const b = parse(current);
  if (!a || !b) return "unknown";
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0 ? "newer" : "older";
  }
  return "same";
}

/** 升级流程依赖的外部能力（便于测试时替换）。 */
export interface UpgradeDeps {
  /** 上传固件并触发 OTA；回调收到 0~100 的百分比。 */
  upload: (id: string, onPercent: (pct: number) => void) => Promise<OtaReceipt>;
  /** 读取设备状态。 */
  status: (id: string) => Promise<DeviceStatus>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** 通知界面该设备进入"重启中"。 */
  markRebooting: (id: string) => void;
}

/** 升级流程的输入。 */
export interface UpgradeJob {
  targets: ReadonlyArray<Pick<UpgradeTarget, "id" | "name">>;
  /** 固件预检得到的版本，升级后设备应报告这个版本 */
  expectedVersion: string;
  deps: UpgradeDeps;
  /** 更新某台设备的状态 */
  update: (id: string, patch: Partial<UpgradeTarget>) => void;
  /** 是否已请求取消后续设备 */
  shouldStop: () => boolean;
}

/**
 * 等待设备重启并回到线上，返回它报告的固件版本。
 *
 * 观察到掉线后再上线就算重启完成；一直没观察到掉线（探测间隔刚好错过）时，等满 [`MIN_BOOT_WAIT_MS`] 后接受在线。
 *
 * # Errors
 *
 * 超过 [`BOOT_WAIT_MS`] 仍未回来时抛出 `{ code: "boot_timeout" }`。
 */
async function waitForBoot(id: string, deps: UpgradeDeps): Promise<string> {
  const start = deps.now();
  let sawOffline = false;
  while (deps.now() - start < BOOT_WAIT_MS) {
    await deps.sleep(BOOT_POLL_MS);
    try {
      const s = await deps.status(id);
      if (sawOffline || deps.now() - start >= MIN_BOOT_WAIT_MS) return s.version;
    } catch {
      sawOffline = true;
    }
  }
  throw { code: "boot_timeout", message: "设备重启后未能在限定时间内回到线上" } satisfies NetError;
}

/**
 * 顺序升级一批设备：上传 → 写入校验 → 重启 → 等待上线 → 验证版本。
 *
 * 同一时间只升级一台（带宽与设备资源有限）；某台失败后继续下一台；
 * 请求取消后，当前设备跑完，其余标为 `skipped`。
 *
 * # Arguments
 *
 * * `job` - 目标设备、期望版本与依赖。
 */
export async function runUpgrade(job: UpgradeJob): Promise<void> {
  const { deps, update } = job;
  for (const target of job.targets) {
    if (job.shouldStop()) {
      update(target.id, { phase: "skipped" });
      continue;
    }
    try {
      update(target.id, { phase: "uploading", percent: 0, error: null });
      await deps.upload(target.id, (pct) =>
        update(target.id, pct >= 100 ? { phase: "writing", percent: 100 } : { percent: pct }),
      );
      update(target.id, { phase: "rebooting", percent: 100 });
      deps.markRebooting(target.id);
      const version = await waitForBoot(target.id, deps);
      update(target.id, { phase: "verifying" });
      if (version !== job.expectedVersion) {
        throw { code: "version_mismatch", message: `设备报告版本 ${version}，期望 ${job.expectedVersion}` } satisfies NetError;
      }
      update(target.id, { phase: "done" });
    } catch (e) {
      update(target.id, { phase: "failed", error: toNetError(e) });
    }
  }
}
