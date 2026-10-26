import { createContext } from "react";

import type { Related } from "./highlight";

/** 画布上节点与边共享的显示状态。 */
export interface FlowDisplay {
  /** 悬停产生的关联路径；`null` 表示没有悬停，所有元素正常显示。 */
  related: Related | null;
  /** 是否在有信号的边上绘制流动粒子。 */
  particles: boolean;
}

/** 默认值：没有高亮、不画粒子。 */
export const FlowDisplayContext = createContext<FlowDisplay>({
  related: null,
  particles: false,
});