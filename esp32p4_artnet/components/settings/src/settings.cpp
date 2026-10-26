//! 配置持久化实现（NVS）。

#include "artcore/settings.hpp"

#include <cstring>
#include <utility>

#include "artcore/ct_compare.hpp"
#include "esp_random.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "psa/crypto.h"  // mbedtls 4.x 稳定公开接口（旧 mbedtls_sha256_* 已禁用，esp_sha 已移除）

namespace artcore {

namespace {

/// NVS 命名空间。
constexpr const char* kNs = "artcfg";

/// 读取 `uint32`，键不存在时保留 `out` 原值。
void get_u32(nvs_handle_t h, const char* key, uint32_t& out) {
    uint32_t v;
    if (nvs_get_u32(h, key, &v) == ESP_OK) {
        out = v;
    }
}

/// 读取 `uint16`。
void get_u16(nvs_handle_t h, const char* key, uint16_t& out) {
    uint16_t v;
    if (nvs_get_u16(h, key, &v) == ESP_OK) {
        out = v;
    }
}

/// 读取 `uint8`。
void get_u8(nvs_handle_t h, const char* key, uint8_t& out) {
    uint8_t v;
    if (nvs_get_u8(h, key, &v) == ESP_OK) {
        out = v;
    }
}

/// 读取 `bool`（以 u8 存储）。
void get_bool(nvs_handle_t h, const char* key, bool& out) {
    uint8_t v;
    if (nvs_get_u8(h, key, &v) == ESP_OK) {
        out = (v != 0);
    }
}

/// 读取字符串。
void get_str(nvs_handle_t h, const char* key, std::string& out) {
    std::size_t len = 0;
    if (nvs_get_str(h, key, nullptr, &len) == ESP_OK && len > 0) {
        std::string buf(len, '\0');
        if (nvs_get_str(h, key, buf.data(), &len) == ESP_OK) {
            // len 含结尾 NUL。
            if (!buf.empty() && buf.back() == '\0') {
                buf.pop_back();
            }
            out = std::move(buf);
        }
    }
}

/// 由盐 + token 派生 SHA-256(salt || token) 到 `out`（长度 [`kTokenHashLen`]）。
///
/// 用 PSA Crypto 的 `psa_hash_compute` 计算 SHA-256（mbedtls 4.x 的稳定公开接口）。
/// salt 与 token 拼接到栈缓冲后一次性计算，缓冲足以容纳 16B 盐 + 最长 256B 呈现 token
/// （Authorization 头上限约束之内）。`psa_crypto_init` 幂等且线程安全，重复调用无副作用。
void derive_token_hash(const uint8_t* salt, std::size_t salt_len, std::string_view token,
                       uint8_t* out) noexcept {
    uint8_t buf[kTokenSaltLen + 256];
    if (salt_len > kTokenSaltLen) {
        salt_len = kTokenSaltLen;
    }
    std::memcpy(buf, salt, salt_len);
    std::size_t tlen = token.size();
    if (tlen > sizeof(buf) - salt_len) {
        tlen = sizeof(buf) - salt_len;
    }
    std::memcpy(buf + salt_len, token.data(), tlen);
    (void)psa_crypto_init();
    std::size_t olen = 0;
    (void)psa_hash_compute(PSA_ALG_SHA_256, buf, salt_len + tlen, out, kTokenHashLen, &olen);
}

/// 向配置写入 token 的盐 + 哈希（空串表示清除）。仅改内存，由调用方持久化。
void assign_token_fields(AppSettings& s, std::string_view token) noexcept {
    if (token.empty()) {
        s.token_set = false;
        s.token_salt.fill(0);
        s.token_hash.fill(0);
        return;
    }
    esp_fill_random(s.token_salt.data(), s.token_salt.size());
    derive_token_hash(s.token_salt.data(), s.token_salt.size(), token, s.token_hash.data());
    s.token_set = true;
}

}  // namespace

Result<void> Settings::load() noexcept {
    nvs_handle_t h;
    esp_err_t e = nvs_open(kNs, NVS_READWRITE, &h);
    if (e != ESP_OK) {
        return err(Status::IoError);
    }

    uint16_t ver = 0;
    bool fresh = (nvs_get_u16(h, "schema", &ver) != ESP_OK);

    if (!fresh) {
        s_.schema_version = ver;
        get_bool(h, "net_dhcp", s_.net.dhcp);
        get_u32(h, "net_ip", s_.net.ip);
        get_u32(h, "net_mask", s_.net.netmask);
        get_u32(h, "net_gw", s_.net.gateway);
        get_str(h, "net_host", s_.net.hostname);

        get_bool(h, "o_art_en", s_.artnet_enabled);
        get_bool(h, "o_sacn_en", s_.sacn_enabled);
        uint8_t tm = static_cast<uint8_t>(s_.target_mode);
        get_u8(h, "o_tmode", tm);
        s_.target_mode = static_cast<TargetMode>(tm);
        get_u32(h, "o_uni_ip", s_.unicast_ip);
        get_u16(h, "o_art_port", s_.artnet_port);
        get_u16(h, "o_sacn_port", s_.sacn_port);
        get_bool(h, "o_sacn_mc", s_.sacn_multicast);
        get_u8(h, "o_sacn_pri", s_.sacn_priority);
        get_str(h, "o_srcname", s_.source_name);
        uint8_t sb = static_cast<uint8_t>(s_.stop_behavior);
        get_u8(h, "o_stop", sb);
        s_.stop_behavior = static_cast<StopBehavior>(sb);
        get_u32(h, "o_keepms", s_.keepalive_ms);

        // v2 字段（缺失时保留默认值，随迁移写回）。
        get_bool(h, "o_uart_en", s_.uart_output_enabled);
        get_bool(h, "o_net_en", s_.net_output_enabled);
        get_u16(h, "fwd_start", s_.forward_uni_start);
        get_u16(h, "fwd_count", s_.forward_uni_count);
        get_bool(h, "fwd_sacn", s_.forward_sacn);

        get_u8(h, "work_mode", s_.work_mode);

        // HTTP token（加盐哈希，v3+）。
        {
            uint8_t tset = 0;
            std::size_t sl = s_.token_salt.size();
            std::size_t hl = s_.token_hash.size();
            if (nvs_get_u8(h, "tok_set", &tset) == ESP_OK && tset != 0 &&
                nvs_get_blob(h, "tok_salt", s_.token_salt.data(), &sl) == ESP_OK &&
                sl == s_.token_salt.size() &&
                nvs_get_blob(h, "tok_hash", s_.token_hash.data(), &hl) == ESP_OK &&
                hl == s_.token_hash.size()) {
                s_.token_set = true;
            }
        }

        // v2→v3 迁移：把旧明文 token 转存为加盐哈希，并抹除明文键。
        if (s_.schema_version < 3) {
            std::string legacy;
            get_str(h, "http_token", legacy);
            if (!s_.token_set && !legacy.empty()) {
                assign_token_fields(s_, legacy);
            }
            nvs_erase_key(h, "http_token");  // 不存在则忽略
        }

        // 迁移：schema < 当前版本时，缺失字段已用默认值补齐，更新版本号。
        if (s_.schema_version != kSettingsSchemaVersion) {
            s_.schema_version = kSettingsSchemaVersion;
            nvs_commit(h);  // 落实上面对旧明文 token 键的擦除（close 不保证提交）
            nvs_close(h);
            return save();
        }
    }
    nvs_close(h);

    if (fresh) {
        // 首次：写入默认配置。
        return save();
    }
    return {};
}

Result<void> Settings::save() noexcept {
    nvs_handle_t h;
    if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) {
        return err(Status::IoError);
    }

    bool ok = true;
    auto chk = [&](esp_err_t e) { ok = ok && (e == ESP_OK); };

    chk(nvs_set_u16(h, "schema", kSettingsSchemaVersion));
    chk(nvs_set_u8(h, "net_dhcp", s_.net.dhcp ? 1 : 0));
    chk(nvs_set_u32(h, "net_ip", s_.net.ip));
    chk(nvs_set_u32(h, "net_mask", s_.net.netmask));
    chk(nvs_set_u32(h, "net_gw", s_.net.gateway));
    chk(nvs_set_str(h, "net_host", s_.net.hostname.c_str()));

    chk(nvs_set_u8(h, "o_art_en", s_.artnet_enabled ? 1 : 0));
    chk(nvs_set_u8(h, "o_sacn_en", s_.sacn_enabled ? 1 : 0));
    chk(nvs_set_u8(h, "o_tmode", static_cast<uint8_t>(s_.target_mode)));
    chk(nvs_set_u32(h, "o_uni_ip", s_.unicast_ip));
    chk(nvs_set_u16(h, "o_art_port", s_.artnet_port));
    chk(nvs_set_u16(h, "o_sacn_port", s_.sacn_port));
    chk(nvs_set_u8(h, "o_sacn_mc", s_.sacn_multicast ? 1 : 0));
    chk(nvs_set_u8(h, "o_sacn_pri", s_.sacn_priority));
    chk(nvs_set_str(h, "o_srcname", s_.source_name.c_str()));
    chk(nvs_set_u8(h, "o_stop", static_cast<uint8_t>(s_.stop_behavior)));
    chk(nvs_set_u32(h, "o_keepms", s_.keepalive_ms));

    chk(nvs_set_u8(h, "o_uart_en", s_.uart_output_enabled ? 1 : 0));
    chk(nvs_set_u8(h, "o_net_en", s_.net_output_enabled ? 1 : 0));
    chk(nvs_set_u16(h, "fwd_start", s_.forward_uni_start));
    chk(nvs_set_u16(h, "fwd_count", s_.forward_uni_count));
    chk(nvs_set_u8(h, "fwd_sacn", s_.forward_sacn ? 1 : 0));

    chk(nvs_set_u8(h, "work_mode", s_.work_mode));
    chk(nvs_set_u8(h, "tok_set", s_.token_set ? 1 : 0));
    if (s_.token_set) {
        chk(nvs_set_blob(h, "tok_salt", s_.token_salt.data(), s_.token_salt.size()));
        chk(nvs_set_blob(h, "tok_hash", s_.token_hash.data(), s_.token_hash.size()));
    }

    chk(nvs_commit(h));
    nvs_close(h);
    return ok ? Result<void>{} : err(Status::IoError);
}

bool Settings::verify_token(std::string_view presented) const noexcept {
    if (!s_.token_set) {
        return false;
    }
    uint8_t calc[kTokenHashLen];
    derive_token_hash(s_.token_salt.data(), s_.token_salt.size(), presented, calc);
    return ct_equal(calc, s_.token_hash.data(), kTokenHashLen);
}

Result<void> Settings::set_token(std::string_view token) noexcept {
    assign_token_fields(s_, token);
    return save();
}

OutputConfig Settings::output_config(const uint8_t mac[6], uint32_t broadcast_ip) const noexcept {
    OutputConfig c{};
    // 网络输出总开关与各协议开关结合：总开关关闭则两协议都不发。
    c.artnet_enabled = s_.net_output_enabled && s_.artnet_enabled;
    c.sacn_enabled = s_.net_output_enabled && s_.sacn_enabled;
    c.target_mode = s_.target_mode;
    c.unicast_ip = s_.unicast_ip;
    c.broadcast_ip = broadcast_ip;
    c.artnet_port = s_.artnet_port;
    c.sacn_port = s_.sacn_port;
    c.sacn_multicast = s_.sacn_multicast;
    c.sacn_priority = s_.sacn_priority;
    c.source_name = s_.source_name;
    c.stop_behavior = s_.stop_behavior;
    c.keepalive_ms = s_.keepalive_ms;

    // CID：固定前缀 + MAC，保证重启稳定且设备间唯一。
    static constexpr uint8_t kCidPrefix[10] = {'A', 'R', 'T', 'C', 'O', 'R', 'E', 0x11, 0x17, 0x4e};
    for (int i = 0; i < 10; ++i) {
        c.cid[i] = kCidPrefix[i];
    }
    for (int i = 0; i < 6; ++i) {
        c.cid[10 + i] = mac[i];
    }
    return c;
}

}  // namespace artcore
