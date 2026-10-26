import type { Device } from "@/shared/domain/device";
import type { ScanSummary } from "@/features/discovery/lib/api";
import { hashText, wobble } from "../lib/random";
import type { DeviceSeed } from "../types";
import type { LiveEngine } from "./live";
import {
  createGate,
  fail,
  sleep,
  str,
  type CommandArgs,
  type DemoModule,
  type World,
} from "./world";

/** 一台设备的运行时状态。 */
interface DeviceState {
  seed: DeviceSeed;
  /** 是否已出现在设备列表里（隐藏设备要等扫描才会出现）。 */
  revealed: boolean;
  /** 被用户“清除离线设备”移除后，等它重新上线才会再出现。 */
  removed: boolean;
  customName: string | null;
}

/** 模拟 ArtPoll 广播与等待回复的耗时（真实后端约 1.5 秒）。 */
const SCAN_MS = 1500;
/** 掉线周期里在线的比例。 */
const FLAP_ONLINE_SHARE = 0.7;

/**
 * 创建设备发现模块：按 `devices.json` 模拟 Art-Net 节点与网络设备的上下线，
 * 并实现主动扫描（逐次发现隐藏设备）、清除离线设备与自定义名。
 *
 * `lastSeenMs` 与引擎运行时长同一时间基准：在线设备紧跟“现在”，离线设备停在各自最后活动的时刻。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 * * `live` - 实时信号引擎，用于判断输出口是否有数据。
 *
 * # Returns
 *
 * 设备发现模块。
 */
export function createDevicesModule(world: World, live: LiveEngine): DemoModule {
  const baseUptimeMs = world.data.live.baseUptimeSec * 1000;
  const states: DeviceState[] = world.data.devices.map((seed) => ({
    seed,
    revealed: seed.discoverOnScan === undefined,
    removed: false,
    customName: seed.customName,
  }));
  let scanCount = 0;
  let scanning = false;
  const gate = createGate(1000);

  /** 设备此刻是否在线，以及（离线时）最后活动的时刻。 */
  const presenceOf = (s: DeviceState): { online: boolean; lastSeenMs: number } => {
    const elapsed = world.elapsedMs();
    const period = (s.seed.flapPeriodSec ?? 0) * 1000;
    if (period > 0) {
      const phase = elapsed % period;
      const online = phase < period * FLAP_ONLINE_SHARE;
      if (online) return { online, lastSeenMs: world.uptimeMs() - jitterMs(s) };
      const cycleStart = elapsed - phase;
      return { online, lastSeenMs: baseUptimeMs + cycleStart + period * FLAP_ONLINE_SHARE };
    }
    if (s.seed.online) return { online: true, lastSeenMs: world.uptimeMs() - jitterMs(s) };
    return { online: false, lastSeenMs: baseUptimeMs - (s.seed.lastSeenAgoSec ?? 0) * 1000 };
  };

  /** 在线设备“最后一次回复”落在最近 0~1.2 秒内，看起来像真实的轮询。 */
  const jitterMs = (s: DeviceState): number =>
    Math.round(wobble(600, 1, world.elapsedMs() / 1000, hashText(s.seed.ip)));

  const snapshot = (): Device[] => {
    const activeUniverses = new Set(live.active().map((u) => u.universe));
    const out: Device[] = [];
    for (const s of states) {
      if (!s.revealed) continue;
      const { online, lastSeenMs } = presenceOf(s);
      // 被清除的设备要等重新上线才再次出现
      if (s.removed) {
        if (!online) continue;
        s.removed = false;
      }
      const { lastSeenAgoSec: _a, discoverOnScan: _d, flapPeriodSec: _f, ...rest } = s.seed;
      out.push({
        ...rest,
        customName: s.customName,
        online,
        lastSeenMs: Math.round(lastSeenMs),
        // 输出口是否“有数据流”跟随实时信号；输入口沿用数据文件里的值
        ports: s.seed.ports?.map((p) => ({
          ...p,
          active: online && (p.direction === "input" ? p.active : activeUniverses.has(p.universe)),
        })),
      });
    }
    return out;
  };

  return {
    commands: {
      get_devices: () => snapshot(),

      clear_offline_devices: () => {
        for (const s of states) {
          if (s.revealed && !presenceOf(s).online) s.removed = true;
        }
        const left = snapshot();
        world.bus.emit("discovery:devices", left);
        return left;
      },

      scan_network: async (): Promise<ScanSummary> => {
        if (scanning) fail("scan_in_progress");
        scanning = true;
        try {
          await sleep(SCAN_MS);
          scanCount += 1;
          let found = 0;
          for (const s of states) {
            if (!s.revealed && s.seed.discoverOnScan === scanCount) {
              s.revealed = true;
              found += 1;
            }
          }
          const list = snapshot();
          world.bus.emit("discovery:devices", list);
          const artnet = list.filter((d) => d.category === "artNet");
          const responded = artnet.filter((d) => d.online).length;
          world.log(
            "info",
            `ArtPoll 扫描完成: ${responded}/${artnet.length} 个 Art-Net 节点响应${found > 0 ? `,新发现 ${found} 个` : ""}`,
          );
          return {
            targets: 2,
            sent: 2,
            responded,
            totalArtnet: artnet.length,
            // 第三次扫描时让一块虚拟网卡发送失败,以便看到“部分失败”提示
            errors: scanCount === 3 ? ["192.168.150.255: 网络不可达 (VMware VMnet8)"] : [],
          };
        } finally {
          scanning = false;
        }
      },

      set_device_name: (args: CommandArgs) => {
        const ip = str(args, "ip");
        const name = str(args, "name").trim();
        const target = states.find((s) => s.seed.ip === ip);
        if (target) target.customName = name || null;
      },
    },

    tick: ({ elapsedMs }) => {
      if (gate(elapsedMs).fire) world.bus.emit("discovery:devices", snapshot());
    },
  };
}
