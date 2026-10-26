idf_component_register(
    SRCS
        "src/player.cpp"
    INCLUDE_DIRS
        "include"
    REQUIRES
        common
        artrec
        dmx_out
        program_store
    PRIV_REQUIRES
        esp_timer
        pthread
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_23)
