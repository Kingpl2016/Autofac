import { useEffect } from "react";

import { moveChatDocument, switchChatDocument } from "../stores/useAiChatStore";
import { useDocumentStore } from "../stores/useDocumentStore";
import { useProjectStore } from "../stores/useProjectStore";

/**
 * 让 AI 对话跟着工程走：换了工程（代次变化）时读入新工程的对话记录；同一工程换了保存位置
 * （第一次保存、另存为）时把对话搬到新位置。在编辑器视图里挂一次。
 */
export function useAiHistorySync(): void {
  useEffect(() => {
    let generation = useProjectStore.getState().generation;
    let origin = useDocumentStore.getState().origin;
    void switchChatDocument(generation, origin);
    // 打开工程时先 `load`（代次变化）再设置来源；两者都变化时按“换了工程”处理（读来源变化后的记录）
    let pending: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        const g = useProjectStore.getState().generation;
        const o = useDocumentStore.getState().origin;
        if (g !== generation) void switchChatDocument(g, o);
        else if (o !== origin) void moveChatDocument(o);
        generation = g;
        origin = o;
      }, 0);
    };
    const offProject = useProjectStore.subscribe((s, prev) => {
      if (s.generation !== prev.generation) check();
    });
    const offDoc = useDocumentStore.subscribe((s, prev) => {
      if (s.origin !== prev.origin) check();
    });
    return () => {
      if (pending) clearTimeout(pending);
      offProject();
      offDoc();
    };
  }, []);
}
