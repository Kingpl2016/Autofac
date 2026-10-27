import type {
  ActivityDto,
  FinishedFile,
  LibraryEntry,
  RecordFilter,
  RecordingResult,
  RecordingStartArgs,
  RecordingStartResult,
  RecordingStatus,
  RecoveryOutcome,
} from "@/features/recording/lib/types";
import { EMPTY_STATUS } from "@/features/recording/lib/types";
import { renderSegments, toSegments, type Segment, type UniverseProgram } from "../lib/patterns";
import type { LiveUniverseSeed } from "../types";
import { createDemoActivity, type DemoActivity } from "./activity";
import { diskInfoOf, diskLevelOf } from "./disk";
import { createLibrary, defaultHeader, sanitizeFileStem, type Library } from "./library";
import { createLibraryOpsCommands } from "./libraryOps";
import type { LiveEngine } from "./live";
import {
  createGate,
  fail,
  str,
  type CommandArgs,
  type DemoModule,
  type World,
} from "./world";

/** 15 位 Port-Address 的上限。 */
const MAX_UNIVERSE = 32767;
/** 单次录制最多接受的 Universe 数（与后端容量一致）。 */
const MAX_UNIVERSES_PER_RECORDING = 90;
/** 录制时只有变化的帧才落盘，其余是重复帧。 */
const FRAME_KEEP_RATIO = 0.35;
/** 每多少个有效帧写一个完整帧（其余为差分帧）。 */
const FULL_FRAME_EVERY = 22;
/** 完整帧 / 差分帧压缩后的平均字节数。 */
const FULL_FRAME_BYTES = 540;
const DIFF_FRAME_BYTES = 72;
/** 录制进行中，统计事件的推送间隔。 */
const STATS_EVERY_MS = 250;

/** 进行中的录制会话。 */
interface Session {
  name: string;
  notes: string;
  path: string;
  /** 开始时的 `elapsedMs`。 */
  startedAtMs: number;
  accepted: number[];
  /** 录制到的各 Universe 图案（取自开始那一刻的实时信号）。 */
  programs: UniverseProgram[];
  sources: string[];
  acceptedPackets: number;
  filteredPackets: number;
  ignoredPackets: number;
  frames: number;
  bytes: number;
  dropped: number;
  /** 活动时间线（与后端一样只在内存里统计）。 */
  activity: DemoActivity;
  /** 各 Universe 的分段图案（与 `accepted` 同序；没有图案的 Universe 为 null，输出全 0）。 */
  segments: (Segment[] | null)[];
  /** 上一次采样活动的会话时间（微秒）。 */
  lastSampleUs: number;
  /** 自动分段长度（微秒）；0 表示不分段。取自开始录制时的设置。 */
  splitUs: number;
}

/** 活动时间线的采样间隔（微秒，与后端录制节拍相近）。 */
const ACTIVITY_SAMPLE_US = 22_000;

/** 空的活动时间线（从未录制过）。 */
const EMPTY_ACTIVITY: ActivityDto = {
  generation: 0,
  bucketUs: 250_000,
  len: 0,
  from: 0,
  universes: [],
  change: [],
  level: [],
  partStartsUs: [],
};

/** 录制模块：除命令外，对外暴露节目库与录制状态。 */
export interface RecordingModule extends DemoModule {
  library: Library;
  isRecording(): boolean;
}

/**
 * 判断一个实时 Universe 是否通过录制过滤条件（来源 / Universe 范围 / 协议，三类取交集）。
 *
 * # Arguments
 *
 * * `u` - 实时 Universe。
 * * `f` - 录制过滤条件；空数组表示该维度不限制。
 *
 * # Returns
 *
 * 通过过滤返回 `true`。
 */
function passesFilter(u: LiveUniverseSeed, f: RecordFilter): boolean {
  if (f.protocols.length > 0 && !f.protocols.includes(u.protocol)) return false;
  if (f.universes.length > 0 && !f.universes.some((r) => u.universe >= r.start && u.universe <= r.end)) {
    return false;
  }
  if (f.sources.length > 0) {
    const listed = u.sources.filter((s) => f.sources.includes(s.ip)).length;
    // 白名单：至少有一个来源在名单内；黑名单：不能所有来源都在名单内
    if (f.excludeSources ? listed === u.sources.length : listed === 0) return false;
  }
  return true;
}

/**
 * 创建录制模块：模拟录制会话的实时统计、停止后生成新节目，以及节目库的增删改。
 *
 * 磁盘剩余空间随录制写入量减少；空间降到阈值以下会推送 `recording:disk`，
 * 临界时自动停止录制（`stoppedBy: "disk"`）。刷新页面后节目库还原为数据文件里的初始内容。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 * * `live` - 实时信号引擎，录制的就是它此刻的信号。
 *
 * # Returns
 *
 * 录制模块。
 */
export function createRecordingModule(world: World, live: LiveEngine): RecordingModule {
  const library = createLibrary(world.data.recordings.programs, world.data.app.recordingDir);
  let session: Session | null = null;
  let diskFree = world.data.app.disk.freeBytes;
  let lastDiskLevel = diskLevelOf(diskFree);
  let recovered: RecoveryOutcome[] | null = buildRecovered(world, library);
  const statsGate = createGate(STATS_EVERY_MS);
  /** 最近一次录制的活动时间线（停止后保留到下次开始，与后端一致）。 */
  let lastActivity: DemoActivity | null = null;

  /** 会话时间轴上的各分段起点（第一段为 0）。 */
  const partStartsOf = (s: Session, sessionUs: number): number[] => {
    const starts = [0];
    if (s.splitUs > 0) {
      for (let t = s.splitUs; t <= sessionUs; t += s.splitUs) starts.push(t);
    }
    return starts;
  };

  const statusOf = (s: Session, nowMs: number): RecordingStatus => {
    const fullFrames = Math.floor(s.frames / FULL_FRAME_EVERY);
    const sessionElapsedUs = Math.round((nowMs - s.startedAtMs) * 1000);
    const partStartsUs = partStartsOf(s, sessionElapsedUs);
    const elapsedUs = sessionElapsedUs - partStartsUs[partStartsUs.length - 1];
    return {
      recording: true,
      name: s.name,
      path: s.path,
      part: partStartsUs.length,
      elapsedUs,
      sessionElapsedUs,
      partStartsUs,
      stats: {
        frames: Math.round(s.frames),
        fullFrames,
        diffFrames: Math.max(0, Math.round(s.frames) - fullFrames),
        bytes: Math.round(s.bytes),
        durationUs: elapsedUs,
        acceptedPackets: Math.round(s.acceptedPackets),
        filteredPackets: Math.round(s.filteredPackets),
        ignoredPackets: Math.round(s.ignoredPackets),
        ignoredUniverses: Math.max(0, live.active().length - s.accepted.length),
        maxChain: 17,
      },
      dropped: s.dropped,
      universes: s.accepted,
      diskFreeBytes: Math.round(diskFree),
      diskLevel: diskLevelOf(diskFree),
    };
  };

  /** 按采样间隔把当前图案喂给活动时间线，跨过分段边界时记录分段起点。 */
  const sampleActivity = (s: Session, nowMs: number) => {
    const sessionUs = Math.round((nowMs - s.startedAtMs) * 1000);
    if (sessionUs - s.lastSampleUs < ACTIVITY_SAMPLE_US) return;
    s.lastSampleUs = sessionUs;
    // 图案按世界时间取值，与实时信号保持一致
    const tSec = nowMs / 1000;
    const snaps = s.segments.map((segs) => (segs ? renderSegments(segs, tSec) : []));
    for (const start of partStartsOf(s, sessionUs).slice(1)) s.activity.markPart(start);
    s.activity.observe(sessionUs, snaps);
  };

  /** `recording:stats` 载荷：状态 + 活动增量。 */
  const statsEventOf = (s: Session, nowMs: number) => {
    const status = statusOf(s, nowMs);
    s.activity.advanceTo(status.sessionElapsedUs);
    return { ...status, activity: s.activity.takeDelta() };
  };

  const idleStatus = (): RecordingStatus => ({
    ...EMPTY_STATUS,
    diskFreeBytes: Math.round(diskFree),
    diskLevel: diskLevelOf(diskFree),
  });

  /** 结束当前会话：落成节目库里的新节目，并推送完成事件。 */
  const finish = (stoppedBy: "disk" | null): RecordingResult => {
    const s = session;
    if (!s) fail("not_recording");
    session = null;
    const nowMs = world.elapsedMs();
    const durationUs = Math.round((nowMs - s.startedAtMs) * 1000);
    const frames = Math.round(s.frames);
    const files: FinishedFile[] = [];

    // 极短（不到半秒）的录制没有可保存的内容，与真实后端一致地返回空文件列表
    if (durationUs >= 500_000 && frames > 0) {
      const bytes = Math.round(s.bytes) + 2048;
      const fileName = s.path.slice(s.path.lastIndexOf("\\") + 1);
      const entry: LibraryEntry = {
        path: s.path,
        fileName,
        name: s.name,
        notes: s.notes,
        bytes,
        modifiedUnixMs: Date.now(),
        durationUs,
        frames,
        universes: s.accepted,
        sources: s.sources,
        recovered: false,
        valid: true,
        editable: false,
        exported: true,
        header: defaultHeader(frames),
      };
      library.add({
        entry,
        universes: s.programs,
        durationSec: durationUs / 1_000_000,
        corruptFrames: 0,
      });
      files.push({ path: s.path, durationUs, frames, bytes, sources: s.sources });
    }

    const result: RecordingResult = { files, error: null, dropped: s.dropped, stoppedBy };
    world.bus.emit("recording:stats", idleStatus());
    world.bus.emit("recording:finished", result);
    world.log(
      stoppedBy === "disk" ? "error" : "info",
      stoppedBy === "disk"
        ? `磁盘空间告急,录制已自动停止: ${s.name}`
        : `录制完成: ${s.name} (${files.length} 个文件, ${frames} 帧)`,
    );
    return result;
  };

  world.hooks.isRecording = () => session !== null;
  world.hooks.currentDiskFree = () => diskFree;

  return {
    library,
    isRecording: () => session !== null,

    commands: {
      recording_start: (args: CommandArgs): RecordingStartResult => {
        const a = args.args as RecordingStartArgs | undefined;
        if (!a) fail("invalid_args");
        if (session) fail("already_recording");
        if (world.hooks.showOutputting()) fail("show_active");
        if (world.mode.mode === "player" || world.hooks.playerLoaded()) fail("playback_active");
        if (!diskInfoOf("", diskFree).canStart) fail("disk_low");

        const liveSeeds = live.active();
        const fromLive = liveSeeds.filter((u) => passesFilter(u, a.filter)).map((u) => u.universe);
        const extras = [...new Set(a.universes)];
        const rejectedOutOfRange = extras.filter((u) => u < 0 || u > MAX_UNIVERSE);
        const merged = [...new Set([...fromLive, ...extras.filter((u) => u >= 0 && u <= MAX_UNIVERSE)])].sort(
          (x, y) => x - y,
        );
        const accepted = merged.slice(0, MAX_UNIVERSES_PER_RECORDING);
        const rejectedOverCapacity = merged.slice(MAX_UNIVERSES_PER_RECORDING);
        if (accepted.length === 0) fail("no_universes");

        const stem = sanitizeFileStem(a.fileStem) || `rec-${Date.now()}`;
        const path = `${world.hooks.recordingDir()}\\${stem}.artrec`;
        const sources = new Set<string>();
        const programs: UniverseProgram[] = [];
        for (const u of liveSeeds) {
          if (!accepted.includes(u.universe)) continue;
          u.sources.forEach((s) => sources.add(s.ip));
          programs.push({ universe: u.universe, ...u.program });
        }

        const programOf = new Map(programs.map((p) => [p.universe, p]));
        const activity = createDemoActivity(accepted);
        lastActivity = activity;
        session = {
          activity,
          segments: accepted.map((u) => {
            const p = programOf.get(u);
            return p ? toSegments(p) : null;
          }),
          lastSampleUs: -ACTIVITY_SAMPLE_US,
          splitUs: Math.max(0, world.hooks.settings().recording.splitMinutes) * 60_000_000,
          name: a.name.trim() || stem,
          notes: a.notes.trim(),
          path,
          startedAtMs: world.elapsedMs(),
          accepted,
          programs,
          sources: [...sources].sort((x, y) => x.localeCompare(y, undefined, { numeric: true })),
          acceptedPackets: 0,
          filteredPackets: 0,
          ignoredPackets: 0,
          frames: 0,
          bytes: 0,
          dropped: 0,
        };
        world.log("info", `录制开始: ${session.name} (${accepted.length} 个 Universe)`);
        sampleActivity(session, world.elapsedMs());
        world.bus.emit("recording:stats", statsEventOf(session, world.elapsedMs()));
        return { path, plan: { accepted, rejectedOutOfRange, rejectedOverCapacity } };
      },

      recording_stop: () => finish(null),

      recording_status: () => (session ? statusOf(session, world.elapsedMs()) : idleStatus()),

      recording_activity: (): ActivityDto => lastActivity?.snapshot() ?? EMPTY_ACTIVITY,

      recording_disk_info: (args: CommandArgs) => {
        const asked = typeof args.path === "string" ? args.path.trim() : "";
        const current = world.hooks.recordingDir();
        const dir = asked || current;
        // 当前录制目录用实时的剩余空间；其它路径取数据文件里登记的值
        const free =
          dir === current
            ? diskFree
            : (world.data.app.dirChecks[dir] ?? world.data.app.unknownDirCheck).freeBytes;
        return diskInfoOf(dir, free);
      },

      recordings_list: () => library.all().map((r) => r.entry),

      recordings_rename: (args: CommandArgs) => {
        const path = str(args, "path");
        const newPath = library.rename(path, str(args, "newName"));
        world.hooks.programMoved(path, newPath);
        return newPath;
      },

      recordings_delete: (args: CommandArgs) => {
        const path = str(args, "path");
        if (!library.remove(path)) fail("not_found");
        world.hooks.programMoved(path, null);
        world.log("info", `已删除节目: ${path}`);
      },

      ...createLibraryOpsCommands(world, library),

      recording_take_recovered: () => {
        const out = recovered ?? [];
        recovered = null;
        return out;
      },
    },

    tick: ({ dtMs, elapsedMs }) => {
      if (!session) return;
      const dt = dtMs / 1000;
      const active = live.active();
      let bytesDelta = 0;

      for (const u of active) {
        const packets = live.rateOf(u.universe) * dt;
        if (session.accepted.includes(u.universe)) {
          session.acceptedPackets += packets;
          const frames = packets * FRAME_KEEP_RATIO;
          session.frames += frames;
          // 按 1/FULL_FRAME_EVERY 的比例折算完整帧与差分帧的体积
          bytesDelta +=
            frames * ((FULL_FRAME_BYTES + (FULL_FRAME_EVERY - 1) * DIFF_FRAME_BYTES) / FULL_FRAME_EVERY);
        } else {
          session.filteredPackets += packets;
        }
      }
      // 少量不属于任何已知 Universe 的杂包
      session.ignoredPackets += 1.5 * dt;
      session.bytes += bytesDelta;
      diskFree -= bytesDelta;

      const level = diskLevelOf(diskFree);
      if (level !== lastDiskLevel) {
        lastDiskLevel = level;
        world.bus.emit("recording:disk", { level, freeBytes: Math.round(diskFree) });
        if (level === "critical") {
          finish("disk");
          return;
        }
      }

      sampleActivity(session, elapsedMs);
      if (statsGate(elapsedMs).fire) world.bus.emit("recording:stats", statsEventOf(session, elapsedMs));
    },
  };
}

/**
 * 把启动时“恢复出”的录制转成前端要的结果列表，并为成功恢复的那一项确认节目库里确有对应条目。
 *
 * # Arguments
 *
 * * `world` - 共享的演示世界。
 * * `library` - 节目库。
 *
 * # Returns
 *
 * 恢复结果列表。
 */
function buildRecovered(world: World, library: Library): RecoveryOutcome[] {
  return world.data.app.recovered.map((r): RecoveryOutcome => {
    if (r.kind === "failed") return { kind: "failed", part: r.part, reason: r.reason };
    const known = library.all().find((p) => p.entry.fileName === r.fileName);
    return {
      kind: "recovered",
      path: known?.entry.path ?? `${world.data.app.recordingDir}\\${r.fileName}`,
      frames: r.frames,
      durationUs: r.durationSec * 1_000_000,
    };
  });
}
