/**
 * 二进制 DMX 通道流的帧编解码，与后端 `host-core/src/stream.rs` 的帧格式 v1 一致（全部小端）：
 *
 * ```text
 * u8 magic = 0x44 | u8 version = 1 | u8 kind | u8 flags | u16 count
 * count × ( u16 universe | u16 len | len 字节通道数据 )
 * ```
 *
 * - `kind`：1 = 实时、2 = 回放；
 * - `flags` bit0 = 全量：用本帧整体替换该 kind 的通道表，未出现的 Universe 视为已移除；
 * - `len = 0`：该 Universe 当前无数据（删除它）。
 */

/** 帧魔数（ASCII `'D'`）。 */
const MAGIC = 0x44;
/** 帧格式版本。 */
const VERSION = 1;
/** 标志位 bit0：全量帧。 */
const FLAG_FULL = 0x01;
/** 帧头长度（字节）。 */
const HEADER_LEN = 6;
/** 每个条目的头部长度（字节）。 */
const ENTRY_HEADER_LEN = 4;
/** `u16` 字段的上限。 */
const U16_MAX = 0xffff;

/** 帧类别：实时接收的合并输出。 */
export const DMX_KIND_LIVE = 1;
/** 帧类别：节目回放的输出。 */
export const DMX_KIND_PLAYBACK = 2;

/** 解码后的一个 Universe 条目。 */
interface DmxFrameEntry {
  universe: number;
  /** 通道数据：指向帧缓冲的零拷贝视图；长度 0 表示该 Universe 已无数据。 */
  data: Uint8Array;
}

/** 解码后的一帧。 */
export interface DmxFrame {
  /** 帧类别（{@link DMX_KIND_LIVE} / {@link DMX_KIND_PLAYBACK}，未知值原样保留）。 */
  kind: number;
  /** 是否全量帧。 */
  full: boolean;
  entries: DmxFrameEntry[];
}

/** 待编码的一帧。 */
interface DmxFrameInput {
  kind: number;
  full: boolean;
  /** 条目；`data` 为空表示该 Universe 已无数据。 */
  entries: ReadonlyArray<{ universe: number; data: ArrayLike<number> }>;
}

/**
 * 编码一帧（测试使用；真实后端在 Rust 侧编码）。
 *
 * # Arguments
 *
 * * `frame` - 帧内容；通道值按字节写入（0~255）。
 *
 * # Returns
 *
 * 帧字节。
 *
 * # Errors
 *
 * 条目数或单条数据长度超过 65535 时抛出 `RangeError`。
 */
export function encodeDmxFrame(frame: DmxFrameInput): ArrayBuffer {
  const { entries } = frame;
  if (entries.length > U16_MAX) throw new RangeError(`条目数超过 ${U16_MAX}`);
  let size = HEADER_LEN;
  for (const e of entries) {
    if (e.data.length > U16_MAX) throw new RangeError(`Universe ${e.universe} 的数据超过 ${U16_MAX} 字节`);
    size += ENTRY_HEADER_LEN + e.data.length;
  }

  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  view.setUint8(0, MAGIC);
  view.setUint8(1, VERSION);
  view.setUint8(2, frame.kind);
  view.setUint8(3, frame.full ? FLAG_FULL : 0);
  view.setUint16(4, entries.length, true);
  let at = HEADER_LEN;
  for (const { universe, data } of entries) {
    view.setUint16(at, universe, true);
    view.setUint16(at + 2, data.length, true);
    bytes.set(data, at + ENTRY_HEADER_LEN);
    at += ENTRY_HEADER_LEN + data.length;
  }
  return buf;
}

/**
 * 解码一帧。
 *
 * # Arguments
 *
 * * `buf` - 通道流收到的帧字节。
 *
 * # Returns
 *
 * 解码结果（条目数据是 `buf` 上的 `Uint8Array` 视图，不拷贝）；
 * 魔数 / 版本不符、长度越界或帧尾有多余字节时返回 `null`，调用方应丢弃该帧。
 */
export function decodeDmxFrame(buf: ArrayBuffer): DmxFrame | null {
  if (buf.byteLength < HEADER_LEN) return null;
  const view = new DataView(buf);
  if (view.getUint8(0) !== MAGIC || view.getUint8(1) !== VERSION) return null;
  const kind = view.getUint8(2);
  const full = (view.getUint8(3) & FLAG_FULL) !== 0;
  const count = view.getUint16(4, true);

  const entries: DmxFrameEntry[] = [];
  let at = HEADER_LEN;
  for (let i = 0; i < count; i += 1) {
    if (at + ENTRY_HEADER_LEN > buf.byteLength) return null;
    const universe = view.getUint16(at, true);
    const len = view.getUint16(at + 2, true);
    at += ENTRY_HEADER_LEN;
    if (at + len > buf.byteLength) return null;
    entries.push({ universe, data: new Uint8Array(buf, at, len) });
    at += len;
  }
  if (at !== buf.byteLength) return null;
  return { kind, full, entries };
}
