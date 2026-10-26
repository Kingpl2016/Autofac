idf_component_register(
    SRCS
        "src/log_ring.cpp"
    INCLUDE_DIRS
        "include"
    REQUIRES
        esp_common
    PRIV_REQUIRES
        log
)

# 本组件公开头文件使用 C++23 的 std::expected
target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_23)
