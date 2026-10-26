idf_component_register(
    SRCS
        "src/settings.cpp"
    INCLUDE_DIRS
        "include"
    REQUIRES
        common
    PRIV_REQUIRES
        nvs_flash
        mbedtls
        esp_hw_support
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_23)
