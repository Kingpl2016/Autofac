//! 定容环形缓冲索引逻辑测试。

#include <vector>

#include "artcore/ring_buffer.hpp"
#include "catch2/catch_test_macros.hpp"

using artcore::RingBuffer;

TEST_CASE("空 / 满 / 计数", "[ring]") {
    RingBuffer<int, 3> r;
    REQUIRE(r.empty());
    REQUIRE_FALSE(r.full());
    REQUIRE(r.size() == 0);
    r.push_slot() = 1;
    r.push_slot() = 2;
    r.push_slot() = 3;
    REQUIRE(r.full());
    REQUIRE(r.size() == 3);
    REQUIRE(r.front() == 1);
}

TEST_CASE("先进先出与绕回", "[ring]") {
    RingBuffer<int, 3> r;
    r.push_slot() = 10;
    r.push_slot() = 20;
    REQUIRE(r.front() == 10);
    r.pop();
    REQUIRE(r.front() == 20);
    // 绕回：再压两个，覆盖到物理起点。
    r.push_slot() = 30;
    r.push_slot() = 40;  // 此时 head 从 20 开始，物理环已绕
    REQUIRE(r.size() == 3);
    REQUIRE(r.front() == 20);
    r.pop();
    REQUIRE(r.front() == 30);
    r.pop();
    REQUIRE(r.front() == 40);
    r.pop();
    REQUIRE(r.empty());
}

TEST_CASE("空时 pop 安全", "[ring]") {
    RingBuffer<int, 2> r;
    r.pop();  // 不应崩溃
    REQUIRE(r.empty());
}

TEST_CASE("clear 保留槽内容量（vector 复用）", "[ring]") {
    RingBuffer<std::vector<int>, 2> r;
    auto& s0 = r.push_slot();
    s0.resize(100);
    const int* p = s0.data();
    r.clear();
    REQUIRE(r.empty());
    // clear 不析构槽元素，复用同一槽应保留已分配缓冲（容量不缩小）。
    auto& s1 = r.push_slot();
    REQUIRE(s1.capacity() >= 100);
    REQUIRE(s1.data() == p);  // 同一物理槽、同一缓冲
}
