//! ArtRec 格式集成测试：对齐规范 §13 示例偏移、round-trip、随机定位、CRC 容错与差分帧。

use std::io::Cursor;

use artrec_core::{
    decode_diff, ArtRecError, ArtRecReader, ArtRecWriter, ChunkHdr, CompressAlgo, DiffChange,
    FileHeader, FrameIndex, UniDesc, FLAG_DIFF_FRAME, FLAG_LOOP, HEADER_SIZE,
};

/// 构造一个 n 路、每路 512 通道、第 c 通道值为 `fill` 的缓冲集合。
fn buffers(n: usize, len: usize, fill: u8) -> Vec<Vec<u8>> {
    (0..n).map(|_| vec![fill; len]).collect()
}

#[test]
fn section_offsets_match_spec_example() {
    // §13：2 路 Universe（各 512），3 帧 → B=64, C=96, D=144
    let unis = vec![UniDesc::new(0, 0, 512), UniDesc::new(0, 1, 512)];
    let cur = Cursor::new(Vec::new());
    let mut w = ArtRecWriter::new(cur, unis, CompressAlgo::None, 0, 0, 0).unwrap();
    w.add_full_frame(0, &buffers(2, 512, 10)).unwrap();
    w.add_full_frame(25_000, &buffers(2, 512, 20)).unwrap();
    w.add_full_frame(50_000, &buffers(2, 512, 30)).unwrap();
    let cur = w.finish(50_000).unwrap();
    let bytes = cur.into_inner();

    let reader = ArtRecReader::open(bytes).unwrap();
    let h = reader.header();
    assert_eq!(h.universe_desc_offset, HEADER_SIZE); // 64
    assert_eq!(h.universe_count, 2);
    assert_eq!(h.frame_count, 3);
    assert_eq!(h.total_duration_us, 50_000);

    // 本实现物理排布为 A,B,D,C；chunk_pool_offset 紧随 B（= 64 + 2×16 = 96）
    assert_eq!(h.chunk_pool_offset, 96);
    // 帧索引时间戳
    let idx = reader.index();
    assert_eq!(idx[0].time_us, 0);
    assert_eq!(idx[1].time_us, 25_000);
    assert_eq!(idx[2].time_us, 50_000);
    // 第二帧的 chunk_pos 应等于第一帧 chunk 的长度
    assert_eq!(idx[1].chunk_pos, u32::from(idx[0].chunk_cmp_len));
}

#[test]
fn header_roundtrip_bytes() {
    let h = FileHeader {
        flags: FLAG_LOOP,
        rec_start_us: 123,
        total_duration_us: 456,
        universe_count: 2,
        frame_count: 3,
        universe_desc_offset: 64,
        frame_index_offset: 200,
        chunk_pool_offset: 96,
        compress_algo: CompressAlgo::Zstd,
        compress_level: 4,
        ver_major: 1,
        ver_minor: 0,
    };
    let bytes = h.to_bytes();
    assert_eq!(bytes.len(), HEADER_SIZE as usize);
    assert_eq!(&bytes[0..4], b"ARTR");
    let back = FileHeader::from_bytes(&bytes).unwrap();
    assert_eq!(back, h);
}

#[test]
fn unidesc_and_index_and_chunkhdr_roundtrip() {
    let u = UniDesc::new(3, 5, 512);
    assert_eq!(u.universe, 3 * 16 + 5);
    assert_eq!(UniDesc::from_bytes(&u.to_bytes()).unwrap(), u);

    let fi = FrameIndex {
        time_us: 999,
        chunk_pos: 120,
        chunk_cmp_len: 115,
    };
    assert_eq!(FrameIndex::from_bytes(&fi.to_bytes()).unwrap(), fi);

    let ch = ChunkHdr {
        chunk_type: 0,
        payload_raw_sz: 1024,
        payload_cmp_sz: 40,
        crc16: 0xABCD,
    };
    assert_eq!(ChunkHdr::from_bytes(&ch.to_bytes()).unwrap(), ch);
}

#[test]
fn full_frame_roundtrip_with_zstd() {
    let unis = vec![UniDesc::new(0, 0, 512), UniDesc::new(0, 1, 512)];
    let cur = Cursor::new(Vec::new());
    let mut w = ArtRecWriter::new(cur, unis, CompressAlgo::Zstd, 3, 0, 0).unwrap();

    let mut f0 = buffers(2, 512, 0);
    f0[0][10] = 200;
    f0[1][500] = 123;
    w.add_full_frame(0, &f0).unwrap();
    let mut f1 = buffers(2, 512, 0);
    f1[0][10] = 255;
    w.add_full_frame(25_000, &f1).unwrap();
    let bytes = w.finish(25_000).unwrap().into_inner();

    let reader = ArtRecReader::open(bytes).unwrap();
    let out0 = reader.frame_at(0).unwrap().unwrap();
    assert_eq!(out0[0][10], 200);
    assert_eq!(out0[1][500], 123);
    // now_us 落在两帧之间，应命中第一帧
    let mid = reader.frame_at(10_000).unwrap().unwrap();
    assert_eq!(mid[0][10], 200);
    // now_us=1 仍在首帧之后（首帧 t=0），命中首帧
    assert_eq!(reader.frame_at(1).unwrap().unwrap()[0][10], 200);
    // 命中第二帧
    let out1 = reader.frame_at(25_000).unwrap().unwrap();
    assert_eq!(out1[0][10], 255);
}

#[test]
fn frame_before_first_returns_none() {
    // 首帧在 t=1000，now_us=500 应早于首帧返回 None
    let unis = vec![UniDesc::new(0, 0, 512)];
    let cur = Cursor::new(Vec::new());
    let mut w = ArtRecWriter::new(cur, unis, CompressAlgo::None, 0, 0, 0).unwrap();
    w.add_full_frame(1000, &buffers(1, 512, 5)).unwrap();
    let reader = ArtRecReader::open(w.finish(1000).unwrap().into_inner()).unwrap();
    assert!(matches!(reader.frame_at(500), Ok(None)));
    assert_eq!(reader.find_index(500), None);
}

#[test]
fn seek_binary_search_picks_latest_not_after_now() {
    let unis = vec![UniDesc::new(0, 0, 512)];
    let cur = Cursor::new(Vec::new());
    let mut w = ArtRecWriter::new(cur, unis, CompressAlgo::None, 0, 0, 0).unwrap();
    for (i, t) in [0u64, 100, 200, 300, 400].into_iter().enumerate() {
        let mut b = buffers(1, 512, 0);
        b[0][0] = i as u8;
        w.add_full_frame(t, &b).unwrap();
    }
    let reader = finish_and_open(w, 400);
    assert_eq!(reader.find_index(0), Some(0));
    assert_eq!(reader.find_index(150), Some(1));
    assert_eq!(reader.find_index(250), Some(2));
    assert_eq!(reader.find_index(400), Some(4));
    assert_eq!(reader.find_index(10_000), Some(4));
}

fn finish_and_open(w: ArtRecWriter<Cursor<Vec<u8>>>, dur: u64) -> ArtRecReader {
    let bytes = w.finish(dur).unwrap().into_inner();
    ArtRecReader::open(bytes).unwrap()
}

#[test]
fn corrupted_crc_is_detected() {
    let unis = vec![UniDesc::new(0, 0, 512)];
    let cur = Cursor::new(Vec::new());
    let mut w = ArtRecWriter::new(cur, unis, CompressAlgo::None, 0, 0, 0).unwrap();
    w.add_full_frame(0, &buffers(1, 512, 7)).unwrap();
    let mut bytes = w.finish(0).unwrap().into_inner();

    // D 区紧随 B（chunk_pool_offset=80），ChunkHdr 8 字节后为 payload 首字节，篡改之
    let reader = ArtRecReader::open(bytes.clone()).unwrap();
    let pool = reader.header().chunk_pool_offset as usize;
    let payload_first = pool + artrec_core::CHUNKHDR_SIZE;
    bytes[payload_first] ^= 0xFF;

    let reader = ArtRecReader::open(bytes).unwrap();
    match reader.read_chunk(0) {
        Err(ArtRecError::CrcMismatch { .. }) => {}
        other => panic!("期望 CRC 校验失败，实际 {other:?}"),
    }
}

#[test]
fn bad_magic_rejected() {
    let mut bytes = vec![0u8; 64];
    bytes[0..4].copy_from_slice(b"XXXX");
    match ArtRecReader::open(bytes) {
        Err(ArtRecError::BadMagic(_)) => {}
        other => panic!("期望 BadMagic，实际 {other:?}"),
    }
}

#[test]
fn diff_frame_roundtrip() {
    let unis = vec![UniDesc::new(0, 0, 512), UniDesc::new(0, 1, 512)];
    let cur = Cursor::new(Vec::new());
    let mut w =
        ArtRecWriter::new(cur, unis, CompressAlgo::None, 0, FLAG_DIFF_FRAME, 0).unwrap();
    // 首帧全量
    let mut base = buffers(2, 512, 0);
    base[0][5] = 50;
    w.add_full_frame(0, &base).unwrap();
    // 差分帧：改 uni0 通道 5 与 uni1 通道 7
    let changes = vec![
        DiffChange { uni_idx: 0, ch_addr: 5, ch_val: 99 },
        DiffChange { uni_idx: 1, ch_addr: 7, ch_val: 42 },
    ];
    w.add_diff_frame(10_000, &changes).unwrap();
    let bytes = w.finish(10_000).unwrap().into_inner();

    let reader = ArtRecReader::open(bytes).unwrap();
    // 首帧
    let f0 = reader.frame_at(0).unwrap().unwrap();
    assert_eq!(f0[0][5], 50);
    // 差分帧：在首帧基础上应用变更
    let f1 = reader.frame_at(10_000).unwrap().unwrap();
    assert_eq!(f1[0][5], 99);
    assert_eq!(f1[1][7], 42);
}

#[test]
fn decode_diff_matches_encode() {
    let changes = vec![
        DiffChange { uni_idx: 1, ch_addr: 100, ch_val: 7 },
        DiffChange { uni_idx: 2, ch_addr: 511, ch_val: 255 },
    ];
    let payload = artrec_core::encode_diff(&changes);
    assert_eq!(decode_diff(&payload).unwrap(), changes);
}

// ---------------------------------------------------------------------------
// Task 1：容量上限、Universe 编码与流式读取
// ---------------------------------------------------------------------------

use artrec_core::{FrameIndex as Fi, MAX_DIFF_CHANGES, MAX_UNIVERSE};

fn unis_n(n: u16) -> Vec<UniDesc> {
    (0..n).map(|u| UniDesc::from_universe(u, 512).unwrap()).collect()
}

#[test]
fn from_universe_maps_linear_number() {
    let u = UniDesc::from_universe(37, 512).unwrap();
    assert_eq!((u.net, u.subuni, u.universe), (2, 5, 37));
    let top = UniDesc::from_universe(MAX_UNIVERSE, 512).unwrap();
    assert_eq!(top.net, 127);
    assert_eq!(top.subuni, 15);
    assert!(matches!(
        UniDesc::from_universe(MAX_UNIVERSE + 1, 512),
        Err(ArtRecError::UniverseOutOfRange(_))
    ));
}

#[test]
fn writer_accepts_127_universes_and_rejects_128() {
    let ok = ArtRecWriter::new(Cursor::new(Vec::new()), unis_n(127), CompressAlgo::None, 0, 0, 0);
    assert!(ok.is_ok());
    let err = ArtRecWriter::new(Cursor::new(Vec::new()), unis_n(128), CompressAlgo::None, 0, 0, 0);
    assert!(matches!(err, Err(ArtRecError::PayloadTooLarge { .. })));
}

#[test]
fn writer_rejects_duplicate_universe() {
    let unis = vec![UniDesc::new(0, 1, 512), UniDesc::new(0, 1, 512)];
    let err = ArtRecWriter::new(Cursor::new(Vec::new()), unis, CompressAlgo::None, 0, 0, 0);
    assert!(matches!(err, Err(ArtRecError::DuplicateUniverse(1))));
}

#[test]
fn max_universe_file_roundtrips_without_truncation() {
    // 127 路、无压缩：8 + 65024 = 65032 字节，仍在 u16 范围内
    let cur = Cursor::new(Vec::new());
    let mut w = ArtRecWriter::new(cur, unis_n(127), CompressAlgo::None, 0, 0, 0).unwrap();
    let mut f = buffers(127, 512, 0);
    f[126][511] = 77;
    w.add_full_frame(0, &f).unwrap();
    let reader = ArtRecReader::open(w.finish(0).unwrap().into_inner()).unwrap();
    assert_eq!(reader.frame_at(0).unwrap().unwrap()[126][511], 77);
}

#[test]
fn writer_rejects_non_monotonic_time() {
    let unis = vec![UniDesc::new(0, 0, 512)];
    let mut w =
        ArtRecWriter::new(Cursor::new(Vec::new()), unis, CompressAlgo::None, 0, 0, 0).unwrap();
    w.add_full_frame(100, &buffers(1, 512, 1)).unwrap();
    let err = w.add_full_frame(50, &buffers(1, 512, 2)).unwrap_err();
    assert!(matches!(err, ArtRecError::NonMonotonicTime { prev: 100, now: 50 }));
}

#[test]
fn writer_rejects_oversized_diff() {
    let unis = vec![UniDesc::new(0, 0, 512)];
    let mut w = ArtRecWriter::new(
        Cursor::new(Vec::new()),
        unis,
        CompressAlgo::None,
        0,
        FLAG_DIFF_FRAME,
        0,
    )
    .unwrap();
    let changes = vec![DiffChange { uni_idx: 0, ch_addr: 0, ch_val: 1 }; MAX_DIFF_CHANGES + 1];
    assert!(matches!(
        w.add_diff_frame(0, &changes),
        Err(ArtRecError::ChunkTooLarge { .. })
    ));
}

#[test]
fn add_frame_returns_index_entry() {
    let unis = vec![UniDesc::new(0, 0, 512)];
    let mut w =
        ArtRecWriter::new(Cursor::new(Vec::new()), unis, CompressAlgo::None, 0, 0, 0).unwrap();
    let e0 = w.add_full_frame(0, &buffers(1, 512, 1)).unwrap();
    let e1 = w.add_full_frame(10, &buffers(1, 512, 2)).unwrap();
    assert_eq!(e0.chunk_pos, 0);
    assert_eq!(e1.chunk_pos, u32::from(e0.chunk_cmp_len));
    assert_eq!(w.frame_count(), 2);
    assert_eq!(w.last_time_us(), Some(10));
}

#[test]
fn streaming_reader_matches_memory_reader() {
    use std::io::Write;

    let unis = vec![UniDesc::new(0, 0, 512), UniDesc::new(0, 1, 512)];
    let mut w = ArtRecWriter::new(
        Cursor::new(Vec::new()),
        unis,
        CompressAlgo::Zstd,
        3,
        FLAG_DIFF_FRAME,
        0,
    )
    .unwrap();
    let mut base = buffers(2, 512, 0);
    base[1][3] = 9;
    w.add_full_frame(0, &base).unwrap();
    w.add_diff_frame(1000, &[DiffChange { uni_idx: 0, ch_addr: 8, ch_val: 44 }])
        .unwrap();
    let bytes = w.finish(1000).unwrap().into_inner();

    let dir = std::env::temp_dir().join(format!("artrec-core-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("t.artrec");
    std::fs::File::create(&path).unwrap().write_all(&bytes).unwrap();

    let mem = ArtRecReader::open(bytes).unwrap();
    let file = ArtRecReader::open_file(&path).unwrap();
    assert_eq!(file.file_len(), mem.file_len());
    for t in [0u64, 500, 1000, 5000] {
        assert_eq!(file.frame_at(t).unwrap(), mem.frame_at(t).unwrap());
    }
    drop(file);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn reader_rejects_oversized_counts_without_allocating() {
    // 构造合法文件后把 frame_count 篡改为极大值，应报截断而不是 OOM
    let unis = vec![UniDesc::new(0, 0, 512)];
    let mut w =
        ArtRecWriter::new(Cursor::new(Vec::new()), unis, CompressAlgo::None, 0, 0, 0).unwrap();
    w.add_full_frame(0, &buffers(1, 512, 1)).unwrap();
    let mut bytes = w.finish(0).unwrap().into_inner();
    bytes[34..38].copy_from_slice(&u32::MAX.to_be_bytes());
    assert!(matches!(
        ArtRecReader::open(bytes),
        Err(ArtRecError::Truncated(_))
    ));
}

#[test]
fn resume_then_finish_produces_readable_file() {
    // 模拟崩溃恢复：写两帧后丢弃 writer，用索引日志 resume 并收尾
    let unis = vec![UniDesc::new(0, 0, 512)];
    let mut w = ArtRecWriter::new(
        Cursor::new(Vec::new()),
        unis.clone(),
        CompressAlgo::None,
        0,
        0,
        0,
    )
    .unwrap();
    let journal: Vec<Fi> = vec![
        w.add_full_frame(0, &buffers(1, 512, 5)).unwrap(),
        w.add_full_frame(40, &buffers(1, 512, 6)).unwrap(),
    ];
    // 截取到 Chunk 池末尾，丢弃索引表与回填后的头部之后的内容，模拟崩溃遗留的 .part
    let pool_end = w.bytes_written() as usize;
    let crashed = w.finish(40).unwrap().into_inner()[..pool_end].to_vec();
    let w2 = ArtRecWriter::resume(Cursor::new(crashed), unis, CompressAlgo::None, 0, 0, 0, journal)
        .unwrap();
    let bytes = w2.finish(40).unwrap().into_inner();
    let reader = ArtRecReader::open(bytes).unwrap();
    assert_eq!(reader.header().frame_count, 2);
    assert_eq!(reader.frame_at(40).unwrap().unwrap()[0][0], 6);
}
