import type { NetError } from "./errors";

/**
 * 当前设备的可用性：
 *
 * - `none`：没有选中设备。
 * - `checking`：首次探测中。
 * - `offline`：不可达。
 * - `needToken`：设备要求 Token 而本地没有或不正确（连读取都被拒绝）。
 * - `rebooting`：已下发重启 / 升级，等待设备回来。
 * - `ok`：可读可写（设备未配置 Token 时同样视为可写）。
 */
export type AccessState = "none" | "checking" | "offline" | "needToken" | "rebooting" | "ok";

/** 设备行 / 摘要里用的连接状态。 */
export type LinkState = "online" | "needToken" | "offline" | "checking" | "rebooting";

/**
 * 把可用性映射为连接状态徽标。
 *
 * # Arguments
 *
 * * `state` - 可用性。
 *
 * # Returns
 *
 * 徽标状态。
 */
export function toLinkState(state: AccessState): LinkState {
  switch (state) {
    case "ok":
      return "online";
    case "needToken":
    case "offline":
    case "rebooting":
      return state;
    default:
      return "checking";
  }
}

/** 推导单台设备连接状态的输入。 */
export interface LinkInput {
  /** 是否在重启跟踪中 */
  rebooting: boolean;
  /** 最近一次状态请求是否成功 */
  online: boolean;
  /** 最近一次失败的错误码 */
  errorCode: string | null;
  /** 是否仍在首次探测 */
  loading: boolean;
}

/**
 * 推导设备栏 / 机群汇总里用的连接状态。
 *
 * 优先级：重启中 → 在线 → 需要 Token → 检测中 → 离线。
 *
 * # Arguments
 *
 * * `i` - 推导输入。
 *
 * # Returns
 *
 * 连接状态。
 */
export function deriveLinkState(i: LinkInput): LinkState {
  if (i.rebooting) return "rebooting";
  if (i.online) return "online";
  if (i.errorCode === "unauthorized") return "needToken";
  if (i.loading) return "checking";
  return "offline";
}

/** 机群汇总计数。 */
export interface FleetCounts {
  total: number;
  online: number;
  needToken: number;
  offline: number;
  /** 检测中 + 重启中 */
  pending: number;
}

/**
 * 统计多台设备的连接状态。
 *
 * # Arguments
 *
 * * `states` - 各设备的连接状态。
 *
 * # Returns
 *
 * 各类计数。
 */
export function countFleet(states: readonly LinkState[]): FleetCounts {
  const counts: FleetCounts = { total: states.length, online: 0, needToken: 0, offline: 0, pending: 0 };
  for (const s of states) {
    if (s === "online") counts.online += 1;
    else if (s === "needToken") counts.needToken += 1;
    else if (s === "offline") counts.offline += 1;
    else counts.pending += 1;
  }
  return counts;
}

/** 严重度从高到低：合并显示时取最需要关注的那个。 */
const SEVERITY: readonly LinkState[] = ["needToken", "offline", "rebooting", "checking", "online"];

/**
 * 多台设备合并成一个状态时，取最需要关注的那个（需要 Token > 离线 > 重启中 > 检测中 > 在线）。
 *
 * # Arguments
 *
 * * `states` - 各设备的连接状态。
 *
 * # Returns
 *
 * 最严重的状态；没有设备时为 `null`。
 */
export function worstLink(states: readonly LinkState[]): LinkState | null {
  for (const s of SEVERITY) if (states.includes(s)) return s;
  return null;
}

/** 可用性判定结果。 */
export interface Access {
  state: AccessState;
  /** 读取类接口可用 */
  canRead: boolean;
  /** 写操作可用 */
  canWrite: boolean;
}

/** 判定输入。 */
export interface AccessInput {
  hasDevice: boolean;
  /** 状态查询是否仍在首次加载 */
  checking: boolean;
  /** 最近一次状态请求是否成功 */
  online: boolean;
  /** 最近一次状态请求的错误 */
  error: NetError | null;
  /** 是否在重启跟踪中 */
  rebooting: boolean;
}

const NO: Access = { state: "none", canRead: false, canWrite: false };

/**
 * 根据状态查询和会话标记推导设备可用性。
 *
 * 设备没配置 Token 时默认可写；若固件仍要求鉴权，写操作会返回 `unauthorized`，由错误提示处理。
 *
 * # Arguments
 *
 * * `i` - 判定输入。
 *
 * # Returns
 *
 * 可用性状态及读写权限。
 */
export function deriveAccess(i: AccessInput): Access {
  if (!i.hasDevice) return NO;
  if (i.rebooting) return { state: "rebooting", canRead: false, canWrite: false };
  if (i.error?.code === "unauthorized") return { state: "needToken", canRead: false, canWrite: false };
  if (!i.online) {
    return i.checking
      ? { state: "checking", canRead: false, canWrite: false }
      : { state: "offline", canRead: false, canWrite: false };
  }
  return { state: "ok", canRead: true, canWrite: true };
}
