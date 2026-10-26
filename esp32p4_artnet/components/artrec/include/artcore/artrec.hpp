//! `.artrec` 灯光节目文件解析与随机定位（回放端，只读）。
//!
//! 对齐《ArtRec 灯光节目录制文件规范 v1.0》与上位机 `artrec-core` 的权威实现：
//! 大端字节序、固定文件头、Universe 描述表、升序帧索引、Chunk 块池、Zstd 压缩、
//! CRC16-CCITT 校验（对**解压后**的原始数据）、二分查找随机定位。
//!
//! # 取舍
//!
//! - 本回放端**不支持差分帧**：文件头 `flags` 置了 `ALLOW_DIFF_FRAME` 位时拒绝打开。
//! - 文件头按偏移字段定位各分区，兼容 64 字节与 88 字节两种头尺寸。
//! - 同时支持大端（`endian_tag=0xAA55`）与小端（`0x55AA`）存储。
//! - 文件以只读打开，配合 FATFS fast seek（CLMT）使 `lseek` 近 O(1)。

#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <vector>

#include "artcore/result.hpp"
#include "artcore/zstd_dec.hpp"

namespace artcore::artrec {

/// 魔数 `'A','R','T','R'`。
inline constexpr uint8_t kMagic[4] = {'A', 'R', 'T', 'R'};
/// 字节序标记：大端。
inline constexpr uint16_t kEndianBE = 0xAA55;
/// 字节序标记：小端。
inline constexpr uint16_t kEndianLE = 0x55AA;
/// 文件头固定写入尺寸（上位机实现为 64 字节）。
inline constexpr uint32_t kHeaderSize = 64;
/// 解析文件头所需的最小字节数（读到 `chunk_pool_offset` 末尾）。
inline constexpr uint32_t kHeaderMinParse = 54;
/// 单条 Universe 描述字节数。
inline constexpr uint32_t kUniDescSize = 16;
/// 单条帧索引字节数。
inline constexpr uint32_t kFrameIndexSize = 16;
/// Chunk 头字节数。
inline constexpr uint32_t kChunkHdrSize = 8;
/// 本解析器支持的最高主版本。
inline constexpr uint16_t kSupportedMajor = 1;

/// 全局标志位：推荐循环播放。
inline constexpr uint32_t kFlagLoop = 1u << 0;
/// 全局标志位：附带 SMPTE 扩展块。
inline constexpr uint32_t kFlagSmpte = 1u << 1;
/// 全局标志位：允许差分帧（本回放端不支持，遇到即拒绝）。
inline constexpr uint32_t kFlagDiffFrame = 1u << 2;

/// 压缩算法：无压缩。
inline constexpr uint8_t kCompressNone = 0;
/// 压缩算法：Zstd。
inline constexpr uint8_t kCompressZstd = 1;

/// Chunk 类型：全量帧。
inline constexpr uint16_t kChunkFull = 0;
/// Chunk 类型：差分增量帧。
inline constexpr uint16_t kChunkDiff = 1;

/// Universe 数上限（规范 §4：net 0~127、subuni 0~15 → universe ≤ 2047，
/// 但单帧全量 Payload ≤ 65527 字节约束下，单文件 Universe 数 ≤ 127）。
inline constexpr uint32_t kMaxUniverseCount = 127;

/// 帧数上限（防御性）：
/// ESP32-P4 为 32 位目标，`frame_count * kFrameIndexSize` 若用 32 位计算会回绕，
/// 恶意文件可借超大帧数触发越界读或巨量分配（OOM 崩溃）。此上限既杜绝 32 位乘法
/// 回绕（1e6 * 16 = 1.6e7 远小于 2^32），又把索引表内存约束在 ~16MB 以内；
/// 真实节目远达不到此量级。精确边界另由 [`header_regions_valid`] 按实际文件大小校验。
inline constexpr uint32_t kMaxFrameCount = 1'000'000;

/// Universe 描述条目。
struct UniDesc {
    /// ArtNet Net（0~127）。
    uint16_t net = 0;
    /// ArtNet SubUni（0~15）。
    uint16_t subuni = 0;
    /// 完整 Universe 编号 = net*16 + subuni。
    uint16_t universe = 0;
    /// DMX 通道长度（标准 512，支持短帧）。
    uint16_t dmx_len = 0;
};

/// 帧索引条目。
struct FrameIndex {
    /// 相对节目起点的时间戳（微秒）。
    uint64_t time_us = 0;
    /// Chunk 在块池内的相对偏移（相对 `chunk_pool_offset`）。
    uint32_t chunk_pos = 0;
    /// 该 Chunk 总字节大小（ChunkHdr + 压缩 Payload）。
    uint16_t chunk_cmp_len = 0;
};

/// Chunk 头。
struct ChunkHdr {
    /// 0=全量帧，1=差分增量帧。
    uint16_t chunk_type = 0;
    /// 解压后原始 Payload 总字节数。
    uint16_t payload_raw_sz = 0;
    /// 压缩后 Payload 字节数（不含 8 字节头）。
    uint16_t payload_cmp_sz = 0;
    /// CRC16-CCITT，仅校验（解压后的）Payload。
    uint16_t crc16 = 0;
};

/// 解析出的文件头关键字段。
struct FileHeader {
    /// 主版本。
    uint16_t ver_major = 0;
    /// 次版本。
    uint16_t ver_minor = 0;
    /// 全局标志位。
    uint32_t flags = 0;
    /// 节目总时长（微秒）。
    uint64_t total_duration_us = 0;
    /// Universe 描述条目数。
    uint32_t universe_count = 0;
    /// 帧索引条目数。
    uint32_t frame_count = 0;
    /// B 区偏移。
    uint32_t universe_desc_offset = 0;
    /// C 区偏移。
    uint32_t frame_index_offset = 0;
    /// D 区偏移。
    uint32_t chunk_pool_offset = 0;
    /// 压缩算法（0/1）。
    uint8_t compress_algo = 0;
    /// 压缩等级。
    uint8_t compress_level = 0;
    /// 文件是否以小端存储（需读取时字节反转）。
    bool little_endian = false;
};

/// 从文件头前若干字节解析 [`FileHeader`]（纯函数，便于单测）。
///
/// # Arguments
///
/// * `head` - 文件起始至少 [`kHeaderMinParse`] 字节。
///
/// # Returns
///
/// 解析并通过基础合法性校验的文件头。
///
/// # Errors
///
/// - 字节不足、magic 不符、字节序标记非法、主版本过高、压缩算法未知，
///   或置位了不支持的差分帧标志时返回 [`Status::BadFile`]。
[[nodiscard]] Result<FileHeader> parse_header(std::span<const uint8_t> head) noexcept;

/// 校验文件头声明的各分区偏移 / 长度是否均落在给定文件大小之内（纯函数，便于单测）。
///
/// 用 64 位计算 `count * entry_size`，杜绝 32 位目标上的乘法回绕；并确保 Universe 表、
/// 帧索引表、Chunk 块池起点都不越过文件末尾，防止恶意 / 损坏文件触发越界读或巨量分配。
///
/// # Arguments
///
/// * `h` - 已通过 [`parse_header`] 的文件头。
/// * `file_size` - 文件实际字节数（通常由 `fstat` 得到）。
///
/// # Returns
///
/// 各分区均合法返回 `true`；任一越界 / 回绕返回 `false`。
[[nodiscard]] bool header_regions_valid(const FileHeader& h, uint64_t file_size) noexcept;

/// 只读打开的 `.artrec` 文件：持有索引表并支持按时间随机定位。
class ArtRecFile {
public:
    ArtRecFile() = default;
    ~ArtRecFile();

    ArtRecFile(const ArtRecFile&) = delete;
    ArtRecFile& operator=(const ArtRecFile&) = delete;
    ArtRecFile(ArtRecFile&& other) noexcept;
    ArtRecFile& operator=(ArtRecFile&& other) noexcept;

    /// 以只读方式打开并解析文件头、Universe 表、帧索引。
    ///
    /// # Arguments
    ///
    /// * `path` - 文件绝对路径（如 `/sdcard/programs/xxx.artrec`）。
    ///
    /// # Errors
    ///
    /// - 打开失败返回 [`Status::NotFound`] 或 [`Status::IoError`]。
    /// - 头 / 索引非法返回 [`Status::BadFile`]。
    [[nodiscard]] Result<void> open(const char* path) noexcept;

    /// 关闭文件（析构亦会调用）。
    void close() noexcept;

    /// 是否已打开。
    [[nodiscard]] bool is_open() const noexcept { return fd_ >= 0; }

    /// 文件头。
    [[nodiscard]] const FileHeader& header() const noexcept { return hdr_; }
    /// Universe 描述表（顺序即 Payload 拼接顺序）。
    [[nodiscard]] const std::vector<UniDesc>& universes() const noexcept { return unis_; }
    /// 帧索引表。
    [[nodiscard]] const std::vector<FrameIndex>& index() const noexcept { return idx_; }
    /// 节目总时长（微秒）。
    [[nodiscard]] uint64_t duration_us() const noexcept { return hdr_.total_duration_us; }
    /// 帧数。
    [[nodiscard]] std::size_t frame_count() const noexcept { return idx_.size(); }
    /// 单帧全量 Payload 字节数（各 Universe dmx_len 之和）。
    [[nodiscard]] std::size_t full_payload_size() const noexcept { return full_payload_; }
    /// 文件是否推荐循环播放（`LOOP_PLAY` 标志）。
    [[nodiscard]] bool loop_recommended() const noexcept { return (hdr_.flags & kFlagLoop) != 0; }

    /// 二分查找：满足 `index[i].time_us <= now_us` 的最大 `i`。
    ///
    /// # Arguments
    ///
    /// * `now_us` - 当前播放相对时间（微秒）。
    ///
    /// # Returns
    ///
    /// 命中帧下标；`now_us` 早于首帧时返回 `std::nullopt`。
    [[nodiscard]] std::optional<std::size_t> frame_at_or_before(uint64_t now_us) const noexcept;

    /// 读取第 `i` 帧：读 Chunk、解压、校验 CRC，结果写入 `raw`。
    ///
    /// 所有全量帧天然是关键帧，无需回溯。
    ///
    /// # Arguments
    ///
    /// * `i` - 帧下标。
    /// * `chunk_scratch` - 复用的 Chunk 读入缓冲（含头 + 压缩 Payload）。
    /// * `raw` - 输出，解压后的原始 Payload（按 Universe 顺序拼接），会被 resize。
    /// * `decoder` - 复用的 Zstd 解码器；无压缩文件可传 `nullptr`。
    ///
    /// # Errors
    ///
    /// - 下标越界返回 [`Status::InvalidArg`]。
    /// - 读失败返回 [`Status::IoError`]。
    /// - 差分帧、CRC 不符、解压失败、长度不符返回 [`Status::BadFile`]。
    [[nodiscard]] Result<void> read_frame(std::size_t i, std::vector<uint8_t>& chunk_scratch,
                                          std::vector<uint8_t>& raw,
                                          ZstdDecoder* decoder) noexcept;

private:
    /// 在绝对偏移 `off` 处精确读取 `n` 字节到 `buf`。
    [[nodiscard]] Result<void> pread_exact(uint64_t off, uint8_t* buf, std::size_t n) noexcept;

    int fd_ = -1;
    FileHeader hdr_{};
    std::vector<UniDesc> unis_;
    std::vector<FrameIndex> idx_;
    std::size_t full_payload_ = 0;
};

}  // namespace artcore::artrec
