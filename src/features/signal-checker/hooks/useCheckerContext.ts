import { useQuery } from "@tanstack/react-query";

import { contextQuery } from "../lib/queries";

/**
 * 运行环境快照（应用模式、接收网卡、转发表、本机地址），见 `contextQuery`。
 * 取不到时为 `undefined`，调用方按"信息未知"处理。
 */
export function useCheckerContext() {
  return useQuery(contextQuery);
}
