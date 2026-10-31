import { lazy, Suspense, useState } from "react";

import { useAiModelsDialogStore } from "../stores/useAiModelsDialogStore";

/** 对话框本体按需加载（不进首屏包）。 */
const AiModelsDialog = lazy(() => import("./AiModelsDialog").then((m) => ({ default: m.AiModelsDialog })));

/**
 * 全局覆盖层里的“模型配置”对话框：第一次打开时才加载，之后保持挂载（关闭动画正常播放）。
 */
export function AiModelsDialogHost() {
  const open = useAiModelsDialogStore((s) => s.open);
  const [used, setUsed] = useState(false);
  if (open && !used) setUsed(true);
  if (!used) return null;
  return (
    <Suspense fallback={null}>
      <AiModelsDialog />
    </Suspense>
  );
}
