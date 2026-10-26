//! Catch2 测试运行器入口。

#include "catch2/catch_session.hpp"

extern "C" void app_main(void) {
    int argc = 1;
    const char* argv[] = {"artnet_core_tests"};
    Catch::Session().run(argc, const_cast<char**>(argv));
}
