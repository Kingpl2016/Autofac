import type { TFunction } from "i18next";
import { toast } from "sonner";

import { announce } from "@/shared/stores/announcerStore";
import { expandPanel } from "../hooks/panelControl";
import { useAiChatStore } from "../stores/useAiChatStore";
import { useAiExemplarStore } from "../stores/useAiExemplarStore";
import { applyStaged, useAiStagingStore, type StagedChange } from "../stores/useAiStagingStore";
import { useProjectStore } from "../stores/useProjectStore";
import { hasShowAliases, makeExemplar } from "./memory";

/**
 * 暂存 / 应用 AI 改动的界面动作（提示、播报、打开对话栏）。
 */

/**
 * 写入暂存的改动，并提示结果。
 *
 * @param t 翻译函数。
 * @returns 是否写入。
 */
export function commitStaged(t: TFunction): boolean {
  const staged = useAiStagingStore.getState().staged;
  const r = applyStaged();
  if (r.ok) {
    if (staged) recordExemplar(staged);
    const text = t("editor.ai.applied", { count: r.cueIds.length });
    announce(text);
    toast.success(text, { action: { label: t("editor.ai.undo"), onClick: () => useProjectStore.temporal.getState().undo() } });
    return true;
  }
  if (r.reason === "stale") toast.error(t("editor.ai.stale"));
  return false;
}

/**
 * 应用过的对话改动记成范例：记进本工程；不含工程别名（灯具、分组、轨道、片段…）的同时记进所有工程共用的范例。
 * 草稿的改动与没有用户原话的改动不记。
 *
 * @param staged 刚应用的改动。
 */
export function recordExemplar(staged: StagedChange): void {
  if (staged.source !== "chat" || !staged.request) return;
  const ex = makeExemplar(staged.request, staged.summary, staged.ops);
  if (!ex) return;
  useAiChatStore.getState().addExemplar(ex);
  if (!hasShowAliases(ex.ops)) useAiExemplarStore.getState().add({ ...ex, id: ex.id.replace(/^e-/, "g-") });
}

/**
 * 交出一份新的改动：开了“自动写入”且不敏感时直接写入（可撤销），否则暂存并打开对话栏等待审阅。
 *
 * @param staged 改动。
 * @param autoApply 是否自动写入。
 * @param t 翻译函数。
 * @returns 是否已经写入。
 */
export function offerChange(staged: StagedChange, autoApply: boolean, t: TFunction): boolean {
  useAiStagingStore.getState().stage(staged);
  if (autoApply && !staged.sensitive) return commitStaged(t);
  expandPanel("ai");
  announce(t(staged.sensitive && autoApply ? "editor.ai.needsReview" : "editor.ai.staged"));
  return false;
}

/** 放弃暂存的改动。 */
export function discardStaged(): void {
  useAiStagingStore.getState().discard();
}

/** 打开对话栏并把焦点交给输入框（等面板展开、对话界面加载后）。 */
export function focusAiInput(): void {
  expandPanel("ai");
  window.setTimeout(() => document.querySelector<HTMLTextAreaElement>("[data-ai-input]")?.focus(), 150);
}
