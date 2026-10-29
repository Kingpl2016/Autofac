/**
 * 测试用的后端 DTO 工厂：给出字段齐全的默认值，用例只覆盖关心的字段。
 *
 * DTO 类型由 Rust 经 ts-rs 生成（`src/bindings`），字段与后端序列化结果一致、全部必填；
 * 后端加字段后只需在这里补默认值。
 */

import type { Device } from "@/shared/domain/device";

/**
 * 构造一个在线、无扩展信息的 Art-Net 设备。
 *
 * @param over 需要覆盖的字段（通常至少给 `ip`）。
 * @returns 完整的 {@link Device}。
 */
export function makeDevice(over: Partial<Device> = {}): Device {
  return {
    ip: "10.0.0.1",
    hostname: null,
    customName: null,
    mac: null,
    category: "artNet",
    artnetPorts: null,
    online: true,
    lastSeenMs: 0,
    shortName: null,
    nodeReport: null,
    firmware: null,
    manufacturer: null,
    oem: null,
    style: null,
    ports: [],
    ...over,
  };
}
