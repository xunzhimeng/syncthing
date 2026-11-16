# GitHub 在线编译与下载

## 一次编译 Mac、Windows、Android

打开 [Build XunCloud Clients](https://github.com/xunzhimeng/syncthing/actions/workflows/build-clients.yml)，点 **Run workflow → main → Run workflow**。相关源码推送到 `main` 也会自动构建。

完成后进入该次运行，在页面底部 **Artifacts** 下载（需要登录 GitHub）：

| Artifact | 安装文件 |
| --- | --- |
| `XunCloud-macos-arm64` | Apple Silicon Mac 的 `.app.zip` |
| `XunCloud-macos-x64` | Intel Mac 的 `.app.zip` |
| `XunCloud-windows-x64` | Windows x64 的 NSIS `-setup.exe` |
| `XunCloud-android-apk` | 含四种 ABI 的可安装通用测试 APK |

每份产物附 `SHA256SUMS.txt` 和 `build-info.json`，记录源码提交、平台及校验值。保留 14 天，过期后重新运行即可。只要对应 job 成功即可下载其产物，不必等其他平台成功。

`server` 输入默认 `192.168.0.104:18443`，必须是账号入口，不是管理 GUI；默认服务仅同局域网可达。包内带现有服务器的**公开 CA**，没有账号密码、API key、服务器私钥或 CA 私钥。App 只在自身连接中信任此 CA，不修改系统证书库。可填写其他公信 HTTPS 地址；其他私有 CA 需先由管理员替换公开证书及相应指纹校验。

取消勾选 `build_android` 可只编译桌面。只编译 APK 可用本仓库的 [Build XunCloud Android Only](https://github.com/xunzhimeng/syncthing/actions/workflows/build-android.yml)，始终使用所选核心分支的精确提交，不重跑桌面。Android 也可独立打开 [Build XunCloud Android](https://github.com/xunzhimeng/syncthing-android/actions/workflows/build-app.yaml)，`coreRef` 指定账号内核的分支、标签或提交。总入口会自动把本次核心提交传给 Android，避免误用旧上游内核。

## 安装与签名边界

- **Mac**：本地 ad-hoc 签名，不是 Developer ID 公证发行包。解压后将“小寻云同步.app”放入 Applications；系统可能要求在“隐私与安全性”中确认来源。不要为安装而关闭全局 Gatekeeper。
- **Windows**：未做 Authenticode 商业签名，系统可能提示未知发布者。不要忽略杀毒报告；先核对提交和校验值。
- **Android**：使用本仓库原有、公开且不可信的 debug 签名，仅适合自用测试。应用 ID 带 `.debug`，与正式 App 分开；同一测试签名可跨次构建更新。不要将此 APK 当作生产发行版或用于分发敏感数据。
- 不需要 Apple 账号、付费证书或自行提供签名 Secrets；不创建 GitHub Release、不推送应用商店。后续正式签名须另行配置。

## 构建与失败检查

- 桌面：Go 生成资源并测试账户 API → 构建对应平台内核 → 网页/Rust 测试与 Clippy → Tauri 原生构建 → 签名检查/打包 → 上传产物。
- Android：读取仓库固定的 JDK/Go/SDK/NDK 版本 → 纯状态 fixture → 从指定核心源码编译四种 ABI → Compose/Java/Kotlin APK 编译 → zipalign、签名和 APK 内容检查 → 上传。
- 版本不可下载、依赖解析失败、测试失败或缺少内核时 job 会失败，不上传冒充可用的安装包。日志在失败 step；Android 额外上传可用的 `XunCloud-android-diagnostics`。
- 若首次打开 fork 的 Actions 要求确认启用工作流，先点 **I understand my workflows, go ahead and enable them**；若策略限制第三方 Actions，需要仓库管理员允许此仓库使用 GitHub 官方 `actions/*`。

原上游的大规模 Go 全平台流水线改为手动/可复用入口，避免一次界面提交触发无关的服务器发布构建。新工作流仅有 `contents: read`，不读取用户配置、不执行数据库迁移、不修改现有设备或同步文件。
