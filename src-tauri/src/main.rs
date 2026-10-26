// Windows release 下隐藏控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// 全局分配器保持系统默认：热路径已基本零分配，端到端压测（256 Universe × 44Hz）中
// mimalloc 没有稳定的 CPU 收益，私有内存却从约 8MB 涨到 46~74MB，故不引入。
fn main() {
    art_net_studio_lib::run();
}
