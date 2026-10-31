import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { aiListModels, aiProfileSave } from "../lib/api";
import { presetForUrl } from "../lib/presets";
import type { AiProfileView } from "../lib/types";
import { AI_PROFILES_KEY } from "./useAiProfiles";

/** 一个可选的模型。 */
export interface ProfileModelOption {
  id: string;
  name: string;
  /** `remote` 模型服务列出的；`preset` 预设里建议的；`current` 配置里现在用的。 */
  source: "remote" | "preset" | "current";
}

/**
 * 一个配置的模型服务能用哪些模型：从服务实时拉取（同一配置 5 分钟内不重复拉），并补上预设建议与当前模型。
 * 拉取失败时仍有建议模型可选。
 *
 * @param profile 配置；`null` 时不拉取。
 * @param enabled 是否拉取（例如菜单打开时才拉）。
 * @returns 模型、加载状态与错误。
 */
export function useProfileModels(profile: AiProfileView | null, enabled: boolean) {
  const query = useQuery({
    queryKey: ["ai", "models", profile?.id ?? "", profile?.kind ?? "", profile?.baseUrl ?? ""],
    queryFn: () => aiListModels({ profileId: profile?.id ?? null, kind: profile?.kind ?? "openaiCompatible", baseUrl: profile?.baseUrl ?? "" }),
    enabled: enabled && profile !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const models = useMemo(() => {
    if (!profile) return [];
    const seen = new Set<string>();
    const out: ProfileModelOption[] = [];
    const add = (id: string, name: string, source: ProfileModelOption["source"]) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ id, name, source });
    };
    add(profile.model, profile.model, "current");
    for (const m of query.data ?? []) add(m.id, m.name, "remote");
    for (const m of presetForUrl(profile.baseUrl)?.models ?? []) add(m, m, "preset");
    return out;
  }, [profile, query.data]);
  return { models, loading: query.isFetching, error: query.error };
}

/**
 * 把配置的模型改成另一个（其它设置不变）。显示名就是旧模型名时跟着换成新模型名。
 *
 * @returns 修改函数（失败时抛出后端错误）。
 */
export function useSetProfileModel(): (profile: AiProfileView, model: string) => Promise<AiProfileView> {
  const client = useQueryClient();
  return useCallback(
    async (profile, model) => {
      const { id, name, kind, baseUrl, supportsStructuredOutputs, inputModalities, temperature, seed } = profile;
      const saved = await aiProfileSave({
        id,
        name: name === profile.model ? "" : name,
        kind,
        baseUrl,
        model,
        supportsStructuredOutputs,
        inputModalities: [...(inputModalities ?? [])],
        temperature,
        seed: seed ?? null,
      });
      await client.invalidateQueries({ queryKey: AI_PROFILES_KEY });
      return saved;
    },
    [client],
  );
}
