import type { ActivityDto } from "@/features/recording/lib/types";

/** 桶数上限（与后端 `recorder::MAX_BUCKETS` 一致）。 */
const MAX_BUCKETS = 512;
/** 初始桶宽（微秒，与后端一致）。 */
const INITIAL_BUCKET_US = 250_000;

/**
 * 变化通道数 → 0~255 强度（与后端 `recorder::scale_change` 相同的对数刻度）。
 *
 * # Arguments
 *
 * * `n` - 桶内累计的变化通道数。
 *
 * # Returns
 *
 * `min(255, round(24 * log2(1 + n)))`。
 */
function scaleChange(n: number): number {
  if (n <= 0) return 0;
  return Math.min(255, Math.round(24 * Math.log2(1 + n)));
}

/** 字节数组 → 标准 Base64。 */
function toBase64(bytes: ArrayLike<number>): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** 演示用的录制活动时间线（逻辑与后端 `recorder::ActivityTimeline` 相同）。 */
export interface DemoActivity {
  /** 观察一份快照（各路 512 通道，与 `universes` 同序）。 */
  observe(tUs: number, snaps: readonly (readonly number[])[]): void;
  /** 把时间轴延长到 `tUs`。 */
  advanceTo(tUs: number): void;
  /** 记录新分段的起点。 */
  markPart(startUs: number): void;
  /** 取走自上次以来的增量。 */
  takeDelta(): ActivityDto;
  /** 全量快照。 */
  snapshot(): ActivityDto;
}

/**
 * 创建演示用的活动时间线。
 *
 * # Arguments
 *
 * * `universes` - 录制的 Universe 集合。
 *
 * # Returns
 *
 * 空时间线。
 */
export function createDemoActivity(universes: number[]): DemoActivity {
  let bucketUs = INITIAL_BUCKET_US;
  let generation = 0;
  let len = 0;
  let change: number[][] = universes.map(() => []);
  let level: number[][] = universes.map(() => []);
  const lastLevel = universes.map(() => 0);
  let prev: number[][] | null = null;
  const partStartsUs = [0];
  let dirtyFrom: number | null = null;

  const touch = (i: number) => {
    dirtyFrom = dirtyFrom === null ? i : Math.min(dirtyFrom, i);
  };
  const compact = () => {
    const pairMax = (row: number[]) => {
      const out: number[] = [];
      for (let i = 0; i < row.length; i += 2) out.push(Math.max(row[i], row[i + 1] ?? 0));
      return out;
    };
    change = change.map(pairMax);
    level = level.map(pairMax);
    len = Math.ceil(len / 2);
    bucketUs *= 2;
    generation += 1;
    dirtyFrom = 0;
  };
  const ensure = (tUs: number): number => {
    let idx = Math.floor(tUs / bucketUs);
    while (idx >= MAX_BUCKETS) {
      compact();
      idx = Math.floor(tUs / bucketUs);
    }
    if (idx >= len) {
      const first = len;
      for (let r = 0; r < universes.length; r += 1) {
        while (change[r].length <= idx) {
          change[r].push(0);
          level[r].push(lastLevel[r]);
        }
      }
      len = idx + 1;
      touch(first);
    }
    return idx;
  };
  const deltaSince = (fromRaw: number): ActivityDto => {
    const from = Math.min(fromRaw, len);
    return {
      generation,
      bucketUs,
      len,
      from,
      universes,
      change: change.map((row) => toBase64(row.slice(from).map(scaleChange))),
      level: level.map((row) => toBase64(row.slice(from))),
      partStartsUs: [...partStartsUs],
    };
  };

  return {
    observe(tUs, snaps) {
      if (universes.length === 0) return;
      const idx = ensure(tUs);
      for (let r = 0; r < universes.length; r += 1) {
        const snap = snaps[r] ?? [];
        const before = prev?.[r] ?? [];
        let changed = 0;
        let peak = 0;
        for (let c = 0; c < snap.length; c += 1) {
          if ((before[c] ?? 0) !== snap[c]) changed += 1;
          if (snap[c] > peak) peak = snap[c];
        }
        change[r][idx] += changed;
        level[r][idx] = Math.max(level[r][idx], peak);
        lastLevel[r] = peak;
      }
      prev = snaps.map((s) => [...s]);
      touch(idx);
    },
    advanceTo(tUs) {
      ensure(tUs);
    },
    markPart(startUs) {
      if (startUs > partStartsUs[partStartsUs.length - 1]) partStartsUs.push(startUs);
    },
    takeDelta() {
      const from = dirtyFrom ?? len;
      dirtyFrom = null;
      return deltaSince(from);
    },
    snapshot: () => deltaSince(0),
  };
}
