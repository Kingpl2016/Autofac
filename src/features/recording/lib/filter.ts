import type { Protocol, UniverseSnapshot } from "@/shared/domain/engine";
import { formatHms, pad2 } from "@/shared/lib/format";
import type { RecordFilter, UniversePlan, UniverseRange } from "./types";

/** ArtRec 可表示的最大 Universe 编号（`net` 0~127 × 16 + 15）。 */
export const MAX_UNIVERSE = 2047;
/** 单个 `.artrec` 文件最多容纳的 Universe 数（单帧全量 Payload ≤ 65527 字节）。 */
export const MAX_UNIVERSES_PER_FILE = 127;

/** 空过滤条件（不限制任何维度）。 */
export const EMPTY_FILTER: RecordFilter = {
  sources: [],
  excludeSources: false,
  universes: [],
  protocols: [],
};

/**
 * 解析形如 `0-3, 10, 20-25` 的 Universe 范围文本。
 *
 * 非法片段被忽略；反向范围自动交换；数值限制在 0~65535。
 *
 * @param text 用户输入。
 * @returns 范围列表。
 */
export function parseUniverseRanges(text: string): UniverseRange[] {
  const out: UniverseRange[] = [];
  for (const raw of text.split(/[,，\s]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d+)(?:\s*[-~–]\s*(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Math.min(Number(m[1]), 65535);
    const b = Math.min(m[2] === undefined ? a : Number(m[2]), 65535);
    out.push({ start: Math.min(a, b), end: Math.max(a, b) });
  }
  return out;
}

/**
 * 把范围列表展开为去重升序的 Universe 编号，最多展开 `limit` 个以防输入过大范围。
 *
 * @param ranges 范围列表。
 * @param limit 最多展开的个数。
 */
export function expandRanges(ranges: UniverseRange[], limit = 4096): number[] {
  const set = new Set<number>();
  for (const r of ranges) {
    for (let u = r.start; u <= r.end && set.size < limit; u += 1) set.add(u);
  }
  return [...set].sort((a, b) => a - b);
}

/** 范围是否包含某 Universe。 */
function inRange(r: UniverseRange, u: number): boolean {
  return u >= Math.min(r.start, r.end) && u <= Math.max(r.start, r.end);
}

/**
 * 与后端 `RecordFilter::matches_parts` 一致的判定。
 *
 * @param filter 过滤条件。
 * @param protocol 协议。
 * @param universe Universe 编号。
 * @param source 来源 IP；null 视为 `0.0.0.0`。
 */
export function matchesParts(
  filter: RecordFilter,
  protocol: Protocol,
  universe: number,
  source: string | null,
): boolean {
  if (filter.protocols.length > 0 && !filter.protocols.includes(protocol)) {
    return false;
  }
  if (
    filter.universes.length > 0 &&
    !filter.universes.some((r) => inRange(r, universe))
  ) {
    return false;
  }
  if (filter.sources.length > 0) {
    const listed = filter.sources.includes(source ?? "0.0.0.0");
    if (listed === filter.excludeSources) return false;
  }
  return true;
}

/**
 * 预览本次录制将包含哪些 Universe（镜像后端 `candidate_universes` + `plan_universes`）。
 *
 * @param snapshot 当前活跃 Universe 快照。
 * @param filter 过滤条件。
 * @param explicit 手动额外指定的 Universe。
 * @returns 规划结果（接受 / 越界拒绝 / 超容量拒绝）。
 */
export function previewUniverses(
  snapshot: UniverseSnapshot[],
  filter: RecordFilter,
  explicit: number[],
): UniversePlan {
  const candidates = new Set<number>(explicit);
  for (const u of snapshot) {
    const protocol: Protocol = u.protocol ?? "artNet";
    const pass =
      u.sourceIps.length === 0
        ? matchesParts(filter, protocol, u.universe, null)
        : u.sourceIps.some((ip) => matchesParts(filter, protocol, u.universe, ip));
    if (pass) candidates.add(u.universe);
  }
  const plan: UniversePlan = {
    accepted: [],
    rejectedOutOfRange: [],
    rejectedOverCapacity: [],
  };
  for (const u of [...candidates].sort((a, b) => a - b)) {
    if (u > MAX_UNIVERSE) plan.rejectedOutOfRange.push(u);
    else if (plan.accepted.length >= MAX_UNIVERSES_PER_FILE) {
      plan.rejectedOverCapacity.push(u);
    } else plan.accepted.push(u);
  }
  return plan;
}

/**
 * 生成按本地时间排序的文件名主干：`yyyyMMdd-HHmmss_名称`。
 *
 * @param date 时间点。
 * @param name 节目名（可空）。
 */
export function buildFileStem(date: Date, name: string): string {
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  const n = name.trim();
  return n ? `${stamp}_${n}` : stamp;
}

/**
 * 把微秒时长格式化为 `h:mm:ss.t` / `m:ss.t`。
 *
 * @param us 微秒。
 */
export function formatDurationUs(us: number): string {
  const totalTenths = Math.floor(Math.max(0, us) / 100_000);
  return `${formatHms(Math.floor(totalTenths / 10))}.${totalTenths % 10}`;
}
