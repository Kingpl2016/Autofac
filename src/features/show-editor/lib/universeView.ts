import { analyzePatch, spansByUniverse, universeUsage, usedUniverses } from "./patch";
import { DMX_CHANNELS, type Rgb, type ShowProject } from "./project";

/**
 * 多 Universe 的直观视图（纯数据）：每个 Universe 一张卡片（名称、颜色、占用、输出端口、冲突、
 * 按地址排开的灯具色块），以及 512 格的通道条（逐通道显示归属）。
 */

/** 卡片上的一段灯具占用。 */
export interface UniverseSegment {
  fixtureId: string;
  name: string;
  modelId: string;
  /** 起止通道（1 起，含两端；超出 512 的部分截掉） */
  start: number;
  end: number;
  mirror: boolean;
  /** 与别的灯具重叠或超出 512 */
  conflict: boolean;
  /** 数据色相（按模型稳定取色，同型号同色） */
  hue: number;
}

/** 一个 Universe 的卡片。 */
export interface UniverseCard {
  universe: number;
  label: string;
  color: Rgb | null;
  used: number;
  /** 灯具数（主地址在这里的） */
  fixtures: number;
  /** 有问题的灯具数 */
  conflicts: number;
  /** 启用的输出端口摘要，例如 `Art-Net 10.0.0.5 → 3` */
  ports: { protocol: "artNet" | "sacn"; target: string; remote: number }[];
  segments: UniverseSegment[];
}

/**
 * 字符串 → 0~359 的稳定色相（同型号同色）。
 *
 * @param key 键（模型 id）。
 * @returns 色相。
 */
export function stableHue(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  // 黄金角分散，避免相近的 id 取到相近的颜色
  return Math.round((h * 137.508) % 360);
}

/**
 * 全部用到的（或在 Universe 表里登记的）Universe 的卡片，按编号升序。
 *
 * @param project 工程（只读）。
 * @returns 卡片。
 */
export function universeCards(
  project: Pick<ShowProject, "fixtures" | "fixtureModels"> & { output: Pick<ShowProject["output"], "universes"> },
): UniverseCard[] {
  const status = analyzePatch(project);
  const spans = spansByUniverse(project);
  const usage = universeUsage(project);
  const byId = new Map(project.fixtures.map((f) => [f.id, f]));
  const configs = new Map(project.output.universes.map((u) => [u.universe, u]));
  const all = [...new Set([...usedUniverses(project.fixtures), ...configs.keys()])].sort((a, b) => a - b);
  return all.map((universe) => {
    const cfg = configs.get(universe);
    const segments: UniverseSegment[] = (spans.get(universe) ?? []).flatMap((s) => {
      const f = byId.get(s.fixtureId);
      if (!f || s.range.start > DMX_CHANNELS) return [];
      const st = status.get(f.id);
      return [
        {
          fixtureId: f.id,
          name: f.name,
          modelId: f.modelId,
          start: s.range.start,
          end: Math.min(s.range.end, DMX_CHANNELS),
          mirror: s.mirror,
          conflict: (st?.conflictsWith.length ?? 0) > 0 || st?.overflow === true,
          hue: stableHue(f.modelId),
        },
      ];
    });
    return {
      universe,
      label: cfg?.label ?? "",
      color: cfg?.color ?? null,
      used: usage.get(universe) ?? 0,
      fixtures: project.fixtures.filter((f) => f.universe === universe).length,
      conflicts: new Set(segments.filter((s) => s.conflict).map((s) => s.fixtureId)).size,
      ports: (cfg?.ports ?? [])
        .filter((p) => p.enabled)
        .map((p) => ({ protocol: p.protocol, target: p.mode === "multicast" ? "multicast" : p.ip, remote: p.remoteUniverse })),
      segments,
    };
  });
}

/** 通道条里的一格。 */
export interface ChannelCell {
  channel: number;
  /** 占用这一格的灯具（冲突时有多个） */
  owners: readonly string[];
  /** 是某台灯的第一个通道（起始地址） */
  head: boolean;
  /** 只被镜像地址占用 */
  mirror: boolean;
  hue: number | null;
}

/**
 * 一个 Universe 的 512 格通道条。
 *
 * @param card 该 Universe 的卡片。
 * @returns 512 格（下标 0 为通道 1）。
 */
export function channelStrip(card: Pick<UniverseCard, "segments">): ChannelCell[] {
  const cells: { owners: string[]; head: boolean; mirror: boolean; hue: number | null }[] = Array.from(
    { length: DMX_CHANNELS },
    () => ({ owners: [], head: false, mirror: true, hue: null }),
  );
  for (const s of card.segments) {
    for (let ch = s.start; ch <= s.end; ch += 1) {
      const c = cells[ch - 1];
      if (!c.owners.includes(s.fixtureId)) c.owners.push(s.fixtureId);
      if (ch === s.start) c.head = true;
      if (!s.mirror) c.mirror = false;
      c.hue ??= s.hue;
    }
  }
  return cells.map((c, i) => ({ channel: i + 1, owners: c.owners, head: c.head, mirror: c.owners.length > 0 && c.mirror, hue: c.hue }));
}
