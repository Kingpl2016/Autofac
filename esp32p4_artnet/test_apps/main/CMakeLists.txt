idf_component_register(
    SRCS
        "test_main.cpp"
        "test_crc16.cpp"
        "test_dmx_packet.cpp"
        "test_dmx_uart.cpp"
        "test_artrec_header.cpp"
        "test_filename.cpp"
        "test_http_auth.cpp"
        "test_ct_compare.cpp"
        "test_ring_buffer.cpp"
        "test_config_validate.cpp"
        "test_htp_merge.cpp"
        "test_etronet_proto.cpp"
        "test_forwarder.cpp"
    INCLUDE_DIRS "."
    REQUIRES
        catch2
        common
        artrec
        dmx_out
        forwarder
        storage
        etronet
    WHOLE_ARCHIVE
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_23)
