idf_component_register(
    SRCS
        "src/program_store.cpp"
    INCLUDE_DIRS
        "include"
    REQUIRES
        common
    PRIV_REQUIRES
        storage
        cjson
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_23)
