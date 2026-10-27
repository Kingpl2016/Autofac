import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  applyDraft,
  draftAssignments,
  mergeDraft,
  touchesProgramNo,
  type ProgramAssignment,
  type ProgramDraft,
} from "../lib/files";
import type { NetFile } from "../lib/types";

const EMPTY: ProgramDraft = new Map();

interface Params {
  deviceId: string;
  /** 设备上的真实文件列表 */
  files: readonly NetFile[];
  /** 正在播放 / 暂停的节目号；没有为 `null`。暂存的更改不得动到它 */
  playingNo: number | null;
  /** 把一批分配一次性提交给设备；返回是否成功 */
  commit: (assignments: ProgramAssignment[], label: string) => Promise<boolean>;
}

/**
 * 节目号更改的暂存区：改号 / 互换 / 拖动排序先记在本机，点“提交”后一次性发给设备。
 *
 * - `files` 是叠加了暂存更改的展示列表，后续的规划（空闲号、互换、拖动）都应基于它。
 * - 提交失败时暂存的更改保留，可以修改后重试；切换设备会丢弃暂存。
 */
export function useProgramDraft({ deviceId, files, playingNo, commit }: Params) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ deviceId: string; draft: ProgramDraft }>({ deviceId, draft: EMPTY });
  // 切到别的设备后，旧设备的暂存不再适用
  const draft = state.deviceId === deviceId ? state.draft : EMPTY;

  const viewFiles = useMemo(() => applyDraft(files, draft), [files, draft]);
  const pending = useMemo(() => draftAssignments(files, draft), [files, draft]);
  const changed = useMemo(() => new Set(pending.map((a) => a.file)), [pending]);

  /**
   * 把一次编辑产生的分配暂存起来（不发请求）。
   * 会动到正在播放的节目号时拒绝；返回是否已暂存。
   */
  const stage = useCallback(
    async (assignments: ProgramAssignment[]): Promise<boolean> => {
      if (assignments.length === 0) return false;
      if (playingNo !== null && touchesProgramNo(viewFiles, assignments, playingNo)) {
        toast.error(t("network.files.programPlaying", { no: playingNo }));
        return false;
      }
      setState((prev) => ({
        deviceId,
        draft: mergeDraft(prev.deviceId === deviceId ? prev.draft : EMPTY, files, assignments),
      }));
      return true;
    },
    [deviceId, files, playingNo, t, viewFiles],
  );

  /** 丢弃全部暂存的更改。 */
  const discard = useCallback(() => setState({ deviceId, draft: EMPTY }), [deviceId]);

  /** 文件改名后，让它的暂存项跟着新名字。 */
  const renameKey = useCallback(
    (from: string, to: string) =>
      setState((prev) => {
        const no = prev.draft.get(from);
        if (prev.deviceId !== deviceId || no === undefined) return prev;
        const next = new Map(prev.draft);
        next.delete(from);
        next.set(to, no);
        return { deviceId, draft: next };
      }),
    [deviceId],
  );

  /** 一次性提交全部暂存的更改；成功后清空暂存，失败则保留。 */
  const submit = useCallback(async (): Promise<boolean> => {
    if (pending.length === 0) return false;
    const ok = await commit(pending, t("network.files.committed", { count: pending.length }));
    if (ok) setState({ deviceId, draft: EMPTY });
    return ok;
  }, [commit, deviceId, pending, t]);

  return { files: viewFiles, count: pending.length, changed, stage, discard, renameKey, submit };
}
