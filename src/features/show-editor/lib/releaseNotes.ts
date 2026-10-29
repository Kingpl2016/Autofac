/**
 * 帮助菜单“新功能”里的更新说明：每条一个文案键（标题 + 说明在 `editor.whatsNew.items.<id>`），新的在前。
 */

/** 一条更新。 */
export interface ReleaseNote {
  id: string;
  /** 所属区域（显示为徽标） */
  area: "fixtures" | "effects" | "timeline" | "file" | "output" | "help" | "color" | "settings";
}

/** 本版本的更新（新的在前）。 */
export const RELEASE_NOTES: readonly ReleaseNote[] = [
  { id: "timelineQuick", area: "timeline" },
  { id: "colorAdvanced", area: "color" },
  { id: "moreTemplates", area: "effects" },
  { id: "fixtureLibraryV2", area: "fixtures" },
  { id: "settingsRedesign", area: "settings" },
  { id: "undoNearFile", area: "file" },
  { id: "fixtureAdd", area: "fixtures" },
  { id: "fixtureDrag", area: "fixtures" },
  { id: "fixtureLibrary", area: "fixtures" },
  { id: "effectLibrary", area: "effects" },
  { id: "timelineTools", area: "timeline" },
  { id: "recentFiles", area: "file" },
  { id: "outputAdvanced", area: "output" },
  { id: "helpMenu", area: "help" },
];
