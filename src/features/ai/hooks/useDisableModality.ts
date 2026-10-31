import { useQueryClient } from "@tanstack/react-query";

import { aiProfileSave } from "../lib/api";
import type { AiModality, AiProfileView } from "../lib/types";
import { AI_PROFILES_KEY } from "./useAiProfiles";

/**
 * 在配置里取消勾选一种输入（模型实际不接受音频 / 图片时用）；其余字段与 Key 不变。
 *
 * @returns 关闭函数：参数为配置与输入类型，完成后刷新配置列表。
 */
export function useDisableModality(): (profile: AiProfileView, modality: AiModality) => Promise<void> {
  const client = useQueryClient();
  return async (profile, modality) => {
    const { id, name, kind, baseUrl, model, supportsStructuredOutputs, inputModalities, temperature, seed } = profile;
    await aiProfileSave({
      id,
      name,
      kind,
      baseUrl,
      model,
      supportsStructuredOutputs,
      inputModalities: (inputModalities ?? []).filter((m) => m !== modality),
      temperature,
      seed: seed ?? null,
    });
    await client.invalidateQueries({ queryKey: AI_PROFILES_KEY });
  };
}
