idf_component_register(
    SRCS
        "src/api_server.cpp"
    INCLUDE_DIRS
        "include"
    REQUIRES
        common
        settings
        player
        program_store
        dmx_out
        forwarder
        net
        storage
        control
    PRIV_REQUIRES
        artrec
        ota
        esp_http_server
        cjson
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_23)
