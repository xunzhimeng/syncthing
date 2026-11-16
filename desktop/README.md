# 小寻云同步桌面版

`desktop/` 使用 HTML/CSS/JavaScript + Tauri 2 + 现有 Go 同步内核，不依赖 Qt。网页不持有管理 API key，不直接请求远端账号服务器，没有通用 shell、文件系统或 HTTP 插件权限。

## 0.3.1

Mac 按用户要求不再使用钥匙串：记住密码和自动登录保留，登录信息存放在 App 数据目录的 `account.json`（目录 `0700`、文件 `0600`，**明文，本地文件权限保护而非加密**）。不自动读取、迁移或删除旧钥匙串条目；首次使用此版本需要重新输入一次云账号密码。Windows 凭据管理器行为保持不变。

- 文件 / 同步 / 设置三页：默认直接显示文件，去掉口号、统计卡、重复空间卡；账号、路径和证书信息收进设置。桌面与 Android 按同一组生图设计并经一次 Opus 简短评审，桌面保留 Tauri，Android 复用原生 Compose。
- 文件页支持逐级面包屑、全目录名称筛选、目录优先的名称/大小/时间排序及每页 100 项。文件与目录在系统管理器中定位（Mac 始终使用 Finder reveal，避免 `.app` 目录被执行）；不执行同步文件，不提供删除或分享。
- 同步页读取 `db/need`、`db/remoteneed`、`folder/errors` 真实队列。只有本机 progress 项标记接收中，远端 need 仅标待发送；不虚构速度、百分比或完成历史。失败/离线/暂停/未知状态不标成同步完成。
- 记住服务器和账号；勾选“记住密码”才持久化密码。Mac 使用上述本机私有文件，Windows 继续使用凭据管理器。网页不能读取已保存的密码，也不写浏览器存储或日志。保存失败明确提示。
- “下次自动登录”依赖记住密码，每次 App 启动仅自动尝试一次。失败后可手动重试，不循环提交密码。自动登录不是开机启动；已授权设备不依赖每次输密码就能恢复同步。
- “清除登录信息”只清理此应用保存的凭据，不删除文件、不停止同步、不撤销设备。设备撤销仍由服务器管理员操作。
- 文件列表来自本机同步索引，只可浏览已授权的 `xc-` 空间，无任意路径读取、文件写入或删除能力。每页 100 项，每目录最多 20,000 项，响应最多 16 MiB；10 秒刷新。目录名称筛选/排序在分页前执行。文件定位会再次校验配置根、索引、本机存在状态，拒绝绝对路径、越界、符号链接及 Windows 重解析点。
- 文件“与服务器一致”要求本机与全局版本相同、已连接服务器持有完整版本；不以 `idle` 或零待下载字节单独宣告完成。目录状态不代表全部子项状态；断线时显示索引状态，不误报端到端完成。新文件扫描后出现在列表中。

## 结构与受限命令

- `web/`：随 App 捆绑的静态页面。
- `src-tauri/src/main.rs`：内核生命周期、`snapshot`、`open_folder`。
- `src-tauri/src/account.rs`：`join_account`、`login_saved`、`forget_account`；密码读取只在 Rust 后端。
- `src-tauri/src/files.rs`：`list_files`、`reveal_file`；仅固定本机 API 和已授权空间，严格检查相对路径并编码查询参数；只定位文件，不执行文件。
- `src-tauri/src/activity.rs`：`sync_activity`，已授权空间的待接收/待发送/错误队列，分页并去重。
- `resources/syncthing[.exe]`：对应平台的 Go 内核；`ca.pem` 只能是公开 CA，不能包含私钥；`server.txt` 为初始地址提示。

为保留已有登录、设备身份与数据，identifier **继续为 `com.xun.cloud.test`**，历史配置和 `~/XunCloud-Test` 同步根不搬迁。产品名及窗口标题为“小寻云同步”；旧路径中出现 Test 不代表另建测试空间，不要删除或重建这些目录。

## 在线编译

[GitHub Actions：Mac / Windows / Android](https://github.com/xunzhimeng/syncthing/actions/workflows/build-clients.yml) → **Run workflow** → 下载 Artifacts。详见 [下载与安装说明](../docs/online-builds.md)。Mac 分 Apple Silicon / Intel，Windows 为 x64 安装器；无需本地编译。

## 构建与验证

```sh
go generate ./lib/api/auto
go build -tags noupgrade -o desktop/src-tauri/resources/syncthing ./cmd/syncthing
# Windows 输出名为 syncthing.exe
```

在 `desktop/` 执行：

```sh
npm ci
npm run test:web
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

macOS 使用 Command Line Tools + Rust；Windows 使用 MSVC、Windows SDK、WebView2、Rust MSVC 和 Node。Windows 自动合并 `tauri.windows.conf.json` 生成 NSIS 安装器；保留锁文件，不忽略版本校验。Linux 当前不支持安全记住凭据，会明确提示，不能使用模拟凭据库作为持久化实现。

`installed_native_https_bridge` 是显式 opt-in 集成测试，只连指定的隔离桌面配置。可设置 `XUNCLOUD_TEST_BINARY`、`XUNCLOUD_TEST_PROFILE` 后运行 `cargo test ... installed_native_https_bridge -- --ignored --nocapture`。额外显式提供 `XUNCLOUD_TEST_CREDENTIALS` 与 `XUNCLOUD_TEST_SAVE_ACCOUNT=1` 可验证保存和自动登录；Mac 必须另给 `XUNCLOUD_TEST_ACCOUNT_HOME`，仅允许仓库 `tmp/` 下独立目录，不写安装版账号文件、不访问钥匙串。Windows 仍会写其凭据管理器，须显式选用测试环境。普通测试不读取真实账号，也不连接真实服务。

## 安全与生命周期

本机 API 为有认证的回环 HTTPS，专用 CA 校验主机名、禁用代理与重定向。远端由 Go 进行 TLS 1.3 和设备私钥证明；公开 CA 仅供 App 使用，不安装到系统信任库。

App 关闭时停止自己的内核，服务器继续独立运行；不改旧 Syncthing、系统防火墙、登录启动项、DNS。当前仍是本地 ad-hoc 签名，不等于公证发行包。Mac 登录存储不链接 keyring 后端，不因应用重新构建而触发钥匙串授权；旧钥匙串条目保持原样。
