idf_component_register(
    SRCS
        "src/ota.cpp"
    INCLUDE_DIRS
        "include"
    REQUIRES
        common
    PRIV_REQUIRES
        app_update
        esp_app_format
        bootloader_support
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_23)
