import type {
  EditProgressEvent,
  EditRequest,
  EditResult,
} from "@/features/recording/lib/types";
import { EDIT_PROGRESS_EVENT } from "@/features/recording/lib/types";
import { defaultHeader, type Library, type ProgramRecord } from "./library";
import { forgetOverview } from "./overview";
import { fail, sleep, str, type CommandArgs, type CommandHandler, type World } from "./world";

/** 模拟编辑导出的进度步数与每步耗时（毫秒）。 */
const EDIT_STEPS = 6;
const EDIT_STEP_MS = 120;

/** 时间片段 `[开始, 结束)`（秒）。 */
type Span = readonly [number, number];

/**
 * 规整保留片段（与后端 `normalize_segments` 一致）：裁剪到 `[0, duration]`、丢弃空片段、
 * 排序并合并重叠或首尾相接的片段。
 *
 * # Arguments
 *
 * * `spans` - 原始片段（秒）。
 * * `duration` - 节目总时长（秒）。
 *
 * # Returns
 *
 * 升序、互不重叠的片段。
 */
export function normalizeSpans(spans: readonly Span[], duration: number): Span[] {
  const v = spans
    .map(([a, b]) => [Math.min(a, duration), Math.min(b, duration)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: [number, number][] = [];
  for (const [a, b] of v) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * 把"节目时间上的片段"换算成"图案时间上的片段"：节目本身若已是编辑导出的结果（带 `timeMap`），
 * 一个片段可能横跨多段图案时间，会被拆开。
 *
 * # Arguments
 *
 * * `map` - 源节目的时间映射；省略表示节目时间即图案时间。
 * * `spans` - 节目时间上的保留片段（已规整，秒）。
 *
 * # Returns
 *
 * 新节目的时间映射。
 */
export function composeTimeMap(map: readonly Span[] | undefined, spans: readonly Span[]): Span[] {
  if (!map || map.length === 0) return spans.map(([a, b]) => [a, b] as const);
  const out: Span[] = [];
  for (const [a, b] of spans) {
    let acc = 0;
    for (const [sa, sb] of map) {
      const len = sb - sa;
      const lo = Math.max(a, acc);
      const hi = Math.min(b, acc + len);
      if (hi > lo) out.push([sa + (lo - acc), sa + (hi - acc)]);
      acc += len;
    }
  }
  return out;
}

/** 改写工程 JSON 里的一个顶层字符串字段；不是合法 JSON 对象时原样返回。 */
function patchShow(json: string | undefined, key: string, value: string): string | undefined {
  if (json === undefined) return undefined;
  try {
    const obj = JSON.parse(json) as unknown;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return json;
    return JSON.stringify({ ...(obj as Record<string, unknown>), [key]: value });
  } catch {
    return json;
  }
}

/**
 * 节目库页面用到的维护命令：修改备注、创建副本、编辑导出（带进度事件与取消）。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 * * `library` - 节目库。
 *
 * # Returns
 *
 * 命令表（与后端同名）。
 */
export function createLibraryOpsCommands(world: World, library: Library): Record<string, CommandHandler> {
  const jobs = new Map<string, { cancelled: boolean }>();

  const recordOf = (path: string): ProgramRecord => {
    const rec = library.find(path);
    if (!rec) fail("not_found");
    return rec;
  };

  return {
    recordings_set_notes: (args: CommandArgs) => {
      const rec = recordOf(str(args, "path"));
      const notes = str(args, "notes");
      rec.entry = { ...rec.entry, notes };
      rec.show = patchShow(rec.show, "notes", notes);
    },

    recordings_duplicate: (args: CommandArgs) => {
      const rec = recordOf(str(args, "path"));
      const name = str(args, "newName").trim() || "copy";
      const { path, fileName } = library.uniquePath(name);
      library.add({
        ...rec,
        entry: { ...rec.entry, path, fileName, name, recovered: false, modifiedUnixMs: Date.now() },
        show: patchShow(rec.show, "name", name),
      });
      world.log("info", `已创建副本: ${fileName}`);
      return path;
    },

    recordings_edit: async (args: CommandArgs): Promise<EditResult> => {
      const req = args.req as EditRequest | undefined;
      if (!req) fail("invalid_args");
      const rec = recordOf(req.path);
      if (!rec.entry.exported) fail("not_found");
      if (!rec.entry.valid) fail("文件头损坏，无法解析节目");
      if (req.output.kind === "replace" && rec.entry.editable) fail("editable_replace");

      const spans = normalizeSpans(
        req.segments.map((s) => [s.startUs / 1_000_000, s.endUs / 1_000_000] as const),
        rec.durationSec,
      );
      const kept = rec.entry.universes.filter((u) => req.universes === null || req.universes.includes(u));
      if (spans.length === 0 || kept.length === 0) fail("empty_edit");

      const job = { cancelled: false };
      jobs.set(req.jobId, job);
      try {
        for (let step = 1; step <= EDIT_STEPS; step += 1) {
          await sleep(EDIT_STEP_MS);
          if (job.cancelled) fail("cancelled");
          const ev: EditProgressEvent = { jobId: req.jobId, progress: step / EDIT_STEPS };
          world.bus.emit(EDIT_PROGRESS_EVENT, ev);
        }
      } finally {
        jobs.delete(req.jobId);
      }

      const totalSec = spans.reduce((n, [a, b]) => n + (b - a), 0);
      const share = (totalSec / Math.max(rec.durationSec, 1e-9)) * (kept.length / rec.entry.universes.length);
      const frames = Math.max(2, Math.round(rec.entry.frames * share));
      const bytes = Math.round(Math.max(0, rec.entry.bytes - 2048) * share) + 2048;
      const durationUs = Math.round(totalSec * 1_000_000);
      const next: Omit<ProgramRecord, "entry"> = {
        universes: rec.universes.filter((u) => kept.includes(u.universe)),
        durationSec: totalSec,
        corruptFrames: 0,
        timeMap: composeTimeMap(rec.timeMap, spans),
      };
      const entryBase = {
        ...rec.entry,
        durationUs,
        frames,
        bytes,
        universes: kept,
        modifiedUnixMs: Date.now(),
        recovered: false,
        valid: true,
        editable: false,
        exported: true,
        header: { ...defaultHeader(frames), loopFlag: rec.entry.header?.loopFlag ?? false },
      };

      if (req.output.kind === "new") {
        const name = req.output.name.trim() || rec.entry.name;
        const { path, fileName } = library.uniquePath(name);
        library.add({ ...next, entry: { ...entryBase, path, fileName, name } });
        world.log("info", `编辑导出完成: ${fileName}`);
        return { path, durationUs, frames, bytes, universes: kept };
      }
      Object.assign(rec, next);
      rec.entry = entryBase;
      forgetOverview(rec.entry.path);
      world.log("info", `已替换节目: ${rec.entry.fileName}`);
      return { path: rec.entry.path, durationUs, frames, bytes, universes: kept };
    },

    recordings_edit_cancel: (args: CommandArgs) => {
      const job = jobs.get(str(args, "jobId"));
      if (job) job.cancelled = true;
    },
  };
}
