import { useCallback, useMemo, useState } from "react";

import {
  EDIT_PROGRESS_EVENT,
  recordingsEdit,
  recordingsEditCancel,
  type EditProgressEvent,
  type EditRequest,
  type EditResult,
} from "@/features/recording";
import { fromTauriEvent } from "@/shared/events/fromTauriEvent";
import { useSubscription } from "@/shared/events/useObservable";

/** 生成任务 id。 */
function newJobId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 运行一次编辑导出：生成任务 id、跟踪 `recordings:edit` 进度事件，并提供取消。
 * 同一时间只运行一个任务。
 */
export function useEditExport() {
  const [job, setJob] = useState<{ id: string; progress: number } | null>(null);
  const progress$ = useMemo(() => fromTauriEvent<EditProgressEvent>(EDIT_PROGRESS_EVENT), []);
  useSubscription(progress$, (e) =>
    setJob((j) => (j && j.id === e.jobId ? { ...j, progress: Math.max(j.progress, e.progress) } : j)),
  );

  const run = useCallback(async (req: Omit<EditRequest, "jobId">): Promise<EditResult> => {
    const id = newJobId();
    setJob({ id, progress: 0 });
    try {
      return await recordingsEdit({ ...req, jobId: id });
    } finally {
      setJob(null);
    }
  }, []);

  const cancel = useCallback(() => {
    if (job) void recordingsEditCancel(job.id);
  }, [job]);

  return { running: job !== null, progress: job?.progress ?? 0, run, cancel };
}
