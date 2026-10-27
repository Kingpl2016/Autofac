//! 统一 HTTP 服务实现。

#include "artcore/api_server.hpp"

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

#include "artcore/artrec.hpp"
#include "artcore/config_validate.hpp"
#include "artcore/http_auth.hpp"
#include "artcore/log_ring.hpp"
#include "artcore/ota.hpp"
#include "cJSON.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

namespace artcore {

namespace {
constexpr const char* kTag = "api";
/// JSON 请求体上限。
constexpr std::size_t kMaxJsonBody = 4096;
/// 文件 / 固件分块传输缓冲大小。
constexpr std::size_t kIoChunk = 8192;
/// 上传预留的磁盘余量（字节）。
constexpr uint64_t kDiskMargin = 512 * 1024;

struct CJsonDeleter {
    void operator()(cJSON* p) const noexcept {
        if (p) cJSON_Delete(p);
    }
};
using CJsonPtr = std::unique_ptr<cJSON, CJsonDeleter>;

ApiServer* srv(httpd_req_t* req) { return static_cast<ApiServer*>(req->user_ctx); }

/// 从请求中提取 `Authorization: Bearer <token>` 并交给 Settings 做加盐哈希校验。
bool verify_bearer(httpd_req_t* req, const Settings& settings) {
    size_t len = httpd_req_get_hdr_value_len(req, "Authorization");
    if (len == 0 || len > 256) {
        return false;
    }
    std::string hdr(len + 1, '\0');
    if (httpd_req_get_hdr_value_str(req, "Authorization", hdr.data(), hdr.size()) != ESP_OK) {
        return false;
    }
    hdr.resize(std::strlen(hdr.c_str()));
    constexpr std::string_view kPrefix = "Bearer ";
    if (hdr.size() <= kPrefix.size() || hdr.compare(0, kPrefix.size(), kPrefix) != 0) {
        return false;
    }
    return settings.verify_token(std::string_view(hdr).substr(kPrefix.size()));
}

/// 鉴权：按 [`auth_policy`] 的默认安全策略放行 / 拒绝。
///
/// - `CONFIG_ART_REQUIRE_AUTH=n`（开发 / 生产当前均如此）：忽略 token，全部放行。
/// - 开启且配置了 token：所有端点都要求有效 Bearer。
/// - 开启且未配置 token：高危（非 GET）端点拒绝、只读放行。
bool check_auth(httpd_req_t* req, ApiDeps& d) {
    const bool token_configured = d.settings->has_token();
    const bool sensitive = (req->method != HTTP_GET);
#if CONFIG_ART_REQUIRE_AUTH
    constexpr bool require_auth = true;
#else
    constexpr bool require_auth = false;
#endif
    const bool bearer_valid = token_configured && verify_bearer(req, *d.settings);
    return auth_policy(token_configured, bearer_valid, sensitive, require_auth) == AuthResult::Allow;
}

/// 统一发送 JSON（obj 由调用方释放）。
esp_err_t send_json(httpd_req_t* req, int http_status, cJSON* obj) {
    char status_line[32];
    const char* phrase = (http_status == 200)   ? "200 OK"
                         : (http_status == 206)  ? "206 Partial Content"
                         : (http_status == 400)  ? "400 Bad Request"
                         : (http_status == 401)  ? "401 Unauthorized"
                         : (http_status == 404)  ? "404 Not Found"
                         : (http_status == 409)  ? "409 Conflict"
                         : (http_status == 422)  ? "422 Unprocessable Entity"
                         : (http_status == 501)  ? "501 Not Implemented"
                         : (http_status == 503)  ? "503 Service Unavailable"
                         : (http_status == 507)  ? "507 Insufficient Storage"
                                                 : "500 Internal Server Error";
    std::snprintf(status_line, sizeof(status_line), "%s", phrase);
    httpd_resp_set_status(req, status_line);
    httpd_resp_set_type(req, "application/json");
    char* text = cJSON_PrintUnformatted(obj);
    esp_err_t e = httpd_resp_sendstr(req, text ? text : "{}");
    if (text) {
        cJSON_free(text);
    }
    return e;
}

/// 发送简单成功 `{"ok":true}`。
esp_err_t send_ok(httpd_req_t* req) {
    CJsonPtr o(cJSON_CreateObject());
    cJSON_AddBoolToObject(o.get(), "ok", true);
    return send_json(req, 200, o.get());
}

/// 发送错误 `{"error":"<name>"}`，HTTP 状态由 Status 映射。
esp_err_t send_err(httpd_req_t* req, Status s) {
    CJsonPtr o(cJSON_CreateObject());
    cJSON_AddStringToObject(o.get(), "error", status_name(s));
    return send_json(req, status_to_http(s), o.get());
}

/// 按 [`Result`] 发送：成功 `{"ok":true}`，失败按 Status 映射错误。
esp_err_t send_result(httpd_req_t* req, const Result<void>& r) {
    return r ? send_ok(req) : send_err(req, r.error());
}

/// 发送 401 未授权。
esp_err_t send_401(httpd_req_t* req) {
    CJsonPtr o(cJSON_CreateObject());
    cJSON_AddStringToObject(o.get(), "error", "unauthorized");
    httpd_resp_set_hdr(req, "WWW-Authenticate", "Bearer");
    return send_json(req, 401, o.get());
}

/// 读取整个请求体到字符串（上限 max）。
bool recv_body(httpd_req_t* req, std::string& out, std::size_t max) {
    if (req->content_len > max) {
        return false;
    }
    out.clear();
    out.reserve(req->content_len);
    char buf[512];
    std::size_t remaining = req->content_len;
    while (remaining > 0) {
        int r = httpd_req_recv(req, buf, std::min(sizeof(buf), remaining));
        if (r <= 0) {
            return false;
        }
        out.append(buf, static_cast<std::size_t>(r));
        remaining -= static_cast<std::size_t>(r);
    }
    return true;
}

/// URL 百分号解码。
std::string url_decode(std::string_view in) {
    std::string out;
    out.reserve(in.size());
    for (std::size_t i = 0; i < in.size(); ++i) {
        if (in[i] == '%' && i + 2 < in.size()) {
            auto hex = [](char c) -> int {
                if (c >= '0' && c <= '9') return c - '0';
                if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                return -1;
            };
            int hi = hex(in[i + 1]);
            int lo = hex(in[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out.push_back(static_cast<char>((hi << 4) | lo));
                i += 2;
                continue;
            }
        }
        if (in[i] == '+') {
            out.push_back(' ');
        } else {
            out.push_back(in[i]);
        }
    }
    return out;
}

/// 取 URI 中 prefix 之后的部分（去掉查询串）。
std::string_view tail_after(const char* uri, std::string_view prefix) {
    std::string_view u(uri);
    auto q = u.find('?');
    if (q != std::string_view::npos) {
        u = u.substr(0, q);
    }
    if (u.size() >= prefix.size() && u.compare(0, prefix.size(), prefix) == 0) {
        return u.substr(prefix.size());
    }
    return {};
}

/// 主机序 u32 → 点分十进制字符串（首八位组在最高位，与 NetConfig 一致）。
std::string ip_to_str(uint32_t ip) {
    char b[16];
    std::snprintf(b, sizeof(b), "%u.%u.%u.%u", static_cast<unsigned>((ip >> 24) & 0xFF),
                  static_cast<unsigned>((ip >> 16) & 0xFF), static_cast<unsigned>((ip >> 8) & 0xFF),
                  static_cast<unsigned>(ip & 0xFF));
    return b;
}

// ===================== 控制类 =====================

esp_err_t h_status(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);

    NetStatus ns = d.net->status();
    OtaStatus os = ota_status();
    CJsonPtr o(cJSON_CreateObject());
    cJSON_AddStringToObject(o.get(), "version", os.version.c_str());
    cJSON_AddNumberToObject(o.get(), "workMode", d.settings->data().work_mode);
    cJSON_AddStringToObject(o.get(), "ip", ip_to_str(ns.ip).c_str());
    cJSON_AddStringToObject(o.get(), "netmask", ip_to_str(ns.netmask).c_str());
    cJSON_AddStringToObject(o.get(), "gateway", ip_to_str(ns.gateway).c_str());
    cJSON_AddBoolToObject(o.get(), "viaDhcp", ns.via_dhcp);
    cJSON_AddBoolToObject(o.get(), "linkUp", ns.link_up);
    cJSON_AddBoolToObject(o.get(), "sdMounted", d.sd->mounted());

    if (auto di = storage::disk_info(d.mount_point.c_str()); di) {
        cJSON_AddNumberToObject(o.get(), "sdTotal", static_cast<double>(di->total_bytes));
        cJSON_AddNumberToObject(o.get(), "sdFree", static_cast<double>(di->free_bytes));
    }
    PlayerStatus ps = d.player->status();
    cJSON* pj = cJSON_AddObjectToObject(o.get(), "player");
    cJSON_AddNumberToObject(pj, "state", ps.state);
    cJSON_AddNumberToObject(pj, "programNo", ps.program_no);
    cJSON_AddNumberToObject(pj, "posMs", ps.pos_ms);
    cJSON_AddNumberToObject(pj, "durMs", ps.dur_ms);
    return send_json(req, 200, o.get());
}

esp_err_t h_workmode_get(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);
    CJsonPtr o(cJSON_CreateObject());
    cJSON_AddNumberToObject(o.get(), "mode", d.control->work_mode());
    return send_json(req, 200, o.get());
}

esp_err_t h_workmode_put(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);
    std::string body;
    if (!recv_body(req, body, kMaxJsonBody)) return send_err(req, Status::InvalidArg);
    CJsonPtr root(cJSON_Parse(body.c_str()));
    cJSON* m = root ? cJSON_GetObjectItem(root.get(), "mode") : nullptr;
    if (!cJSON_IsNumber(m)) return send_err(req, Status::InvalidArg);
    return send_result(req, d.control->set_work_mode(m->valueint));
}

esp_err_t h_board(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);
    std::string body;
    if (!recv_body(req, body, kMaxJsonBody)) return send_err(req, Status::InvalidArg);
    CJsonPtr root(cJSON_Parse(body.c_str()));
    cJSON* op = root ? cJSON_GetObjectItem(root.get(), "op") : nullptr;
    if (!cJSON_IsNumber(op)) return send_err(req, Status::InvalidArg);
    // 复位 / 出厂的回调由 app 层做成延迟执行，故此处可先回成功响应再触发重启。
    return send_result(req, d.control->board_op(op->valueint));
}

esp_err_t h_program(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);
    std::string body;
    if (!recv_body(req, body, kMaxJsonBody)) return send_err(req, Status::InvalidArg);
    CJsonPtr root(cJSON_Parse(body.c_str()));
    cJSON* jno = root ? cJSON_GetObjectItem(root.get(), "no") : nullptr;
    cJSON* jact = root ? cJSON_GetObjectItem(root.get(), "action") : nullptr;
    if (!cJSON_IsNumber(jno) || !cJSON_IsNumber(jact)) return send_err(req, Status::InvalidArg);
    return send_result(req, d.control->program_op(jno->valueint, jact->valueint));
}

esp_err_t h_player_get(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);
    PlayerStatus ps = d.player->status();
    CJsonPtr o(cJSON_CreateObject());
    cJSON_AddNumberToObject(o.get(), "state", ps.state);
    cJSON_AddNumberToObject(o.get(), "programNo", ps.program_no);
    cJSON_AddNumberToObject(o.get(), "repeat", ps.repeat);
    cJSON_AddNumberToObject(o.get(), "speedX100", ps.speed_x100);
    cJSON_AddNumberToObject(o.get(), "posMs", ps.pos_ms);
    cJSON_AddNumberToObject(o.get(), "durMs", ps.dur_ms);
    cJSON_AddNumberToObject(o.get(), "universes", ps.universes);
    cJSON_AddNumberToObject(o.get(), "frames", ps.frames);
    cJSON_AddNumberToObject(o.get(), "badFrames", ps.bad_frames);
    return send_json(req, 200, o.get());
}

esp_err_t h_player_seek(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);
    std::string body;
    if (!recv_body(req, body, kMaxJsonBody)) return send_err(req, Status::InvalidArg);
    CJsonPtr root(cJSON_Parse(body.c_str()));
    cJSON* p = root ? cJSON_GetObjectItem(root.get(), "posMs") : nullptr;
    if (!cJSON_IsNumber(p) || p->valuedouble < 0) return send_err(req, Status::InvalidArg);
    return send_result(req, d.control->player_seek(static_cast<uint32_t>(p->valuedouble)));
}

esp_err_t h_player_speed(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);
    std::string body;
    if (!recv_body(req, body, kMaxJsonBody)) return send_err(req, Status::InvalidArg);
    CJsonPtr root(cJSON_Parse(body.c_str()));
    cJSON* s = root ? cJSON_GetObjectItem(root.get(), "speedX100") : nullptr;
    if (!cJSON_IsNumber(s)) return send_err(req, Status::InvalidArg);
    return send_result(req, d.control->player_set_speed(s->valueint));
}

esp_err_t h_logs(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);
    std::string logs = log_ring::snapshot();
    httpd_resp_set_type(req, "text/plain; charset=utf-8");
    return httpd_resp_send(req, logs.data(), static_cast<ssize_t>(logs.size()));
}

/// 运行期诊断：各任务栈高水位 / CPU 占比 / 所在核 + 堆信息 + DMX UART 欠载计数。
///
/// 用于把并发加固从「理论成立」变成「可量化证据」：验证栈余量（重点 player_prefetch
/// 的 Zstd 解压栈）、core 0 负载、长跑堆碎片趋势，以及 TX 欠载是否归零。只读端点。
esp_err_t h_diag(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);

    CJsonPtr o(cJSON_CreateObject());

    // 堆：空闲 / 历史最小空闲 / 最大可分配块（碎片指标）/ PSRAM 空闲。
    cJSON* heap = cJSON_AddObjectToObject(o.get(), "heap");
    cJSON_AddNumberToObject(heap, "free", static_cast<double>(esp_get_free_heap_size()));
    cJSON_AddNumberToObject(heap, "minFree",
                            static_cast<double>(esp_get_minimum_free_heap_size()));
    cJSON_AddNumberToObject(heap, "largestBlock",
                            static_cast<double>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));
    cJSON_AddNumberToObject(heap, "psramFree",
                            static_cast<double>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)));

    // 任务列表：名称 / 优先级 / 栈历史最小剩余（字节，越小越危险）/ 运行计数 / CPU 千分比。
    cJSON* tasks = cJSON_AddArrayToObject(o.get(), "tasks");
    UBaseType_t n = uxTaskGetNumberOfTasks();
    std::vector<TaskStatus_t> st(static_cast<std::size_t>(n) + 4);
    uint32_t total_runtime = 0;
    UBaseType_t got = uxTaskGetSystemState(st.data(), static_cast<UBaseType_t>(st.size()),
                                           &total_runtime);
    for (UBaseType_t i = 0; i < got; ++i) {
        cJSON* t = cJSON_CreateObject();
        cJSON_AddStringToObject(t, "name", st[i].pcTaskName ? st[i].pcTaskName : "?");
        cJSON_AddNumberToObject(t, "prio", static_cast<double>(st[i].uxCurrentPriority));
        // 栈高水位：运行以来的最小剩余栈字节数（uxTaskGetStackHighWaterMark 语义）。
        cJSON_AddNumberToObject(t, "stackMin",
                                static_cast<double>(st[i].usStackHighWaterMark));
#if (configTASKLIST_INCLUDE_COREID == 1)
        cJSON_AddNumberToObject(t, "core", static_cast<double>(st[i].xCoreID));
#endif
        cJSON_AddNumberToObject(t, "runtime", static_cast<double>(st[i].ulRunTimeCounter));
        if (total_runtime > 0) {
            cJSON_AddNumberToObject(
                t, "cpuPermille",
                static_cast<double>(static_cast<uint64_t>(st[i].ulRunTimeCounter) * 1000 /
                                    total_runtime));
        }
        cJSON_AddItemToArray(tasks, t);
    }

    // DMX UART：口数 + TX 超时计数（帧中欠载间接指标，修复后应长期保持 0）。
    if (d.uart != nullptr) {
        cJSON* u = cJSON_AddObjectToObject(o.get(), "dmxUart");
        cJSON_AddNumberToObject(u, "ports", static_cast<double>(d.uart->port_count()));
        cJSON_AddNumberToObject(u, "txTimeouts", static_cast<double>(d.uart->tx_timeout_count()));
    }

    // 回放迟到统计（引擎已有度量，经 player 状态暴露 badFrames；此处补总体位置）。
    PlayerStatus ps = d.player->status();
    cJSON* pj = cJSON_AddObjectToObject(o.get(), "player");
    cJSON_AddNumberToObject(pj, "state", ps.state);
    cJSON_AddNumberToObject(pj, "badFrames", ps.bad_frames);

    return send_json(req, 200, o.get());
}

// ===================== 配置 =====================

esp_err_t h_config_get(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);
    const AppSettings& s = d.settings->data();
    CJsonPtr o(cJSON_CreateObject());
    cJSON_AddBoolToObject(o.get(), "artnetEnabled", s.artnet_enabled);
    cJSON_AddBoolToObject(o.get(), "sacnEnabled", s.sacn_enabled);
    cJSON_AddNumberToObject(o.get(), "targetMode", static_cast<int>(s.target_mode));
    cJSON_AddNumberToObject(o.get(), "sacnMulticast", s.sacn_multicast ? 1 : 0);
    cJSON_AddNumberToObject(o.get(), "sacnPriority", s.sacn_priority);
    cJSON_AddNumberToObject(o.get(), "stopBehavior", static_cast<int>(s.stop_behavior));
    cJSON_AddNumberToObject(o.get(), "keepaliveMs", s.keepalive_ms);
    cJSON_AddStringToObject(o.get(), "sourceName", s.source_name.c_str());
    // 输出通路开关与实时转发订阅（v2）。
    cJSON_AddBoolToObject(o.get(), "uartOutputEnabled", s.uart_output_enabled);
    cJSON_AddBoolToObject(o.get(), "netOutputEnabled", s.net_output_enabled);
    cJSON_AddNumberToObject(o.get(), "forwardUniStart", s.forward_uni_start);
    cJSON_AddNumberToObject(o.get(), "forwardUniCount", s.forward_uni_count);
    cJSON_AddBoolToObject(o.get(), "forwardSacn", s.forward_sacn);
    cJSON_AddBoolToObject(o.get(), "dhcp", s.net.dhcp);
    cJSON_AddStringToObject(o.get(), "ip", ip_to_str(s.net.ip).c_str());
    cJSON_AddStringToObject(o.get(), "netmask", ip_to_str(s.net.netmask).c_str());
    cJSON_AddStringToObject(o.get(), "gateway", ip_to_str(s.net.gateway).c_str());
    cJSON_AddStringToObject(o.get(), "hostname", s.net.hostname.c_str());
    // 仅告知是否已配置 token，不回显任何明文 / 哈希。
    cJSON_AddBoolToObject(o.get(), "tokenSet", d.settings->has_token());
    return send_json(req, 200, o.get());
}

esp_err_t h_config_put(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);
    std::string body;
    if (!recv_body(req, body, kMaxJsonBody)) return send_err(req, Status::InvalidArg);
    CJsonPtr root(cJSON_Parse(body.c_str()));
    if (!root) return send_err(req, Status::InvalidArg);
    AppSettings& s = d.settings->data();

    // 前置校验：任一存在字段越界 / 非法则整体拒绝，不改动任何配置。
    // 数值读原始 valuedouble，避免写入窄类型时被截断而掩盖越界。
    auto range_ok = [&](const char* k, bool (*pred)(long)) -> bool {
        cJSON* j = cJSON_GetObjectItem(root.get(), k);
        if (j == nullptr) return true;  // 缺省不校验
        if (!cJSON_IsNumber(j)) return false;
        return pred(static_cast<long>(j->valuedouble));
    };
    auto str_ok = [&](const char* k, bool (*pred)(std::string_view)) -> bool {
        cJSON* j = cJSON_GetObjectItem(root.get(), k);
        if (j == nullptr) return true;
        if (!cJSON_IsString(j)) return false;
        return pred(j->valuestring);
    };
    if (!range_ok("targetMode", valid_target_mode) ||
        !range_ok("sacnPriority", valid_sacn_priority) ||
        !range_ok("stopBehavior", valid_stop_behavior) ||
        !range_ok("keepaliveMs", valid_keepalive_ms) ||
        !range_ok("forwardUniStart", valid_forward_uni_start) ||
        !range_ok("forwardUniCount", valid_forward_uni_count) ||
        !str_ok("sourceName", valid_source_name) ||
        !str_ok("hostname", valid_hostname) ||
        !str_ok("ip", valid_ipv4) ||
        !str_ok("netmask", valid_ipv4) ||
        !str_ok("gateway", valid_ipv4) ||
        !str_ok("httpToken", valid_http_token)) {
        return send_err(req, Status::InvalidArg);
    }

    // 静态 IP 一致性：最终若关闭 DHCP，必须有非 0 静态 IP，避免落到 0.0.0.0。
    {
        bool eff_dhcp = s.net.dhcp;
        if (cJSON* jd = cJSON_GetObjectItem(root.get(), "dhcp");
            cJSON_IsBool(jd) || cJSON_IsNumber(jd)) {
            eff_dhcp = cJSON_IsTrue(jd) || (cJSON_IsNumber(jd) && jd->valueint != 0);
        }
        uint32_t eff_ip = s.net.ip;
        if (cJSON* ji = cJSON_GetObjectItem(root.get(), "ip"); cJSON_IsString(ji)) {
            eff_ip = parse_ipv4(ji->valuestring).value_or(0);
        }
        if (!eff_dhcp && eff_ip == 0) {
            return send_err(req, Status::InvalidArg);
        }
    }

    auto get_bool = [&](const char* k, bool& v) {
        cJSON* j = cJSON_GetObjectItem(root.get(), k);
        if (cJSON_IsBool(j)) v = cJSON_IsTrue(j);
        else if (cJSON_IsNumber(j)) v = (j->valueint != 0);
    };
    auto get_num = [&](const char* k, auto& v) {
        cJSON* j = cJSON_GetObjectItem(root.get(), k);
        if (cJSON_IsNumber(j)) v = static_cast<std::remove_reference_t<decltype(v)>>(j->valueint);
    };

    get_bool("artnetEnabled", s.artnet_enabled);
    get_bool("sacnEnabled", s.sacn_enabled);
    { int tm = static_cast<int>(s.target_mode); get_num("targetMode", tm);
      s.target_mode = static_cast<TargetMode>(tm); }
    get_bool("sacnMulticast", s.sacn_multicast);
    get_num("sacnPriority", s.sacn_priority);
    { int sb = static_cast<int>(s.stop_behavior); get_num("stopBehavior", sb);
      s.stop_behavior = static_cast<StopBehavior>(sb); }
    get_num("keepaliveMs", s.keepalive_ms);
    if (cJSON* sn = cJSON_GetObjectItem(root.get(), "sourceName"); cJSON_IsString(sn)) {
        s.source_name = sn->valuestring;
    }
    get_bool("uartOutputEnabled", s.uart_output_enabled);
    get_bool("netOutputEnabled", s.net_output_enabled);
    get_num("forwardUniStart", s.forward_uni_start);
    get_num("forwardUniCount", s.forward_uni_count);
    get_bool("forwardSacn", s.forward_sacn);
    get_bool("dhcp", s.net.dhcp);
    if (cJSON* ji = cJSON_GetObjectItem(root.get(), "ip"); cJSON_IsString(ji)) {
        s.net.ip = parse_ipv4(ji->valuestring).value_or(s.net.ip);
    }
    if (cJSON* jm = cJSON_GetObjectItem(root.get(), "netmask"); cJSON_IsString(jm)) {
        s.net.netmask = parse_ipv4(jm->valuestring).value_or(s.net.netmask);
    }
    if (cJSON* jg = cJSON_GetObjectItem(root.get(), "gateway"); cJSON_IsString(jg)) {
        s.net.gateway = parse_ipv4(jg->valuestring).value_or(s.net.gateway);
    }
    if (cJSON* hn = cJSON_GetObjectItem(root.get(), "hostname"); cJSON_IsString(hn)) {
        s.net.hostname = hn->valuestring;
    }
    // HTTP token：提供 httpToken 字段即设置 / 清除（空串清除）；不回显明文。
    if (cJSON* tk = cJSON_GetObjectItem(root.get(), "httpToken"); cJSON_IsString(tk)) {
        (void)d.settings->set_token(tk->valuestring);
    }

    (void)d.settings->save();
    // 输出相关（UDP + UART 开关）即时生效；网络接入相关需重启。
    if (d.apply_output) {
        (void)d.apply_output();
    }
    // 转发订阅 / 模式相关：按当前工作模式重新应用，使转发参数即时生效。
    if (d.apply_mode) {
        d.apply_mode(s.work_mode);
    }
    CJsonPtr o(cJSON_CreateObject());
    cJSON_AddBoolToObject(o.get(), "ok", true);
    cJSON_AddBoolToObject(o.get(), "netRebootRequired", true);
    return send_json(req, 200, o.get());
}

// ===================== OTA =====================

esp_err_t h_ota_post(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);

    OtaSession ota;
    if (auto r = ota.begin(req->content_len); !r) {
        return send_err(req, r.error());
    }
    std::vector<uint8_t> buf(kIoChunk);
    std::size_t remaining = req->content_len;
    while (remaining > 0) {
        int r = httpd_req_recv(req, reinterpret_cast<char*>(buf.data()),
                               std::min(buf.size(), remaining));
        if (r <= 0) {
            ota.abort();
            return send_err(req, Status::IoError);
        }
        if (auto w = ota.write(std::span<const uint8_t>(buf.data(), static_cast<std::size_t>(r)));
            !w) {
            return send_err(req, w.error());
        }
        remaining -= static_cast<std::size_t>(r);
    }
    if (auto f = ota.finish(); !f) {
        return send_err(req, f.error());
    }
    CJsonPtr o(cJSON_CreateObject());
    cJSON_AddBoolToObject(o.get(), "ok", true);
    cJSON_AddStringToObject(o.get(), "newVersion", ota.new_version().c_str());
    cJSON_AddBoolToObject(o.get(), "rebooting", true);
    send_json(req, 200, o.get());
    // 延迟重启，给响应发送留时间。
    vTaskDelay(pdMS_TO_TICKS(500));
    if (d.reboot) d.reboot();
    return ESP_OK;
}

esp_err_t h_ota_status(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);
    OtaStatus os = ota_status();
    CJsonPtr o(cJSON_CreateObject());
    cJSON_AddStringToObject(o.get(), "running", os.running_partition.c_str());
    cJSON_AddStringToObject(o.get(), "version", os.version.c_str());
    cJSON_AddStringToObject(o.get(), "compileTime", os.compile_time.c_str());
    cJSON_AddBoolToObject(o.get(), "pendingVerify", os.pending_verify);
    cJSON_AddBoolToObject(o.get(), "rollbackEnabled", os.rollback_enabled);
    return send_json(req, 200, o.get());
}

esp_err_t h_ota_confirm(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);
    ota_mark_valid();
    return send_ok(req);
}

// ===================== 节目映射 =====================

esp_err_t h_programs_get(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);
    CJsonPtr o(cJSON_CreateObject());
    cJSON* arr = cJSON_AddArrayToObject(o.get(), "programs");
    for (const auto& e : d.store->list()) {
        cJSON* item = cJSON_CreateObject();
        cJSON_AddNumberToObject(item, "no", e.no);
        cJSON_AddStringToObject(item, "file", e.file.c_str());
        cJSON_AddNumberToObject(item, "size", static_cast<double>(e.size));
        cJSON_AddItemToArray(arr, item);
    }
    return send_json(req, 200, o.get());
}

/// 下载某编号对应的节目文件（支持 Range）。
esp_err_t send_file_range(httpd_req_t* req, const std::string& full);

/// 批量重排请求体上限：255 条 × 最长 128 字节文件名，远大于通用 JSON 上限。
constexpr std::size_t kMaxReorderBody = 64 * 1024;

/// 批量重排：`POST /api/programs/reorder`，body `{"entries":[{"no":1,"file":"a.artrec"},...]}`。
esp_err_t h_programs_reorder(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);
    std::string body;
    if (!recv_body(req, body, kMaxReorderBody)) return send_err(req, Status::InvalidArg);
    CJsonPtr root(cJSON_Parse(body.c_str()));
    cJSON* arr = root ? cJSON_GetObjectItem(root.get(), "entries") : nullptr;
    if (!cJSON_IsArray(arr)) return send_err(req, Status::InvalidArg);

    std::vector<ProgramEntry> entries;
    cJSON* it = nullptr;
    cJSON_ArrayForEach(it, arr) {
        cJSON* jno = cJSON_GetObjectItem(it, "no");
        cJSON* jfile = cJSON_GetObjectItem(it, "file");
        if (!cJSON_IsNumber(jno) || !cJSON_IsString(jfile) ||
            jno->valuedouble != static_cast<double>(jno->valueint) || jno->valueint < 1 ||
            jno->valueint > 255) {
            return send_err(req, Status::InvalidArg);
        }
        entries.push_back(
            ProgramEntry{static_cast<uint16_t>(jno->valueint), jfile->valuestring, 0});
    }

    // 播放中的节目编号 / 文件对应关系不得被改动，否则状态里的 programNo 会指向别的文件。
    PlayerStatus ps = d.player->status();
    if (ps.state != static_cast<uint8_t>(PlayState::Idle) && ps.program_no != 0) {
        if (auto cur = d.store->file_for(ps.program_no)) {
            for (const auto& e : entries) {
                if ((e.file == *cur) != (e.no == ps.program_no)) {
                    return send_err(req, Status::Busy);
                }
            }
        }
    }

    auto r = d.store->reorder(entries);
    if (!r) return send_err(req, r.error());
    return h_programs_get(req);  // 返回重排后的完整列表，便于客户端直接刷新
}

esp_err_t h_programs_wild(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);

    std::string_view tail = tail_after(req->uri, "/api/programs/");
    if (tail.empty()) return send_err(req, Status::InvalidArg);

    // 解析 "<no>" 或 "<no>/file"。
    bool want_file = false;
    std::string_view num_part = tail;
    if (auto slash = tail.find('/'); slash != std::string_view::npos) {
        num_part = tail.substr(0, slash);
        want_file = (tail.substr(slash + 1) == "file");
    }
    int no = std::atoi(std::string(num_part).c_str());
    if (no < 1 || no > 255) return send_err(req, Status::InvalidArg);

    if (req->method == HTTP_GET) {
        if (want_file) {
            auto path = d.store->path_for(static_cast<uint16_t>(no));
            if (!path) return send_err(req, Status::NotFound);
            return send_file_range(req, *path);
        }
        auto file = d.store->file_for(static_cast<uint16_t>(no));
        if (!file) return send_err(req, Status::NotFound);
        CJsonPtr o(cJSON_CreateObject());
        cJSON_AddNumberToObject(o.get(), "no", no);
        cJSON_AddStringToObject(o.get(), "file", file->c_str());
        cJSON_AddNumberToObject(
            o.get(), "size",
            static_cast<double>(d.store->size_for(static_cast<uint16_t>(no)).value_or(0)));
        return send_json(req, 200, o.get());
    }
    if (req->method == HTTP_PUT) {
        std::string body;
        if (!recv_body(req, body, kMaxJsonBody)) return send_err(req, Status::InvalidArg);
        CJsonPtr root(cJSON_Parse(body.c_str()));
        cJSON* jf = root ? cJSON_GetObjectItem(root.get(), "file") : nullptr;
        if (!cJSON_IsString(jf)) return send_err(req, Status::InvalidArg);
        bool force = false;
        if (cJSON* q = root ? cJSON_GetObjectItem(root.get(), "force") : nullptr; cJSON_IsBool(q)) {
            force = cJSON_IsTrue(q);
        }
        auto r = d.store->assign(static_cast<uint16_t>(no), jf->valuestring, force);
        return r ? send_ok(req) : send_err(req, r.error());
    }
    if (req->method == HTTP_DELETE) {
        auto r = d.store->unassign(static_cast<uint16_t>(no));
        return r ? send_ok(req) : send_err(req, r.error());
    }
    return send_err(req, Status::NotSupported);
}

// ===================== 文件 CRUD =====================

esp_err_t send_file_range(httpd_req_t* req, const std::string& full) {
    int fd = ::open(full.c_str(), O_RDONLY);
    if (fd < 0) return send_err(req, Status::NotFound);
    struct stat st;
    if (::fstat(fd, &st) != 0) {
        ::close(fd);
        return send_err(req, Status::IoError);
    }
    uint64_t size = static_cast<uint64_t>(st.st_size);

    uint64_t start = 0;
    uint64_t end = (size == 0) ? 0 : size - 1;
    bool partial = false;
    char range[64];
    if (httpd_req_get_hdr_value_str(req, "Range", range, sizeof(range)) == ESP_OK) {
        unsigned long long a = 0, b = 0;
        int matched = std::sscanf(range, "bytes=%llu-%llu", &a, &b);
        if (matched >= 1) {
            start = a;
            // 是否带结束位（"bytes=A-" 形式末尾为 '-'，视为到文件尾）。
            std::size_t rl = std::strlen(range);
            bool open_ended = (rl > 0 && range[rl - 1] == '-');
            if (matched >= 2 && !open_ended) {
                end = std::min<uint64_t>(b, size ? size - 1 : 0);
            }
            if (start <= end && start < size) {
                partial = true;
            }
        }
    }

    httpd_resp_set_type(req, "application/octet-stream");
    if (partial) {
        httpd_resp_set_status(req, "206 Partial Content");
        char cr[64];
        std::snprintf(cr, sizeof(cr), "bytes %llu-%llu/%llu",
                      static_cast<unsigned long long>(start),
                      static_cast<unsigned long long>(end),
                      static_cast<unsigned long long>(size));
        httpd_resp_set_hdr(req, "Content-Range", cr);
        ::lseek(fd, static_cast<off_t>(start), SEEK_SET);
    }

    uint64_t remaining = partial ? (end - start + 1) : size;
    std::vector<char> buf(kIoChunk);
    while (remaining > 0) {
        std::size_t want = static_cast<std::size_t>(std::min<uint64_t>(remaining, buf.size()));
        ssize_t r = ::read(fd, buf.data(), want);
        if (r <= 0) break;
        if (httpd_resp_send_chunk(req, buf.data(), r) != ESP_OK) {
            ::close(fd);
            return ESP_FAIL;
        }
        remaining -= static_cast<uint64_t>(r);
    }
    ::close(fd);
    httpd_resp_send_chunk(req, nullptr, 0);
    return ESP_OK;
}

esp_err_t h_files_list(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);
    CJsonPtr arr(cJSON_CreateArray());
    DIR* dir = ::opendir(d.programs_dir.c_str());
    if (dir) {
        struct dirent* ent;
        while ((ent = ::readdir(dir)) != nullptr) {
            std::string nm(ent->d_name);
            std::string full = d.programs_dir + "/" + nm;
            struct stat st;
            if (::stat(full.c_str(), &st) != 0) continue;
            cJSON* item = cJSON_CreateObject();
            cJSON_AddStringToObject(item, "name", nm.c_str());
            cJSON_AddNumberToObject(item, "size", static_cast<double>(st.st_size));
            cJSON_AddBoolToObject(item, "isDir", (st.st_mode & S_IFDIR) != 0);
            if (auto no = d.store->number_for(nm); no) {
                cJSON_AddNumberToObject(item, "program", *no);
            }
            cJSON_AddItemToArray(arr.get(), item);
        }
        ::closedir(dir);
    }
    httpd_resp_set_type(req, "application/json");
    char* text = cJSON_PrintUnformatted(arr.get());
    esp_err_t e = httpd_resp_sendstr(req, text ? text : "[]");
    if (text) cJSON_free(text);
    return e;
}

esp_err_t h_files_wild(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);

    std::string name = url_decode(tail_after(req->uri, "/files/"));
    if (!storage::is_valid_program_filename(name)) {
        return send_err(req, Status::InvalidArg);
    }
    std::string full = d.programs_dir + "/" + name;

    if (req->method == HTTP_GET) {
        return send_file_range(req, full);
    }
    if (req->method == HTTP_DELETE) {
        PlayerStatus ps = d.player->status();
        auto playing_no = d.store->number_for(name);
        if (playing_no && ps.program_no == *playing_no &&
            ps.state != static_cast<uint8_t>(PlayState::Idle)) {
            return send_err(req, Status::Busy);
        }
        if (::unlink(full.c_str()) != 0) return send_err(req, Status::NotFound);
        (void)d.store->on_file_removed(name);
        return send_ok(req);
    }
    if (req->method == HTTP_PUT) {
#if CONFIG_ART_MAX_UPLOAD_BYTES > 0
        // 绝对单文件上限（防异常超大文件 / 写满卡）。
        if (req->content_len > static_cast<std::size_t>(CONFIG_ART_MAX_UPLOAD_BYTES)) {
            return send_err(req, Status::NoSpace);
        }
#endif
        // 磁盘空间检查。
        if (auto di = storage::disk_info(d.mount_point.c_str()); di) {
            if (di->free_bytes < req->content_len + kDiskMargin) {
                return send_err(req, Status::NoSpace);
            }
        }
        std::string tmp = full + ".part";
        FILE* f = std::fopen(tmp.c_str(), "wb");
        if (!f) return send_err(req, Status::IoError);
        std::vector<char> buf(kIoChunk);
        std::size_t remaining = req->content_len;
        bool io_ok = true;
        while (remaining > 0) {
            int r = httpd_req_recv(req, buf.data(), std::min(buf.size(), remaining));
            if (r <= 0) { io_ok = false; break; }
            if (std::fwrite(buf.data(), 1, static_cast<std::size_t>(r), f) !=
                static_cast<std::size_t>(r)) {
                io_ok = false;
                break;
            }
            remaining -= static_cast<std::size_t>(r);
        }
        std::fflush(f);
        ::fsync(::fileno(f));  // 刷到物理介质后再原子替换，缩小掉电丢失窗口
        std::fclose(f);
        if (!io_ok) {
            ::unlink(tmp.c_str());
            return send_err(req, Status::IoError);
        }
        // 校验 .artrec 头。
        {
            int vfd = ::open(tmp.c_str(), O_RDONLY);
            if (vfd < 0) { ::unlink(tmp.c_str()); return send_err(req, Status::IoError); }
            uint8_t head[artrec::kHeaderSize];
            ssize_t got = ::read(vfd, head, sizeof(head));
            ::close(vfd);
            if (got < static_cast<ssize_t>(artrec::kHeaderMinParse) ||
                !artrec::parse_header(
                     std::span<const uint8_t>(head, static_cast<std::size_t>(got)))) {
                ::unlink(tmp.c_str());
                return send_err(req, Status::BadFile);
            }
        }
        if (auto rr = storage::atomic_replace(tmp.c_str(), full.c_str()); !rr) {
            ::unlink(tmp.c_str());
            return send_err(req, rr.error());
        }
        uint64_t size = 0;
        if (struct stat st; ::stat(full.c_str(), &st) == 0) size = st.st_size;
        auto no = d.store->on_file_added(name, size);
        CJsonPtr o(cJSON_CreateObject());
        cJSON_AddStringToObject(o.get(), "name", name.c_str());
        cJSON_AddNumberToObject(o.get(), "size", static_cast<double>(size));
        if (no) cJSON_AddNumberToObject(o.get(), "program", *no);
        return send_json(req, 200, o.get());
    }
    return send_err(req, Status::NotSupported);
}

esp_err_t h_rename(httpd_req_t* req) {
    ApiDeps& d = srv(req)->deps();
    if (!check_auth(req, d)) return send_401(req);
    std::string body;
    if (!recv_body(req, body, kMaxJsonBody)) return send_err(req, Status::InvalidArg);
    CJsonPtr root(cJSON_Parse(body.c_str()));
    cJSON* jf = root ? cJSON_GetObjectItem(root.get(), "from") : nullptr;
    cJSON* jt = root ? cJSON_GetObjectItem(root.get(), "to") : nullptr;
    if (!cJSON_IsString(jf) || !cJSON_IsString(jt)) return send_err(req, Status::InvalidArg);
    std::string from = jf->valuestring, to = jt->valuestring;
    if (!storage::is_valid_program_filename(from) || !storage::is_valid_program_filename(to)) {
        return send_err(req, Status::InvalidArg);
    }
    std::string ffrom = d.programs_dir + "/" + from;
    std::string fto = d.programs_dir + "/" + to;
    if (std::rename(ffrom.c_str(), fto.c_str()) != 0) {
        return send_err(req, Status::IoError);
    }
    (void)d.store->on_file_renamed(from, to);
    return send_ok(req);
}

/// 注册一条路由。
void reg(httpd_handle_t s, ApiServer* self, const char* uri, httpd_method_t m,
         esp_err_t (*h)(httpd_req_t*)) {
    httpd_uri_t u = {};
    u.uri = uri;
    u.method = m;
    u.handler = h;
    u.user_ctx = self;
    if (httpd_register_uri_handler(s, &u) != ESP_OK) {
        ESP_LOGE(kTag, "注册路由失败：%s（检查 max_uri_handlers 是否足够）", uri);
    }
}

}  // namespace

ApiServer::~ApiServer() { stop(); }

Result<void> ApiServer::start(const ApiDeps& deps, uint16_t port) noexcept {
    deps_ = deps;
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.server_port = port;
    cfg.max_uri_handlers = 29;
    cfg.stack_size = 8192;
    cfg.lru_purge_enable = true;
    cfg.uri_match_fn = httpd_uri_match_wildcard;
    cfg.recv_wait_timeout = 15;
    cfg.send_wait_timeout = 15;

    httpd_handle_t s = nullptr;
    if (httpd_start(&s, &cfg) != ESP_OK) {
        return err(Status::IoError);
    }
    server_ = s;

    reg(s, this, "/api/status", HTTP_GET, h_status);
    reg(s, this, "/api/workmode", HTTP_GET, h_workmode_get);
    reg(s, this, "/api/workmode", HTTP_PUT, h_workmode_put);
    reg(s, this, "/api/board", HTTP_POST, h_board);
    reg(s, this, "/api/program", HTTP_POST, h_program);
    reg(s, this, "/api/player", HTTP_GET, h_player_get);
    reg(s, this, "/api/player/seek", HTTP_POST, h_player_seek);
    reg(s, this, "/api/player/speed", HTTP_POST, h_player_speed);
    reg(s, this, "/api/logs", HTTP_GET, h_logs);
    reg(s, this, "/api/diag", HTTP_GET, h_diag);
    reg(s, this, "/api/config", HTTP_GET, h_config_get);
    reg(s, this, "/api/config", HTTP_PUT, h_config_put);
    reg(s, this, "/api/ota", HTTP_POST, h_ota_post);
    reg(s, this, "/api/ota/status", HTTP_GET, h_ota_status);
    reg(s, this, "/api/ota/confirm", HTTP_POST, h_ota_confirm);
    reg(s, this, "/api/programs", HTTP_GET, h_programs_get);
    reg(s, this, "/api/programs/reorder", HTTP_POST, h_programs_reorder);
    reg(s, this, "/api/programs/*", HTTP_GET, h_programs_wild);
    reg(s, this, "/api/programs/*", HTTP_PUT, h_programs_wild);
    reg(s, this, "/api/programs/*", HTTP_DELETE, h_programs_wild);
    reg(s, this, "/files", HTTP_GET, h_files_list);
    reg(s, this, "/files/*", HTTP_GET, h_files_wild);
    reg(s, this, "/files/*", HTTP_PUT, h_files_wild);
    reg(s, this, "/files/*", HTTP_DELETE, h_files_wild);
    reg(s, this, "/rename", HTTP_POST, h_rename);

    ESP_LOGI(kTag, "HTTP 服务已启动，端口 %u", port);
    return {};
}

void ApiServer::stop() noexcept {
    if (server_ != nullptr) {
        httpd_stop(static_cast<httpd_handle_t>(server_));
        server_ = nullptr;
    }
}

}  // namespace artcore
