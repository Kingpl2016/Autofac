//! 兼容性测试：复用压缩 / 解压上下文后的产物与读取端，和旧版实现
//! （`zstd::encode_all` 写、`zstd::stream::decode_all` 读）逐字节互通。
//!
//! 嵌入式核心板固件无法实测，所以这里从字节层面确认：
//!
//! 1. 新写入端的每个 Chunk 都能被旧解码路径解出与原始 Payload 逐字节相同的数据；
//! 2. 新产物的 Zstd 帧头不含原始大小字段，帧头结构与 `encode_all` 产物一致
//!    （唯一允许的差异是窗口大小 `Window_Descriptor`，且只会更小）；
//! 3. 用旧写法（`encode_all`）手工拼出的文件，新读取端读出的帧与原始数据一致，
//!    索引 `chunk_cmp_len` 异常时也与旧读取端一样能容忍；
//! 4. `with_source` 派生的读取器（含 `ReadAhead`、跨线程）读帧结果与原读取器一致。

use std::collections::BTreeMap;
use std::io::Cursor;

use artrec_core::{
    assemble_full, crc16_ccitt, decompress, encode_diff, ArtRecError, ArtRecReader, ArtRecWriter,
    ChunkHdr, CompressAlgo, DiffChange, FileHeader, FrameIndex, ReadAhead, UniDesc, CHUNKHDR_SIZE,
    CHUNK_DIFF, CHUNK_FULL, FLAG_DIFF_FRAME, FRAMEINDEX_SIZE, HEADER_SIZE, UNIDESC_SIZE, VER_MAJOR,
    VER_MINOR,
};
use zstd::zstd_safe;

/// 与录制默认配置一致的压缩等级。
const LEVEL: u8 = 3;
/// 每路通道数。
const DMX_LEN: usize = 512;

/// 编号 `0..n` 的 Universe 描述表。
fn unis(n: usize) -> Vec<UniDesc> {
    (0..n)
        .map(|u| UniDesc::from_universe(u as u16, DMX_LEN as u16).unwrap())
        .collect()
}

/// 确定性 xorshift64。
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

/// 三角波 0~255~0，周期 512。
fn triangle(p: usize) -> u8 {
    let p = p % 512;
    (if p < 256 { p } else { 511 - p }) as u8
}

/// fade 码流（每路 50 台灯具：调光静止 255，RGB 渐变）。
fn fade_frame(n: usize, f: usize) -> Vec<Vec<u8>> {
    (0..n)
        .map(|u| {
            let mut b = vec![0u8; DMX_LEN];
            for fx in 0..50 {
                let ph = f + fx * 5 + u * 7;
                b[fx * 4] = 255;
                b[fx * 4 + 1] = triangle(ph);
                b[fx * 4 + 2] = triangle(ph + 170);
                b[fx * 4 + 3] = triangle(ph + 340);
            }
            b
        })
        .collect()
}

/// 全随机码流。
fn random_frame(n: usize, rng: &mut Rng) -> Vec<Vec<u8>> {
    (0..n)
        .map(|_| (0..DMX_LEN).map(|_| (rng.next() >> 32) as u8).collect())
        .collect()
}

/// 一帧测试数据：全量帧或差分帧。
enum Frame {
    Full(Vec<Vec<u8>>),
    Diff(Vec<DiffChange>),
}

/// 一帧解析后的完整各路 DMX 状态。
type State = Vec<Vec<u8>>;

/// 测试节目：fade、全零、随机全量帧，夹杂若干长度不同的差分帧。
///
/// # Returns
///
/// `(帧时间与内容, 每帧期望的完整各路状态)`。
fn program(n: usize, frames: usize) -> (Vec<(u64, Frame)>, Vec<State>) {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut out = Vec::new();
    let mut states = Vec::new();
    let mut cur = vec![vec![0u8; DMX_LEN]; n];
    for f in 0..frames {
        let t = f as u64 * 22_727;
        let frame = match f % 10 {
            0..=4 => Frame::Full(fade_frame(n, f)),
            5 => Frame::Full(vec![vec![0u8; DMX_LEN]; n]),
            6 => Frame::Full(random_frame(n, &mut rng)),
            _ => {
                // 差分：1 ~ 600 个变更点（覆盖压缩后大于 / 小于原始长度的情况）
                let k = 1 + (rng.next() % 600) as usize;
                Frame::Diff(
                    (0..k)
                        .map(|_| DiffChange {
                            uni_idx: (rng.next() % n as u64) as u16,
                            ch_addr: (rng.next() % DMX_LEN as u64) as u16,
                            ch_val: rng.next() as u8,
                        })
                        .collect(),
                )
            }
        };
        match &frame {
            Frame::Full(b) => cur.clone_from(b),
            Frame::Diff(ch) => {
                for c in ch {
                    cur[usize::from(c.uni_idx)][usize::from(c.ch_addr)] = c.ch_val;
                }
            }
        }
        states.push(cur.clone());
        out.push((t, frame));
    }
    (out, states)
}

/// 帧的原始 Payload（与写入端装配规则一致）。
fn raw_payload(unis: &[UniDesc], f: &Frame) -> Vec<u8> {
    match f {
        Frame::Full(b) => assemble_full(unis, b).unwrap(),
        Frame::Diff(ch) => encode_diff(ch),
    }
}

/// 用新写入端写出节目。
fn write_new(n: usize, frames: &[(u64, Frame)]) -> Vec<u8> {
    let mut w = ArtRecWriter::new(
        Cursor::new(Vec::new()),
        unis(n),
        CompressAlgo::Zstd,
        LEVEL,
        FLAG_DIFF_FRAME,
        0,
    )
    .unwrap();
    for (t, f) in frames {
        match f {
            Frame::Full(b) => w.add_full_frame(*t, b).unwrap(),
            Frame::Diff(ch) => w.add_diff_frame(*t, ch).unwrap(),
        };
    }
    let end = frames.last().map_or(0, |(t, _)| *t);
    w.finish(end).unwrap().into_inner()
}

/// 用旧写法（`zstd::encode_all`，每帧新建流式上下文）手工拼出同样排布（A,B,D,C）的文件。
///
/// # Returns
///
/// `(文件字节, 帧索引)`。
fn write_legacy(n: usize, frames: &[(u64, Frame)]) -> (Vec<u8>, Vec<FrameIndex>) {
    let u = unis(n);
    let pool_off = HEADER_SIZE + n as u32 * UNIDESC_SIZE;
    let mut pool = Vec::new();
    let mut index = Vec::new();
    for (t, f) in frames {
        let raw = raw_payload(&u, f);
        let packed = zstd::encode_all(&raw[..], i32::from(LEVEL)).unwrap();
        let hdr = ChunkHdr {
            chunk_type: if matches!(f, Frame::Full(_)) {
                CHUNK_FULL
            } else {
                CHUNK_DIFF
            },
            payload_raw_sz: raw.len() as u16,
            payload_cmp_sz: packed.len() as u16,
            crc16: crc16_ccitt(&raw),
        };
        index.push(FrameIndex {
            time_us: *t,
            chunk_pos: pool.len() as u32,
            chunk_cmp_len: (CHUNKHDR_SIZE + packed.len()) as u16,
        });
        pool.extend_from_slice(&hdr.to_bytes());
        pool.extend_from_slice(&packed);
    }
    (assemble_file(&u, &pool, &index, pool_off), index)
}

/// 按 A(头) → B(UniDesc) → D(Chunk 池) → C(索引) 拼出文件。
fn assemble_file(u: &[UniDesc], pool: &[u8], index: &[FrameIndex], pool_off: u32) -> Vec<u8> {
    let header = FileHeader {
        flags: FLAG_DIFF_FRAME,
        rec_start_us: 0,
        total_duration_us: index.last().map_or(0, |f| f.time_us),
        universe_count: u.len() as u32,
        frame_count: index.len() as u32,
        universe_desc_offset: HEADER_SIZE,
        frame_index_offset: pool_off + pool.len() as u32,
        chunk_pool_offset: pool_off,
        compress_algo: CompressAlgo::Zstd,
        compress_level: LEVEL,
        ver_major: VER_MAJOR,
        ver_minor: VER_MINOR,
    };
    let mut bytes = header.to_bytes().to_vec();
    for d in u {
        bytes.extend_from_slice(&d.to_bytes());
    }
    bytes.extend_from_slice(pool);
    for fi in index {
        bytes.extend_from_slice(&fi.to_bytes());
    }
    bytes
}

/// 不经读取器、直接从文件字节切出每个 Chunk：`(块头, 压缩 Payload, 索引条目)`。
fn raw_chunks(bytes: &[u8]) -> Vec<(ChunkHdr, Vec<u8>, FrameIndex)> {
    let h = FileHeader::from_bytes(bytes).unwrap();
    (0..h.frame_count as usize)
        .map(|i| {
            let off = h.frame_index_offset as usize + i * FRAMEINDEX_SIZE as usize;
            let fi = FrameIndex::from_bytes(&bytes[off..]).unwrap();
            let base = (h.chunk_pool_offset + fi.chunk_pos) as usize;
            let hdr = ChunkHdr::from_bytes(&bytes[base..]).unwrap();
            let p = base + CHUNKHDR_SIZE;
            (
                hdr,
                bytes[p..p + usize::from(hdr.payload_cmp_sz)].to_vec(),
                fi,
            )
        })
        .collect()
}

/// Zstd 帧头（RFC 8878 §3.1.1）解析结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ZstdHeader {
    /// Frame_Header_Descriptor 原始字节。
    fhd: u8,
    /// Frame_Content_Size_Flag（0 且非单段 = 不写原始大小）。
    fcs_flag: u8,
    /// Single_Segment_Flag。
    single_segment: bool,
    /// Content_Checksum_Flag。
    checksum: bool,
    /// Dictionary_ID_Flag。
    dict_id_flag: u8,
    /// Window_Descriptor 原始字节（单段帧没有）。
    window_desc: Option<u8>,
    /// 帧头总字节数（含 4 字节魔数）。
    header_len: usize,
}

impl ZstdHeader {
    fn parse(frame: &[u8]) -> Self {
        assert_eq!(&frame[0..4], &[0x28, 0xB5, 0x2F, 0xFD], "Zstd 魔数");
        let fhd = frame[4];
        let fcs_flag = fhd >> 6;
        let single_segment = fhd & 0x20 != 0;
        let checksum = fhd & 0x04 != 0;
        let dict_id_flag = fhd & 0x03;
        assert_eq!(fhd & 0x08, 0, "保留位必须为 0");
        let window_desc = (!single_segment).then(|| frame[5]);
        let did_len = [0usize, 1, 2, 4][usize::from(dict_id_flag)];
        let fcs_len = match fcs_flag {
            0 => usize::from(single_segment),
            1 => 2,
            2 => 4,
            _ => 8,
        };
        Self {
            fhd,
            fcs_flag,
            single_segment,
            checksum,
            dict_id_flag,
            window_desc,
            header_len: 5 + usize::from(!single_segment) + did_len + fcs_len,
        }
    }

    /// 窗口大小（字节），按 RFC 8878 §3.1.1.1.2 由 Window_Descriptor 计算。
    fn window_size(&self) -> Option<u64> {
        self.window_desc.map(|wd| {
            let log = 10 + u64::from(wd >> 3);
            let base = 1u64 << log;
            base + (base / 8) * u64::from(wd & 7)
        })
    }
}

/// 解析帧内所有块：`(Block_Type, Block_Size)`；并断言块序列恰好覆盖整个帧。
fn blocks(frame: &[u8], h: &ZstdHeader) -> Vec<(u8, usize)> {
    let mut p = h.header_len;
    let mut out = Vec::new();
    loop {
        let bh =
            u32::from(frame[p]) | (u32::from(frame[p + 1]) << 8) | (u32::from(frame[p + 2]) << 16);
        let last = bh & 1 == 1;
        let ty = ((bh >> 1) & 3) as u8;
        let size = (bh >> 3) as usize;
        p += 3 + if ty == 1 { 1 } else { size };
        out.push((ty, size));
        if last {
            break;
        }
    }
    p += if h.checksum { 4 } else { 0 };
    assert_eq!(p, frame.len(), "块序列应恰好覆盖整个帧，无尾随数据");
    out
}

#[test]
fn new_writer_chunks_decode_with_legacy_stream_decoder() {
    for n in [1usize, 8, 64, 127] {
        let (frames, _) = program(n, 40);
        let bytes = write_new(n, &frames);
        let u = unis(n);
        let chunks = raw_chunks(&bytes);
        assert_eq!(chunks.len(), frames.len());
        for (k, ((hdr, packed, fi), (_, f))) in chunks.iter().zip(&frames).enumerate() {
            let raw = raw_payload(&u, f);
            // 旧读取端的解码方式：流式 decode_all / copy_decode
            assert_eq!(
                zstd::stream::decode_all(&packed[..]).unwrap(),
                raw,
                "n={n} k={k}"
            );
            assert_eq!(
                decompress(CompressAlgo::Zstd, packed, raw.len()).unwrap(),
                raw
            );
            assert_eq!(usize::from(hdr.payload_raw_sz), raw.len());
            assert_eq!(hdr.crc16, crc16_ccitt(&raw));
            assert_eq!(
                usize::from(hdr.payload_cmp_sz) + CHUNKHDR_SIZE,
                usize::from(fi.chunk_cmp_len)
            );
            // 每个 Chunk 恰好是一个完整的独立帧
            assert_eq!(
                zstd_safe::find_frame_compressed_size(packed),
                Ok(packed.len())
            );
        }
    }
}

/// 帧头声明的原始大小：`None` 表示帧头未写该字段（"未知"）；帧头非法时测试失败。
fn content_size(frame: &[u8]) -> Option<u64> {
    zstd_safe::get_frame_content_size(frame).expect("帧头应可解析")
}

#[test]
fn new_frames_omit_content_size_and_match_encode_all_header_layout() {
    // 对照组：默认参数的 bulk 压缩器会写原始大小，证明下面的检查能识别差异
    let probe = vec![1u8; 4096];
    let with_fcs = zstd::bulk::compress(&probe, i32::from(LEVEL)).unwrap();
    assert_eq!(content_size(&with_fcs), Some(4096));

    let mut windows: BTreeMap<(u64, u64), usize> = BTreeMap::new();
    let mut block_kinds: BTreeMap<(Vec<u8>, Vec<u8>), usize> = BTreeMap::new();
    let mut sizes = (0usize, 0usize);
    for n in [1usize, 8, 64, 127] {
        let (frames, _) = program(n, 40);
        let bytes = write_new(n, &frames);
        let u = unis(n);
        for ((_, packed, _), (_, f)) in raw_chunks(&bytes).iter().zip(&frames) {
            let raw = raw_payload(&u, f);
            let legacy = zstd::encode_all(&raw[..], i32::from(LEVEL)).unwrap();
            // 公开的 `compress()` 与写入端产物逐字节相同
            assert_eq!(
                &artrec_core::compress(CompressAlgo::Zstd, LEVEL, &raw).unwrap(),
                packed
            );

            // 不写原始大小：与 encode_all 一样是"未知"
            assert_eq!(content_size(packed), None);
            assert_eq!(content_size(&legacy), None);

            let new_h = ZstdHeader::parse(packed);
            let old_h = ZstdHeader::parse(&legacy);
            // 帧头描述字节完全一致：FCS 标志 0、非单段、无校验和、无字典 ID
            assert_eq!(new_h.fhd, old_h.fhd, "Frame_Header_Descriptor 应一致");
            assert_eq!(new_h.fhd, 0x00);
            assert_eq!(
                (
                    new_h.fcs_flag,
                    new_h.single_segment,
                    new_h.checksum,
                    new_h.dict_id_flag
                ),
                (0, false, false, 0)
            );
            assert_eq!(new_h.header_len, 6, "魔数 4 + FHD 1 + Window_Descriptor 1");
            assert_eq!(new_h.header_len, old_h.header_len);
            // 唯一差异：窗口大小。新帧窗口能容纳整帧（单块），且不大于旧帧
            let (nw, ow) = (new_h.window_size().unwrap(), old_h.window_size().unwrap());
            assert!(
                nw >= raw.len() as u64,
                "窗口 {nw} 应能容纳 {} 字节",
                raw.len()
            );
            assert!(nw <= ow, "新窗口 {nw} 不应大于旧窗口 {ow}");
            *windows.entry((nw, ow)).or_default() += 1;

            let nb: Vec<u8> = blocks(packed, &new_h).iter().map(|b| b.0).collect();
            let ob: Vec<u8> = blocks(&legacy, &old_h).iter().map(|b| b.0).collect();
            *block_kinds.entry((nb, ob)).or_default() += 1;
            sizes.0 += packed.len();
            sizes.1 += legacy.len();
        }
    }
    // 供报告引用：`cargo test -p artrec-core --test compat -- --nocapture`
    println!("窗口大小分布 (新, 旧) -> 帧数: {windows:?}");
    println!("块类型序列 (新, 旧) -> 帧数（0=Raw 1=RLE 2=Compressed）: {block_kinds:?}");
    println!("压缩后总字节 新 {} / 旧 {}", sizes.0, sizes.1);
}

#[test]
fn reader_reads_legacy_encode_all_file() {
    for n in [1usize, 8, 64] {
        let (frames, states) = program(n, 60);
        let (bytes, _) = write_legacy(n, &frames);
        let u = unis(n);
        let r = ArtRecReader::open(bytes).unwrap();
        let mut raw = Vec::new();
        let mut walk = r.zero_buffers();
        for (i, (t, f)) in frames.iter().enumerate() {
            let hdr = r.read_chunk_into(i, &mut raw).unwrap();
            assert_eq!(raw, raw_payload(&u, f), "n={n} i={i}");
            let (hdr2, raw2) = r.read_chunk(i).unwrap();
            assert_eq!((hdr2, &raw2), (hdr, &raw));
            r.apply_chunk_into(&mut walk, &hdr, &raw).unwrap();
            assert_eq!(walk, states[i], "顺序应用 n={n} i={i}");
            assert_eq!(
                r.resolve_frame(i).unwrap(),
                states[i],
                "随机定位 n={n} i={i}"
            );
            assert_eq!(r.frame_at(*t).unwrap().unwrap(), states[i]);
        }
    }
}

#[test]
fn reader_tolerates_bad_chunk_cmp_len_like_legacy_reader() {
    // 旧读取端完全以块头为准、忽略索引里的 chunk_cmp_len；新读取端交叉校验失败时须回退
    let n = 4;
    let (frames, states) = program(n, 30);
    let (good, index) = write_legacy(n, &frames);
    let h = FileHeader::from_bytes(&good).unwrap();
    let cases: [fn(u16) -> u16; 4] = [
        |_| 0,        // 不足块头
        |l| l - 1,    // 偏小
        |l| l + 7,    // 偏大但仍在文件内
        |_| u16::MAX, // 越过文件末尾
    ];
    for (k, bad_len) in cases.iter().enumerate() {
        let mut bytes = good.clone();
        for (i, fi) in index.iter().enumerate() {
            let patched = FrameIndex {
                chunk_cmp_len: bad_len(fi.chunk_cmp_len),
                ..*fi
            };
            let off = h.frame_index_offset as usize + i * FRAMEINDEX_SIZE as usize;
            bytes[off..off + FRAMEINDEX_SIZE as usize].copy_from_slice(&patched.to_bytes());
        }
        let r = ArtRecReader::open(bytes).unwrap();
        for (i, want) in states.iter().enumerate() {
            assert_eq!(&r.resolve_frame(i).unwrap(), want, "case={k} i={i}");
        }
    }
}

#[test]
fn with_source_matches_original_reader() {
    let n = 16;
    let (frames, states) = program(n, 120);
    let bytes = write_new(n, &frames);
    let base = ArtRecReader::open(bytes.clone()).unwrap();
    let cursor = base.with_source(Cursor::new(bytes.clone())).unwrap();
    let ahead = base
        .with_source(ReadAhead::new(Cursor::new(bytes.clone()), 4096))
        .unwrap();
    // 头、Universe 表一致；索引共享同一份内存
    assert_eq!(cursor.header(), base.header());
    assert_eq!(cursor.unis(), base.unis());
    assert!(std::ptr::eq(cursor.index(), base.index()));
    assert!(std::ptr::eq(ahead.index(), base.index()));
    assert_eq!(ahead.file_len(), base.file_len());

    let mut got = Vec::new();
    let mut expect = Vec::new();
    for (i, state) in states.iter().enumerate() {
        let want = base.read_chunk(i).unwrap();
        assert_eq!(cursor.read_chunk(i).unwrap(), want);
        assert_eq!(ahead.read_chunk_into(i, &mut got).unwrap(), want.0);
        assert_eq!(got, want.1);
        assert_eq!(&cursor.resolve_frame(i).unwrap(), state);
        assert_eq!(&ahead.resolve_frame(i).unwrap(), state);
    }
    // 倒序 / 跳跃访问（ReadAhead 窗口外 seek）
    for i in (0..frames.len()).rev().step_by(7) {
        ahead.read_chunk_into(i, &mut got).unwrap();
        base.read_chunk_into(i, &mut expect).unwrap();
        assert_eq!(got, expect);
    }
}

#[test]
fn with_source_rejects_length_mismatch() {
    let (frames, _) = program(2, 5);
    let bytes = write_new(2, &frames);
    let base = ArtRecReader::open(bytes.clone()).unwrap();
    let len = bytes.len() as u64;

    let shorter = Cursor::new(bytes[..bytes.len() - 1].to_vec());
    match base.with_source(shorter) {
        Err(ArtRecError::SourceLenMismatch { expected, actual }) => {
            assert_eq!((expected, actual), (len, len - 1));
        }
        other => panic!("期望 SourceLenMismatch，实际 {other:?}"),
    }
    let mut longer = bytes.clone();
    longer.push(0);
    assert!(matches!(
        base.with_source(Cursor::new(longer)),
        Err(ArtRecError::SourceLenMismatch { expected, actual }) if expected == len && actual == len + 1
    ));
}

#[test]
fn with_source_on_disk_file_and_across_threads() {
    let n = 8;
    let (frames, states) = program(n, 200);
    let bytes = write_new(n, &frames);
    let dir = std::env::temp_dir().join(format!("artrec-compat-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("shared.artrec");
    std::fs::write(&path, &bytes).unwrap();

    let base = ArtRecReader::open_file(&path).unwrap();
    // 顺序扫描：ReadAhead（小窗口以覆盖多次重新填充）
    let scan = base
        .with_source(ReadAhead::new(
            std::fs::File::open(&path).unwrap(),
            8 * 1024,
        ))
        .unwrap();
    let mut walk = scan.zero_buffers();
    let mut raw = Vec::new();
    for (i, want) in states.iter().enumerate() {
        let hdr = scan.read_chunk_into(i, &mut raw).unwrap();
        scan.apply_chunk_into(&mut walk, &hdr, &raw).unwrap();
        assert_eq!(&walk, want, "i={i}");
    }

    // 并行：在持有原读取器的线程上派生，再移交给工作线程
    let workers = 4;
    let readers: Vec<_> = (0..workers)
        .map(|_| {
            base.with_source(std::fs::File::open(&path).unwrap())
                .unwrap()
        })
        .collect();
    let handles: Vec<_> = readers
        .into_iter()
        .enumerate()
        .map(|(w, r)| {
            std::thread::spawn(move || {
                (w..r.index().len())
                    .step_by(workers)
                    .map(|i| (i, r.resolve_frame(i).unwrap()))
                    .collect::<Vec<_>>()
            })
        })
        .collect();
    let mut seen = 0;
    for h in handles {
        for (i, f) in h.join().unwrap() {
            assert_eq!(f, states[i], "i={i}");
            seen += 1;
        }
    }
    assert_eq!(seen, states.len());

    drop((base, scan));
    std::fs::remove_dir_all(&dir).unwrap();
}
