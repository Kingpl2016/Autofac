idf_component_register(
    SRCS
        "src/storage.cpp"
    INCLUDE_DIRS
        "include"
    REQUIRES
        common
    PRIV_REQUIRES
        fatfs
        sdmmc
        esp_driver_sdmmc
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_23)
