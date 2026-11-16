# Windows 接手开发提示词

下载前先读同包/本会话提供的 `docs/windows-download.md`，使用应用 CA 验证 HTTPS，不忽略证书错误。

请在 Windows 上继续小寻云同步项目，使用 **HTML/CSS/JavaScript + Tauri 2 + 现有 Go 同步内核**，不使用 Qt，不改成 GPUI，不重写文件同步协议。

## 来源与范围

用户可提供 Mac 导出的源码包和 SHA-256，也可从 `git@github.com:xunzhimeng/syncthing.git` 获取源码。离线包是导出时的工作区快照，可能包含当时未提交的改动；Git 获取应核对分支、提交及 `desktop/package.json` 版本。旧源码包或旧分支不能当作已包含本轮更新，包内文件以 `MANIFEST.json` 为准。

解压到新目录（不要覆盖已有配置/代码）。阅读：
- `source/docs/cloud-accounts.md`
- `source/docs/cloud-mac-lan-test.md`
- `source/desktop/README.md`
- 此文件以及包内 `MANIFEST.json`

包内 `source/desktop/` 是 0.3.1 Tauri 客户端（文件 / 同步 / 设置三页，真实队列、整目录筛选/排序、系统文件定位；继续保留安全凭据与自动登录）。优先阅读 `source/desktop/README.md` 完成此次升级验收；原配置 identifier 不变，不搬迁文件。`source/lib/cloudsync/` 提供账户验证、设备绑定和按账号目录隔离；`source/cmd/syncthing/cloud_desktop.go` 初始化独立本机 core。预编译 Windows amd64 内核在 `windows/syncthing.exe`，已包含 `cloud init-desktop`，可以先用它构建 UI，再自行重编内核。

## 服务器和证书

- 同一局域网 Mac 账号入口：`https://192.168.0.104:18443`。
- 文件同步端口：`22110/TCP`。
- 不要使用旧 `8384/22000` 作为此次账户服务。
- 测试用户名 `testuser`，密码由用户另行通过可信渠道给出；不在代码包内。不要要求或使用服务器管理 API key。
- `trust/ca.pem` 是公开的应用专用 CA，不是私钥。其 PEM 文件 SHA-256 必须为：
  `168dc62859e2bab44c89bfc70c36a2f3d95ffa523c9483b80c9d5510a35889cf`
- 只把它复制到 `source/desktop/src-tauri/resources/ca.pem`；由应用交给自己的内核。**不要导入 Windows 系统根证书库，不要设置 insecure/跳过证书或主机名校验。**
- 服务器证书匹配 `192.168.0.104`。`nmas.top` 现在是别的机器，本次没配置 `cloud.nmas.top`，不要自行改 DNS 或以为填主域名即连接 Mac。

## 首次运行

1. 核验包 SHA-256 与 CA 指纹，检查文件清单不包含真实私钥、API key、账号密码或生产 config。
2. 检查 Rust MSVC、Visual Studio C++ Build Tools / Windows SDK、WebView2、Node/npm 是否可用；缺项明确提示，不静默换框架。
3. 复制 `windows/syncthing.exe` 到 `source/desktop/src-tauri/resources/syncthing.exe`，复制公开 CA；写 `resources/server.txt` 为 `192.168.0.104:18443`。
4. 在 `source/desktop` 执行 `npm ci`、`npm run test:web`、`npm run tauri -- build`。使用提交的 Cargo.lock/package-lock.json；不使用 --ignore-version-mismatches。
5. 安装并实际运行新测试客户端。不覆盖旧 Syncthing 或旧 Qt 客户端。独立配置路径由 Tauri app_data_dir 生成，identifier 为 `com.xun.cloud.test`，同步根为用户主目录 `XunCloud-Test`。
6. 使用普通账号登录；无需手动填写设备 ID。测试 Windows→Mac 和 Mac→Windows 文件同步，对比 SHA-256；重启 App 验证复用设备身份与目录。
7. 验证 0.3.1 默认文件页、可点击面包屑、整目录筛选/排序、分页，以及“在资源管理器中显示”仅定位已落盘文件、不执行文件、拒绝链接/越界。同步页核验真实接收/待发送/错误队列，离线和列表读取失败不能显示已同步。设置保留记住密码和一次启动自动登录；首页不显示凭据、证书和路径长文。

## 安全和验收

- API key 只存在 Rust 后端/内核配置，绝不能下发给网页或发送远端服务器。密码不写日志、不进 URL、不进 localStorage/普通配置；用户勾选“记住密码”后只保存到 Windows 凭据管理器，凭据库失败时明确报错，不能回退到明文。
- 只开放受限 native 命令；禁止万能 HTTP 代理/任意 shell 执行；外部网页不得取得 Tauri IPC 权限。
- 本地 API 使用回环 HTTPS，并校验本客户端专用 CA。远端入网用 TLS 1.3 设备私钥证明；普通用户没有服务器管理员权限。
- 多次启动、端口冲突、服务器离线、密码错误、证书错误均应有明确错误；不能误杀已有 core。
- 检查 Windows 子进程无多余控制台、正确停止、App 退出/重启不遗留进程；不改系统防火墙/证书/登录自启动，除非用户另行要求。
- 不删除任何现有同步文件。不做数据库迁移/发布/git push。
- 完成后报告：Windows 编译/安装产物位置、实际操作路径、双向同步证据、剩余问题。不能把 Mac 的测试结果当作 Windows 验收。

允许继续打磨 UI、托盘/后台运行、安装器和错误提示；重大范围变更先问用户。先让当前最小版 Windows 真正可用，再做美化。
