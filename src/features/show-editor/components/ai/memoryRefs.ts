import { useAiMemoryStore } from "@/features/ai";
import type { MemoryKind, MemoryRef } from "../../ai/memory";
import { useAiChatStore } from "../../stores/useAiChatStore";
import { useAiExemplarStore } from "../../stores/useAiExemplarStore";

/**
 * 按引用找到记忆、启用 / 停用、删除（回复下方的记忆来源与记忆页共用）。
 */

/** 找到的一条记忆（显示用）。 */
export interface ResolvedMemory {
  ref: MemoryRef;
  /** 文字（范例为用户当时的话）；已删除时为 `null` */
  text: string | null;
  enabled: boolean;
}

/** 所有记忆的当前状态（订阅用，任一变化时组件重绘）。 */
export interface MemoryState {
  prefs: ReturnType<typeof useAiMemoryStore.getState>["prefs"];
  notes: ReturnType<typeof useAiChatStore.getState>["notes"];
  exemplars: ReturnType<typeof useAiChatStore.getState>["exemplars"];
  shared: ReturnType<typeof useAiExemplarStore.getState>["items"];
}

/**
 * 订阅所有记忆。
 *
 * @returns 当前状态。
 */
export function useMemoryState(): MemoryState {
  return {
    prefs: useAiMemoryStore((s) => s.prefs),
    notes: useAiChatStore((s) => s.notes),
    exemplars: useAiChatStore((s) => s.exemplars),
    shared: useAiExemplarStore((s) => s.items),
  };
}

/**
 * 按引用找到记忆。
 *
 * @param state 所有记忆。
 * @param ref 引用。
 * @returns 找到的记忆；已删除时 `text` 为 `null`。
 */
export function resolveMemory(state: MemoryState, ref: MemoryRef): ResolvedMemory {
  const lists: Record<MemoryKind, readonly { id: string; enabled: boolean; text?: string; request?: string }[]> = {
    pref: state.prefs,
    note: state.notes,
    exemplar: state.exemplars,
    shared: state.shared,
  };
  const item = lists[ref.kind].find((m) => m.id === ref.id);
  return { ref, text: item ? (item.text ?? item.request ?? "") : null, enabled: item?.enabled ?? false };
}

/**
 * 启用 / 停用一条记忆。
 *
 * @param ref 引用。
 * @param enabled 是否启用。
 */
export function setMemoryEnabled(ref: MemoryRef, enabled: boolean): void {
  switch (ref.kind) {
    case "pref":
      useAiMemoryStore.getState().update(ref.id, { enabled });
      return;
    case "note":
      useAiChatStore.getState().updateNote(ref.id, { enabled });
      return;
    case "exemplar":
      useAiChatStore.getState().setExemplarEnabled(ref.id, enabled);
      return;
    case "shared":
      useAiExemplarStore.getState().setEnabled(ref.id, enabled);
  }
}

/**
 * 删除一条记忆。
 *
 * @param ref 引用。
 */
export function removeMemoryRef(ref: MemoryRef): void {
  switch (ref.kind) {
    case "pref":
      useAiMemoryStore.getState().remove(ref.id);
      return;
    case "note":
      useAiChatStore.getState().removeNote(ref.id);
      return;
    case "exemplar":
      useAiChatStore.getState().removeExemplar(ref.id);
      return;
    case "shared":
      useAiExemplarStore.getState().remove(ref.id);
  }
}
