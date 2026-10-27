fn main() {
    // 应用图标会在编译期嵌入可执行文件（窗口左上角 / 任务栏 / 资源管理器的图标）。
    // tauri-build 默认不监视 icons 目录，换了图标文件后 Cargo 会认为没有变化而沿用旧产物，
    // 所以这里显式声明：icons 目录里任何文件变化都要重新运行构建脚本并重新链接。
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build();
}
