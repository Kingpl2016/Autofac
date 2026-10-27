import "@/shared/i18n";
import "@/styles/globals.css";
import { bootstrap } from "@/app/bootstrap";
import { applyLanguageAttr, usePrefsStore } from "@/shared/stores/prefsStore";

// 首次渲染前先应用语言属性；明暗与主题由 index.html 的内联脚本在首次绘制前还原，
// 随后外观插件在渲染前读回完整设置并接管
applyLanguageAttr(usePrefsStore.getState().language);

void bootstrap(document.getElementById("root") as HTMLElement);
