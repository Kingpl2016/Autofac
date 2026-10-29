import { toast } from "sonner";

/** `copyText` 的提示文案。 */
export interface CopyMessages {
  /** 成功提示；省略则不提示。 */
  success?: string;
  /** 失败提示；省略则静默。 */
  failure?: string;
}

/**
 * 复制文本到剪贴板，并按需提示成功 / 失败（不抛出）。
 *
 * @param text 要复制的文本。
 * @param messages 提示文案。
 * @returns 是否复制成功（剪贴板不可用时为 `false`）。
 */
export async function copyText(text: string, { success, failure }: CopyMessages = {}): Promise<boolean> {
  try {
    if (!navigator.clipboard) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
    if (success) toast.success(success);
    return true;
  } catch {
    if (failure) toast.error(failure);
    return false;
  }
}
