import { describe, expect, it } from "vitest";

import { DMX_KIND_LIVE, DMX_KIND_PLAYBACK, decodeDmxFrame, encodeDmxFrame } from "../dmxFrame";

/** 与后端 `host-core/src/stream.rs` 测试 `SHARED_VECTOR` 相同的字节。 */
const SHARED_VECTOR = [
  0x44, 0x01, 0x01, 0x01, 0x02, 0x00, // 魔数 / 版本 / 实时 / 全量 / count=2
  0x01, 0x00, 0x03, 0x00, 10, 20, 30, // Universe 1，3 字节
  0x2c, 0x01, 0x00, 0x00, // Universe 300，len=0
];

const bufferOf = (bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer;

describe("encodeDmxFrame / decodeDmxFrame", () => {
  it("编码结果与后端字节向量逐字节一致", () => {
    const buf = encodeDmxFrame({
      kind: DMX_KIND_LIVE,
      full: true,
      entries: [
        { universe: 1, data: [10, 20, 30] },
        { universe: 300, data: [] },
      ],
    });
    expect([...new Uint8Array(buf)]).toEqual(SHARED_VECTOR);
  });

  it("解码后端字节向量：数据是帧缓冲上的零拷贝视图", () => {
    const buf = bufferOf(SHARED_VECTOR);
    const frame = decodeDmxFrame(buf);
    expect(frame).not.toBeNull();
    expect(frame!.kind).toBe(DMX_KIND_LIVE);
    expect(frame!.full).toBe(true);
    expect(frame!.entries.map((e) => [e.universe, [...e.data]])).toEqual([
      [1, [10, 20, 30]],
      [300, []],
    ]);
    expect(frame!.entries[0].data.buffer).toBe(buf);
    expect(frame!.entries[0].data.byteOffset).toBe(10);
  });

  it("增量回放帧与空全量帧可往返", () => {
    const data = Uint8Array.from({ length: 512 }, (_, i) => i & 0xff);
    const inc = decodeDmxFrame(
      encodeDmxFrame({ kind: DMX_KIND_PLAYBACK, full: false, entries: [{ universe: 0x1234, data }] }),
    );
    expect(inc).toMatchObject({ kind: DMX_KIND_PLAYBACK, full: false });
    expect(inc!.entries[0].universe).toBe(0x1234);
    expect([...inc!.entries[0].data]).toEqual([...data]);

    const empty = encodeDmxFrame({ kind: DMX_KIND_LIVE, full: true, entries: [] });
    expect([...new Uint8Array(empty)]).toEqual([0x44, 1, 1, 1, 0, 0]);
    expect(decodeDmxFrame(empty)).toEqual({ kind: DMX_KIND_LIVE, full: true, entries: [] });
  });

  it("条目数在 u16 边界内都能往返，超出则拒绝编码", () => {
    const entries = Array.from({ length: 0xffff }, (_, universe) => ({ universe, data: [] as number[] }));
    const frame = decodeDmxFrame(encodeDmxFrame({ kind: DMX_KIND_LIVE, full: false, entries }));
    expect(frame!.entries).toHaveLength(0xffff);
    expect(frame!.entries[0xfffe].universe).toBe(0xfffe);

    expect(() =>
      encodeDmxFrame({ kind: DMX_KIND_LIVE, full: false, entries: [...entries, { universe: 0, data: [] }] }),
    ).toThrow(RangeError);
    expect(() =>
      encodeDmxFrame({ kind: DMX_KIND_LIVE, full: false, entries: [{ universe: 0, data: new Uint8Array(0x10000) }] }),
    ).toThrow(RangeError);
  });

  it("格式错误的帧返回 null", () => {
    expect(decodeDmxFrame(new ArrayBuffer(0))).toBeNull();
    expect(decodeDmxFrame(bufferOf([0x44, 1, 1, 0, 0]))).toBeNull(); // 帧头不完整
    expect(decodeDmxFrame(bufferOf([0x45, 1, 1, 0, 0, 0]))).toBeNull(); // 魔数不符
    expect(decodeDmxFrame(bufferOf([0x44, 2, 1, 0, 0, 0]))).toBeNull(); // 版本不符
    expect(decodeDmxFrame(bufferOf(SHARED_VECTOR.slice(0, -1)))).toBeNull(); // 条目头被截断
    expect(decodeDmxFrame(bufferOf(SHARED_VECTOR.slice(0, 12)))).toBeNull(); // 数据被截断
    expect(decodeDmxFrame(bufferOf([...SHARED_VECTOR, 0]))).toBeNull(); // 帧尾多余字节
  });
});
