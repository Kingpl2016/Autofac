import type { HeaderInfo, LibraryEntry } from "@/features/recording/lib/types";
import { hash01, hashText } from "../lib/random";
import type { UniverseProgram } from "../lib/patterns";
import type { ProgramSeed } from "../types";
import { fail } from "./world";

/** 节目库里的一个节目：列表信息 + 生成画面所需的图案描述。 */
export interface ProgramRecord {
  entry: LibraryEntry;
  universes: UniverseProgram[];
  durationSec: number;
  /** 回放时会报告的损坏帧数。 */
  corruptFrames: number;
  /** 节目编辑器保存的工程 JSON（只有编辑器节目才有）。 */
  show?: string;
  /**
   * 编辑导出得到的节目：节目时间到图案时间的映射，按顺序列出保留的图案时间片段
   * `[开始秒, 结束秒)`，节目时间依次落在这些片段上。省略表示节目时间就是图案时间。
   */
  timeMap?: readonly (readonly [number, number])[];
}

/**
 * 把节目时间换算成图案时间（编辑导出的节目经 `timeMap` 映射，其余原样返回）。
 *
 * # Arguments
 *
 * * `record` - 节目记录。
 * * `tSec` - 节目时间（秒）。
 *
 * # Returns
 *
 * 用于 `renderSegments` 取值的图案时间（秒）；超出最后一个片段时停在其末尾。
 */
export function sourceTimeSec(record: Pick<ProgramRecord, "timeMap">, tSec: number): number {
  const map = record.timeMap;
  if (!map || map.length === 0) return tSec;
  let acc = 0;
  for (const [a, b] of map) {
    const len = b - a;
    if (tSec < acc + len) return a + Math.max(0, tSec - acc);
    acc += len;
  }
  return map[map.length - 1][1];
}

/** 内存里的节目库（`.artrec` 文件列表）。 */
export interface Library {
  /** 全部节目，按修改时间从新到旧。 */
  all(): ProgramRecord[];
  /** 按路径查找。 */
  find(path: string): ProgramRecord | undefined;
  /** 加入一个节目。 */
  add(record: ProgramRecord): void;
  /** 删除；找不到返回 `false`。 */
  remove(path: string): boolean;
  /** 重命名并返回新路径；重名时以 `already_exists` 失败。 */
  rename(path: string, newName: string): string;
  /** 列表里紧随其后的有效节目（连播用）。 */
  nextValidAfter(path: string): ProgramRecord | undefined;
  /**
   * 为新节目挑选不冲突的路径与文件名（与后端 `unique_entry_path` 一致：重名时追加 `-2`、`-3`…）。
   */
  uniquePath(name: string): { path: string; fileName: string };
}

/** 平均每个 Universe 每秒产生的有效帧占比（其余为重复帧，被差分压缩掉）。 */
const FRAME_KEEP_RATIO = 0.35;

/**
 * 去掉文件名里 Windows 不允许的字符。
 *
 * # Arguments
 *
 * * `name` - 用户输入的名称。
 *
 * # Returns
 *
 * 可作文件名的字符串（不含扩展名）。
 */
export function sanitizeFileStem(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "-").trim();
}

/**
 * 本程序录出的节目的默认文件头信息（v1.0、Zstd L3、无标志、索引在尾部）。
 *
 * # Arguments
 *
 * * `frames` - 帧数；为 0 时带上 `emptyProgram` 问题。
 *
 * # Returns
 *
 * 文件头派生信息。
 */
export function defaultHeader(frames: number): HeaderInfo {
  return {
    verMajor: 1,
    verMinor: 0,
    compression: "zstd",
    compressLevel: 3,
    loopFlag: false,
    diffFrames: false,
    frameIndexAtTail: true,
    issues: frames === 0 ? ["emptyProgram"] : [],
  };
}

/**
 * 预置节目的文件头信息：默认值叠加数据文件里的覆盖项。
 *
 * # Arguments
 *
 * * `seed` - 预置节目。
 * * `frames` - 推算出的帧数。
 *
 * # Returns
 *
 * 文件头派生信息。
 */
function headerOf(seed: ProgramSeed, frames: number): HeaderInfo {
  return { ...defaultHeader(frames), ...seed.header };
}

/**
 * 由数据文件里的预置节目生成列表条目。
 *
 * 帧数、体积由时长、帧率与 Universe 数推出（体积带一点按文件名固定的差异），
 * 所以改数据文件里的时长或 Universe，列表上的数字会自洽地跟着变。
 *
 * # Arguments
 *
 * * `seed` - 预置节目。
 * * `dir` - 录制目录。
 * * `nowMs` - 当前墙钟时间（毫秒），用于换算修改时间。
 *
 * # Returns
 *
 * 节目记录。
 */
function recordFromSeed(seed: ProgramSeed, dir: string, nowMs: number): ProgramRecord {
  const valid = seed.valid ?? true;
  const universes = seed.universes.map((u) => u.universe);
  const frames = valid
    ? Math.round(seed.durationSec * seed.rateHz * universes.length * FRAME_KEEP_RATIO)
    : 0;
  const perFrame = 48 + 40 * hash01(hashText(seed.fileName));
  return {
    entry: {
      path: `${dir}\\${seed.fileName}`,
      fileName: seed.fileName,
      name: seed.name,
      notes: seed.notes,
      bytes: valid ? Math.round(frames * perFrame) + 2048 : 512,
      modifiedUnixMs: nowMs - seed.ageMinutes * 60_000,
      durationUs: valid ? seed.durationSec * 1_000_000 : 0,
      frames,
      universes,
      sources: seed.sources,
      recovered: seed.recovered ?? false,
      valid,
      editable: false,
      exported: true,
      header: valid ? headerOf(seed, frames) : null,
    },
    universes: seed.universes,
    durationSec: valid ? seed.durationSec : 0,
    corruptFrames: seed.corruptFrames ?? 0,
  };
}

/**
 * 创建节目库，初始内容来自 `recordings.json`。
 *
 * # Arguments
 *
 * * `seeds` - 预置节目。
 * * `dir` - 初始录制目录。
 *
 * # Returns
 *
 * 节目库。
 */
export function createLibrary(seeds: readonly ProgramSeed[], dir: string): Library {
  const now = Date.now();
  let records = seeds.map((s) => recordFromSeed(s, dir, now));

  const sorted = () => [...records].sort((a, b) => b.entry.modifiedUnixMs - a.entry.modifiedUnixMs);

  return {
    all: sorted,
    find: (path) => records.find((r) => r.entry.path === path),

    add: (record) => {
      records = [...records, record];
    },

    remove: (path) => {
      const before = records.length;
      records = records.filter((r) => r.entry.path !== path);
      return records.length !== before;
    },

    rename: (path, newName) => {
      const rec = records.find((r) => r.entry.path === path);
      if (!rec) fail("not_found");
      const stem = sanitizeFileStem(newName);
      if (!stem) fail("invalid_name");
      const fileName = `${stem}.artrec`;
      if (records.some((r) => r !== rec && r.entry.fileName === fileName)) fail("already_exists");
      const dirPart = rec.entry.path.slice(0, rec.entry.path.length - rec.entry.fileName.length);
      rec.entry = {
        ...rec.entry,
        name: newName.trim(),
        fileName,
        path: `${dirPart}${fileName}`,
      };
      return rec.entry.path;
    },

    nextValidAfter: (path) => {
      const list = sorted();
      const i = list.findIndex((r) => r.entry.path === path);
      if (i < 0) return undefined;
      return list.slice(i + 1).find((r) => r.entry.valid);
    },

    uniquePath: (name) => {
      const base = sanitizeFileStem(name) || "copy";
      const taken = (stem: string) => records.some((r) => r.entry.fileName === `${stem}.artrec`);
      let stem = base;
      for (let n = 2; taken(stem); n += 1) stem = `${base}-${n}`;
      const fileName = `${stem}.artrec`;
      return { path: `${dir}\\${fileName}`, fileName };
    },
  };
}
