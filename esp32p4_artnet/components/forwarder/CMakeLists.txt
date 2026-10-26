idf_component_register(
    SRCS
        "src/forwarder.cpp"
    INCLUDE_DIRS
        "include"
    REQUIRES
        common
        dmx_out
    PRIV_REQUIRES
        lwip
        pthread
        esp_timer
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_23)
