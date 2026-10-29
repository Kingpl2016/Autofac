/** 转发相关类型：由 Rust `forwarding` 模型经 ts-rs 生成（`npm run gen:types`），此处转出并补前端辅助函数。 */

import type { ForwardDestination } from "@/bindings/ForwardDestination";

export type { ForwardProtocol } from "@/bindings/ForwardProtocol";
export type { OverrideAction } from "@/bindings/OverrideAction";
export type { UniverseOverride } from "@/bindings/UniverseOverride";
export type { ForwardDestination };
export type { ForwardingTable } from "@/bindings/ForwardingTable";

/** 创建一个带默认值的新目的地。 */
export function newDestination(): ForwardDestination {
  return {
    id: crypto.randomUUID(),
    name: "",
    targetIp: "",
    protocol: "artNet",
    port: 6454,
    mode: "all",
    universeOffset: 0,
    defaultDelayMs: 0,
    description: "",
    enabled: true,
    overrides: [],
  };
}

/** 解析范围记法为去重升序 Universe 列表（镜像后端实现）。 */
export function parseRange(text: string): number[] {
  const set = new Set<number>();
  for (const part of text.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const dash = p.split("-");
    if (dash.length === 2) {
      const lo = Number.parseInt(dash[0].trim(), 10);
      const hi = Number.parseInt(dash[1].trim(), 10);
      if (Number.isFinite(lo) && Number.isFinite(hi)) {
        const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
        for (let u = a; u <= b; u++) set.add(u);
      }
    } else {
      const v = Number.parseInt(p, 10);
      if (Number.isFinite(v)) set.add(v);
    }
  }
  return [...set].sort((a, b) => a - b);
}
