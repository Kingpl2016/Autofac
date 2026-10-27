// REST 客户端。失败时抛出带中文说明的 Error(ApiError),界面统一用 toast 展示。

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** 发起请求。body 为对象时按 JSON 发送;返回解析后的 JSON(204 返回 null)。 */
export async function api(method, path, body) {
  const options = { method, headers: {}, credentials: "same-origin" };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new ApiError("无法连接到服务端", 0);
  }
  if (response.status === 204) return null;
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // 非 JSON 响应
  }
  if (!response.ok) {
    const detail = payload && payload.detail;
    throw new ApiError(typeof detail === "string" ? detail : `请求失败 (${response.status})`, response.status);
  }
  return payload;
}

export const get = (path) => api("GET", path);
export const post = (path, body) => api("POST", path, body === undefined ? {} : body);
export const patch = (path, body) => api("PATCH", path, body);
export const del = (path) => api("DELETE", path);

/** 上传文件(multipart),field 名为 file。 */
export async function upload(path, file) {
  const form = new FormData();
  form.append("file", file, file.name);
  let response;
  try {
    response = await fetch(path, { method: "POST", body: form, credentials: "same-origin" });
  } catch {
    throw new ApiError("无法连接到服务端", 0);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError((payload && payload.detail) || `上传失败 (${response.status})`, response.status);
  }
  return payload;
}
