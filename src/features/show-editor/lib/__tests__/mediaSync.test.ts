import { describe, expect, it } from "vitest";

import {
  canPlayExtension,
  DRIFT_OK_MS,
  DRIFT_SEEK_MS,
  planSync,
  SCRUB_TOLERANCE_MS,
  type SyncInput,
} from "../mediaSync";

const base: SyncInput = {
  transport: "playing",
  positionMs: 10_000,
  offsetMs: 0,
  mediaDurationMs: 60_000,
  currentTimeMs: 10_000,
  elementPaused: false,
};
const plan = (over: Partial<SyncInput> = {}) => planSync({ ...base, ...over });

describe("planSync：播放中", () => {
  it("同步（偏差 ≤ 30 ms）：什么都不做，速率 1", () => {
    expect(plan()).toEqual({ play: false, pause: false, seekToMs: null, rate: 1 });
    expect(plan({ currentTimeMs: 10_000 + DRIFT_OK_MS }).seekToMs).toBeNull();
    expect(plan({ currentTimeMs: 10_000 - DRIFT_OK_MS }).rate).toBe(1);
  });

  it("小偏差：变速追平 —— 元素跑在前面就放慢，落后就加快，幅度不超过 ±5%", () => {
    const ahead = plan({ currentTimeMs: 10_100 });
    expect(ahead.seekToMs).toBeNull();
    expect(ahead.rate).toBeCloseTo(0.95, 12);
    const behind = plan({ currentTimeMs: 9_940 });
    expect(behind.rate).toBeCloseTo(1.05, 12);
    const slight = plan({ currentTimeMs: 10_040 });
    expect(slight.rate).toBeCloseTo(0.96, 12);
    expect(slight.rate).toBeLessThan(1);
  });

  it("大偏差（> 200 ms）：直接跳到目标位置并恢复速率 1", () => {
    const p = plan({ currentTimeMs: 10_000 + DRIFT_SEEK_MS + 1 });
    expect(p).toEqual({ play: false, pause: false, seekToMs: 10_000, rate: 1 });
    expect(plan({ currentTimeMs: 9_000 }).seekToMs).toBe(10_000);
  });

  it("元素还没开始播放：定位到目标并播放", () => {
    expect(plan({ elementPaused: true, currentTimeMs: 0 })).toEqual({
      play: true,
      pause: false,
      seekToMs: 10_000,
      rate: 1,
    });
  });

  it("素材偏移：目标 = 位置 - 偏移", () => {
    const p = plan({ offsetMs: 4_000, currentTimeMs: 0, elementPaused: true });
    expect(p.seekToMs).toBe(6_000);
    // 负偏移：素材比时间线先开始
    expect(plan({ offsetMs: -2_000, elementPaused: true, currentTimeMs: 0 }).seekToMs).toBe(12_000);
  });

  it("时间线还没走到素材：停在开头等待；走过素材末尾：停在末尾", () => {
    const early = plan({ positionMs: 1_000, offsetMs: 5_000, currentTimeMs: 0, elementPaused: false });
    expect(early).toEqual({ play: false, pause: true, seekToMs: null, rate: 1 });
    expect(plan({ positionMs: 1_000, offsetMs: 5_000, currentTimeMs: 0, elementPaused: true }).pause).toBe(false);
    const late = plan({ positionMs: 70_000, currentTimeMs: 59_980 });
    expect(late.pause).toBe(true);
    expect(late.seekToMs).toBeNull(); // 已在末尾附近
    expect(plan({ positionMs: 70_000, currentTimeMs: 5_000, elementPaused: true }).seekToMs).toBe(60_000);
  });

  it("循环回绕：位置突然回到开头，元素偏差很大 → 跳回去", () => {
    expect(plan({ positionMs: 100, currentTimeMs: 59_000 }).seekToMs).toBe(100);
  });
});

describe("planSync：暂停 / 停止（拖动播放头）", () => {
  it("正在响的元素要暂停；位置不对就对齐，已经对齐就不再 seek", () => {
    const moving = plan({ transport: "paused", currentTimeMs: 3_000 });
    expect(moving).toEqual({ play: false, pause: true, seekToMs: 10_000, rate: 1 });
    const aligned = plan({ transport: "stopped", currentTimeMs: 10_000 + SCRUB_TOLERANCE_MS, elementPaused: true });
    expect(aligned).toEqual({ play: false, pause: false, seekToMs: null, rate: 1 });
  });

  it("目标超出素材范围时夹取到端点", () => {
    expect(plan({ transport: "paused", positionMs: 1_000, offsetMs: 5_000, elementPaused: true }).seekToMs).toBe(0);
    expect(plan({ transport: "paused", positionMs: 99_000, elementPaused: true }).seekToMs).toBe(60_000);
  });
});

describe("canPlayExtension", () => {
  const answering = (answer: string) => () => ({ canPlayType: () => answer as CanPlayTypeResult });

  it("返回空串表示肯定不能播放；maybe / probably 视为可以", () => {
    expect(canPlayExtension("mp3", answering(""))).toBe(false);
    expect(canPlayExtension("mp3", answering("maybe"))).toBe(true);
    expect(canPlayExtension("mp4", answering("probably"))).toBe(true);
  });

  it("按扩展名选择 audio / video 探测，未知扩展名不能播放", () => {
    const kinds: string[] = [];
    const probe = (kind: "audio" | "video") => {
      kinds.push(kind);
      return { canPlayType: () => "maybe" as CanPlayTypeResult };
    };
    canPlayExtension("wav", probe);
    canPlayExtension("webm", probe);
    expect(kinds).toEqual(["audio", "video"]);
    expect(canPlayExtension("xyz", probe)).toBe(false);
    expect(kinds).toHaveLength(2);
  });
});
