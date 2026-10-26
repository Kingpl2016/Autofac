idf_component_register(
    SRCS
        "src/artrec.cpp"
    INCLUDE_DIRS
        "include"
    REQUIRES
        common
        zstd
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_23)
