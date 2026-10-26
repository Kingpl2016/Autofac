import type { DemoData } from "../types";
import app from "./app.json";
import controller from "./controller.json";
import devices from "./devices.json";
import forwarding from "./forwarding.json";
import live from "./live.json";
import logs from "./logs.json";
import network from "./network.json";
import output from "./output.json";
import recordings from "./recordings.json";
import settings from "./settings.json";
import update from "./update.json";

/**
 * 汇总全部演示数据文件。
 *
 * 数据本体都在同目录的 `*.json` 里，这里只负责把它们断言成带类型的结构；
 * 要增删或调整测试数据，直接改 JSON 即可，不需要碰任何引擎代码。
 *
 * # Returns
 *
 * 全部演示数据的深拷贝：引擎在运行中会修改自己的状态，不能污染模块级的原始数据。
 */
export function loadDemoData(): DemoData {
  const raw = {
    app,
    settings,
    network,
    update,
    devices,
    live,
    forwarding,
    output,
    recordings,
    controller,
    logs,
  };
  return structuredClone(raw) as unknown as DemoData;
}
