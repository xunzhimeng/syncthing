# Windows 手动取包：先信任“公开 CA 文件”，不是装系统根证书

优先从本会话的附件/可信共享渠道取 `ca.pem`，用以下 PowerShell 核验 **PEM 文件** SHA-256：

```powershell
(Get-FileHash .\ca.pem -Algorithm SHA256).Hash.ToLowerInvariant()
```

应为 `168dc62859e2bab44c89bfc70c36a2f3d95ffa523c9483b80c9d5510a35889cf`。

拿到私有 CA 前，Windows 浏览器不认识它属于正常情况，**不要点击忽略证书继续，不要把密码发送给未验证服务器**。

拿到 CA 后，使用支持 OpenSSL 的 `curl.exe --cacert .\ca.pem <本会话提供的局域网HTTPS下载URL> -o xun-cloud-windows-handoff.zip`。Windows 内置 Schannel curl 对 `--cacert` 的支持随版本变化；若不支持，可用已安装的 Python 3：

```powershell
python -c "import ssl,urllib.request; c=ssl.create_default_context(cafile='ca.pem'); o=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=c)); u=input('粘贴本会话下载URL: '); r=o.open(u,timeout=60); open('xun-cloud-windows-handoff.zip','wb').write(r.read())"
```

然后核对本会话给出的压缩包 SHA-256，再解压。包中 `WINDOWS-PROMPT.md` 是完整交接提示词，`build-windows.ps1` 是不改系统证书的构建脚本。不要把下载 URL、CA 指纹或压缩包哈希都只从同一个未经验证的网页取来后互相当作信任依据。
