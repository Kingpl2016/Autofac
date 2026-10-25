import type { CheckerContext, SendMode, SignalConfig } from "./types";

/**
 * 开始发送前需要用户确认的原因。
 *
 * - `remote`：目标不是本机，收到信号的灯具会真实响应；
 * - `forwarding`：发给本机的信号会经转发表发到真实设备；
 * - `strobe`：频闪的高频闪烁有光敏风险（每个会话只确认一次）。
 */
export type StartReason =
  | { kind: "remote"; ip: string }
  | { kind: "forwarding"; count: number }
  | { kind: "strobe" };

/** 自测时的诊断提示：不阻止发送，只说明"为什么可能收不到 / 会连带发出去"。 */
export type Hint =
  | { kind: "playerMode" }
  | { kind: "receiverBinding"; ip: string | null }
  | { kind: "forwarding"; count: number };

/**
 * 目标是不是"发给自己"：回环网段（`127.x.x.x`）或本机某块网卡的 IP。
 *
 * # Arguments
 *
 * * `ip` - 目标 IP 文本（首尾空白被忽略）。
 * * `localIps` - 本机全部 IPv4 地址；未知时传空数组，此时只认回环。
 */
export function isLocalIp(ip: string, localIps: readonly string[]): boolean {
  const target = ip.trim();
  return target.startsWith("127.") || localIps.includes(target);
}

/** 判定开始发送前要确认的原因所需的输入。 */
interface StartReasonInput {
  config: SignalConfig;
  mode: SendMode;
  /** 当前图案是否会高频闪烁 */
  flashing: boolean;
  /** 运行环境；取不到时传 `undefined`，此时按"非本机、无转发"保守判断 */
  context: CheckerContext | undefined;
  /** 本会话是否已确认过频闪风险 */
  strobeAcknowledged: boolean;
}

/**
 * 开始发送前，哪些情况要先让用户确认。
 *
 * # Returns
 *
 * 原因列表；为空表示可以直接开始。目标不是本机时只报 `remote`（转发表对它无关）；
 * 发给本机且应用处于实时模式时，若转发表有启用的目的地则报 `forwarding`；
 * 自动模式下选了闪烁图案且本会话未确认过则报 `strobe`。
 */
export function startReasons({
  config,
  mode,
  flashing,
  context,
  strobeAcknowledged,
}: StartReasonInput): StartReason[] {
  const reasons: StartReason[] = [];
  if (!isLocalIp(config.targetIp, context?.localIps ?? [])) {
    reasons.push({ kind: "remote", ip: config.targetIp.trim() });
  } else if (context && context.appMode === "live" && context.forwardingEnabled > 0) {
    reasons.push({ kind: "forwarding", count: context.forwardingEnabled });
  }
  if (mode === "auto" && flashing && !strobeAcknowledged) reasons.push({ kind: "strobe" });
  return reasons;
}

/**
 * 针对"发给本机自测"的诊断提示。
 *
 * 只在目标是本机时给出；提示依赖运行环境，取不到环境时不给。
 *
 * # Returns
 *
 * 提示列表，按重要性排序：播放器模式（根本收不到）、接收绑定（Art-Net 才受影响，sACN 始终绑 `0.0.0.0`）、转发。
 */
export function diagnosticHints(
  config: SignalConfig,
  context: CheckerContext | undefined,
): Hint[] {
  if (!context || !isLocalIp(config.targetIp, context.localIps)) return [];
  const hints: Hint[] = [];

  if (context.appMode === "player") {
    hints.push({ kind: "playerMode" });
    return hints; // 实时接收都停了，其它提示没有意义
  }

  const loopback = config.targetIp.trim().startsWith("127.");
  const boundToNic = context.receiveInterface !== "0.0.0.0" && context.receiveInterface !== "";
  if (config.protocol === "artNet" && loopback && (context.multiNic || boundToNic)) {
    hints.push({ kind: "receiverBinding", ip: context.multiNic ? null : context.receiveInterface });
  }
  if (context.forwardingEnabled > 0) {
    hints.push({ kind: "forwarding", count: context.forwardingEnabled });
  }
  return hints;
}
