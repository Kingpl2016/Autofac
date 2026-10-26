idf_component_register(
    SRCS
        "src/etronet_proto.cpp"
        "src/etronet_link.cpp"
    INCLUDE_DIRS
        "include"
    REQUIRES
        common
    PRIV_REQUIRES
        esp_driver_uart
        driver
        pthread
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_23)
