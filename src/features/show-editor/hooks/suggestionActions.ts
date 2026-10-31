import { announce } from "@/shared/stores/announcerStore";
import type { Suggestion } from "../ai/suggestions";
import { acceptSuggestion } from "../stores/useAiSuggestionStore";
import { useAskAiStore } from "../stores/useAskAiStore";

/** 翻译函数。 */
type T = (k: string, o?: Record<string, unknown>) => string;

/**
 * 建议的说明（参数里的文案键先翻译）。
 *
 * @param t 翻译函数。
 * @param s 建议。
 * @returns 文案。
 */
export function suggestionText(t: T, s: Suggestion): string {
  const args = Object.fromEntries(Object.entries(s.text.args ?? {}).map(([k, v]) => [k, typeof v === "string" && v.startsWith("editor.") ? t(v) : v]));
  return t(s.text.key, args);
}

/**
 * 采纳一条建议并播报。
 *
 * @param s 建议。
 * @param t 翻译函数。
 */
export function acceptWithAnnounce(s: Suggestion, t: T): void {
  announce(t(acceptSuggestion(s) ? "editor.suggest.accepted" : "editor.suggest.failed"));
}

/**
 * 让 AI 细化：在建议的范围上打开“问 AI”，带着细化的话直接发出。
 *
 * @param s 建议。
 * @param t 翻译函数。
 * @param at 弹层位置。
 */
export function refineSuggestion(s: Suggestion, t: T, at: { x: number; y: number }): void {
  const scope = s.trackId ? ({ kind: "track", id: s.trackId } as const) : ({ kind: "range", startMs: s.startMs, endMs: s.endMs } as const);
  useAskAiStore.getState().openAt(scope, at, t("editor.suggest.refine.prompt", { ask: t(s.refine.key), text: suggestionText(t, s) }));
}
