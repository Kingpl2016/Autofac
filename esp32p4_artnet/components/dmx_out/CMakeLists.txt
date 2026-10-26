idf_component_register(
    SRCS
        "src/dmx_packet.cpp"
        "src/dmx_output.cpp"
        "src/dmx_uart.cpp"
    INCLUDE_DIRS
        "include"
    REQUIRES
        common
    PRIV_REQUIRES
        lwip
        esp_driver_uart
        driver
        pthread
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_23)
