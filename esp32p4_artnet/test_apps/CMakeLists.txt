# ArtNet Core 片上测试工程（Catch2）。
#
# 复用上级工程的组件：
#   idf.py -C test_apps set-target esp32p4
#   idf.py -C test_apps -p <PORT> flash monitor
#
# 测试覆盖纯逻辑：CRC16、Art-Net / sACN 打包、.artrec 头解析、文件名校验。

cmake_minimum_required(VERSION 3.22)

# 复用上级 components 目录。
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../components")

# 只构建 main 的依赖闭包（common/artrec/zstd/dmx_out/storage/catch2 等），
# 避免把整套固件组件（net→ip101、ota、api_server…）也拉进测试工程而要求其托管依赖。
set(COMPONENTS main)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(artnet_core_tests)
