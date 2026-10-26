//! 定容环形缓冲（单生产者 / 单消费者场景下使用，索引逻辑为纯逻辑便于单测）。
//!
//! 设计要点：
//! - `clear()` 只重置读写指针，**不析构槽内元素**，使槽内 `std::vector` 等容器保留已分配
//!   容量，供预读复用、避免热路径反复分配。
//! - 提供 `push_slot()` 返回待写槽的引用，支持「就地解码进槽」而非先构造再拷入。
//! - 本类自身不加锁；在 Player 的预读中由 `pf_mutex_` 串行化访问（单生产者单消费者、
//!   临界区极短），比无锁实现更易验证正确性。

#pragma once

#include <array>
#include <cstddef>

namespace artcore {

/// 定容环形缓冲。
///
/// # Type Parameters
///
/// * `T` - 元素类型。
/// * `N` - 容量（必须 >= 1）。
template <typename T, std::size_t N>
class RingBuffer {
    static_assert(N >= 1, "RingBuffer 容量必须 >= 1");

public:
    /// 是否为空。
    [[nodiscard]] bool empty() const noexcept { return count_ == 0; }
    /// 是否已满。
    [[nodiscard]] bool full() const noexcept { return count_ == N; }
    /// 当前元素数。
    [[nodiscard]] std::size_t size() const noexcept { return count_; }
    /// 容量。
    [[nodiscard]] static constexpr std::size_t capacity() noexcept { return N; }

    /// 取下一个待写槽的引用并推进写指针（前置：`!full()`）。调用方随后就地写入该槽。
    [[nodiscard]] T& push_slot() noexcept {
        const std::size_t w = (head_ + count_) % N;
        ++count_;
        return buf_[w];
    }

    /// 队首元素引用（前置：`!empty()`）。
    [[nodiscard]] T& front() noexcept { return buf_[head_]; }
    /// 队首元素只读引用（前置：`!empty()`）。
    [[nodiscard]] const T& front() const noexcept { return buf_[head_]; }

    /// 弹出队首（空时无操作）。不析构元素，仅推进读指针。
    void pop() noexcept {
        if (count_ > 0) {
            head_ = (head_ + 1) % N;
            --count_;
        }
    }

    /// 清空（只重置读写指针，保留槽内元素及其已分配容量）。
    void clear() noexcept {
        head_ = 0;
        count_ = 0;
    }

private:
    std::array<T, N> buf_{};
    std::size_t head_ = 0;   ///< 读指针
    std::size_t count_ = 0;  ///< 元素数
};

}  // namespace artcore
