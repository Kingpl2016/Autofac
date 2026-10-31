import { layoutOf } from "./functions";
import { modelType } from "./profile";
import type { FixtureModel, FixtureShape } from "./types";

/**
 * 按通道推断外形模板（模型没有外观时的兜底，与 OFL 导入的规则一致的简化版）：
 * 能动 → 摇头灯；一行像素 → 灯条；多行像素 → 像素面板；有烟雾输出 → 烟机；能出光 → 帕灯；其余为通用方盒。
 *
 * @param model 模型。
 * @returns 外形模板。
 */
export function inferShape(model: FixtureModel): FixtureShape {
  const type = modelType(model);
  if (type === "mover") return "movingHead";
  if (model.matrix) return model.matrix.rows === 1 ? "bar" : "pixelPanel";
  const layout = layoutOf(model) ?? [];
  if (layout.some((p) => p.function === "fog")) return "fogger";
  if (type === "mixing" || type === "white" || type === "dimmer") return "par";
  return "generic";
}

/**
 * 模型实际使用的外形模板：有外观时取外观里的，否则按通道推断。
 *
 * @param model 模型。
 * @returns 外形模板。
 */
export function modelShape(model: FixtureModel): FixtureShape {
  return model.appearance?.shape ?? inferShape(model);
}
