idf_component_register(
    SRCS
        "src/control.cpp"
    INCLUDE_DIRS
        "include"
    REQUIRES
        common
        player
        program_store
        settings
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_23)
