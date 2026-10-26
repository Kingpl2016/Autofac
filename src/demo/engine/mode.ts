import type { ModeStatus } from "@/features/app-mode/lib/types";
import type { AppModeName } from "@/shared/stores/engineStatusStore";
import { fail, sleep, str, type CommandArgs, type DemoModule, type World } from "./world";

/** 模拟重建接收套接字所需的时间。 */
const SWITCH_DELAY_MS = 180;

/**
 * 创建应用模式模块（实时 / 播放器）。
 *
 * 行为对齐真实后端：进入播放器模式会暂停实时接收，录制进行中不允许进入，
 * 回到实时模式时会卸载已打开的节目。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 *
 * # Returns
 *
 * 命令模块。
 */
export function createModeModule(world: World): DemoModule {
  const apply = (mode: AppModeName): ModeStatus => {
    world.mode = {
      mode,
      receivers: mode === "live" ? "bound" : "suspended",
      sender: "ready",
    };
    world.bus.emit("app:mode", world.mode);
    return world.mode;
  };

  // 回放打开时由播放器模块调用：已在播放器模式则什么也不做
  world.hooks.enterPlayerMode = () => {
    if (world.mode.mode === "player") return;
    apply("player");
    world.log("info", "切换到播放器模式,接收任务已暂停");
  };

  return {
    commands: {
      app_mode_get: () => world.mode,

      app_mode_set: async (args: CommandArgs) => {
        const target = str(args, "mode");
        if (target !== "live" && target !== "player") fail(`invalid_mode: ${target}`);
        if (target === world.mode.mode) return world.mode;

        if (target === "player") {
          if (world.hooks.isRecording()) fail("recording_active");
          await sleep(SWITCH_DELAY_MS);
          const status = apply("player");
          world.log("info", "切换到播放器模式,接收任务已暂停");
          return status;
        }

        world.hooks.closePlayer();
        await sleep(SWITCH_DELAY_MS);
        const status = apply("live");
        world.log("info", "切换到实时模式,接收任务已恢复");
        return status;
      },
    },
  };
}
