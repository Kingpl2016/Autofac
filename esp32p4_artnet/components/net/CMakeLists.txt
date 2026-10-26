idf_component_register(
    SRCS
        "src/net.cpp"
        "src/discovery.cpp"
    INCLUDE_DIRS
        "include"
    REQUIRES
        common
        settings
        dmx_out
    PRIV_REQUIRES
        esp_eth
        esp_netif
        esp_event
        ip101
        mdns
        lwip
        pthread
        esp_hw_support
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_23)
