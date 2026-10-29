// 主窗口只需要插件（顶栏按钮与快捷键）；检测器窗口的根组件经 `./window` 单独导出，
// 不放在这里，避免两个页面入口共用本模块时把检测器视图打进主窗口的首屏包。
export { signalCheckerPlugin } from "./plugin";
