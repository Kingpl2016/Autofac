import type { LibraryEntry } from "@/features/recording/lib/types";
import { sanitizeFileStem, type Library } from "./library";
import { fail, str, type DemoModule, type World } from "./world";

/** 演示里“烘焙”耗时（毫秒）。 */
const BAKE_MS = 600;

/** 工程 JSON 的大小上限（与真实后端一致）。 */
const MAX_PROJECT_BYTES = 64 * 1024 * 1024;

/**
 * 校验工程内容：不能太大，且必须是合法 JSON。
 *
 * # Arguments
 *
 * * `json` - 工程文本。
 */
function checkJson(json: string): void {
  if (json.length > MAX_PROJECT_BYTES) fail("project_too_large");
  try {
    JSON.parse(json);
  } catch {
    fail("invalid_project");
  }
}

/**
 * 创建节目编辑器的工程存取模块：保存进（内存里的）节目库、打开、库外另存为 / 读取、自动存档。
 *
 * 行为与真实后端一致：首次保存只有工程、没有 `.artrec`（条目 `editable` 但未导出），
 * 重名自动追加 `-2`、`-3`，库外文件必须是 `.artshow`，覆盖保存沿用原路径。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 * * `library` - 演示节目库。
 *
 * # Returns
 *
 * 工程存取模块（只有命令，没有周期驱动）。
 */
export function createShowModule(world: World, library: Library): DemoModule {
  /** 库外的 `.artshow` 文件（演示里不碰真实磁盘）。 */
  const external = new Map<string, string>();
  let autosave: string | null = null;

  /**
   * 模拟保存后的后台烘焙：有灯具和时长就在片刻后把条目变成“已导出”，否则报告没有可烘焙的内容。
   *
   * # Arguments
   *
   * * `path` - 节目的 `.artrec` 路径。
   */
  const simulateBake = (path: string) => {
    const rec = library.find(path);
    if (!rec?.show) return;
    const event = (status: string, extra: Record<string, unknown> = {}) =>
      world.bus.emit("show:bake", { path, status, progress: 0, frames: null, bytes: null, reason: null, ...extra });
    let project: { durationMs?: number; fixtures?: { universe: number }[] };
    try {
      project = JSON.parse(rec.show) as typeof project;
    } catch {
      return event("failed", { reason: "invalid_project" });
    }
    const universes = [...new Set((project.fixtures ?? []).map((f) => f.universe))].sort((a, b) => a - b);
    const durationMs = project.durationMs ?? 0;
    if (universes.length === 0 || durationMs <= 0) return event("skipped", { reason: "nothing_to_bake" });
    event("running");
    window.setTimeout(() => {
      const current = library.find(path);
      if (!current) return;
      const frames = Math.max(2, Math.round(durationMs / 1000) * 3);
      current.universes = universes.map((universe) => ({ universe, pattern: "static", level: 200 }));
      current.durationSec = durationMs / 1000;
      current.entry = {
        ...current.entry,
        valid: true,
        exported: true,
        frames,
        durationUs: durationMs * 1000,
        universes,
        bytes: frames * 64,
      };
      event("done", { progress: 1, frames, bytes: frames * 64 });
    }, BAKE_MS);
  };

  const uniqueFileName = (stem: string): string => {
    const taken = (name: string) => library.all().some((r) => r.entry.fileName === name);
    if (!taken(`${stem}.artrec`)) return `${stem}.artrec`;
    for (let n = 2; ; n += 1) {
      if (!taken(`${stem}-${n}.artrec`)) return `${stem}-${n}.artrec`;
    }
  };

  return {
    commands: {
      show_project_save: (args) => {
        const a = args.args as { path?: string; name: string; notes?: string; fileStem?: string; json: string };
        checkJson(a.json);
        const now = Date.now();
        if (a.path) {
          const rec = library.find(a.path);
          if (!rec) return fail("not_found");
          rec.show = a.json;
          rec.entry = { ...rec.entry, name: a.name.trim(), notes: a.notes ?? "", modifiedUnixMs: now, editable: true };
          simulateBake(rec.entry.path);
          return rec.entry.path;
        }
        const stem = sanitizeFileStem(a.fileStem?.trim() ? a.fileStem : a.name) || "show";
        const fileName = uniqueFileName(stem);
        const entry: LibraryEntry = {
          path: `${world.hooks.recordingDir()}\\${fileName}`,
          fileName,
          name: a.name.trim(),
          notes: a.notes ?? "",
          bytes: a.json.length,
          modifiedUnixMs: now,
          durationUs: 0,
          frames: 0,
          universes: [],
          sources: [],
          recovered: false,
          valid: false,
          editable: true,
          exported: false,
        };
        library.add({ entry, universes: [], durationSec: 0, corruptFrames: 0, show: a.json });
        world.log("info", `演示模式：工程已保存到节目库 ${fileName}`);
        simulateBake(entry.path);
        return entry.path;
      },

      show_project_open: (args) => {
        const rec = library.find(str(args, "path"));
        if (!rec?.show) return fail("not_found");
        return rec.show;
      },

      show_external_save: (args) => {
        const path = str(args, "path");
        if (!path.toLowerCase().endsWith(".artshow")) return fail("bad_path");
        const json = str(args, "json");
        checkJson(json);
        external.set(path, json);
        return undefined;
      },

      show_external_read: (args) => {
        const path = str(args, "path");
        if (!path.toLowerCase().endsWith(".artshow")) return fail("bad_path");
        const json = external.get(path);
        return json ?? fail("not_found");
      },

      show_autosave_write: (args) => {
        const json = str(args, "json");
        checkJson(json);
        autosave = json;
        return undefined;
      },
      show_autosave_read: () => autosave,
      show_autosave_clear: () => {
        autosave = null;
        return undefined;
      },
    },
  };
}
