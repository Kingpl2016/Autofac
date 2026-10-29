/**
 * 设置相关类型：由 Rust `settings::AppSettings` 等经 ts-rs 生成（`npm run gen:types`），此处只转出前端用到的。
 * 需要其它分区类型时直接从 `@/bindings/<名>` 转出。
 */

export type { ValueFormat } from "@/bindings/ValueFormat";
export type { AppSettings } from "@/bindings/AppSettings";
/** 本机网络接口（Rust `netif::NetworkInterfaceDto`）。 */
export type { NetworkInterfaceDto as NetworkInterface } from "@/bindings/NetworkInterfaceDto";
