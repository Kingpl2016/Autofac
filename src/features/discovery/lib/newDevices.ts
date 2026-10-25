import type { Device } from "@/shared/domain/device";

/**
 * 找出不在“已知集合”里的设备 IP。
 *
 * @param known 已见过的 IP 集合。
 * @param devices 最新设备列表。
 * @returns 新出现的 IP（保持列表顺序、去重）。
 */
export function findNewIps(
  known: ReadonlySet<string>,
  devices: readonly Device[],
): string[] {
  const seen = new Set<string>();
  const added: string[] = [];
  for (const d of devices) {
    if (known.has(d.ip) || seen.has(d.ip)) continue;
    seen.add(d.ip);
    added.push(d.ip);
  }
  return added;
}
