import { distinctUntilChanged, fromEvent, map, Observable, type Subscription } from "rxjs";

import i18n from "@/shared/i18n";
import { applyLanguageAttr, usePrefsStore, type Language } from "@/shared/stores/prefsStore";

/** 界面语言的变化流：订阅时先发出当前值，之后只在语言真正变化时发出。 */
const language$ = new Observable<Language>((subscriber) => {
  subscriber.next(usePrefsStore.getState().language);
  return usePrefsStore.subscribe((state) => subscriber.next(state.language));
}).pipe(distinctUntilChanged());

/**
 * 从磁盘读回界面语言（首次启动取系统语言）。读取失败时保持当前值，不阻塞启动。
 */
export async function loadLanguage(): Promise<void> {
  await usePrefsStore.persist.rehydrate();
}

/**
 * 开始把界面语言同步到 `<html lang>` 与 i18n：语言一变就立即生效。
 *
 * @returns 订阅；退订即停止同步。
 */
export function startLanguageSync(): Subscription {
  return language$.subscribe((language) => {
    applyLanguageAttr(language);
    if (i18n.language !== language) void i18n.changeLanguage(language);
  });
}

/**
 * 窗口获得焦点时重新读取磁盘上的偏好。
 * 第二个窗口（如信号检测器）获得焦点时重读一次，即可追上主窗口里切换的语言。
 *
 * @returns 订阅；退订即停止。
 */
export function rehydrateLanguageOnFocus(): Subscription {
  return fromEvent(window, "focus")
    .pipe(map(() => undefined))
    .subscribe(() => void usePrefsStore.persist.rehydrate());
}
