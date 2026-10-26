//! 日志环形缓冲实现：基于 `esp_log_set_vprintf` 的 tee。

#include "artcore/log_ring.hpp"

#include <array>
#include <cstdarg>
#include <cstdio>
#include <mutex>

#include "esp_log.h"

namespace artcore::log_ring {

namespace {

/// 环形缓冲容量（字节）。约 16 KiB，足够留存最近数百行日志。
constexpr std::size_t kCapacity = 16 * 1024;

/// 单条日志格式化后的最大长度。
constexpr std::size_t kLineMax = 512;

std::mutex g_mutex;
std::array<char, kCapacity> g_buf{};
/// 写游标（下一个写入位置）。
std::size_t g_head = 0;
/// 当前已占用字节数（<= kCapacity）。
std::size_t g_len = 0;
/// 原始 vprintf，用于继续输出到串口。
vprintf_like_t g_prev = nullptr;
bool g_installed = false;

/// 向环形缓冲追加一段字节，满则覆盖最旧内容。
void append(const char* data, std::size_t n) {
    if (n >= kCapacity) {
        // 超长单条只保留尾部 kCapacity 字节。
        data += (n - kCapacity);
        n = kCapacity;
    }
    for (std::size_t i = 0; i < n; ++i) {
        g_buf[g_head] = data[i];
        g_head = (g_head + 1) % kCapacity;
    }
    g_len = (g_len + n > kCapacity) ? kCapacity : (g_len + n);
}

/// tee 回调：格式化到临时栈缓冲 → 追加到环形缓冲 → 转发原 vprintf。
int tee_vprintf(const char* fmt, va_list args) {
    // 先转发到原输出（需要复制 va_list，因为 vsnprintf 会消费它）。
    va_list args_copy;
    va_copy(args_copy, args);
    int ret = g_prev ? g_prev(fmt, args) : 0;

    char line[kLineMax];
    int written = vsnprintf(line, sizeof(line), fmt, args_copy);
    va_end(args_copy);
    if (written > 0) {
        std::size_t n = (static_cast<std::size_t>(written) < sizeof(line))
                            ? static_cast<std::size_t>(written)
                            : sizeof(line) - 1;
        std::lock_guard<std::mutex> lock(g_mutex);
        append(line, n);
    }
    return ret;
}

}  // namespace

void install() {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_installed) {
        return;
    }
    g_prev = esp_log_set_vprintf(&tee_vprintf);
    g_installed = true;
}

std::string snapshot() {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_len == 0) {
        return {};
    }
    std::string out;
    out.reserve(g_len);
    // 起点 = head 回退 len（环形）。
    std::size_t start = (g_head + kCapacity - g_len) % kCapacity;
    for (std::size_t i = 0; i < g_len; ++i) {
        out.push_back(g_buf[(start + i) % kCapacity]);
    }
    return out;
}

void clear() {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_head = 0;
    g_len = 0;
}

}  // namespace artcore::log_ring
