import type { TFunction } from "i18next";
import { toast } from "sonner";

import { errorText } from "./errors";

/**
 * 执行一次即时命令：成功提示（可选）、失败用统一文案提示。
 *
 * # Arguments
 *
 * * `t` - 翻译函数。
 * * `fn` - 要执行的异步操作。
 * * `okMessage` - 成功提示；省略则不提示。
 *
 * # Returns
 *
 * 是否成功。
 */
export async function runCommand(
  t: TFunction,
  fn: () => Promise<unknown>,
  okMessage?: string,
): Promise<boolean> {
  try {
    await fn();
    if (okMessage) toast.success(okMessage);
    return true;
  } catch (e) {
    toast.error(errorText(t, e));
    return false;
  }
}
