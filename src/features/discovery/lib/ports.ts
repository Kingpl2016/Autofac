import type { NodePort } from "@/shared/domain/device";

/**
 * 把 15 位 Port-Address 格式化为 `Net:Sub:Uni`。
 *
 * @param universe 15 位 Port-Address。
 * @returns 形如 `0:1:3` 的字符串。
 */
export function formatUniverse(universe: number): string {
  const net = (universe >> 8) & 0x7f;
  const sub = (universe >> 4) & 0x0f;
  const uni = universe & 0x0f;
  return `${net}:${sub}:${uni}`;
}

/**
 * 统计输入 / 输出口数量。
 *
 * @param ports 设备上报的端口。
 * @returns 输入口与输出口各自的数量。
 */
export function summarizePorts(ports: readonly NodePort[] | undefined): {
  input: number;
  output: number;
} {
  let input = 0;
  let output = 0;
  for (const p of ports ?? []) {
    if (p.direction === "input") input += 1;
    else output += 1;
  }
  return { input, output };
}
