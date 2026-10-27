# ESP32-P4 Art-Net / sACN 节目回放核心板固件
#
# 目标板：Waveshare ESP32-P4-WIFI6-POE-ETH（IP101 PHY，SDIO3.0 TF 卡槽，32MB PSRAM）
# 工具链：ESP-IDF v6.1，C++（gnu++23 及以上，关异常 / 关 RTTI）
#
# 构建：
#   idf.py set-target esp32p4
#   idf.py build
#   idf.py -p <PORT> flash monitor
#
# 芯片版本：若烧录提示 "requires chip revision in range ..."，按实际芯片版本
# 追加对应的配置覆盖文件（见 README）。

cmake_minimum_required(VERSION 3.22)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

# 固件版本不写在 project() 里，而由工程根目录的 version.txt 提供
# （IDF 读取其内容作为 app_desc.version；用 scripts/deploy.py --bump 自增）。
project(artnet_core)
