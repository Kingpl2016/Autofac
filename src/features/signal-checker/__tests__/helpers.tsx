import type { ReactElement } from "react";

import { createTauriEventBus } from "@/test/mockTauriEvents";
import { renderWithProviders } from "@/test/renderWithProviders";
import type { PatternGroup, PatternId, PatternInfo, SenderStatus } from "../lib/types";

/** 构造一份发送器状态，默认是"空闲、本机回环、Art-Net、Universe 0"。 */
export function makeStatus(over: Partial<SenderStatus> = {}): SenderStatus {
  return {
    running: false,
    mode: "auto",
    pattern: "sine",
    speed: 1,
    packetsSent: 0,
    sendErrors: 0,
    measuredHz: 0,
    universeCount: 1,
    universes: [0],
    config: { targetIp: "127.0.0.1", port: 6454, protocol: "artNet", universes: "0" },
    lastError: null,
    ...over,
  };
}

/** 带查询客户端（关闭重试）的渲染。 */
export function renderWithQuery(ui: ReactElement) {
  return renderWithProviders(ui);
}

/** 模拟 Tauri 事件总线（见 `@/test/mockTauriEvents`）。 */
export const createEventBus = createTauriEventBus;

/** 与后端 `PatternId::ALL` 相同的分组和顺序。 */
const GROUPS: Record<PatternGroup, PatternId[]> = {
  basic: ["full-on", "blackout", "gradient"],
  wave: ["sine", "square", "triangle", "ramp-up", "ramp-down", "pulse"],
  sweep: ["chase", "rainbow", "odd-even", "binary"],
  stress: ["random", "strobe"],
};

/** 构造后端 `signal_checker_list_patterns` 的返回值。 */
export function makePatterns(): PatternInfo[] {
  return (Object.entries(GROUPS) as Array<[PatternGroup, PatternId[]]>).flatMap(([group, ids]) =>
    ids.map((id) => ({
      id,
      group,
      isStatic: group === "basic",
      isFlashing: id === "strobe",
    })),
  );
}

/** 一帧 512 通道数据：全 0，指定下标处设为给定值。 */
export function makeFrame(values: Record<number, number> = {}): number[] {
  return Array.from({ length: 512 }, (_, i) => values[i] ?? 0);
}