import { useQuery } from "@tanstack/react-query";

import { aiProfilesList } from "../lib/api";
import type { AiProfileView } from "../lib/types";
import { useAiPrefsStore } from "../stores/useAiPrefsStore";

/** AI 配置列表的查询键。 */
export const AI_PROFILES_KEY = ["ai", "profiles"] as const;

/**
 * AI 配置列表（含 Key 状态）。
 *
 * @returns TanStack Query 结果。
 */
export function useAiProfiles() {
  return useQuery({ queryKey: AI_PROFILES_KEY, queryFn: aiProfilesList });
}

/**
 * 在配置列表里挑出当前使用的配置：优先 `preferred`，其次默认配置，再其次第一个。
 *
 * @param profiles 配置列表。
 * @param defaultId 默认配置 id。
 * @param preferred 本次指定的配置 id。
 * @returns 配置；列表为空时为 `null`。
 */
export function pickProfile(
  profiles: readonly AiProfileView[],
  defaultId: string | null,
  preferred?: string | null,
): AiProfileView | null {
  return (
    profiles.find((p) => p.id === preferred) ?? profiles.find((p) => p.id === defaultId) ?? profiles[0] ?? null
  );
}

/**
 * 当前使用的 AI 配置（默认配置；默认配置被删除时回退到第一个）。
 *
 * @param preferred 本次指定的配置 id（例如对话面板里临时切换的模型）。
 * @returns 配置列表、当前配置与加载状态。
 */
export function useActiveAiProfile(preferred?: string | null) {
  const query = useAiProfiles();
  const defaultId = useAiPrefsStore((s) => s.defaultProfileId);
  const profiles = query.data ?? [];
  return { profiles, profile: pickProfile(profiles, defaultId, preferred), loading: query.isPending };
}
