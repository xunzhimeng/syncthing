# Mac 服务、证书及 Windows 联调

## 域名条件

本次读取到 `nmas.top` 的 A 记录为 `218.78.135.116`，并非直接证明可以连接到这台 Mac；`cloud.nmas.top` 暂未返回 A 记录。主域名在其他机器使用不妨碍申请子域名证书，但**仅填写主域名不能使请求到达 Mac**。

后续推荐：保留主站，选独立的 `cloud.nmas.top`；由域名管理员配置 DNS。使用 ACME DNS-01 可证明域名所有权并签发公信证书，即便 Mac 在内网也可申请，但需 DNS TXT 验证/续期自动化。联网路径仍需局域网 DNS、VPN 或公网 TCP/NAT/TLS 透传。不要把普通反向代理的 TLS 终止放在现有设备证书认证接口前。此轮**未变更 DNS、未签发公信证书、未配置路由器或全局信任**。

## 本次已选方案

用户确认先以应用专用 CA + Mac 局域网 IP 联调。

- 账号入口：`https://192.168.0.104:18443`（TLS 1.3 + 设备证书认证；不是浏览器网盘页面）。
- 文件同步：`192.168.0.104:22110/TCP`。
- 服务器管理仅监听：`https://127.0.0.1:18385`。
- 独立服务：`com.xun.cloud-test-server` LaunchAgent；配置在 `~/Library/Application Support/XunCloud-TestServer/`。
- 独立数据：`~/XunCloud-TestServer-Data/`，不使用 `~/nas`。
- 测试账号文件：`~/Library/Application Support/XunCloud-TestServer/test-account.json`，仅本机用户可读；不进入代码包或下载服务。需要给 Windows 测试者时经另一个可信渠道传递。
- 公共 CA 文件：上述目录的 `pki/ca.pem`。CA 私钥与服务器私钥只留在本机。

CA PEM **文件** SHA-256（不是证书 DER 指纹）：

```text
168dc62859e2bab44c89bfc70c36a2f3d95ffa523c9483b80c9d5510a35889cf
```

客户端只对自己的连接信任此 CA，不安装系统根证书、不跳过 TLS 验证。证书包含 `192.168.0.104`、`127.0.0.1`、`localhost`、`xundemac-mini.local`；IP 变化须重新签发/部署匹配的服务器证书，不能直接忽略主机名错误。

## 桌面路线

本轮新增 `desktop/`：纯 HTML/CSS/JavaScript + Tauri 2 + Rust 受限桥接 + Go 同步内核，**不依赖 Qt**。GPUI 是 Rust 原生绘制 UI，不是网页容器；需要优先复用网页代码时选择 Tauri 更合适。原有 Qt/Swift 客户端保留，不删除或改动其安装。

Mac 已安装为 `~/Applications/XunCloud Test.app`（本地 ad-hoc 签名）；专用内核配置在 `~/Library/Application Support/com.xun.cloud.test/core/`，同步文件位于 `~/XunCloud-Test/`。该客户端退出会停止自己的内核；独立服务器继续由 LaunchAgent 运行以供 Windows 联调。

## 原有服务

原有 8384/22000 服务及 `XunSyncthingMenu.app` 不替换、不停机，原 NAS/Windows 测试设备配置不修改。测试版不修改系统证书库、防火墙或 DNS，不打开原管理员 API 的匿名访问。

停止新测试服务器（会中断新测试用户同步，不影响旧实例）：

```sh
launchctl bootout "gui/$(id -u)/com.xun.cloud-test-server"
```

保留证书/账号/数据，重新启动用 `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.xun.cloud-test-server.plist"`。不要删除证书来“重置用户”，已绑定设备使用的是持续授权。

## 本次 Mac 验证

已启动安装的 Tauri App 及其独立 core，真实普通账号接入后 Mac 客户端→服务器、服务器→Mac 客户端两个方向的文件内容及 SHA-256 均匹配。用同一 Rust HTTPS 桥执行 `snapshot` 的显式集成检查也通过；普通单元测试确保返回字段不含管理 API key/密码。证据在 `~/Library/Application Support/com.xun.cloud.test/core/desktop-verification.json`。

本机没有给 osascript 辅助访问权限，所以未自动点击控件或截图，没有绕过该权限。程序启动、Rust API 桥与真实文件同步已经验证，完整 UI 点击体验仍请用户在已打开的 App 中确认。Windows GUI 编译/安装和 Windows 端实际同步由接手代理验证。

## 临时下载服务

为了给同一局域网的 Windows 获取代码，将启用只读 HTTPS 下载服务 `192.168.0.104:18444`，只提供预先准备的公开交接文件、不列目录、拒绝路径穿越/符号链接、URL 带随机下载令牌，仅允许本机及 `192.168.0.0/24`。进程运行 24 小时后自动关闭，不设置登录自启动。停止它不会影响账号服务器和文件同步。

该服务使用同一个应用专用 CA 签发的证书。首次 CA 请从本会话文件链接/可信渠道取得并核对上面的 SHA-256，再使用 `--cacert` 或 Python SSLContext 下载，不关闭 TLS 验证。测试账号密码、配置 API key、CA/服务器私钥均不在下载目录。
