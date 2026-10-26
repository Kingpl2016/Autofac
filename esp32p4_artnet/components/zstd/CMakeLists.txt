# zstd 组件：封装上游 libzstd 的解压部分。
#
# 上游源码不入库，由 fetch_zstd.ps1 / fetch_zstd.sh 按固定版本拉到 upstream/，
# 只保留 lib/common 与 lib/decompress（解压所需）。详见本目录 README.md。

# 注意：
# 1) 不要用 CONFIGURE_DEPENDS —— 组件依赖展开阶段以 CMake 脚本模式执行本文件，
#    该模式下 CONFIGURE_DEPENDS 非法（CMake 4.x 直接报错）。源码拉取后固定，无需重扫。
# 2) 用 ${COMPONENT_DIR} 而非 ${CMAKE_CURRENT_SOURCE_DIR}：脚本模式下后者不指向组件目录，
#    GLOB 会落空而误报「源码缺失」。COMPONENT_DIR 在两种模式下都正确。
file(GLOB ZSTD_SRCS
    "${COMPONENT_DIR}/upstream/lib/common/*.c"
    "${COMPONENT_DIR}/upstream/lib/decompress/*.c"
)

if(NOT ZSTD_SRCS)
    message(FATAL_ERROR
        "zstd 上游源码缺失：请先在 components/zstd 下运行 fetch_zstd.ps1 "
        "(Windows) 或 fetch_zstd.sh，把固定版本的 libzstd 拉到 upstream/。详见 README.md。")
endif()

idf_component_register(
    SRCS "src/zstd_dec.cpp" ${ZSTD_SRCS}
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "upstream/lib"
    REQUIRES common
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_23)

# 只编译解压路径，关闭 legacy / 多线程。
target_compile_definitions(${COMPONENT_LIB} PRIVATE
    ZSTD_LEGACY_SUPPORT=0
    ZSTD_MULTITHREAD=0
    XXH_NAMESPACE=ZSTD_
)

# 上游源码放宽告警（本工程默认把告警当错误）。
set_source_files_properties(${ZSTD_SRCS} PROPERTIES COMPILE_FLAGS "-w")
