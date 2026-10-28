import { selectionOfTracks } from "../lib/fixtureSelection";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { expandPanel } from "./panelControl";

/**
 * 选中轨道，并把灯具选择同步成这些轨道驱动的灯具（Patch、编程器、舞台共用这份选择）。
 *
 * 只选了一条分组轨道时同时选中该分组。`openPatch` 时把右侧切到“灯具与 Patch”并请求定位到第一台；
 * 右侧已收起时不强行展开（窄边上的“灯具”标签会高亮）。
 *
 * @param trackIds 轨道 id（按选择顺序）。
 * @param primary 主轨道；省略时取最后一条。
 * @param opts.openPatch 是否切到 Patch 页并定位。
 */
export function selectTracksWithFixtures(trackIds: string[], primary?: string | null, opts: { openPatch?: boolean } = {}): void {
  const ui = useEditorUiStore.getState();
  ui.selectTracks(trackIds, primary);
  const { fixtureIds, groupId } = selectionOfTracks(useProjectStore.getState().project, trackIds);
  ui.setSelectedFixtures(fixtureIds);
  ui.selectGroup(groupId);
  if (opts.openPatch) {
    ui.setInspectorTab("patch");
    if (fixtureIds.length > 0) ui.revealFixtures(fixtureIds);
  }
}

/**
 * 在 Patch 中查看这些灯具：选中、切到“灯具与 Patch”、右侧收起时先展开，再滚动到第一台。
 *
 * @param fixtureIds 灯具 id。
 */
export function revealInPatch(fixtureIds: string[]): void {
  const ui = useEditorUiStore.getState();
  ui.setSelectedFixtures(fixtureIds);
  ui.setInspectorTab("patch");
  expandPanel("inspector");
  if (fixtureIds.length > 0) ui.revealFixtures(fixtureIds);
}
