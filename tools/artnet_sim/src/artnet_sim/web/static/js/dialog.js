// 对话框工具:表单对话框与确认对话框。基于原生 <dialog>,自带焦点陷阱和 Esc 关闭。

import { h } from "./dom.js";

let dialogCounter = 0;

function closeAndRemove(dialog) {
  if (dialog.open) dialog.close();
  dialog.remove();
}

/**
 * 打开表单对话框。
 * @param {object} options
 * @param {string} options.title 标题
 * @param {Node[]} options.content 表单内容(字段、说明等)
 * @param {string} [options.submitText] 提交按钮文字
 * @param {() => Promise<void>} options.onSubmit 提交处理;抛 Error 时在对话框内显示消息且不关闭
 * @param {Element} [options.focus] 打开后获得焦点的元素
 */
export function openFormDialog({ title, content, submitText = "确定", onSubmit, focus = null }) {
  const titleId = `dlg-title-${++dialogCounter}`;
  const dialog = h("dialog", { "aria-labelledby": titleId });
  const error = h("p", { class: "error-text", role: "alert" });
  const submit = h("button", { type: "submit", class: "primary" }, submitText);
  const form = h("form", {
    onsubmit: async (event) => {
      event.preventDefault();
      error.textContent = "";
      submit.disabled = true;
      try {
        await onSubmit();
        closeAndRemove(dialog);
      } catch (e) {
        error.textContent = e.message;
      } finally {
        submit.disabled = false;
      }
    },
  },
    h("h2", { id: titleId }, title),
    content,
    error,
    h("div", { class: "actions" },
      h("button", { type: "button", onclick: () => closeAndRemove(dialog) }, "取消"),
      submit));
  dialog.appendChild(form);
  dialog.addEventListener("cancel", () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();
  if (focus) focus.focus();
  return dialog;
}

/**
 * 确认对话框。返回 Promise<boolean>:点确定为 true,取消或按 Esc 为 false。
 * 默认焦点放在"取消"上,避免误按回车就执行危险操作。
 */
export function confirmDialog(message, okText = "确定") {
  return new Promise((resolve) => {
    const titleId = `dlg-title-${++dialogCounter}`;
    const dialog = h("dialog", { "aria-labelledby": titleId });
    let result = false;
    const cancel = h("button", { type: "button", onclick: () => closeAndRemove(dialog) }, "取消");
    const ok = h("button", {
      type: "button",
      class: "primary",
      onclick: () => {
        result = true;
        closeAndRemove(dialog);
      },
    }, okText);
    dialog.append(
      h("h2", { id: titleId }, "请确认"),
      h("p", {}, message),
      h("div", { class: "actions" }, cancel, ok),
    );
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
    document.body.appendChild(dialog);
    dialog.showModal();
    cancel.focus();
  });
}

/** 只读信息对话框(只有"关闭"按钮)。 */
export function openInfoDialog(title, content) {
  const titleId = `dlg-title-${++dialogCounter}`;
  const dialog = h("dialog", { "aria-labelledby": titleId });
  const close = h("button", { type: "button", class: "primary", onclick: () => closeAndRemove(dialog) }, "关闭");
  dialog.append(h("h2", { id: titleId }, title), content, h("div", { class: "actions" }, close));
  dialog.addEventListener("close", () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();
  close.focus();
  return dialog;
}
