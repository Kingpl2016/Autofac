// 安全的 DOM 构造工具:所有文本都以文本节点写入,绝不把字符串当 HTML 解析,避免注入。

const PROPS = new Set(["value", "checked", "disabled", "selected", "hidden", "open", "readOnly", "required", "min", "max", "step", "placeholder", "type", "name", "id", "title", "href", "rows", "cols"]);

/**
 * 创建元素。
 * attrs:`class`、`dataset`、`on事件`(函数)、`for`(→ htmlFor),其余按属性或 attribute 设置。
 * children:字符串/数字(文本节点)、Node、数组(递归展开),null/false 被忽略。
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key === "style") applyStyle(el, value);
    else if (key === "for") el.htmlFor = value;
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (PROPS.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

/**
 * 通过 CSSOM 设置样式。严格的 CSP 禁止内联 style 属性(setAttribute("style") 会被拦截),
 * 而 el.style.setProperty 不受影响。value 可以是 "a:b;c:d" 字符串或对象。
 */
function applyStyle(el, value) {
  const entries = typeof value === "string"
    ? value.split(";").map((d) => d.split(":")).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()])
    : Object.entries(value);
  for (const [name, v] of entries) el.style.setProperty(name, String(v));
}

function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

/** 清空并填入新内容。 */
export function render(parent, ...children) {
  parent.replaceChildren();
  append(parent, children);
  return parent;
}

/** 带标签的表单字段。control 是已创建好的输入元素。 */
export function field(labelText, control, hint = "") {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return h("div", { class: "field" },
    h("label", { for: id }, labelText, hint ? h("span", { class: "hint" }, ` ${hint}`) : null),
    control);
}

/** 简单的消息提示。kind: "ok" | "error"。 */
export function toast(message, kind = "ok", ms = 4000) {
  const host = document.getElementById("toasts");
  if (!host) return;
  const node = h("div", { class: `toast ${kind}` }, message);
  host.appendChild(node);
  setTimeout(() => node.remove(), ms);
}

/** 状态徽标:文字 + 样式类(不单靠颜色区分)。 */
export function badge(text, kind = "") {
  return h("span", { class: `badge ${kind}`.trim() }, text);
}

/** 仅在文本变化时才写入,避免无谓的重排与读屏器重复朗读。 */
export function setText(el, text) {
  const value = String(text);
  if (el.textContent !== value) el.textContent = value;
}

/**
 * 按键同步一个容器的子元素:缺少的创建,多余的移除,已有的原地更新。
 * 已有元素不会被重建,所以键盘焦点和未提交的输入不会因为每秒刷新而丢失。
 *
 * @param {Element} parent 容器(如 tbody)
 * @param {Array} items 数据
 * @param {(item) => string|number} keyOf 取键
 * @param {(item) => Element} create 创建一行(只在新增时调用)
 * @param {(row: Element, item) => void} update 用数据更新一行
 */
export function syncKeyed(parent, items, keyOf, create, update) {
  const existing = new Map();
  for (const child of [...parent.children]) existing.set(child.dataset.key, child);
  const wanted = new Set();
  let previous = null;
  for (const item of items) {
    const key = String(keyOf(item));
    wanted.add(key);
    let row = existing.get(key);
    if (!row) {
      row = create(item);
      row.dataset.key = key;
    }
    update(row, item);
    const expected = previous ? previous.nextSibling : parent.firstChild;
    if (row !== expected) parent.insertBefore(row, expected);
    previous = row;
  }
  for (const [key, row] of existing) if (!wanted.has(key)) row.remove();
}
