import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { checkerKeys } from "../lib/queries";
import { validateConfig } from "../lib/api";
import { draftToConfig, type Draft } from "../lib/draft";
import { isConfigError } from "../lib/errors";
import type { ConfigError } from "../lib/types";
import { useDebouncedValue } from "@/shared/hooks/useDebounced";

/** 草稿的校验结果。 */
export type Validation =
  | { state: "unknown" }
  | { state: "ok"; universeCount: number }
  | { state: "error"; error: ConfigError };

/** 输入停顿多久后才向后端校验。 */
const DEBOUNCE_MS = 200;

/**
 * 边输入边校验连接草稿。
 *
 * 校验规则只有后端一份（`SignalConfig::validate`），这里把停顿后的草稿交给它；端口是前端自己的
 * 文本框，格式不对时直接给出 `invalidPort`，不必往返。结果在输入过程中保留上一次的，避免提示闪烁。
 *
 * # Arguments
 *
 * * `draft` - 当前草稿。
 *
 * # Returns
 *
 * 校验结果：尚无结果为 `unknown`，通过时带上将要发送的 Universe 数量。
 */
export function useConfigValidation(draft: Draft): Validation {
  const settled = useDebouncedValue(draft, DEBOUNCE_MS);
  const config = draftToConfig(settled);

  const query = useQuery({
    queryKey: [...checkerKeys.validate, config],
    queryFn: async (): Promise<Validation> => {
      try {
        return { state: "ok", universeCount: await validateConfig(config!) };
      } catch (e: unknown) {
        if (isConfigError(e)) return { state: "error", error: e };
        throw e;
      }
    },
    enabled: config !== null,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (config === null) return { state: "error", error: { code: "invalidPort" } };
  return query.data ?? { state: "unknown" };
}
