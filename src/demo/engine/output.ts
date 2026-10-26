import type {
  DestinationOutput,
  OutputPayload,
  OutputState,
} from "@/shared/domain/engine";
import type { ForwardDestination } from "@/features/forwarding/lib/types";
import { hashText, wobble } from "../lib/random";
import type { ForwardingModule } from "./forwarding";
import { routesFor } from "./forwarding";
import type { LiveEngine } from "./live";
import type { PlayerModule } from "./player";
import { createGate, type DemoModule, type World } from "./world";

/** 回放直发目标在输出统计里的 id（与信号流页的约定一致）。 */
const PLAYER_DIRECT_ID = "player-direct";
/** DMX 回放的帧率上限。 */
const PLAYBACK_RATE_HZ = 44;
/** `engine:output` 的推送间隔，与真实后端一致（约 2Hz）。 */
const OUTPUT_EVERY_MS = 500;

/** 一个目的地的累计计数。 */
interface Counter {
  sent: number;
  errors: number;
  dropped: number;
  /** 最近一次有包发出的 `elapsedMs`；从未发出为 `null`。 */
  lastSendAt: number | null;
  rate: number;
}

/**
 * 创建输出统计模块：根据转发表、实时信号（或回放负载）推算每个目的地的发送速率，
 * 并按 `output.json` 注入错误与丢帧，约 2Hz 推送 `engine:output`。
 *
 * 累计数从“引擎已运行一段时间”的初值起算，所以仪表盘上看到的是合理的大数字，而不是从 0 开始。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 * * `live` - 实时信号引擎。
 * * `forwarding` - 转发模块。
 * * `player` - 回放模块。
 *
 * # Returns
 *
 * 输出统计模块。
 */
export function createOutputModule(
  world: World,
  live: LiveEngine,
  forwarding: ForwardingModule,
  player: PlayerModule,
): DemoModule {
  const counters = new Map<string, Counter>();
  const faults = new Map(world.data.output.faults.map((f) => [f.destinationId, f]));
  const gate = createGate(OUTPUT_EVERY_MS);
  const baseSec = world.data.live.baseUptimeSec;
  // 演示开始前两分钟就已经出过一次错，仪表盘一打开就能看到“最近错误”
  const firstFault = world.data.output.faults[0];
  let lastError: { message: string; at: number } | null = firstFault
    ? { message: firstFault.error, at: -120_000 }
    : null;
  let recentDropAt = -Infinity;

  const counterOf = (d: ForwardDestination): Counter => {
    let c = counters.get(d.id);
    if (!c) {
      const fault = faults.get(d.id);
      // 按“已运行 baseSec 秒”估算历史累计，让数字看起来是长期运行的结果
      // 只有转发表里本来就有的目的地才带历史累计；回放直发等临时目的地从 0 开始
      const seeded = world.data.forwarding.destinations.some((x) => x.id === d.id);
      c = {
        sent: d.enabled && seeded ? Math.round(30 * baseSec * (1 + (hashText(d.id) % 5))) : 0,
        errors: fault ? Math.round(fault.errorsPerSec * baseSec * 0.2) : 0,
        dropped: fault ? Math.round(fault.dropPerSec * fault.dropBurstLenSec * (baseSec / fault.dropBurstEverySec) * 0.1) : 0,
        lastSendAt: null,
        rate: 0,
      };
      counters.set(d.id, c);
    }
    return c;
  };

  /** 当前输出的目的地列表与各自应有的发送速率（pps，未扣丢帧）。 */
  const currentLoad = (): Array<{ dest: ForwardDestination; rate: number }> => {
    const table = forwarding.table();
    const playing = player.outputLoad();

    if (playing) {
      const { target, universes } = playing;
      if (target.kind === "direct") {
        const dest: ForwardDestination = {
          id: PLAYER_DIRECT_ID,
          name: target.ip,
          targetIp: target.ip,
          protocol: target.protocol,
          port: target.port,
          mode: "all",
          universeOffset: 0,
          defaultDelayMs: 0,
          description: "",
          enabled: true,
          overrides: [],
        };
        return [{ dest, rate: universes.length * PLAYBACK_RATE_HZ }];
      }
      return table.destinations.map((dest) => ({
        dest,
        rate: routesFor(dest, universes).length * PLAYBACK_RATE_HZ,
      }));
    }

    const active = live.active().map((u) => u.universe);
    return table.destinations.map((dest) => ({
      dest,
      rate: routesFor(dest, active).reduce((sum, r) => sum + live.rateOf(r.sourceUniverse), 0),
    }));
  };

  return {
    commands: {},

    tick: ({ elapsedMs }) => {
      const { fire, dtSec } = gate(elapsedMs);
      if (!fire) return;
      const tSec = elapsedMs / 1000;

      const destinations: DestinationOutput[] = [];
      let sentRate = 0;
      let dropping = false;

      for (const { dest, rate } of currentLoad()) {
        const c = counterOf(dest);
        const fault = faults.get(dest.id);
        let dropRate = 0;
        if (fault && rate > 0) {
          const inBurst = tSec % fault.dropBurstEverySec >= fault.dropBurstEverySec - fault.dropBurstLenSec;
          if (inBurst) {
            dropRate = Math.min(rate, fault.dropPerSec);
            dropping = true;
            recentDropAt = elapsedMs;
          }
          // 错误数按小数累加，每跨过一个整数就算新增一次错误，错误间隔因此不是恒定的
          const before = Math.floor(c.errors);
          c.errors += wobble(fault.errorsPerSec, 0.8, tSec, hashText(dest.id)) * dtSec;
          if (Math.floor(c.errors) > before) lastError = { message: fault.error, at: elapsedMs };
        }
        const effective = Math.max(0, rate - dropRate);
        c.sent += effective * dtSec;
        c.dropped += dropRate * dtSec;
        c.rate = effective;
        if (effective > 0) c.lastSendAt = elapsedMs;
        sentRate += effective;
        destinations.push({
          id: dest.id,
          sent: Math.round(c.sent),
          errors: Math.round(c.errors),
          dropped: Math.round(c.dropped),
          sentRate: round1(effective),
          lastSendAgoMs: c.lastSendAt === null ? null : Math.round(elapsedMs - c.lastSendAt),
        });
      }

      const all = [...counters.values()];
      let state: OutputState = "idle";
      if (world.mode.sender === "down") state = "error";
      else if (sentRate > 0) state = dropping || elapsedMs - recentDropAt < 1500 ? "dropping" : "sending";

      const payload: OutputPayload = {
        state,
        sent: Math.round(all.reduce((n, c) => n + c.sent, 0)),
        sendErrors: Math.round(all.reduce((n, c) => n + c.errors, 0)),
        dropped: Math.round(all.reduce((n, c) => n + c.dropped, 0)),
        sentRate: round1(sentRate),
        lastError: lastError?.message ?? null,
        lastErrorAgoMs: lastError ? Math.round(elapsedMs - lastError.at) : null,
        sender: world.mode.sender,
        destinations,
      };
      world.bus.emit("engine:output", payload);
    },
  };
}

/** 保留 1 位小数。 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
