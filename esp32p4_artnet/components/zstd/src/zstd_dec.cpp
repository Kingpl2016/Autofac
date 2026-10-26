//! Zstd 解压封装实现。

#include "artcore/zstd_dec.hpp"

#include <utility>

#include "zstd.h"

namespace artcore {

Result<std::size_t> zstd_decompress(std::span<uint8_t> dst, std::span<const uint8_t> src) noexcept {
    const std::size_t n =
        ZSTD_decompress(dst.data(), dst.size(), src.data(), src.size());
    if (ZSTD_isError(n) != 0) {
        return err(Status::BadFile);
    }
    return n;
}

ZstdDecoder::ZstdDecoder() noexcept : ctx_(ZSTD_createDCtx()) {}

ZstdDecoder::~ZstdDecoder() {
    if (ctx_ != nullptr) {
        ZSTD_freeDCtx(static_cast<ZSTD_DCtx*>(ctx_));
    }
}

ZstdDecoder::ZstdDecoder(ZstdDecoder&& other) noexcept : ctx_(other.ctx_) {
    other.ctx_ = nullptr;
}

ZstdDecoder& ZstdDecoder::operator=(ZstdDecoder&& other) noexcept {
    if (this != &other) {
        if (ctx_ != nullptr) {
            ZSTD_freeDCtx(static_cast<ZSTD_DCtx*>(ctx_));
        }
        ctx_ = other.ctx_;
        other.ctx_ = nullptr;
    }
    return *this;
}

Result<std::size_t> ZstdDecoder::decompress(std::span<uint8_t> dst,
                                            std::span<const uint8_t> src) noexcept {
    if (ctx_ == nullptr) {
        return err(Status::BadFile);
    }
    const std::size_t n = ZSTD_decompressDCtx(static_cast<ZSTD_DCtx*>(ctx_), dst.data(),
                                              dst.size(), src.data(), src.size());
    if (ZSTD_isError(n) != 0) {
        return err(Status::BadFile);
    }
    return n;
}

}  // namespace artcore
