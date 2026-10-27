// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EditRequest, EditResult, LibraryEntry, OverviewDto } from "@/features/recording/lib/types";
import { loadDemoData } from "../../data";
import { EventBus } from "../../lib/eventBus";
import { createStreamHub } from "../../lib/streamHub";
import { createLibrary, sourceTimeSec } from "../library";
import { composeTimeMap, createLibraryOpsCommands, normalizeSpans } from "../libraryOps";
import { buildOverview } from "../overview";
import type { World } from "../world";

function makeWorld(): World {
  const data = loadDemoData();
  return {
    bus: new EventBus(),
    stream: createStreamHub(),
    data,
    mode: { mode: "live", receivers: "bound", sender: "ready" },
    elapsedMs: () => 0,
    uptimeMs: () => 0,
    log: () => undefined,
    hooks: {
      isRecording: () => false,
      playerLoaded: () => false,
      showOutputting: () => false,
      closePlayer: () => undefined,
      enterPlayerMode: () => undefined,
      settings: () => data.settings,
      recordingDir: () => "D:\\rec",
      currentDiskFree: () => 0,
      programMoved: () => undefined,
    },
  };
}

function setup() {
  const world = makeWorld();
  const library = createLibrary(world.data.recordings.programs, "D:\\rec");
  const cmds = createLibraryOpsCommands(world, library);
  const first = library.all().find((r) => r.entry.valid && r.universes.length > 1)!;
  return { world, library, cmds, first };
}

/** 运行一个带进度的编辑导出（推进假时钟直到完成）。 */
async function runEdit(cmds: ReturnType<typeof setup>["cmds"], req: EditRequest): Promise<EditResult> {
  // 先挂上结果处理，避免推进时钟期间的拒绝被当成未处理的错误
  const settled = Promise.allSettled([cmds.recordings_edit({ req }) as Promise<EditResult>]);
  await vi.runAllTimersAsync();
  const [r] = await settled;
  if (r.status === "rejected") throw r.reason;
  return r.value;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("演示节目库维护命令", () => {
  it("规整片段与时间映射的组合", () => {
    expect(normalizeSpans([[5, 9], [0, 1], [0.5, 2], [9.5, 20], [3, 3]], 10)).toEqual([[0, 2], [5, 9], [9.5, 10]]);
    // 先保留 [10,20) + [30,40)，再从结果里截取 [5,15)：横跨两段
    expect(composeTimeMap([[10, 20], [30, 40]], [[5, 15]])).toEqual([[15, 20], [30, 35]]);
    expect(sourceTimeSec({ timeMap: [[10, 20], [30, 40]] }, 12)).toBe(32);
    expect(sourceTimeSec({}, 12)).toBe(12);
  });

  it("修改备注并复制节目，副本重名时自动编号", () => {
    const { library, cmds, first } = setup();
    cmds.recordings_set_notes({ path: first.entry.path, notes: "新备注" });
    expect(library.find(first.entry.path)?.entry.notes).toBe("新备注");

    const a = cmds.recordings_duplicate({ path: first.entry.path, newName: "副本" }) as string;
    const b = cmds.recordings_duplicate({ path: first.entry.path, newName: "副本" }) as string;
    expect(a.endsWith("\\副本.artrec")).toBe(true);
    expect(b.endsWith("\\副本-2.artrec")).toBe(true);
    expect(library.find(b)?.entry.notes).toBe("新备注");
  });

  it("编辑导出另存：时长、Universe 与概览随之变化，并推送进度", async () => {
    const { world, library, cmds, first } = setup();
    const progress: number[] = [];
    world.bus.on("recordings:edit", (e) => progress.push((e as { progress: number }).progress));
    const keepU = first.entry.universes[0];
    const res = await runEdit(cmds, {
      path: first.entry.path,
      jobId: "j1",
      segments: [{ startUs: 0, endUs: 2_000_000 }, { startUs: 4_000_000, endUs: 5_000_000 }],
      universes: [keepU],
      output: { kind: "new", name: "裁剪" },
    });
    expect(res.durationUs).toBe(3_000_000);
    expect(res.universes).toEqual([keepU]);
    expect(progress.at(-1)).toBe(1);
    const rec = library.find(res.path)!;
    const entry: LibraryEntry = rec.entry;
    expect(entry.name).toBe("裁剪");
    expect(entry.editable).toBe(false);
    const ov: OverviewDto = buildOverview(rec);
    expect(ov.universes).toEqual([keepU]);
    expect(ov.durationUs).toBe(3_000_000);
    // 原节目不变
    expect(library.find(first.entry.path)?.entry.durationUs).toBe(first.entry.durationUs);
  });

  it("替换原节目；空结果与取消给出错误码", async () => {
    const { library, cmds, first } = setup();
    const path = first.entry.path;
    await runEdit(cmds, { path, jobId: "j", segments: [{ startUs: 0, endUs: 1_000_000 }], universes: null, output: { kind: "replace" } });
    expect(library.find(path)?.entry.durationUs).toBe(1_000_000);

    await expect(runEdit(cmds, { path, jobId: "e", segments: [], universes: null, output: { kind: "replace" } })).rejects.toBe("empty_edit");

    const p = cmds.recordings_edit({
      req: { path, jobId: "c", segments: [{ startUs: 0, endUs: 500_000 }], universes: null, output: { kind: "new", name: "x" } },
    }) as Promise<EditResult>;
    const settled = p.catch((e: unknown) => e);
    cmds.recordings_edit_cancel({ jobId: "c" });
    await vi.runAllTimersAsync();
    expect(await settled).toBe("cancelled");
  });
});
