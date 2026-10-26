import type { DirCheck } from "@/features/settings/lib/recordingDir";
import type { AppSettings } from "@/features/settings/lib/types";
import { diskInfoOf } from "./disk";
import { fail, str, type CommandArgs, type DemoModule, type World } from "./world";

/** 把数值限制在闭区间内并取整。 */
function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * 规整设置：把越界值夹回合法范围，与真实后端保存时的规范化一致。
 *
 * # Arguments
 *
 * * `s` - 待保存的设置。
 *
 * # Returns
 *
 * 规整后的新对象，不修改入参。
 */
function normalize(s: AppSettings): AppSettings {
  const universes = [...new Set(s.protocol.sacnUniverses.map((u) => clampInt(u, 1, 63999)))].sort(
    (a, b) => a - b,
  );
  return {
    ...s,
    protocol: {
      ...s.protocol,
      artnetPort: clampInt(s.protocol.artnetPort, 1, 65535),
      sacnPort: clampInt(s.protocol.sacnPort, 1, 65535),
      sacnUniverses: universes,
    },
    display: { ...s.display, uiUpdateRate: clampInt(s.display.uiUpdateRate, 1, 120) },
    merge: { ...s.merge, sourceTimeoutMs: clampInt(s.merge.sourceTimeoutMs, 100, 60_000) },
    recording: {
      ...s.recording,
      directory: s.recording.directory.trim(),
      zstdLevel: clampInt(s.recording.zstdLevel, 1, 9),
      splitMinutes: clampInt(s.recording.splitMinutes, 0, 1440),
    },
  };
}

/**
 * 创建系统模块：应用信息、设置的读写与导入导出、网卡列表，以及录制目录的检查。
 *
 * 设置保存后立即在内存里生效（例如关闭 sACN 后，实时信号里的 sACN Universe 随即消失），
 * 刷新页面后还原为数据文件里的初始设置。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 *
 * # Returns
 *
 * 系统模块。
 */
export function createSystemModule(world: World): DemoModule {
  let settings: AppSettings = world.data.settings;

  world.hooks.settings = () => settings;
  world.hooks.recordingDir = () => settings.recording.directory || world.data.app.recordingDir;

  const apply = (next: AppSettings): AppSettings => {
    settings = normalize(next);
    return settings;
  };

  return {
    commands: {
      app_info: () => world.data.app.info,

      get_settings: () => settings,

      save_settings: (args: CommandArgs) => {
        const incoming = args.settings as AppSettings | undefined;
        if (!incoming) fail("invalid_settings");
        const saved = apply(incoming);
        world.log("info", `设置已保存: 录制分段 ${saved.recording.splitMinutes} 分钟,Zstd 等级 ${saved.recording.zstdLevel}`);
        return saved;
      },

      import_settings: (args: CommandArgs) => {
        let parsed: Partial<AppSettings> | null;
        try {
          parsed = JSON.parse(str(args, "json")) as Partial<AppSettings> | null;
        } catch (e) {
          return fail(`配置文件不是合法的 JSON: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!parsed || typeof parsed !== "object") fail("配置文件内容不是对象");
        // 缺失的分组沿用当前设置，和后端导入时“按字段回落到默认值”的效果一致
        const saved = apply({
          ...settings,
          ...parsed,
          network: { ...settings.network, ...parsed.network },
          protocol: { ...settings.protocol, ...parsed.protocol },
          display: { ...settings.display, ...parsed.display },
          merge: { ...settings.merge, ...parsed.merge },
          recording: { ...settings.recording, ...parsed.recording },
          player: { ...settings.player, ...parsed.player },
          update: { ...settings.update, ...parsed.update },
        });
        world.log("info", "已导入配置文件");
        return saved;
      },

      export_settings: () => JSON.stringify(settings, null, 2),

      list_network_interfaces: () => world.data.network,

      get_recording_dir: () => world.hooks.recordingDir(),

      recording_check_dir: (args: CommandArgs): DirCheck => {
        const asked = typeof args.path === "string" ? args.path.trim() : "";
        const current = world.hooks.recordingDir();
        const path = asked || current;
        // 当前生效的目录一定存在且可写，剩余空间取实时值
        if (path === current) {
          return {
            path,
            exists: true,
            isDir: true,
            writable: true,
            disk: diskInfoOf(path, world.hooks.currentDiskFree()),
          };
        }
        const check = world.data.app.dirChecks[path] ?? world.data.app.unknownDirCheck;
        return {
          path,
          exists: check.exists,
          isDir: check.isDir,
          writable: check.writable,
          disk: diskInfoOf(path, check.freeBytes),
        };
      },

      recording_open_dir: (args: CommandArgs) => {
        const asked = typeof args.path === "string" ? args.path.trim() : "";
        world.log("info", `在文件管理器中打开: ${asked || world.hooks.recordingDir()}`);
      },
    },
  };
}
