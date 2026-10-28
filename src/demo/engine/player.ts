import {
  EMPTY_PLAYBACK,
  type PlaybackStatus,
  type PlayerTarget,
  type RepeatMode,
  type SeriesQuery,
} from "@/features/recording/lib/types";
import { DMX_KIND_PLAYBACK, encodeDmxFrame } from "@/shared/lib/dmxFrame";
import { renderSegments, toSegments } from "../lib/patterns";
import { FULL_FRAME_MS, sameData, sameList } from "../lib/streamHub";
import type { ForwardingModule } from "./forwarding";
import { sourceTimeSec, type Library, type ProgramRecord } from "./library";
import { buildOverview, buildSeries } from "./overview";
import {
  createGate,
  fail,
  str,
  type CommandArgs,
  type DemoModule,
  type World,
} from "./world";

/** 回放期间对输出的贡献。 */
export interface PlayerLoad {
  universes: number[];
  target: PlayerTarget;
}

/** 回放模块：对外暴露正在播放的负载，供输出统计使用。 */
export interface PlayerModule extends DemoModule {
  /** 正在播放时的输出负载；未打开或未在播放时为 `null`。 */
  outputLoad(): PlayerLoad | null;
  /** 当前回放状态。 */
  status(): PlaybackStatus;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * 校验并规整回放输出目标。
 *
 * # Arguments
 *
 * * `raw` - 前端传来的目标；`null` / 缺省表示走转发表。
 *
 * # Returns
 *
 * 规整后的目标。
 *
 * # Errors
 *
 * 直发目标的 IP 或端口非法时以 `bad_target` 失败。
 */
function normalizeTarget(raw: unknown): PlayerTarget {
  if (raw === null || raw === undefined) return { kind: "forwarding" };
  const t = raw as PlayerTarget;
  if (t.kind === "forwarding") return t;
  // 与后端一致：0.0.0.0 不能作为发送目标
  if (t.kind === "direct" && IPV4.test(t.ip) && t.ip !== "0.0.0.0" && t.port > 0 && t.port < 65536) return t;
  return fail("bad_target");
}

/**
 * 创建回放模块：模拟节目的打开、播放、暂停、跳转、倍速、循环与连播。
 *
 * 行为对齐真实后端：打开节目会自动进入播放器模式且处于停止状态（需要再点播放）；
 * 播完后停在结尾；循环模式回绕；连播模式在结尾自动打开并播放节目库里的下一个有效节目，
 * 到列表末尾发 `listFinished`。状态约 30Hz 推送，空闲时每 500ms 兜底重发一次。
 *
 * 被查看 Universe 的通道数据经二进制通道流（kind = 2，与实时引擎共用 `world.stream`）推送：
 * 播放中每个节拍检查一次、空闲时每 500ms 检查一次，只推有变化的 Universe；
 * 查看集合变化、新订阅、打开节目或距上次全量满 1 秒时推全量帧，关闭节目时推空的全量帧。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 * * `library` - 节目库。
 * * `forwarding` - 转发模块，用来统计启用的目的地数量。
 *
 * # Returns
 *
 * 回放模块。
 */
export function createPlayerModule(
  world: World,
  library: Library,
  forwarding: ForwardingModule,
): PlayerModule {
  let status: PlaybackStatus = { ...EMPTY_PLAYBACK };
  /** 用户选的重复模式：没有节目时也被记住，沿用到之后打开的节目。 */
  let repeat: RepeatMode = "off";
  let viewed: number[] = [];
  const idleGate = createGate(500);

  const recordOf = (): ProgramRecord | undefined => library.find(status.path);

  const publish = () => world.bus.emit("player:state", status);

  // ---- 二进制通道流（kind = 2）----
  /** 上次发给前端的通道数据；不在表里的 Universe 表示前端没有它的数据。 */
  let sent = new Map<number, number[]>();
  /** 查看集合变化 / 打开节目后下一帧须为全量。 */
  let needFull = true;
  /** 上次看到的全量代次（订阅变化时改变）。 */
  let seenEpoch = Number.NaN;
  let lastFullMs = Number.NEGATIVE_INFINITY;

  /** 推一帧回放通道数据：只含有变化的 Universe；需要全量时含全部被查看且节目里有的 Universe。 */
  const publishChannels = () => {
    if (!status.loaded || !world.stream.hasSubscribers()) return;
    const rec = recordOf();
    const nowMs = world.elapsedMs();
    const epoch = world.stream.epoch();
    const full = needFull || epoch !== seenEpoch || nowMs - lastFullMs >= FULL_FRAME_MS;
    seenEpoch = epoch;
    const posSec = rec ? sourceTimeSec(rec, status.posUs / 1_000_000) : 0;
    const entries: Array<{ universe: number; data: readonly number[] }> = [];
    const next = new Map<number, number[]>();
    for (const universe of viewed) {
      const prog = rec?.universes.find((u) => u.universe === universe);
      if (!prog) {
        // 全量帧里省略即表示移除；增量帧需要显式的 len = 0
        if (!full && sent.has(universe)) entries.push({ universe, data: [] });
        continue;
      }
      const data = renderSegments(toSegments(prog), posSec);
      next.set(universe, data);
      if (full || !sameData(sent.get(universe), data)) entries.push({ universe, data });
    }
    sent = next;
    if (!full && entries.length === 0) return;
    if (full) {
      needFull = false;
      lastFullMs = nowMs;
    }
    world.stream.send(encodeDmxFrame({ kind: DMX_KIND_PLAYBACK, full, entries }));
  };

  /** 节目关闭：推一帧空的回放全量帧，让前端清空回放通道表。 */
  const clearChannels = () => {
    sent = new Map();
    needFull = true;
    if (world.stream.hasSubscribers()) {
      world.stream.send(encodeDmxFrame({ kind: DMX_KIND_PLAYBACK, full: true, entries: [] }));
    }
  };

  const requireLoaded = () => {
    if (!status.loaded) fail("no_player");
  };

  const open = (rec: ProgramRecord, target: PlayerTarget): PlaybackStatus => {
    world.hooks.enterPlayerMode();
    // 新节目的第一帧为全量（与真实后端每个节目一个新的回放线程一致）
    needFull = true;
    status = {
      loaded: true,
      path: rec.entry.path,
      name: rec.entry.name,
      state: "stopped",
      posUs: 0,
      durationUs: rec.entry.durationUs,
      speedMilli: 1000,
      repeat,
      frames: rec.entry.frames,
      corruptFrames: rec.corruptFrames,
      universes: rec.entry.universes,
      target,
      destinations: forwarding.table().destinations.filter((d) => d.enabled).length,
    };
    publish();
    world.log("info", `打开节目: ${rec.entry.name} (${rec.entry.universes.length} 个 Universe)`);
    return status;
  };

  const close = () => {
    if (!status.loaded) return;
    world.log("info", `关闭节目: ${status.name}`);
    status = { ...EMPTY_PLAYBACK };
    viewed = [];
    publish();
    clearChannels();
  };

  /** 节目自然播完后的处理。 */
  const onEnd = () => {
    if (status.repeat === "loop") {
      status.posUs %= Math.max(1, status.durationUs);
      return;
    }
    status.posUs = status.durationUs;
    status.state = "stopped";
    if (status.repeat !== "playlist") return;

    const next = library.nextValidAfter(status.path);
    if (!next) {
      world.bus.emit("player:playlist", { kind: "listFinished" });
      return;
    }
    const { target, speedMilli } = status;
    open(next, target);
    status.speedMilli = speedMilli;
    status.state = "playing";
    world.bus.emit("player:playlist", { kind: "advanced", name: next.entry.name });
  };

  world.hooks.playerLoaded = () => status.loaded;
  world.hooks.closePlayer = close;
  world.hooks.programMoved = (from, to) => {
    if (!status.loaded || status.path !== from) return;
    if (to === null) {
      close();
      return;
    }
    status.path = to;
    status.name = library.find(to)?.entry.name ?? status.name;
    publish();
  };

  /** 取节目记录，并确认文件头可解析。 */
  const programAt = (path: string): ProgramRecord => {
    const rec = library.find(path);
    if (!rec) fail("bad_path");
    if (!rec.entry.valid) fail("无法解析 ArtRec 文件: 文件头魔数不匹配");
    return rec;
  };

  return {
    outputLoad: () =>
      status.loaded && status.state === "playing"
        ? { universes: status.universes, target: status.target }
        : null,
    status: () => status,

    commands: {
      player_open: (args: CommandArgs) => {
        if (world.hooks.isRecording()) fail("recording_active");
        if (world.hooks.showOutputting()) fail("show_active");
        const rec = programAt(str(args, "path"));
        return open(rec, normalizeTarget(args.target));
      },

      player_play: () => {
        requireLoaded();
        if (status.posUs >= status.durationUs) status.posUs = 0;
        status.state = "playing";
        publish();
      },

      player_pause: () => {
        requireLoaded();
        if (status.state === "playing") status.state = "paused";
        publish();
      },

      player_stop: () => {
        requireLoaded();
        status.state = "stopped";
        status.posUs = 0;
        publish();
        publishChannels();
      },

      player_close: () => close(),

      player_seek: (args: CommandArgs) => {
        requireLoaded();
        const pos = typeof args.posUs === "number" ? args.posUs : 0;
        status.posUs = Math.min(status.durationUs, Math.max(0, pos));
        publish();
        publishChannels();
      },

      player_set_speed: (args: CommandArgs) => {
        requireLoaded();
        const m = typeof args.speedMilli === "number" ? args.speedMilli : 1000;
        status.speedMilli = Math.min(4000, Math.max(100, Math.round(m)));
        publish();
      },

      player_set_repeat: (args: CommandArgs) => {
        const mode = str(args, "mode") as RepeatMode;
        if (mode !== "off" && mode !== "loop" && mode !== "playlist") fail("invalid_repeat_mode");
        repeat = mode;
        if (status.loaded) {
          status.repeat = mode;
          publish();
        }
      },

      player_set_target: (args: CommandArgs) => {
        requireLoaded();
        status.target = normalizeTarget(args.target);
        publish();
      },

      player_set_viewed: (args: CommandArgs) => {
        const list = args.universes;
        const next = Array.isArray(list) ? list.filter((n): n is number => typeof n === "number") : [];
        // 查看集合变化：下一帧为全量（与后端一致）
        if (!sameList(next, viewed)) {
          viewed = next;
          needFull = true;
        }
        publishChannels();
      },

      player_status: () => status,

      player_overview: (args: CommandArgs) => {
        const rec = programAt(str(args, "path"));
        const buckets = typeof args.buckets === "number" ? args.buckets : undefined;
        return buildOverview(rec, buckets);
      },

      player_series: (args: CommandArgs) => {
        const q = args.query as SeriesQuery;
        const rec = programAt(q.path);
        return buildSeries(rec, q);
      },
    },

    tick: ({ dtMs, elapsedMs }) => {
      if (!status.loaded) return;
      if (status.state === "playing") {
        status.posUs += dtMs * status.speedMilli;
        if (status.posUs >= status.durationUs) onEnd();
        publish();
        publishChannels();
      } else if (idleGate(elapsedMs).fire) {
        publish();
        publishChannels();
      }
    },
  };
}
