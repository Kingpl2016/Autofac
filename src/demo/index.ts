import { installDemoBackend, installDemoStream, type DemoBackend } from "@/shared/tauri/demoBridge";
import { useLogStore } from "@/shared/stores/logStore";
import { loadDemoData } from "./data";
import { createDevicesModule } from "./engine/devices";
import { createForwardingModule } from "./engine/forwarding";
import { createLiveEngine } from "./engine/live";
import { createLogsModule } from "./engine/logs";
import { createModeModule } from "./engine/mode";
import { createNetdevModule } from "./engine/netdev";
import { createOutputModule } from "./engine/output";
import { createPlayerModule } from "./engine/player";
import { createRecordingModule } from "./engine/recording";
import { createSystemModule } from "./engine/system";
import { createUpdateChecker } from "./engine/updater";
import { sleep, type CommandHandler, type DemoModule, type World } from "./engine/world";
import { EventBus } from "./lib/eventBus";
import { createStreamHub } from "./lib/streamHub";

/** 时钟节拍，约 30Hz，与真实后端的界面刷新节奏一致。 */
const TICK_MS = 33;
/** 单次节拍的时间步长上限：窗口被挂起很久后恢复时，不让计数器一次跳变过大。 */
const MAX_STEP_MS = 1000;
/** 模拟一次 IPC 往返的耗时。 */
const IPC_LATENCY_MS = 12;

/** 演示后端会产生的全部事件；不在此列的事件（窗口关闭守卫等）仍交给真实后端。 */
const DEMO_EVENTS: ReadonlySet<string> = new Set([
  "app:mode",
  "discovery:devices",
  "engine:output",
  "engine:sources",
  "engine:stats",
  "engine:universes",
  "player:playlist",
  "player:state",
  "recording:disk",
  "recording:finished",
  "recording:stats",
]);

/**
 * 启用演示模式：用 `src/demo/data/*.json` 里的测试数据接管所有后端命令与事件。
 *
 * 只在构建期常量 `__DEMO_MODE__` 为真时由 `main.tsx` 动态导入（`npm run dev:demo`）；
 * 普通构建不会包含这里的任何代码或数据。演示后端没有接管的命令（`app_quit`、信号检测器等）
 * 仍交给真实 Tauri。必须在首次渲染之前调用，这样各监听器挂载时就能拿到演示数据。
 */
export async function installDemo(): Promise<void> {
  const bus = new EventBus();
  // 实时引擎与回放模块共用的二进制通道流，经 demoBridge 交给 `subscribeDmxStream`
  const stream = createStreamHub();
  const data = loadDemoData();
  const startedAt = performance.now();

  const world: World = {
    bus,
    stream,
    data,
    mode: { mode: "live", receivers: "bound", sender: "ready" },
    elapsedMs: () => performance.now() - startedAt,
    uptimeMs: () => data.live.baseUptimeSec * 1000 + (performance.now() - startedAt),
    log: (level, message) => useLogStore.getState().append(level, message),
    // 以下入口由各模块在装配时覆盖；这里只放安全的默认值
    hooks: {
      isRecording: () => false,
      playerLoaded: () => false,
      closePlayer: () => undefined,
      enterPlayerMode: () => undefined,
      settings: () => data.settings,
      recordingDir: () => data.app.recordingDir,
      currentDiskFree: () => data.app.disk.freeBytes,
      programMoved: () => undefined,
    },
  };

  const system = createSystemModule(world);
  const mode = createModeModule(world);
  const live = createLiveEngine(world);
  const forwarding = createForwardingModule(world);
  const recording = createRecordingModule(world, live);
  const player = createPlayerModule(world, recording.library, forwarding);
  const devices = createDevicesModule(world, live);
  const output = createOutputModule(world, live, forwarding, player);
  const netdev = createNetdevModule(world, recording.library);
  const logs = createLogsModule(world);
  const checkForUpdate = createUpdateChecker(world);

  const modules: DemoModule[] = [
    system,
    mode,
    live,
    forwarding,
    recording,
    player,
    devices,
    output,
    netdev,
    logs,
  ];

  const commands = new Map<string, CommandHandler>();
  for (const m of modules) {
    for (const [name, handler] of Object.entries(m.commands)) {
      if (commands.has(name)) console.warn(`[demo] 命令重复注册: ${name}`);
      commands.set(name, handler);
    }
  }

  const backend: DemoBackend = {
    hasCommand: (cmd) => commands.has(cmd),

    invoke: async (cmd, args) => {
      const handler = commands.get(cmd);
      if (!handler) throw `unknown_command: ${cmd}`;
      await sleep(IPC_LATENCY_MS);
      const result = await handler(args ?? {});
      // 与真实 IPC 一样返回副本，调用方改动结果不会影响演示引擎内部状态
      return result === undefined ? undefined : structuredClone(result);
    },

    hasEvent: (event) => DEMO_EVENTS.has(event),
    subscribe: (event, handler) => bus.on(event, handler),
    checkForUpdate,
  };

  // 驱动所有模块；单个模块出错只影响它自己，不会拖垮整个演示
  let previous = performance.now();
  const timer = window.setInterval(() => {
    const now = performance.now();
    const dtMs = Math.min(MAX_STEP_MS, now - previous);
    previous = now;
    const info = { dtMs, elapsedMs: now - startedAt };
    for (const m of modules) {
      try {
        m.tick?.(info);
      } catch (e) {
        console.error("[demo] 模块节拍出错", e);
      }
    }
  }, TICK_MS);
  import.meta.hot?.dispose(() => window.clearInterval(timer));

  installDemoBackend(backend);
  installDemoStream(stream);
  console.info(
    `[demo] 演示模式已启用: ${commands.size} 个命令、${DEMO_EVENTS.size} 类事件由 src/demo 提供,数据见 src/demo/data/*.json`,
  );
}
