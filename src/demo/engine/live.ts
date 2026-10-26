import type {
  EngineStats,
  Protocol,
  UniverseSnapshot,
} from "@/shared/domain/engine";
import { DMX_KIND_LIVE, encodeDmxFrame } from "@/shared/lib/dmxFrame";
import type { SourceStat } from "@/features/recording/lib/types";
import { renderPattern } from "../lib/patterns";
import { hashText, wobble } from "../lib/random";
import { FULL_FRAME_MS, sameData, sameList } from "../lib/streamHub";
import type { LiveUniverseSeed } from "../types";
import { createGate, type CommandArgs, type DemoModule, type World } from "./world";

/** 一个来源在某个 Universe 上的运行时计数。 */
interface SourceState {
  ip: string;
  rateHz: number;
  /** 累计包数（用浮点累加，对外取整）。 */
  packets: number;
}

/** 一个实时 Universe 的运行时状态。 */
interface UniverseState {
  seed: LiveUniverseSeed;
  sources: SourceState[];
}

/** 实时信号引擎对外提供的只读视图（供输出、设备、录制等模块使用）。 */
export interface LiveEngine extends DemoModule {
  /** 当前正在接收的 Universe 种子；播放器模式或协议被关闭时相应部分为空。 */
  active(): LiveUniverseSeed[];
  /** 某个 Universe 当前的合并后包速率（pps）。 */
  rateOf(universe: number): number;
  /** 按 IP 聚合的来源统计。 */
  sourceStats(): SourceStat[];
}

/**
 * 创建实时信号引擎：按 `live.json` 的场景模拟 Art-Net / sACN 的接收统计与通道数据。
 *
 * 推送节奏对齐真实后端：统计与 Universe 列表约 10Hz，来源统计约 4Hz；被查看 Universe 的通道数据
 * 每个节拍检查一次（约 30Hz），经二进制通道流（kind = 1）只推有变化的 Universe，查看集合变化、
 * 新订阅或距上次全量满 1 秒时推全量帧，Universe 停止接收时推 `len = 0` 条目。
 * 切换到播放器模式后接收任务停止，实时状态清空；
 * sACN 的开关与订阅的 Universe 取自设置，改动立即生效（Art-Net 的开关需重启，所以不跟随）。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 *
 * # Returns
 *
 * 实时信号引擎。
 */
export function createLiveEngine(world: World): LiveEngine {
  const scene = world.data.live;
  const baseUptime = scene.baseUptimeSec;
  // 假设各来源在引擎启动约 20 秒后陆续出现，据此给累计包数一个合理的初值
  const states: UniverseState[] = scene.universes.map((seed) => ({
    seed,
    sources: seed.sources.map((s) => ({
      ip: s.ip,
      rateHz: s.rateHz,
      packets: Math.round(s.rateHz * Math.max(0, baseUptime - 20)),
    })),
  }));

  let viewed: number[] = [];
  const statsGate = createGate(100);
  const sourcesGate = createGate(250);

  // ---- 二进制通道流（kind = 1，与回放模块共用 `world.stream`）----
  /** 上次发给前端的通道数据；不在表里的 Universe 表示前端没有它的数据。 */
  let sent = new Map<number, number[]>();
  /** 查看集合变化后下一帧须为全量。 */
  let needFull = true;
  /** 上次看到的全量代次（订阅变化时改变）。 */
  let seenEpoch = Number.NaN;
  let lastFullMs = Number.NEGATIVE_INFINITY;

  /** 推一帧通道数据：只含有变化的 Universe；需要全量时含全部有数据的 Universe。 */
  const pushChannels = (current: UniverseState[], tSec: number, elapsedMs: number) => {
    const epoch = world.stream.epoch();
    const full = needFull || epoch !== seenEpoch || elapsedMs - lastFullMs >= FULL_FRAME_MS;
    seenEpoch = epoch;
    const entries: Array<{ universe: number; data: readonly number[] }> = [];
    const next = new Map<number, number[]>();
    for (const universe of viewed) {
      const u = current.find((s) => s.seed.universe === universe);
      if (!u) {
        // 全量帧里省略即表示移除；增量帧需要显式的 len = 0
        if (!full && sent.has(universe)) entries.push({ universe, data: [] });
        continue;
      }
      const data = renderPattern(u.seed.program, tSec);
      next.set(universe, data);
      if (full || !sameData(sent.get(universe), data)) entries.push({ universe, data });
    }
    sent = next;
    if (!full && entries.length === 0) return;
    if (full) {
      needFull = false;
      lastFullMs = elapsedMs;
    }
    world.stream.send(encodeDmxFrame({ kind: DMX_KIND_LIVE, full, entries }));
  };

  /** 此刻真正在接收的 Universe：实时模式，且 sACN 已启用并订阅了该 Universe。 */
  const receiving = (): UniverseState[] => {
    if (world.mode.mode !== "live") return [];
    const { protocol } = world.hooks.settings();
    return states.filter(
      (u) =>
        u.seed.protocol !== "sacn" ||
        (protocol.sacnEnabled && protocol.sacnUniverses.includes(u.seed.universe)),
    );
  };

  const rateOfSource = (u: UniverseState, s: SourceState, tSec: number): number =>
    s.rateHz >= 10 ? wobble(s.rateHz, 0.03, tSec, hashText(`${u.seed.universe}-${s.ip}`)) : s.rateHz;

  const rateOfUniverse = (u: UniverseState, tSec: number): number =>
    u.sources.reduce((sum, s) => sum + rateOfSource(u, s, tSec), 0);

  const snapshotOf = (u: UniverseState, tSec: number): UniverseSnapshot => {
    const frame = renderPattern(u.seed.program, tSec);
    const sources = [...u.sources]
      .sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }))
      .map((s) => ({
        ip: s.ip,
        packets: Math.round(s.packets),
        packetRate: round1(rateOfSource(u, s, tSec)),
      }));
    return {
      universe: u.seed.universe,
      protocol: u.seed.protocol,
      sourceIps: sources.map((s) => s.ip),
      sourceCount: sources.length,
      activeChannels: frame.reduce((n, v) => n + (v > 0 ? 1 : 0), 0),
      conflictChannels: u.seed.conflictChannels ?? 0,
      totalPackets: sources.reduce((n, s) => n + s.packets, 0),
      packetRate: round1(sources.reduce((n, s) => n + s.packetRate, 0)),
      sources,
    };
  };

  const sourceStats = (): SourceStat[] => {
    const byIp = new Map<string, { protocol: Protocol; universes: number[]; packets: number }>();
    for (const u of receiving()) {
      for (const s of u.sources) {
        const entry = byIp.get(s.ip) ?? { protocol: u.seed.protocol, universes: [], packets: 0 };
        entry.universes.push(u.seed.universe);
        entry.packets += Math.round(s.packets);
        byIp.set(s.ip, entry);
      }
    }
    return [...byIp.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([ip, e]) => ({
        ip,
        protocol: e.protocol,
        universes: e.universes.sort((a, b) => a - b),
        packets: e.packets,
      }));
  };

  return {
    commands: {
      set_viewed_universes: (args: CommandArgs) => {
        const list = args.universes;
        const next = Array.isArray(list) ? list.filter((n): n is number => typeof n === "number") : [];
        // 查看集合变化：下一帧为全量（与后端一致）
        if (!sameList(next, viewed)) {
          viewed = next;
          needFull = true;
        }
      },
      get_source_stats: () => sourceStats(),
    },

    active: () => receiving().map((u) => u.seed),
    rateOf: (universe) => {
      const u = receiving().find((s) => s.seed.universe === universe);
      return u ? rateOfUniverse(u, world.elapsedMs() / 1000) : 0;
    },
    sourceStats,

    tick: ({ dtMs, elapsedMs }) => {
      const tSec = elapsedMs / 1000;
      const current = receiving();

      for (const u of current) {
        for (const s of u.sources) s.packets += rateOfSource(u, s, tSec) * (dtMs / 1000);
      }

      // 只给被查看的 Universe 推通道数据，没有订阅者时跳过（与真实后端一致）
      if (world.stream.hasSubscribers()) pushChannels(current, tSec, elapsedMs);

      if (statsGate(elapsedMs).fire) {
        const snapshots = current.map((u) => snapshotOf(u, tSec));
        const stats: EngineStats = {
          activeUniverses: snapshots.length,
          totalPackets: snapshots.reduce((n, u) => n + u.totalPackets, 0),
          packetRate: round1(snapshots.reduce((n, u) => n + u.packetRate, 0)),
          uptimeSec: Math.floor(world.uptimeMs() / 1000),
          memoryBytes: Math.round(memoryAt(world, tSec)),
        };
        world.bus.emit("engine:stats", stats);
        world.bus.emit("engine:universes", snapshots);
      }

      if (sourcesGate(elapsedMs).fire) world.bus.emit("engine:sources", sourceStats());
    },
  };
}

/** 进程内存：在基准附近缓慢起伏，并随运行时间略有增长。 */
function memoryAt(world: World, tSec: number): number {
  return world.data.live.memoryBytes + tSec * 2048 + wobble(6_000_000, 0.5, tSec, 77);
}

/** 保留 1 位小数。 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
