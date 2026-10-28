import { fail, num, type DemoModule, type World } from "./world";

/** 演示用的工程最小形态：只读取播放引擎关心的字段。 */
interface DemoProject {
  durationMs?: number;
  fixtures?: { id: string; universe: number; mirrors?: { universe: number }[] }[];
  output?: { loop?: boolean; target?: { kind?: string }; universes?: DemoUniverse[] };
  loopRange?: { startMs: number; endMs: number } | null;
}

/** 路由表的一项（只取校验需要的字段）。 */
interface DemoUniverse {
  universe: number;
  ports?: { protocol?: string; mode?: string; ip?: string; remoteUniverse?: number; enabled?: boolean }[];
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * 校验路由表并统计启用的端口（规则同后端 `DispatchTarget::normalized`）。
 *
 * # Arguments
 *
 * * `universes` - 工程的 Universe 路由表。
 *
 * # Returns
 *
 * 启用的端口数；任一启用端口不合法时抛出 `bad_target`。
 */
function routedPortCount(universes: DemoUniverse[] | undefined): number {
  let n = 0;
  for (const u of universes ?? []) {
    for (const p of u.ports ?? []) {
      if (!p.enabled) continue;
      const remote = p.remoteUniverse ?? -1;
      const okRemote = p.protocol === "sacn" ? remote >= 1 && remote <= 63_999 : remote >= 0 && remote <= 0x7fff;
      const okMode = p.mode === "multicast" ? p.protocol === "sacn" : IPV4.test((p.ip ?? "").trim()) && (p.ip ?? "").trim() !== "0.0.0.0";
      if (!okRemote || !okMode) fail("bad_target");
      n += 1;
    }
  }
  return n;
}

type Transport = "stopped" | "playing" | "paused";

/**
 * 创建节目预览播放引擎模块：模拟后端 30 FPS 引擎的传输状态机。
 *
 * 行为对齐真实后端：
 * - 位置由“后端”（这里的时钟节拍）推进，约 30 Hz 推送 `show:state`；
 * - 播完且不循环则停在结尾并结束输出；循环则回绕；停止回到 0；
 * - 录制进行中 / 已打开回放节目时拒绝开始输出；输出期间拒绝录制和打开回放节目；
 * - “输出到网络”关闭时照常播放，但不占用输出（不受录制 / 回放互斥影响）；

 * - 定位只在灯具存在时允许。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 *
 * # Returns
 *
 * 预览播放模块（命令 + 周期驱动）。
 */
export function createShowPlaybackModule(world: World): DemoModule {
  let loaded = false;
  let durationMs = 0;
  let looping = false;
  /** A-B 循环区间（与后端一致：从终点之前开始播放时，到终点回到起点） */
  let loopRange: { startMs: number; endMs: number } | null = null;
  /** 本轮播放开始时的位置（判断是否从区间终点之前开始） */
  let playFrom = 0;
  let forwarding = true;
  /** 按 Universe 表路由时启用的端口数；其它目标为 `null` */
  let routedPorts: number | null = null;
  let universes: number[] = [];
  let fixtureIds = new Set<string>();
  let transport: Transport = "stopped";
  let positionMs = 0;
  let locate: string | null = null;
  /** “输出到网络”开关（默认开启）；关闭时照常走时钟，但不占用输出 */
  let outputEnabled = true;

  const outputting = () => transport !== "stopped" || locate !== null;
  /** 真正在向网络发送：会话在运行且输出打开（与后端的 `sending` 一致） */
  const sending = () => outputting() && outputEnabled;

  const state = () => ({
    loaded,
    transport,
    positionMs: Math.round(positionMs),
    durationMs,
    looping,
    locate,
    universes,
    warnings: [] as unknown[],
    outputting: outputting(),
    outputEnabled,
    sending: sending(),
    destinations: routedPorts ?? (forwarding ? 1 : null),
    dropped: 0,
  });

  const publish = () => world.bus.emit("show:state", state());

  /** 开始输出前的互斥检查（输出关闭时不占用输出，不检查）。 */
  const guard = () => {
    if (sending() || !outputEnabled) return;
    checkFree();
  };
  /** 录制 / 回放进行中时不能开始输出。 */
  const checkFree = () => {
    if (world.hooks.isRecording()) fail("recording_active");
    if (world.hooks.playerLoaded()) fail("playback_active");
  };

  world.hooks.showOutputting = sending;

  return {
    commands: {
      show_load: (args) => {
        const p = args.project as DemoProject | undefined;
        if (!p || typeof p.durationMs !== "number") return fail("invalid_project");
        const kind = p.output?.target?.kind ?? "forwarding";
        // 与后端一致：按 Universe 表路由时先校验启用的端口（失败时不改动已加载的节目），目的地数为启用端口总数
        const ports = kind === "routed" ? routedPortCount(p.output?.universes) : null;
        loaded = true;
        durationMs = Math.max(0, p.durationMs);
        looping = p.output?.loop ?? false;
        const r = p.loopRange;
        const a = r ? Math.min(Math.max(0, r.startMs), durationMs) : 0;
        const b = r ? Math.min(Math.max(0, r.endMs), durationMs) : 0;
        loopRange = r && b > a ? { startMs: a, endMs: b } : null;
        routedPorts = ports;
        forwarding = kind === "forwarding";
        fixtureIds = new Set((p.fixtures ?? []).map((f) => f.id));
        universes = [
          ...new Set((p.fixtures ?? []).flatMap((f) => [f.universe, ...(f.mirrors ?? []).map((m) => m.universe)])),
        ].sort((a, b) => a - b);
        positionMs = Math.min(positionMs, durationMs);
        if (locate !== null && !fixtureIds.has(locate)) locate = null;
        publish();
        return state();
      },

      show_play: () => {
        if (!loaded) return fail("no_show");
        if (durationMs <= 0) return fail("empty_show");
        guard();
        if (positionMs >= durationMs) positionMs = 0;
        playFrom = positionMs;
        transport = "playing";
        publish();
        return state();
      },

      show_pause: () => {
        if (transport === "playing") transport = "paused";
        publish();
        return state();
      },

      show_stop: () => {
        transport = "stopped";
        positionMs = 0;
        publish();
        return state();
      },

      show_seek: (args) => {
        positionMs = Math.min(durationMs, Math.max(0, num(args, "positionMs")));
        playFrom = positionMs;
        publish();
        return state();
      },

      show_locate: (args) => {
        const id = args.fixtureId;
        if (typeof id === "string") {
          if (!loaded) return fail("no_show");
          if (!fixtureIds.has(id)) return fail("unknown_fixture");
          guard();
          locate = id;
        } else {
          locate = null;
        }
        publish();
        return state();
      },

      show_set_output_enabled: (args) => {
        const enabled = args.enabled === true;
        // 与后端一致：会话运行中重新打开输出时才需要仲裁
        if (enabled && !outputEnabled && outputting()) checkFree();
        outputEnabled = enabled;
        publish();
        return state();
      },

      show_status: () => state(),
    },

    tick: ({ dtMs }) => {
      if (transport !== "playing") return;
      positionMs += dtMs;
      if (loopRange && playFrom < loopRange.endMs && positionMs >= loopRange.endMs) {
        const span = loopRange.endMs - loopRange.startMs;
        positionMs = loopRange.startMs + ((positionMs - loopRange.endMs) % span);
        playFrom = positionMs;
      } else if (positionMs >= durationMs) {
        if (looping && durationMs > 0) {
          positionMs %= durationMs;
        } else {
          positionMs = durationMs;
          transport = "stopped";
        }
      }
      publish();
    },
  };
}
