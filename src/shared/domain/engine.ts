/**
 * 引擎事件与快照的共享类型：由 Rust `artnet-net` / `signal-engine` / `host-core` 的 DTO
 * 经 ts-rs 生成（`npm run gen:types`），此处按前端习惯起别名。
 */

export type { Protocol } from "@/bindings/Protocol";
/** 某个 Universe 内单个来源的统计。 */
export type { UniverseSource } from "@/bindings/UniverseSource";
export type { UniverseSnapshot } from "@/bindings/UniverseSnapshot";
/** `engine:stats` 事件载荷（Rust `host_core::runtime::StatsPayload`）。 */
export type { StatsPayload as EngineStats } from "@/bindings/StatsPayload";
/** 输出总体状态（Rust `OutputState`）。 */
export type { OutputState } from "@/bindings/OutputState";
/** `engine:output` 事件载荷（约 2Hz）。 */
export type { OutputPayload } from "@/bindings/OutputPayload";
