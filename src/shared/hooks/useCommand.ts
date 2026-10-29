import { useCallback } from "react";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";

import { errorMessage } from "@/shared/lib/errors";

/** `useCommand` 的选项。 */
export interface CommandOptions<V> {
  /** 执行命令。 */
  run: (vars: V) => Promise<unknown>;
  /** 成功提示；省略或返回 `undefined` 时不提示。 */
  success?: string | ((vars: V) => string | undefined);
  /** 把错误转成提示文案；默认 `errorMessage`。 */
  describe?: (e: unknown) => string;
  /** 结束后要刷新的查询。 */
  invalidate?: readonly QueryKey[] | ((vars: V) => readonly QueryKey[]);
  /** 什么时候刷新：`settled`（默认，成败都以服务端为准）或只在 `success` 时。 */
  invalidateOn?: "settled" | "success";
  /** 成功后（刷新查询之前）的额外处理。 */
  onSuccess?: (vars: V) => void;
}

/** `useCommand` 的返回值。 */
export interface Command<V> {
  /** 执行一次：失败时已提示，不向外抛出。查询刷新完成后才返回。 */
  run: (vars: V) => Promise<boolean>;
  /** 是否正在执行（含刷新查询）。 */
  pending: boolean;
  /** 正在执行的那次调用的参数。 */
  variables: V | undefined;
}

/**
 * 执行一条“改动服务端状态”的命令：提交中状态、成功 / 失败提示、结束后刷新相关查询。
 * 基于 TanStack Query 的 `useMutation`，组件里不再手写 `busy` 状态和 `invalidateQueries`。
 *
 * @param options 命令、提示与要刷新的查询。
 * @returns `run` / `pending` / `variables`。
 */
export function useCommand<V = void>({
  run,
  success,
  describe = errorMessage,
  invalidate,
  invalidateOn = "settled",
  onSuccess,
}: CommandOptions<V>): Command<V> {
  const client = useQueryClient();
  const refresh = (vars: V) => {
    const keys = typeof invalidate === "function" ? invalidate(vars) : (invalidate ?? []);
    return Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
  };

  const mutation = useMutation({
    mutationFn: run,
    onSuccess: async (_data, vars) => {
      const text = typeof success === "function" ? success(vars) : success;
      if (text) toast.success(text);
      onSuccess?.(vars);
      if (invalidateOn === "success") await refresh(vars);
    },
    onError: (e) => {
      toast.error(describe(e));
    },
    onSettled: async (_data, _error, vars) => {
      if (invalidateOn === "settled") await refresh(vars);
    },
  });

  const { mutateAsync } = mutation;
  const execute = useCallback(
    (vars: V) =>
      mutateAsync(vars).then(
        () => true,
        () => false,
      ),
    [mutateAsync],
  );

  return { run: execute, pending: mutation.isPending, variables: mutation.isPending ? mutation.variables : undefined };
}
