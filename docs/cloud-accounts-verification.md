# 账户同步验证记录

范围：管理员建号、同账号多设备通过服务器同步、不同账号目录隔离；本仓库及上级四个客户端工程。未部署到用户现有服务、未迁移现有数据库、未发布或替换已安装 App。

## 已通过

- `go test`：`lib/cloudsync`、`lib/api`、`lib/config`、`lib/connections`、`lib/model`、`lib/syncthing`、`cmd/syncthing`、`meta`。
- `go test -race`：`lib/cloudsync`、`lib/api`。
- `go vet`：账户包、API、同步应用和命令入口。
- 新功能测试覆盖：账号格式/密码校验、不覆盖已有账号、错误密码、同账号重复/并发接入、跨账号设备复用拒绝、TLS 设备身份、非法证书/重定向/无效授权响应拒绝、请求大小/限流、CSRF/回环限制、路径重叠/符号链接/非空目录拒绝、拒绝继承不安全模板和接管已有文件夹。
- `test/cloud_account_gui_test.js`：实际控制器接入代码的本地入口判断、字段提交、防止重复点击、密码清空、错误呈现（模拟 HTTP 传输；不是完整浏览器视觉测试）。
- `test/cloud_account_e2e.py`：四个真实独立实例（服务器 + Alice 两端 + Bob 一端），管理员 CLI 建号，经实际 HTTPS 及设备证书接入，真实 BEP 文件传输；Alice1 → 服务器 → Alice2 和反向传输均通过，Bob 目录隔离，服务器重启/重复登录后不重复创建配置。测试实例只监听临时回环端口，结束时全部停止。
- Go core：macOS arm64 本机构建及运行；Windows amd64、Linux amd64、macOS amd64 交叉编译通过（未在对应 OS 上运行）。
- Syncthing Tray：集成脚本生成保留原 C bindings 的源码；该源码的账户/API 测试通过，`-buildmode=c-archive` 编译通过；验证拒绝覆盖已有 staging 目录及不匹配集成锚点。
- 小寻菜单栏：Swift 编译通过（`-warnings-as-errors`）。
- macOS 包装器：Swift 类型检查、Objective-C 语法检查、XIB XML 校验通过；既有通知 API 有弃用警告。资源脚本验证确实使用指定的新 core，且无效路径明确失败。
- Android：新增资源/XML、构建脚本 Python 语法、版本匹配/不匹配分支检查通过。
- 主仓库及三个位于 Git 的客户端仓库 `git diff --check` 通过；原有 `assets/.DS_Store` 未修改。

## 尚未验证 / 尚未交付

- 没有 Android SDK/NDK、Qt 完整开发环境或完整 Xcode，未生成或运行 APK、完整 Qt App、macOS App/DMG；未签名、公证或上传发行包。
- 未做 Android 真机权限/后台同步测试，也未做完整浏览器 UI 自动化/视觉测试。
- 未验证公网 NAT、防火墙、实际域名证书签发或生产负载。生产环境需准备 `8443/TCP` 账户入口和匹配的文件同步端口，并使用受信任且匹配域名/IP 的 HTTPS 证书。
- 账户回收、密码找回、配额和跨账号共享不在本次范围；设备撤销须由管理员操作既有设备授权。

## 本机开发产物

Go SDK 和依赖/测试缓存保存在主仓库 `tmp/cloud-tools/`；测试文件、随机测试凭据和日志保存在 `tmp/cloud-e2e-*`；Tray 的临时集成源码位于其 `tmp/`。这些目录已忽略，不应提交或发布。它们不是用户的生产数据或安装目录。

部署步骤及操作边界见 [cloud-accounts.md](cloud-accounts.md)。
