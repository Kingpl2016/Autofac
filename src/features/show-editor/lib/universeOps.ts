import type { Device } from "@/shared/domain/device";
import { newId } from "./ids";
import { footprintOf, sequentialAddresses, usedUniverses } from "./patch";
import {
  DMX_CHANNELS,
  MAX_UNIVERSE,
  type PatchAddress,
  type ShowProject,
  type SyncSettings,
  type UniverseConfig,
  type UniversePort,
} from "./project";
import { clamp } from "./time";

/**
 * Patch 与 Universe 路由表的纯编辑操作（直接修改 immer 草稿）。
 *
 * 路由表的校验规则与后端 `DispatchTarget::normalized` 一致：只校验启用的端口；
 * Art-Net 远端 Universe 0~32767、sACN 1~63999；组播只用于 sACN；单播 / 广播需要合法 IPv4。
 */

/** Art-Net 默认 UDP 端口。 */
export const ARTNET_PORT = 6454;
/** sACN 默认 UDP 端口。 */
export const SACN_PORT = 5568;
/** sACN 默认优先级。 */
export const DEFAULT_SACN_PRIORITY = 100;
/** Art-Net Port-Address 上限（15 位）。 */
export const MAX_ARTNET_UNIVERSE = 0x7fff;
/** sACN Universe 范围。 */
export const MIN_SACN_UNIVERSE = 1;
export const MAX_SACN_UNIVERSE = 63_999;
/** 每台灯具最多的镜像地址数。 */
export const MAX_MIRRORS = 8;

// ---------------------------------------------------------------- Patch

/**
 * 切换灯具的通道模式；模式不存在时回到默认模式。
 *
 * @param draft 工程草稿。
 * @param fixtureId 灯具 id。
 * @param modeId 模式 id；`undefined` 为默认模式。
 */
export function setFixtureMode(draft: ShowProject, fixtureId: string, modeId: string | undefined): void {
  const fixture = draft.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return;
  const model = draft.fixtureModels.find((m) => m.id === fixture.modelId);
  if (modeId && model?.modes?.some((m) => m.id === modeId)) fixture.modeId = modeId;
  else delete fixture.modeId;
}

/** 把地址夹回合法范围。 */
function clampAddress(a: PatchAddress): PatchAddress {
  return {
    universe: clamp(Math.floor(a.universe) || 0, 0, MAX_UNIVERSE),
    address: clamp(Math.floor(a.address) || 1, 1, DMX_CHANNELS),
  };
}

/**
 * 给灯具加一个镜像地址（多重配接）：默认放在主地址的下一个 Universe 同一地址。
 *
 * @param draft 工程草稿。
 * @param fixtureId 灯具 id。
 * @param at 镜像地址；省略时按上述默认值。
 * @returns 是否添加（灯具不存在或已达 [`MAX_MIRRORS`] 时为 `false`）。
 */
export function addMirror(draft: ShowProject, fixtureId: string, at?: PatchAddress): boolean {
  const fixture = draft.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return false;
  const mirrors = fixture.mirrors ?? [];
  if (mirrors.length >= MAX_MIRRORS) return false;
  const last = mirrors.at(-1) ?? { universe: fixture.universe, address: fixture.address };
  fixture.mirrors = [...mirrors, clampAddress(at ?? { universe: last.universe + 1, address: last.address })];
  return true;
}

/**
 * 修改灯具的某个镜像地址。
 *
 * @param draft 工程草稿。
 * @param fixtureId 灯具 id。
 * @param index 镜像下标。
 * @param at 新地址（夹回合法范围）。
 */
export function setMirror(draft: ShowProject, fixtureId: string, index: number, at: PatchAddress): void {
  const fixture = draft.fixtures.find((f) => f.id === fixtureId);
  if (!fixture?.mirrors?.[index]) return;
  fixture.mirrors[index] = clampAddress(at);
}

/**
 * 删除灯具的某个镜像地址；删空后去掉 `mirrors` 字段。
 *
 * @param draft 工程草稿。
 * @param fixtureId 灯具 id。
 * @param index 镜像下标。
 */
export function removeMirror(draft: ShowProject, fixtureId: string, index: number): void {
  const fixture = draft.fixtures.find((f) => f.id === fixtureId);
  if (!fixture?.mirrors) return;
  fixture.mirrors = fixture.mirrors.filter((_, i) => i !== index);
  if (fixture.mirrors.length === 0) delete fixture.mirrors;
}

/**
 * 批量重新配接：按给定顺序从起点依次排布，Universe 放不下时自动进到下一个 Universe。
 *
 * @param draft 工程草稿。
 * @param fixtureIds 要重新配接的灯具（按此顺序排布；不存在的忽略）。
 * @param start 起始地址。
 * @param gap 相邻灯具之间空出的通道数。
 * @returns 实际改了地址的灯具数（Universe 用尽时后面的保持原地址）。
 */
export function repatchSequential(
  draft: ShowProject,
  fixtureIds: readonly string[],
  start: PatchAddress,
  gap = 0,
): number {
  const models = new Map(draft.fixtureModels.map((m) => [m.id, m]));
  const fixtures = fixtureIds
    .map((id) => draft.fixtures.find((f) => f.id === id))
    .filter((f): f is NonNullable<typeof f> => f !== undefined);
  const slots = sequentialAddresses(
    fixtures.map((f) => footprintOf(models.get(f.modelId), f.modeId)),
    clampAddress(start),
    gap,
  );
  let moved = 0;
  fixtures.forEach((f, i) => {
    const slot = slots[i];
    if (!slot) return;
    f.universe = slot.universe;
    f.address = slot.address;
    moved += 1;
  });
  return moved;
}

// ---------------------------------------------------------------- 路由表

/**
 * 新端口的默认值：Art-Net 广播到 `255.255.255.255`，远端 Universe 与工程内编号相同。
 *
 * @param universe 工程内 Universe。
 * @param protocol 协议。
 * @returns 新端口。
 */
export function defaultPort(universe: number, protocol: UniversePort["protocol"] = "artNet"): UniversePort {
  return protocol === "artNet"
    ? {
        id: newId(),
        protocol,
        mode: "broadcast",
        ip: "255.255.255.255",
        port: ARTNET_PORT,
        remoteUniverse: clamp(universe, 0, MAX_ARTNET_UNIVERSE),
        enabled: true,
      }
    : {
        id: newId(),
        protocol,
        mode: "multicast",
        ip: "",
        port: SACN_PORT,
        remoteUniverse: clamp(universe + 1, MIN_SACN_UNIVERSE, MAX_SACN_UNIVERSE),
        priority: DEFAULT_SACN_PRIORITY,
        enabled: true,
      };
}

/** 路由表按 Universe 升序排列（保持确定的显示 / 存盘顺序）。 */
function sortTable(draft: ShowProject): void {
  draft.output.universes.sort((a, b) => a.universe - b.universe);
}

/**
 * 在路由表里加一个 Universe（已存在时不重复添加），带一个默认端口。
 *
 * @param draft 工程草稿。
 * @param universe 工程内 Universe；省略时取表里最大编号 + 1。
 * @returns 实际加入的 Universe 编号；已存在或越界时为 `null`。
 */
export function addUniverseConfig(draft: ShowProject, universe?: number): number | null {
  const table = draft.output.universes;
  const n = universe ?? (table.length > 0 ? Math.max(...table.map((u) => u.universe)) + 1 : 0);
  if (!Number.isInteger(n) || n < 0 || n > MAX_UNIVERSE || table.some((u) => u.universe === n)) return null;
  table.push({ universe: n, label: "", ports: [defaultPort(n)] });
  sortTable(draft);
  return n;
}

/**
 * 给工程用到、但路由表里还没有的 Universe 补上默认路由。
 *
 * @param draft 工程草稿。
 * @param protocol 新端口的协议。
 * @returns 补上的 Universe。
 */
export function fillMissingUniverses(draft: ShowProject, protocol: UniversePort["protocol"] = "artNet"): number[] {
  const have = new Set(draft.output.universes.map((u) => u.universe));
  const added: number[] = [];
  for (const u of usedUniverses(draft.fixtures)) {
    if (have.has(u)) continue;
    draft.output.universes.push({ universe: u, label: "", ports: [defaultPort(u, protocol)] });
    added.push(u);
  }
  sortTable(draft);
  return added;
}

/**
 * 删除路由表里的一个 Universe。
 *
 * @param draft 工程草稿。
 * @param universe 工程内 Universe。
 */
export function removeUniverseConfig(draft: ShowProject, universe: number): void {
  draft.output.universes = draft.output.universes.filter((u) => u.universe !== universe);
}

/**
 * 修改 Universe 的名称 / 颜色。
 *
 * @param draft 工程草稿。
 * @param universe 工程内 Universe。
 * @param patch 要改的字段。
 */
export function updateUniverseConfig(
  draft: ShowProject,
  universe: number,
  patch: Partial<Pick<UniverseConfig, "label" | "color">>,
): void {
  const config = draft.output.universes.find((u) => u.universe === universe);
  if (!config) return;
  if (patch.label !== undefined) config.label = patch.label.trim();
  if (patch.color !== undefined) config.color = patch.color;
}

/**
 * 给 Universe 加一个端口（同一份数据同时发往多个目标，例如 Art-Net 节点 + sACN 备份）。
 *
 * @param draft 工程草稿。
 * @param universe 工程内 Universe。
 * @param port 端口；省略为默认端口。
 * @returns 新端口 id；Universe 不在表里时为 `null`。
 */
export function addPort(draft: ShowProject, universe: number, port?: UniversePort): string | null {
  const config = draft.output.universes.find((u) => u.universe === universe);
  if (!config) return null;
  const next = port ?? defaultPort(universe);
  config.ports.push(next);
  return next.id;
}

/**
 * 修改端口。切换协议时同时换成该协议合适的默认寻址方式、端口号与远端编号范围。
 *
 * @param draft 工程草稿。
 * @param universe 工程内 Universe。
 * @param portId 端口 id。
 * @param patch 要改的字段（数值会取整并夹回协议允许的范围）。
 */
export function updatePort(
  draft: ShowProject,
  universe: number,
  portId: string,
  patch: Partial<Omit<UniversePort, "id">>,
): void {
  const port = draft.output.universes.find((u) => u.universe === universe)?.ports.find((p) => p.id === portId);
  if (!port) return;
  if (patch.protocol && patch.protocol !== port.protocol) {
    const fresh = defaultPort(universe, patch.protocol);
    port.protocol = fresh.protocol;
    port.mode = fresh.mode;
    port.ip = fresh.ip;
    port.port = fresh.port;
    port.remoteUniverse = fresh.remoteUniverse;
    if (fresh.priority === undefined) delete port.priority;
    else port.priority = fresh.priority;
  }
  if (patch.mode) port.mode = port.protocol === "artNet" && patch.mode === "multicast" ? "unicast" : patch.mode;
  if (patch.mode === "broadcast" && port.ip.trim() === "") port.ip = "255.255.255.255";
  if (patch.ip !== undefined) port.ip = patch.ip.trim();
  if (patch.port !== undefined) port.port = clamp(Math.round(patch.port) || 1, 1, 65_535);
  if (patch.remoteUniverse !== undefined) {
    const [lo, hi] = port.protocol === "artNet" ? [0, MAX_ARTNET_UNIVERSE] : [MIN_SACN_UNIVERSE, MAX_SACN_UNIVERSE];
    port.remoteUniverse = clamp(Math.round(patch.remoteUniverse) || lo, lo, hi);
  }
  if (patch.priority !== undefined) port.priority = clamp(Math.round(patch.priority), 0, 200);
  if (patch.enabled !== undefined) port.enabled = patch.enabled;
}

/**
 * 删除端口。
 *
 * @param draft 工程草稿。
 * @param universe 工程内 Universe。
 * @param portId 端口 id。
 */
export function removePort(draft: ShowProject, universe: number, portId: string): void {
  const config = draft.output.universes.find((u) => u.universe === universe);
  if (config) config.ports = config.ports.filter((p) => p.id !== portId);
}

/**
 * 设置帧同步。
 *
 * @param draft 工程草稿。
 * @param patch 要改的字段；sACN 同步 Universe 会夹回 1~63999。
 */
export function setSync(draft: ShowProject, patch: Partial<SyncSettings>): void {
  const sync = draft.output.sync;
  if (patch.artSync !== undefined) sync.artSync = patch.artSync;
  if (patch.sacnSyncUniverse !== undefined) {
    sync.sacnSyncUniverse =
      patch.sacnSyncUniverse === null
        ? null
        : clamp(Math.round(patch.sacnSyncUniverse), MIN_SACN_UNIVERSE, MAX_SACN_UNIVERSE);
  }
}

// ---------------------------------------------------------------- 校验

/** 端口的问题（与后端 `RouteError` 对应）。 */
export type PortIssue = "remoteUniverse" | "badIp" | "multicastArtNet";

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * 是否为合法的点分十进制 IPv4 地址。
 *
 * @param ip 文本。
 * @returns 合法时为 `true`。
 */
export function isIpv4(ip: string): boolean {
  return IPV4.test(ip.trim());
}

/**
 * 校验一个端口（停用的端口不校验，与后端一致）。
 *
 * @param port 端口。
 * @returns 问题；没有问题时为 `null`。
 */
export function portIssue(port: UniversePort): PortIssue | null {
  if (!port.enabled) return null;
  const okRemote =
    port.protocol === "artNet"
      ? port.remoteUniverse >= 0 && port.remoteUniverse <= MAX_ARTNET_UNIVERSE
      : port.remoteUniverse >= MIN_SACN_UNIVERSE && port.remoteUniverse <= MAX_SACN_UNIVERSE;
  if (!okRemote) return "remoteUniverse";
  if (port.mode === "multicast") return port.protocol === "artNet" ? "multicastArtNet" : null;
  return isIpv4(port.ip) ? null : "badIp";
}

/** 路由表的整体检查结果。 */
export interface RoutingReport {
  /** 端口 id → 问题 */
  portIssues: Map<string, PortIssue>;
  /** 工程用到但路由表里没有（或没有启用端口）的 Universe：这些 Universe 不会输出 */
  unrouted: number[];
  /** 路由表里有、但没有灯具用到的 Universe */
  unused: number[];
  /** 多个工程 Universe 发往同一目标（协议 + IP + 远端 Universe）的冲突 */
  duplicates: { key: string; universes: number[] }[];
}

/**
 * 检查路由表。
 *
 * @param project 工程（只读）。
 * @returns 检查结果；`portIssues` 为空时后端能接受这张表。
 */
export function checkRouting(project: Pick<ShowProject, "fixtures" | "output">): RoutingReport {
  const portIssues = new Map<string, PortIssue>();
  const routed = new Set<number>();
  const targets = new Map<string, Set<number>>();
  for (const u of project.output.universes) {
    for (const p of u.ports) {
      const issue = portIssue(p);
      if (issue) portIssues.set(p.id, issue);
      if (!p.enabled || issue) continue;
      routed.add(u.universe);
      const host = p.mode === "multicast" ? "multicast" : p.ip.trim();
      const key = `${p.protocol}|${host}|${p.remoteUniverse}`;
      const set = targets.get(key) ?? new Set<number>();
      set.add(u.universe);
      targets.set(key, set);
    }
  }
  const used = usedUniverses(project.fixtures);
  const usedSet = new Set(used);
  return {
    portIssues,
    unrouted: used.filter((u) => !routed.has(u)),
    unused: project.output.universes.map((u) => u.universe).filter((u) => !usedSet.has(u)),
    duplicates: [...targets]
      .filter(([, set]) => set.size > 1)
      .map(([key, set]) => ({ key, universes: [...set].sort((a, b) => a - b) })),
  };
}

// ---------------------------------------------------------------- 从发现的节点生成

/** 一个可分配的节点输出口。 */
export interface NodeOutput {
  ip: string;
  /** 显示名（自定义名 / 短名 / IP） */
  name: string;
  /** 端口序号 */
  index: number;
  /** 节点该输出口监听的 Port-Address */
  remoteUniverse: number;
}

/**
 * 列出在线 Art-Net 节点的 DMX 输出口（按 IP、端口序号排序）。
 *
 * @param devices 已发现的设备。
 * @returns 输出口列表。
 */
export function nodeOutputs(devices: readonly Device[]): NodeOutput[] {
  const out: NodeOutput[] = [];
  for (const d of devices) {
    if (!d.online || d.category !== "artNet" || !isIpv4(d.ip)) continue;
    const name = d.customName || d.shortName || d.hostname || d.ip;
    for (const p of d.ports ?? []) {
      if (p.direction !== "output") continue;
      out.push({ ip: d.ip, name, index: p.index, remoteUniverse: p.universe });
    }
  }
  const ipKey = (ip: string) => ip.split(".").map((x) => x.padStart(3, "0")).join(".");
  return out.sort((a, b) => ipKey(a.ip).localeCompare(ipKey(b.ip)) || a.index - b.index);
}

/**
 * 把一个节点输出口设为某个 Universe 的路由（Art-Net 单播到节点 IP，远端 Universe 取节点口的 Port-Address）。
 * Universe 不在表里时先加入；表里已有同一目标的端口时不重复添加。
 *
 * @param draft 工程草稿。
 * @param universe 工程内 Universe。
 * @param node 节点输出口。
 * @param replace 为 `true` 时先移除该 Universe 原有的端口。
 */
export function routeToNode(draft: ShowProject, universe: number, node: NodeOutput, replace = false): void {
  let config = draft.output.universes.find((u) => u.universe === universe);
  if (!config) {
    config = { universe, label: "", ports: [] };
    draft.output.universes.push(config);
    sortTable(draft);
    config = draft.output.universes.find((u) => u.universe === universe);
    if (!config) return;
  }
  if (replace) config.ports = [];
  if (!config.label) config.label = `${node.name} #${node.index + 1}`;
  const exists = config.ports.some(
    (p) => p.protocol === "artNet" && p.ip === node.ip && p.remoteUniverse === node.remoteUniverse,
  );
  if (exists) return;
  config.ports.push({
    id: newId(),
    protocol: "artNet",
    mode: "unicast",
    ip: node.ip,
    port: ARTNET_PORT,
    remoteUniverse: node.remoteUniverse,
    enabled: true,
  });
}

/**
 * 一键分配：把工程用到的 Universe 依次对应到发现的节点输出口（替换原有端口）。
 * 节点输出口不够时，多出的 Universe 保持原样。
 *
 * @param draft 工程草稿。
 * @param nodes 节点输出口（`nodeOutputs` 的结果）。
 * @returns 分配了的 Universe 数。
 */
export function autoRouteToNodes(draft: ShowProject, nodes: readonly NodeOutput[]): number {
  const universes = usedUniverses(draft.fixtures);
  const n = Math.min(universes.length, nodes.length);
  for (let i = 0; i < n; i += 1) routeToNode(draft, universes[i], nodes[i], true);
  return n;
}

// ---------------------------------------------------------------- Park

/** 锁定通道最多的条数。 */
export const MAX_PARK = 512;

/**
 * 锁定一个通道（同一 Universe + 通道已锁定时改为新值）。数值夹回合法范围。
 *
 * @param draft 工程草稿。
 * @param entry Universe（0~2047）、通道（1~512）与固定值（0~255）。
 * @returns 是否写入（条数已达 [`MAX_PARK`] 且是新通道时为 `false`）。
 */
export function setPark(draft: ShowProject, entry: { universe: number; channel: number; value: number }): boolean {
  const universe = Math.min(MAX_UNIVERSE, Math.max(0, Math.floor(entry.universe) || 0));
  const channel = Math.min(DMX_CHANNELS, Math.max(1, Math.floor(entry.channel) || 1));
  const value = Math.min(255, Math.max(0, Math.round(entry.value) || 0));
  const existing = draft.output.park.find((p) => p.universe === universe && p.channel === channel);
  if (existing) {
    existing.value = value;
    return true;
  }
  if (draft.output.park.length >= MAX_PARK) return false;
  draft.output.park.push({ universe, channel, value });
  draft.output.park.sort((a, b) => a.universe - b.universe || a.channel - b.channel);
  return true;
}

/**
 * 解除一个通道的锁定。
 *
 * @param draft 工程草稿。
 * @param universe Universe。
 * @param channel 通道。
 */
export function removePark(draft: ShowProject, universe: number, channel: number): void {
  draft.output.park = draft.output.park.filter((p) => !(p.universe === universe && p.channel === channel));
}
