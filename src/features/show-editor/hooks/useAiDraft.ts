import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { aiErrorText, isAiAbort, loadLanguageModel, useActiveAiProfile, useAiPrefsStore } from "@/features/ai";
import { offerChange } from "../ai/actions";
import { editorSnapshot, ensureLibraries, memorySnapshot } from "../ai/env";
import type { PaletteName } from "../ai/vocab";
import { makeStaged } from "../stores/useAiStagingStore";
import { ensurePrimaryAnalysis } from "../stores/useMediaAnalysisStore";

/** AI 草稿的状态。 */
export interface AiDraftState {
  pending: boolean;
  /** 第几次尝试（模型修正时递增） */
  attempt: number;
  /** 失败的说明（已本地化） */
  error: string | null;
}

/**
 * 一键 AI 草稿：按描述生成整首歌的灯光，结果进入暂存区等待审阅（开了自动写入时直接写入）。
 *
 * AI SDK 与提供商包在第一次生成时才加载。
 *
 * @returns 状态、生成与取消。
 */
export function useAiDraft() {
  const { t, i18n } = useTranslation();
  const { profile, profiles } = useActiveAiProfile();
  const [state, setState] = useState<AiDraftState>({ pending: false, attempt: 0, error: null });
  const abort = useRef<AbortController | null>(null);

  const generate = useCallback(
    async (prompt: string, palette: PaletteName | null, accents = false): Promise<boolean> => {
      if (!profile) {
        setState({ pending: false, attempt: 0, error: t("ai.errors.no_profile") });
        return false;
      }
      const ac = new AbortController();
      abort.current = ac;
      setState({ pending: true, attempt: 1, error: null });
      try {
        // 生成草稿时才分析音乐（导入素材时不分析）；分析失败不影响生成
        await ensurePrimaryAnalysis().catch(() => null);
        await ensureLibraries();
        const [{ runDraft }, loaded] = await Promise.all([import("../ai/runtime"), loadLanguageModel(profile)]);
        const snapshot = editorSnapshot(i18n.language);
        const result = await runDraft({
          loaded,
          snapshot,
          prompt,
          palette,
          accents,
          memory: memorySnapshot(),
          signal: ac.signal,
          onAttempt: (attempt) => setState((s) => ({ ...s, attempt })),
        });
        const staged = makeStaged({
          summary: result.ops.summary,
          ops: result.ops.ops,
          base: snapshot.project,
          aliases: snapshot.aliases,
          env: snapshot.env,
          source: "draft",
        });
        if (!staged) throw new Error(t("ai.errors.no_object"));
        offerChange(staged, useAiPrefsStore.getState().autoApply, t);
        setState({ pending: false, attempt: 0, error: null });
        return true;
      } catch (e) {
        setState({ pending: false, attempt: 0, error: isAiAbort(e) ? null : aiErrorText(t, e) });
        return false;
      } finally {
        abort.current = null;
      }
    },
    [profile, t, i18n.language],
  );

  const cancel = useCallback(() => abort.current?.abort(), []);

  return { ...state, generate, cancel, profile, hasProfiles: profiles.length > 0 };
}
