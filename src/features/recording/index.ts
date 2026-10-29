export { usePlayerStore } from "./stores/usePlayerStore";
export { useRecordingStore } from "./stores/useRecordingStore";
export { recordingPlugin } from "./plugin";
export type { PlaybackStatus } from "./lib/types";
export {
  RECORDINGS_QUERY_KEY,
  playerClose,
  playerOpen,
  playerPause,
  playerPlay,
  playerSeek,
  recordingsEdit,
  recordingsEditCancel,
  recordingsList,
} from "./lib/api";
export type {
  EditProgressEvent,
  EditRequest,
  EditResult,
  EditSegment,
  LibraryEntry,
  Overview,
} from "./lib/types";
export { EDIT_PROGRESS_EVENT, LIB_ERR_CANCELLED } from "./lib/types";

// 节目库页面复用的节目展示与操作（与录制页侧栏保持一致的行为）
export { ProgramActionsMenu } from "./components/ProgramActionsMenu";
export { ProgramDeleteDialog } from "./components/ProgramDeleteDialog";
export { ProgramHeaderTags } from "./components/ProgramHeaderTags";
export { ProgramPlayButton } from "./components/ProgramPlayButton";
export { ProgramRenameInput } from "./components/ProgramRenameInput";
export { ProgramStatusBadges } from "./components/ProgramStatusBadges";
export { ProgramThumb } from "./components/ProgramThumb";
export { useProgramActions, type ProgramActions } from "./hooks/useProgramActions";
export { useOverview } from "./hooks/useOverview";
export { drawHeatmap, heatmapCells, summarizeOverview } from "./lib/heatmap";
export { formatDurationUs } from "./lib/filter";
export { invalidateProgramCaches } from "./lib/programCaches";
export { libraryHref } from "./lib/libraryRoutes";
