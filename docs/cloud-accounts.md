# XunCloud 账户同步（第一版）

本功能保留 Syncthing 的文件同步协议，在其上增加普通用户接入层。范围：**管理员建号、同账号多设备同步、不同账号隔离**。不开放注册，不提供跨账号共享，也不是在线文件浏览器。

## 用户体验与权限边界

1. 管理员准备运行新版 `xun-cloud` 的服务器、HTTPS 证书和账号。
2. 在客户端的**本地** Web GUI 中选择“操作 → 连接云同步账号”，输入服务器地址、用户名、密码。
3. 客户端自动提交本机设备证书；服务器验证密码和设备私钥持有证明，创建用户目录并授权该设备。
4. 客户端自动配置服务器 Device ID、连接地址和本地文件夹。此后由原有同步内核持续工作，不需要保存云账号密码。

同一账号的多个客户端仅与服务器共享自己的文件夹，以服务器为同步中枢，不自动互相配对。服务器必须在线且有存储空间。

**普通用户不会获得服务器管理 API key、GUI 会话或全局配置权限。** 本地 GUI 的管理认证与云账号认证是两套不同的入口；本地 GUI 如果已有密码，仍需先完成该本地认证。

## 构建

在 `xun-cloud` 仓库使用满足 `go.mod` 的 Go 版本：

```sh
go generate ./lib/api/auto
go build -o bin/syncthing ./cmd/syncthing
```

正式自定义发行版应关闭上游自动升级，避免功能被上游二进制覆盖：使用 `go run build.go -no-upgrade build syncthing` 构建，或运行时设置 `--no-upgrade`。不要用旧版 Syncthing 二进制替代新版账户服务。

## 服务端部署

以下路径仅为示例。服务应以非 root 用户运行；配置目录和数据目录必须分开，数据根目录及其父目录不能由普通用户修改或被其他同步文件夹包含。

先生成独立实例配置，并设置**管理员 GUI**账号密码（`-` 表示从标准输入读入）：

```sh
bin/syncthing --home /srv/xun-cloud/config generate --gui-user admin --gui-password -
```

为普通用户建号，终端会隐藏密码输入；自动化时也可从标准输入传入，不能把密码放在命令行：

```sh
bin/syncthing --home /srv/xun-cloud/config cloud add-user alice
bin/syncthing --home /srv/xun-cloud/config cloud add-user bob
```

用户名：小写字母开头，允许小写字母、数字、下划线、连字符，最多 32 字符。密码：12–72 字节。账号文件只保存 bcrypt 哈希和随机文件夹 ID；重复建号拒绝覆盖。账号文件位于配置目录下 `cloud-accounts/user-<用户名>.json`，新增账号不需要重启服务。

启动：

```sh
bin/syncthing --home /srv/xun-cloud/config serve --no-browser --no-upgrade \
  --cloud-listen 0.0.0.0:8443 \
  --cloud-root /srv/xun-cloud/users \
  --cloud-cert /srv/xun-cloud/tls/fullchain.pem \
  --cloud-key /srv/xun-cloud/tls/privkey.pem \
  --cloud-sync-port 22000
```

- `8443/TCP`：独立的 HTTPS 账户接入端口，只处理 `/v1/enroll`，不提供管理 API。
- `22000/TCP`：实际文件同步端口。必须与 Syncthing 监听配置/NAT 映射一致。`--cloud-sync-port` 是客户端使用的公网端口，不会更改实际监听地址。
- `8384`：节点管理 GUI，建议只监听回环地址，通过本机或 SSH 隧道管理，**不要作为普通用户入口公开**。
- 可以使用对应的环境变量：`XUNCLOUD_LISTEN`、`XUNCLOUD_ROOT`、`XUNCLOUD_CERT`、`XUNCLOUD_KEY`、`XUNCLOUD_SYNC_PORT`。
- 未配置 `--cloud-listen` 时不启动账户服务，原有设备配对方式保持不变。
- 不要使用终止 TLS 的普通反向代理转发账户入口；设备私钥证明在 TLS 握手中完成，应直连或使用 TCP/TLS 透传。
- 证书更新后需要重启账户服务进程。

首次登录后自动创建：

```text
/srv/xun-cloud/users/user-alice/
/srv/xun-cloud/users/user-bob/
```

已有非空目录、符号链接、配置/数据库目录、与既有同步目录重叠的路径均拒绝自动接管。不要直接把已有 NAS 根目录作为用户个人空间。

## TLS：是否只填 IP 就能使用？

管理员完成上述部署后，用户只需输入地址和账号密码；无需输入 Device ID 或管理 API key。省略端口时使用 `8443`，可以输入 `192.0.2.10`、`cloud.example.net:8443` 或完整 HTTPS 地址。

**IP 必须被证书的 IP SAN 覆盖，证书必须受客户端信任。** 域名证书不能用不匹配的 IP 代替；不接受 HTTP、无效/不受信任证书、关闭 TLS 校验或重定向。最简单的公共部署方式是使用有效域名证书。

私有 CA 场景：在客户端启动同步内核前设置 `XUNCLOUD_CA_FILE` 指向可信 PEM CA 文件；CA 文件必须由管理员通过可信渠道提供，不能从待验证服务器自动下载后直接信任。未设置时使用系统信任库。

## 客户端目录及使用方式

默认本地位置为 `默认文件夹路径/XunCloud/xc-<随机ID>/`；未设置默认路径则使用 `~/XunCloud/xc-<随机ID>/`。GUI 显示友好名称 `XunCloud - alice` 和实际路径。同一账号的设备可使用不同本地默认路径。

- 浏览器直接打开本机 GUI 的 `/?cloud=join`，或“操作 → 连接云同步账号”。远程 GUI 不能代替本机发起此操作。
- `syncthing-android`：抽屉菜单新增“连接云同步账号”，在已有安全的本地 WebView 内打开。需要包含新版内核；存储授权及后台运行限制仍遵循 Android。
- `syncthing-macos`：菜单新增 `Connect cloud account`，打开本机浏览器；打包通过 `XUNCLOUD_CORE_BINARY` 选择新版内核。
- `xun-syncthing-menubar`：新增“连接云同步账号”，只打开本机页面，不替换或启动内核；已有本机服务需单独升级。
- `syncthingtray`：桌面底部工具栏及 Quick UI 新增云账号入口。可使用新版独立内核；内嵌模式必须通过集成脚本准备源码，不能只替换 CMake 的路径为没有 C bindings 的 `xun-cloud` 仓库。

各客户端仓库的 `XUNCLOUD.md`（Tray 为 `docs/xuncloud.md`）给出构建方法。现有已安装 App 不会因源代码变动自动升级。

## 协议与安全约束

- 客户端本地：`POST /rest/cloud/join`，JSON `{server, username, password}`。沿用本地 GUI 认证和 CSRF，另要求请求来源及 Host 为回环地址。
- 服务端：TLS 1.3、客户端证书私钥证明；`POST /v1/enroll`，JSON `{username, password}`。设备 ID 从 TLS 证书导出，不接受任意 `deviceID` 字段。成功仅返回 `{serverID, folderID, syncPort}`。
- 不保存客户端云密码，不下发服务器目录路径或管理凭据。请求/响应体有限长，拒绝未知字段和尾随 JSON，限制登录频率和并发。
- 每个服务器上的一个设备身份只能属于一个云账号；每个账号最多 64 个远端设备。不启用 introducer、自动接受其他文件夹，不继承模板的共享设备或外部版本脚本。
- 配置更新排队且幂等；响应成功前保存配置。客户端配置失败时服务端可能已完成授权，修复本地问题后可用同一账号重试。不会自动删除用户数据“回滚”。
- 目录隔离是同步协议级授权，不是独立 OS 用户或容器隔离。服务器管理员/运行服务的系统用户能访问所有用户数据，不能用此功能抵御不可信服务器管理员。
- 同步不是备份：同账号设备对文件的更改和删除会传播。请另做备份/按需配置版本保留。

## 运维限制

当前版本没有自助注册、密码找回、配额、跨账号分享、网页登录文件浏览或账户管理面板。管理员通过建号命令管理首次接入；设备授权保存在标准 Syncthing 配置中，已经授权的设备不依赖每次密码登录。

撤销设备必须由管理员在服务器 GUI 中移除相应设备/共享；仅更改或移除账号文件不会自动撤销既有证书授权。不要删除证书、账号文件或用户目录来“重置”；涉及已有数据的迁移和账户回收须单独制定步骤。

## 验证

本次执行结果及尚未验证的平台见 [验证记录](cloud-accounts-verification.md)。

```sh
go test ./lib/cloudsync ./lib/api ./lib/config ./lib/connections ./lib/model ./lib/syncthing ./cmd/syncthing
go test -race ./lib/cloudsync ./lib/api
node test/cloud_account_gui_test.js
python3 test/cloud_account_e2e.py bin/syncthing
```

端到端脚本只在仓库 `tmp/` 中生成随机凭据和独立实例，绑定临时回环端口，关闭发现/中继/升级；测试退出时停止所有启动的进程，保留日志以供诊断。不访问或修改正在运行的用户实例。
