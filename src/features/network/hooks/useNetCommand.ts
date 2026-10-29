import { useTranslation } from "react-i18next";

import { useCommand, type Command, type CommandOptions } from "@/shared/hooks/useCommand";
import { errorText } from "../lib/errors";

/**
 * 对核心板执行一条命令（见 `useCommand`），失败时按网络设备的错误码给出文案。
 *
 * @param options 命令、提示与要刷新的查询。
 * @returns `run` / `pending` / `variables`。
 */
export function useNetCommand<V = void>(options: Omit<CommandOptions<V>, "describe">): Command<V> {
  const { t } = useTranslation();
  return useCommand({ ...options, describe: (e) => errorText(t, e) });
}
