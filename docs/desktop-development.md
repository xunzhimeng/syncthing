# 本轮 Tauri/证书开发范围

新增 Tauri Web 客户端不依赖 Qt：`desktop/`。现有 Qt、Android 和 Swift 仓库保留供兼容，但 Windows 新实现应优先使用 `desktop/`。

服务端域名与本机安装路径见 [cloud-mac-lan-test.md](cloud-mac-lan-test.md)；Windows 交接见 [windows-tauri-handoff.md](windows-tauri-handoff.md) 与 [windows-download.md](windows-download.md)。

开发过程中修复的验证问题：
- 首次离线 Cargo 缺少 webpki-roots，改为正常联网获取精确依赖并生成锁文件。
- 旧 Tauri 2.11 与新运行时不兼容；改为已实际编译通过的 Tauri 2.12.5/tauri-build 2.7.4，保留 Cargo.lock。
- 本机 HTTPS 使用独立 CA 签发的叶子证书，CA 签名私钥不持久化；远端测试 CA 与本机 IPC 信任边界分离。
- Go 桌面初始化拒绝接管非本客户端目录、保留身份且不启动公网发现/中继；进程持有者退出时尝试通过 HTTPS 正常关闭自己的 core。

测试版不是公证的正式发行包；Windows 必须独立构建、安装并验收，不能将 Mac 测试当作 Windows 成功。任何公网 DNS/证书自动续期、路由器映射、系统根证书或防火墙变更均没有执行。

## 0.2.0 桌面更新

详见 [desktop-0.2-update.md](desktop-0.2-update.md)。App 改为“小寻云同步”，配置 identifier 和数据路径不变；增加系统凭据库保存、单次启动自动登录、只读文件列表与真实同步状态。Keychain/Windows Credential Manager 是唯一持久化密码路径，没有明文回退。文件浏览不引入通用磁盘访问或写入权限。

Mac 安装位置更新为 `~/Applications/小寻云同步.app`，旧 `XunCloud Test.app` 保留但已退出。原配置、设备证书、账号目录复用；不重建数据，不变更服务器。
