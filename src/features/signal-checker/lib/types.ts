/**
 * 信号检测器的类型：由 Rust `signal-gen` / `signal_checker_commands` 的 DTO 经 ts-rs 生成（`npm run gen:types`），
 * 此处按前端习惯起别名，并补充前端用到的常量。
 */

import type { PatternId } from "@/bindings/PatternId";
import type { SignalProtocol } from "@/bindings/SignalProtocol";

export type { PatternId, SignalProtocol };
/** 发送模式：自动（测试图案）/ 手动（逐通道设值）。 */
export type { SendMode } from "@/bindings/SendMode";
/** 图案分组（界面按分组排布）。 */
export type { PatternGroup } from "@/bindings/PatternGroup";
/** 图案元数据。文案由前端按 `id` 本地化。 */
export type { PatternInfo } from "@/bindings/PatternInfo";
/** 用户填写的发送配置。 */
export type { SignalConfig } from "@/bindings/SignalConfig";
/** 发送器状态快照（每 200ms 推送一次）。 */
export type { SenderStatus } from "@/bindings/SenderStatus";
/** 配置校验错误（按 `code` 区分）。 */
export type { ConfigError } from "@/bindings/ConfigError";
/** 手动数据错误。 */
export type { ManualError } from "@/bindings/ManualError";
/** 发送器错误。 */
export type { SenderError } from "@/bindings/SenderError";
/** 目标 IP 候选项。 */
export type { TargetOption } from "@/bindings/TargetOption";
/** 按来源分组的目标候选项。 */
export type { TargetGroups } from "@/bindings/TargetGroups";
/** 界面做"发送前确认"与"自测提示"所需的运行环境快照。 */
export type { CheckerContext } from "@/bindings/CheckerContext";
/** `signal-checker:error` 事件载荷。 */
export type { ErrorPayload as SendErrorEvent } from "@/bindings/ErrorPayload";
/** `signal-checker:preview` 事件载荷。 */
export type { PreviewPayload as PreviewEvent } from "@/bindings/PreviewPayload";

/** 全部图案标识，按界面分组顺序排列（与后端 `PatternId::ALL` 一致）。 */
export const PATTERN_IDS = [
  "full-on",
  "blackout",
  "gradient",
  "sine",
  "square",
  "triangle",
  "ramp-up",
  "ramp-down",
  "pulse",
  "chase",
  "rainbow",
  "odd-even",
  "binary",
  "random",
  "strobe",
] as const satisfies readonly PatternId[];

/** 协议默认端口。 */
export const DEFAULT_PORT: Record<SignalProtocol, number> = {
  artNet: 6454,
  sacn: 5568,
};

/** 一次最多同时发送的 Universe 数（与后端 `MAX_UNIVERSES` 一致）。 */
export const MAX_UNIVERSES = 100;

/** 一个 Universe 的通道数。 */
export const CHANNELS = 512;
