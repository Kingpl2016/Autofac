import type { AudioAnalysis } from "../mediaApi";

/**
 * 测试用的音乐分析（素材内时刻）：120 BPM、一小节 2 秒、32 小节（64 秒）。
 *
 * - 段落：`A` 0~16 秒（安静）、`B` 16~48 秒（很响）、`A` 48~64 秒（安静）；
 * - 事件：8~16 秒渐强，16 秒爆点，48 秒断层，B 段每小节一个冲击（16 个）。
 *
 * @param over 覆盖部分字段。
 * @returns 分析结果。
 */
export function testAnalysis(over: Partial<AudioAnalysis> = {}): AudioAnalysis {
  const loud = (ms: number) => ms >= 16_000 && ms < 48_000;
  const bars = Array.from({ length: 32 }, (_, i) => {
    const startMs = i * 2000;
    const energy = loud(startMs) ? 1 : i >= 4 && i < 8 ? 0.2 + (i - 4) * 0.1 : 0.1;
    return { startMs, endMs: startMs + 2000, loudnessDb: -30 + energy * 24, energy, brightness: loud(startMs) ? 0.8 : 0.3, bass: loud(startMs) ? 0.9 : 0.2, density: loud(startMs) ? 0.7 : 0.2 };
  });
  return {
    version: 1,
    sensitivity: 1,
    beats: {
      bpm: 120,
      offsetMs: 0,
      beatsPerBar: 4,
      beatsMs: Array.from({ length: 128 }, (_, i) => i * 500),
      confidence: 0.9,
      durationMs: 64_000,
      sections: [
        { startMs: 0, endMs: 16_000, energy: 0.1 },
        { startMs: 16_000, endMs: 48_000, energy: 1 },
        { startMs: 48_000, endMs: 64_000, energy: 0.1 },
      ],
    },
    bars,
    sections: [
      { startMs: 0, endMs: 16_000, energy: 0.1, brightness: 0.3, bass: 0.2, density: 0.2, label: "A", labelConfidence: 0.8 },
      { startMs: 16_000, endMs: 48_000, energy: 1, brightness: 0.8, bass: 0.9, density: 0.7, label: "B", labelConfidence: 0.9 },
      { startMs: 48_000, endMs: 64_000, energy: 0.1, brightness: 0.3, bass: 0.2, density: 0.2, label: "A", labelConfidence: 0.8 },
    ],
    events: [
      { kind: "build" as const, atMs: 8000, endMs: 16_000, strength: 0.6 },
      { kind: "drop" as const, atMs: 16_000, strength: 0.9 },
      ...Array.from({ length: 16 }, (_, i) => ({ kind: "hit" as const, atMs: 16_000 + i * 2000, strength: 1 })),
      { kind: "break" as const, atMs: 48_000, strength: 0.9 },
    ].sort((a, b) => a.atMs - b.atMs),
    ...over,
  };
}
