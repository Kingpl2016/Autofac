//! 节目编号映射表实现（cJSON 持久化 + 目录对账）。

#include "artcore/program_store.hpp"

#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <memory>

#include "artcore/storage.hpp"
#include "cJSON.h"

namespace artcore {

namespace {

/// cJSON 的 RAII 删除器。
struct CJsonDeleter {
    void operator()(cJSON* p) const noexcept {
        if (p != nullptr) {
            cJSON_Delete(p);
        }
    }
};
using CJsonPtr = std::unique_ptr<cJSON, CJsonDeleter>;

/// 读取整个文本文件到字符串。
std::optional<std::string> read_file(const char* path) {
    FILE* f = std::fopen(path, "rb");
    if (f == nullptr) {
        return std::nullopt;
    }
    // 上限防御：programs.json 由本机自写，正常极小；损坏 / 超大则放弃加载，
    // 由后续 reconcile 从目录重建（自愈）。
    static constexpr std::size_t kMaxJsonFile = 256 * 1024;
    std::string out;
    char buf[512];
    std::size_t n;
    while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) {
        if (out.size() + n > kMaxJsonFile) {
            std::fclose(f);
            return std::nullopt;
        }
        out.append(buf, n);
    }
    std::fclose(f);
    return out;
}

/// 判断某路径是否为普通文件并取大小。
std::optional<uint64_t> file_size(const std::string& path) {
    struct stat st;
    if (::stat(path.c_str(), &st) == 0 && (st.st_mode & S_IFREG)) {
        return static_cast<uint64_t>(st.st_size);
    }
    return std::nullopt;
}

}  // namespace

Result<void> ProgramStore::init(const char* programs_dir, const char* json_path) noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    dir_ = programs_dir;
    json_ = json_path;
    for (auto& s : slots_) {
        s.reset();
    }

    // 先加载 JSON（损坏 / 缺失则忽略，后续从目录重建）。
    if (auto text = read_file(json_.c_str()); text.has_value()) {
        CJsonPtr root(cJSON_Parse(text->c_str()));
        if (root) {
            cJSON* arr = cJSON_GetObjectItem(root.get(), "entries");
            if (cJSON_IsArray(arr)) {
                cJSON* it = nullptr;
                cJSON_ArrayForEach(it, arr) {
                    cJSON* jno = cJSON_GetObjectItem(it, "no");
                    cJSON* jfile = cJSON_GetObjectItem(it, "file");
                    if (cJSON_IsNumber(jno) && cJSON_IsString(jfile)) {
                        int no = jno->valueint;
                        // 复校文件名：即便 programs.json 被篡改（如注入 ".." / 绝对路径），
                        // 非法条目也一律丢弃，守住文件名白名单的防御纵深。
                        if (no >= 1 && no <= kMaxNo &&
                            storage::is_valid_program_filename(jfile->valuestring)) {
                            slots_[static_cast<std::size_t>(no)] =
                                Slot{jfile->valuestring, 0};
                        }
                    }
                }
            }
        }
    }

    reconcile_locked();
    return {};
}

void ProgramStore::reconcile_locked() noexcept {
    // 1. 收集目录内的 .artrec 文件及大小。
    std::vector<std::string> files;
    DIR* d = ::opendir(dir_.c_str());
    if (d != nullptr) {
        struct dirent* ent;
        while ((ent = ::readdir(d)) != nullptr) {
            std::string nm(ent->d_name);
            if (storage::is_valid_program_filename(nm)) {
                files.push_back(std::move(nm));
            }
        }
        ::closedir(d);
    }

    bool changed = false;

    // 2. 丢弃映射里已不存在的文件；给仍存在的补 size。
    for (uint16_t no = 1; no <= kMaxNo; ++no) {
        auto& slot = slots_[no];
        if (!slot.has_value()) {
            continue;
        }
        std::string full = dir_ + "/" + slot->file;
        auto sz = file_size(full);
        if (!sz.has_value()) {
            slot.reset();
            changed = true;
        } else {
            slot->size = *sz;
        }
    }

    // 3. 目录里未被任何编号映射的文件，分配最小空闲编号。
    for (const auto& f : files) {
        bool mapped = false;
        for (uint16_t no = 1; no <= kMaxNo; ++no) {
            if (slots_[no].has_value() && slots_[no]->file == f) {
                mapped = true;
                break;
            }
        }
        if (!mapped) {
            uint16_t no = smallest_free_locked();
            if (no != 0) {
                auto sz = file_size(dir_ + "/" + f);
                slots_[no] = Slot{f, sz.value_or(0)};
                changed = true;
            }
        }
    }

    if (changed) {
        (void)persist_locked();
    }
}

uint16_t ProgramStore::smallest_free_locked() const noexcept {
    for (uint16_t no = 1; no <= kMaxNo; ++no) {
        if (!slots_[no].has_value()) {
            return no;
        }
    }
    return 0;  // 耗尽
}

Result<void> ProgramStore::persist_locked() noexcept {
    CJsonPtr root(cJSON_CreateObject());
    if (!root) {
        return err(Status::IoError);
    }
    cJSON* arr = cJSON_AddArrayToObject(root.get(), "entries");
    for (uint16_t no = 1; no <= kMaxNo; ++no) {
        if (!slots_[no].has_value()) {
            continue;
        }
        cJSON* item = cJSON_CreateObject();
        cJSON_AddNumberToObject(item, "no", no);
        cJSON_AddStringToObject(item, "file", slots_[no]->file.c_str());
        cJSON_AddItemToArray(arr, item);
    }

    char* text = cJSON_PrintUnformatted(root.get());
    if (text == nullptr) {
        return err(Status::IoError);
    }

    std::string tmp = json_ + ".tmp";
    FILE* f = std::fopen(tmp.c_str(), "wb");
    if (f == nullptr) {
        cJSON_free(text);
        return err(Status::IoError);
    }
    std::size_t len = std::strlen(text);
    std::size_t w = std::fwrite(text, 1, len, f);
    std::fflush(f);
    ::fsync(::fileno(f));  // 刷到物理介质，缩小掉电丢失窗口
    std::fclose(f);
    cJSON_free(text);
    if (w != len) {
        ::unlink(tmp.c_str());
        return err(Status::IoError);
    }

    return storage::atomic_replace(tmp.c_str(), json_.c_str());
}

std::optional<std::string> ProgramStore::file_for(uint16_t no) const noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    if (no < 1 || no > kMaxNo || !slots_[no].has_value()) {
        return std::nullopt;
    }
    return slots_[no]->file;
}

std::optional<std::string> ProgramStore::path_for(uint16_t no) const noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    if (no < 1 || no > kMaxNo || !slots_[no].has_value()) {
        return std::nullopt;
    }
    return dir_ + "/" + slots_[no]->file;
}

std::optional<uint64_t> ProgramStore::size_for(uint16_t no) const noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    if (no < 1 || no > kMaxNo || !slots_[no].has_value()) {
        return std::nullopt;
    }
    return slots_[no]->size;
}

std::optional<uint16_t> ProgramStore::number_for(std::string_view file) const noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    for (uint16_t no = 1; no <= kMaxNo; ++no) {
        if (slots_[no].has_value() && slots_[no]->file == file) {
            return no;
        }
    }
    return std::nullopt;
}

std::vector<ProgramEntry> ProgramStore::list() const noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<ProgramEntry> out;
    for (uint16_t no = 1; no <= kMaxNo; ++no) {
        if (slots_[no].has_value()) {
            out.push_back(ProgramEntry{no, slots_[no]->file, slots_[no]->size});
        }
    }
    return out;
}

Result<void> ProgramStore::assign(uint16_t no, std::string_view file, bool force) noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    if (no < 1 || no > kMaxNo) {
        return err(Status::InvalidArg);
    }
    std::string fname(file);
    auto sz = file_size(dir_ + "/" + fname);
    if (!sz.has_value()) {
        return err(Status::NotFound);
    }
    if (slots_[no].has_value() && !force) {
        return err(Status::Busy);
    }
    // 若该文件已被别的编号映射，先解除旧映射（一个文件只对应一个编号）。
    for (uint16_t i = 1; i <= kMaxNo; ++i) {
        if (i != no && slots_[i].has_value() && slots_[i]->file == fname) {
            slots_[i].reset();
        }
    }
    slots_[no] = Slot{std::move(fname), *sz};
    return persist_locked();
}

Result<void> ProgramStore::unassign(uint16_t no) noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    if (no < 1 || no > kMaxNo) {
        return err(Status::InvalidArg);
    }
    if (!slots_[no].has_value()) {
        return {};
    }
    slots_[no].reset();
    return persist_locked();
}

Result<uint16_t> ProgramStore::on_file_added(std::string_view file, uint64_t size) noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    std::string fname(file);
    for (uint16_t no = 1; no <= kMaxNo; ++no) {
        if (slots_[no].has_value() && slots_[no]->file == fname) {
            slots_[no]->size = size;  // 覆盖上传，更新大小
            (void)persist_locked();
            return no;
        }
    }
    uint16_t no = smallest_free_locked();
    if (no == 0) {
        return err(Status::NoSpace);
    }
    slots_[no] = Slot{std::move(fname), size};
    if (auto r = persist_locked(); !r) {
        return err(r.error());
    }
    return no;
}

Result<void> ProgramStore::on_file_removed(std::string_view file) noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    for (uint16_t no = 1; no <= kMaxNo; ++no) {
        if (slots_[no].has_value() && slots_[no]->file == file) {
            slots_[no].reset();
            return persist_locked();
        }
    }
    return {};
}

Result<void> ProgramStore::on_file_renamed(std::string_view from, std::string_view to) noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    for (uint16_t no = 1; no <= kMaxNo; ++no) {
        if (slots_[no].has_value() && slots_[no]->file == from) {
            slots_[no]->file = std::string(to);
            auto sz = file_size(dir_ + "/" + std::string(to));
            if (sz.has_value()) {
                slots_[no]->size = *sz;
            }
            return persist_locked();
        }
    }
    return {};
}

}  // namespace artcore
