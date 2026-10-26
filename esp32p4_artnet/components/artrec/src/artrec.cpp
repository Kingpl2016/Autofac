//! `.artrec` 解析与随机定位实现。

#include "artcore/artrec.hpp"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstring>
#include <utility>

#include "artcore/bytes.hpp"
#include "artcore/crc16.hpp"

namespace artcore::artrec {

namespace {

/// 按文件字节序读取 `uint16`。
uint16_t rd16(const uint8_t* p, bool le) noexcept {
    return le ? rd_le16(p) : rd_be16(p);
}

/// 按文件字节序读取 `uint32`。
uint32_t rd32(const uint8_t* p, bool le) noexcept {
    if (!le) {
        return rd_be32(p);
    }
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

/// 按文件字节序读取 `uint64`。
uint64_t rd64(const uint8_t* p, bool le) noexcept {
    uint64_t v = 0;
    if (le) {
        for (int i = 7; i >= 0; --i) {
            v = (v << 8) | p[i];
        }
    } else {
        for (int i = 0; i < 8; ++i) {
            v = (v << 8) | p[i];
        }
    }
    return v;
}

}  // namespace

Result<FileHeader> parse_header(std::span<const uint8_t> head) noexcept {
    if (head.size() < kHeaderMinParse) {
        return err(Status::BadFile);
    }
    const uint8_t* b = head.data();
    if (std::memcmp(b, kMagic, 4) != 0) {
        return err(Status::BadFile);
    }
    // 字节序标记以大端读出判断（0xAA55 / 0x55AA 本身对称，直接比对两种）。
    const uint16_t tag = rd_be16(b + 4);
    bool le;
    if (tag == kEndianBE) {
        le = false;
    } else if (tag == kEndianLE) {
        le = true;
    } else {
        return err(Status::BadFile);
    }

    FileHeader h{};
    h.little_endian = le;
    h.ver_major = rd16(b + 6, le);
    h.ver_minor = rd16(b + 8, le);
    h.flags = rd32(b + 10, le);
    // rec_start_us 在 b+14（8B），日志用，忽略
    h.total_duration_us = rd64(b + 22, le);
    h.universe_count = rd32(b + 30, le);
    h.frame_count = rd32(b + 34, le);
    h.universe_desc_offset = rd32(b + 38, le);
    h.frame_index_offset = rd32(b + 42, le);
    h.chunk_pool_offset = rd32(b + 46, le);
    h.compress_algo = b[50];
    h.compress_level = b[51];

    if (h.ver_major > kSupportedMajor) {
        return err(Status::BadFile);
    }
    if (h.compress_algo != kCompressNone && h.compress_algo != kCompressZstd) {
        return err(Status::BadFile);
    }
    // 本回放端不支持差分帧。
    if ((h.flags & kFlagDiffFrame) != 0) {
        return err(Status::BadFile);
    }
    if (h.universe_count == 0 || h.universe_count > kMaxUniverseCount) {
        return err(Status::BadFile);
    }
    // 帧数上限：杜绝 32 位乘法回绕与超大分配（精确边界由 header_regions_valid 校验）。
    if (h.frame_count > kMaxFrameCount) {
        return err(Status::BadFile);
    }
    return h;
}

bool header_regions_valid(const FileHeader& h, uint64_t file_size) noexcept {
    // [off, off+len) 是否整体落在文件内（减法前先比较，避免无符号下溢）。
    const auto region_ok = [file_size](uint64_t off, uint64_t len) noexcept {
        return off <= file_size && len <= file_size - off;
    };
    // 64 位乘法：即便 count 为 32 位最大值也不会回绕。
    const uint64_t uni_bytes = static_cast<uint64_t>(h.universe_count) * kUniDescSize;
    const uint64_t idx_bytes = static_cast<uint64_t>(h.frame_count) * kFrameIndexSize;
    if (!region_ok(h.universe_desc_offset, uni_bytes)) {
        return false;
    }
    if (!region_ok(h.frame_index_offset, idx_bytes)) {
        return false;
    }
    // Chunk 块池起点须在文件内；单个 Chunk 的具体读取由 pread_exact 的 EOF 判定兜底。
    if (h.chunk_pool_offset > file_size) {
        return false;
    }
    return true;
}

ArtRecFile::~ArtRecFile() { close(); }

ArtRecFile::ArtRecFile(ArtRecFile&& other) noexcept
    : fd_(other.fd_),
      hdr_(other.hdr_),
      unis_(std::move(other.unis_)),
      idx_(std::move(other.idx_)),
      full_payload_(other.full_payload_) {
    other.fd_ = -1;
}

ArtRecFile& ArtRecFile::operator=(ArtRecFile&& other) noexcept {
    if (this != &other) {
        close();
        fd_ = other.fd_;
        hdr_ = other.hdr_;
        unis_ = std::move(other.unis_);
        idx_ = std::move(other.idx_);
        full_payload_ = other.full_payload_;
        other.fd_ = -1;
    }
    return *this;
}

void ArtRecFile::close() noexcept {
    if (fd_ >= 0) {
        ::close(fd_);
        fd_ = -1;
    }
    unis_.clear();
    idx_.clear();
    full_payload_ = 0;
    hdr_ = FileHeader{};
}

Result<void> ArtRecFile::pread_exact(uint64_t off, uint8_t* buf, std::size_t n) noexcept {
    if (::lseek(fd_, static_cast<off_t>(off), SEEK_SET) < 0) {
        return err(Status::IoError);
    }
    std::size_t got = 0;
    while (got < n) {
        ssize_t r = ::read(fd_, buf + got, n - got);
        if (r < 0) {
            return err(Status::IoError);
        }
        if (r == 0) {
            return err(Status::BadFile);  // 提前到达文件尾
        }
        got += static_cast<std::size_t>(r);
    }
    return {};
}

Result<void> ArtRecFile::open(const char* path) noexcept {
    close();
    fd_ = ::open(path, O_RDONLY);
    if (fd_ < 0) {
        return err(Status::NotFound);
    }

    // 读文件头（固定 64 字节，按偏移字段解析）。
    uint8_t head[kHeaderSize];
    if (auto r = pread_exact(0, head, kHeaderSize); !r) {
        close();
        return err(r.error());
    }
    auto ph = parse_header(std::span<const uint8_t>(head, kHeaderSize));
    if (!ph) {
        close();
        return err(ph.error());
    }
    hdr_ = *ph;
    const bool le = hdr_.little_endian;

    // 用实际文件大小校验各分区偏移 / 长度，必须在任何 resize / 读取之前，
    // 以阻止恶意文件（声明超大帧数 / 越界偏移）触发巨量分配或越界读。
    {
        struct stat st;
        if (::fstat(fd_, &st) != 0 || st.st_size < 0) {
            close();
            return err(Status::IoError);
        }
        if (!header_regions_valid(hdr_, static_cast<uint64_t>(st.st_size))) {
            close();
            return err(Status::BadFile);
        }
    }

    // Universe 描述表。
    unis_.resize(hdr_.universe_count);
    {
        std::vector<uint8_t> buf(static_cast<std::size_t>(hdr_.universe_count) * kUniDescSize);
        if (auto r = pread_exact(hdr_.universe_desc_offset, buf.data(), buf.size()); !r) {
            close();
            return err(r.error());
        }
        full_payload_ = 0;
        for (uint32_t i = 0; i < hdr_.universe_count; ++i) {
            const uint8_t* p = buf.data() + static_cast<std::size_t>(i) * kUniDescSize;
            UniDesc u{};
            u.net = rd16(p + 0, le);
            u.subuni = rd16(p + 2, le);
            u.universe = rd16(p + 4, le);
            u.dmx_len = rd16(p + 6, le);
            if (u.dmx_len == 0 || u.dmx_len > 512) {
                close();
                return err(Status::BadFile);
            }
            unis_[i] = u;
            full_payload_ += u.dmx_len;
        }
    }

    // 帧索引表（可能为 0 帧的空节目；此处要求至少 1 帧）。
    if (hdr_.frame_count == 0) {
        close();
        return err(Status::BadFile);
    }
    idx_.resize(hdr_.frame_count);
    {
        std::vector<uint8_t> buf(static_cast<std::size_t>(hdr_.frame_count) * kFrameIndexSize);
        if (auto r = pread_exact(hdr_.frame_index_offset, buf.data(), buf.size()); !r) {
            close();
            return err(r.error());
        }
        uint64_t prev = 0;
        for (uint32_t i = 0; i < hdr_.frame_count; ++i) {
            const uint8_t* p = buf.data() + static_cast<std::size_t>(i) * kFrameIndexSize;
            FrameIndex fi{};
            fi.time_us = rd64(p + 0, le);
            fi.chunk_pos = rd32(p + 8, le);
            fi.chunk_cmp_len = rd16(p + 12, le);
            if (i > 0 && fi.time_us < prev) {
                close();
                return err(Status::BadFile);  // 索引必须按时间升序
            }
            if (fi.chunk_cmp_len < kChunkHdrSize) {
                close();
                return err(Status::BadFile);
            }
            prev = fi.time_us;
            idx_[i] = fi;
        }
    }

    return {};
}

std::optional<std::size_t> ArtRecFile::frame_at_or_before(uint64_t now_us) const noexcept {
    if (idx_.empty() || now_us < idx_.front().time_us) {
        return std::nullopt;
    }
    std::size_t lo = 0;
    std::size_t hi = idx_.size();  // [lo, hi)
    // 找满足 time_us <= now_us 的最大下标。
    while (lo + 1 < hi) {
        std::size_t mid = lo + (hi - lo) / 2;
        if (idx_[mid].time_us <= now_us) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return lo;
}

Result<void> ArtRecFile::read_frame(std::size_t i, std::vector<uint8_t>& chunk_scratch,
                                    std::vector<uint8_t>& raw, ZstdDecoder* decoder) noexcept {
    if (i >= idx_.size()) {
        return err(Status::InvalidArg);
    }
    const FrameIndex& fi = idx_[i];
    const bool le = hdr_.little_endian;

    // 一次读入整个 Chunk（头 + 压缩 Payload）。
    const std::size_t chunk_len = fi.chunk_cmp_len;
    chunk_scratch.resize(chunk_len);
    const uint64_t off = static_cast<uint64_t>(hdr_.chunk_pool_offset) + fi.chunk_pos;
    if (auto r = pread_exact(off, chunk_scratch.data(), chunk_len); !r) {
        return err(r.error());
    }

    // 解析 Chunk 头。
    const uint8_t* h = chunk_scratch.data();
    ChunkHdr ch{};
    ch.chunk_type = rd16(h + 0, le);
    ch.payload_raw_sz = rd16(h + 2, le);
    ch.payload_cmp_sz = rd16(h + 4, le);
    ch.crc16 = rd16(h + 6, le);

    if (ch.chunk_type != kChunkFull) {
        return err(Status::BadFile);  // 不支持差分帧
    }
    if (static_cast<std::size_t>(kChunkHdrSize) + ch.payload_cmp_sz > chunk_len) {
        return err(Status::BadFile);
    }

    std::span<const uint8_t> payload(chunk_scratch.data() + kChunkHdrSize, ch.payload_cmp_sz);
    raw.resize(ch.payload_raw_sz);

    if (hdr_.compress_algo == kCompressNone) {
        if (ch.payload_cmp_sz != ch.payload_raw_sz) {
            return err(Status::BadFile);
        }
        std::memcpy(raw.data(), payload.data(), ch.payload_raw_sz);
    } else {
        // Zstd 解压。
        Result<std::size_t> dr =
            decoder ? decoder->decompress(std::span<uint8_t>(raw), payload)
                    : zstd_decompress(std::span<uint8_t>(raw), payload);
        if (!dr) {
            return err(Status::BadFile);
        }
        if (*dr != ch.payload_raw_sz) {
            return err(Status::BadFile);
        }
    }

    // 全量帧的原始长度应等于各 Universe dmx_len 之和。
    if (raw.size() != full_payload_) {
        return err(Status::BadFile);
    }

    // CRC 校验（对解压后的原始 Payload）。
    const uint16_t actual = crc16_ccitt(raw.data(), raw.size());
    if (actual != ch.crc16) {
        return err(Status::BadFile);
    }

    return {};
}

}  // namespace artcore::artrec
