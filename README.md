# Remote Runtime

> 面向 AI Coding Agent 的安全远程执行运行时。

[![Release](https://img.shields.io/github/v/release/weimin96/remote-runtime?include_prereleases&sort=semver)](https://github.com/weimin96/remote-runtime/releases)
[![Python](https://img.shields.io/badge/python-3.11%2B-3776ab)](https://www.python.org/)
[![License](https://img.shields.io/badge/license-Apache--2.0-0f766e)](LICENSE)

Remote Runtime 为 ChatGPT、Codex 和其他 MCP Client 提供一个稳定的远程执行入口。它把认证、能力发现、命令执行、文件操作和远端设备连接集中到一套运行时中，而不是让每台机器分别暴露 MCP Server。

当前 `0.99.x` 为 1.0 RC 版本线，重点是稳定性、兼容性和发布工程。建议先在受控环境中使用。

## 能力概览

Remote Runtime 提供三种互补的执行方式：

| 模式 | 适用场景 | 主要能力 |
| --- | --- | --- |
| Local Runtime | AI 直接操作 Gateway 所在 Linux 主机 | Shell、PTY、补丁、持久会话、项目发现 |
| Remote Agent | NAT/内网/CI/桌面设备主动连接 Gateway | Shell Profile、Workspace Profile、设备生命周期 |
| Remote SSH | Codex 通过本机 OpenSSH 操作服务器 | SSH、SFTP、PTY、ProxyJump、Local Forward、主机监控 |

Local Runtime 对模型只暴露三个高能力原语：

- `exec_command`：执行命令；长任务返回 `session_id`。
- `write_stdin`：继续读取输出、写 stdin、调整 PTY 或取消任务。
- `apply_patch`：在允许的 Workspace Root 内应用文本补丁。

Remote Agent 使用固定 Profile 契约：

| Profile | Action | MCP 工具 |
| --- | --- | --- |
| `shell.v1` | `exec` | `remote_exec` |
| `workspace.v1` | `read` | `remote_read_file` |
| `workspace.v1` | `write` | `remote_write_file` |
| `workspace.v1` | `edit` | `remote_edit_file` |

## 架构

```text
AI / MCP Client
      │
      │ MCP Streamable HTTP
      ▼
Remote Runtime / Gateway
  auth · routing · policy · audit
      │
      ├──────── Local Runtime ────────► local OS
      │
      └──────── WebSocket ────────────► Remote Agent
                                         │
                                         └─ Profile → system capability
```

Remote Agent 主动向 Gateway 建立出站连接，因此远端设备不需要公网 IP 或开放入站端口。Remote SSH 则直接复用用户已有的 OpenSSH 配置、`ssh-agent`、`known_hosts` 和 `ProxyJump`。

## 快速开始

### 本地开发运行

需要 Python 3.11 或更高版本。

```bash
git clone https://github.com/weimin96/remote-runtime.git
cd remote-runtime
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/python -m gateway
```

Windows PowerShell：

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe -m gateway
```

打开 `http://127.0.0.1:8000`。

普通 Remote Agent 模式可以直接注册账号、在 Agent 工作台生成设备包，然后让远端 Agent 主动连接 Gateway。

### Linux Local Runtime

生产环境的 Local Runtime 基线是 systemd Linux。公开仓库可直接使用 bootstrap：

```bash
curl -fsSL https://raw.githubusercontent.com/weimin96/remote-runtime/main/install.sh \
  | bash -s -- \
      --public-url https://runtime.example.com \
      --owner-email owner@example.com
```

安装器会创建独立 Gateway/runner 系统账号、managed release 目录、systemd 服务、最小 sudoers 规则和只读 doctor。首次部署会要求初始化唯一 Owner 与 TOTP MFA。

完成 HTTPS 反向代理后运行：

```bash
sudo remote-agent-doctor
```

ChatGPT / MCP Client 连接：

```text
https://runtime.example.com/mcp/
```

Local Runtime 使用 OAuth 2.1 Authorization Code + PKCE S256。公网部署必须使用 HTTPS。

若要固定发布版本，可给 bootstrap 传入：

```bash
--version <version>
```

后续升级：

```bash
sudo remote-agent-upgrade --version <version>
sudo remote-agent-doctor
```

升级采用独立 staging release、SHA-256 校验、SQLite backup、原子切换和 health check；失败时自动恢复上一应用版本。线上只保留 `current + previous` 两份应用 release。

### Docker Gateway

容器模式适合 Remote Agent Gateway，不适合需要直接操作宿主机 systemd/Docker 的 Local Runtime。

```bash
docker compose up --build
```

默认监听 `http://127.0.0.1:8000`。公网部署请设置 `GATEWAY_PUBLIC_URL` 并在 TLS 反向代理后运行。

### Remote SSH for Codex

Remote SSH 位于 `apps/codex-remote-ssh`。发布包包含已构建 UI/MCP bundle 和对应平台的 `node-pty` native runtime。

普通用户直接一键安装最新发布包：

```bash
curl -fsSL https://raw.githubusercontent.com/weimin96/remote-runtime/main/install-remote-ssh.sh | bash
```

固定版本：

```bash
curl -fsSL https://raw.githubusercontent.com/weimin96/remote-runtime/main/install-remote-ssh.sh \
  | bash -s -- --version 0.99.11
```

安装器根据当前 macOS / Linux 架构选择 GitHub Release 中的预编译包，验证 SHA-256 后注册 `remote-ssh@remote-agent`。用户不需要 clone 仓库、执行 `npm install` 或本地编译 `node-pty`。

源码开发仅用于贡献者：

```bash
cd apps/codex-remote-ssh
npm ci
npm run check
```

插件读取 `~/.ssh/config`，也可以在 UI 中维护独立主机。跳板机使用标准 OpenSSH `ProxyJump`；最终目标主机仍由本机 SSH 凭据完成认证。

Remote SSH 的主要入口：

| 能力 | UI 入口 | 说明 |
| --- | --- | --- |
| SSH 主机 | 右上角齿轮 → `SSH 主机` | 合并 `~/.ssh/config` 与插件管理主机；插件配置只保存 `IdentityFile` 路径，不读取私钥内容 |
| ProxyJump | 齿轮 → `添加 / 更新主机` → `连接方式` → `ProxyJump / 经跳板机` | 使用标准 OpenSSH `-J`；可填写 `~/.ssh/config` 的 Host alias 或 `user@host` |
| Agent 执行视图 | 顶部 `Agent` | 查看模型发起的命令、长任务状态、stdout/stderr 和 Human Takeover 状态 |
| 真实 Terminal | 顶部 `Terminal` | 打开真实 PTY，支持交互输入与终端 resize |
| SFTP | 左侧文件面板 | 浏览、上传、下载、重命名、删除和编辑小型 UTF-8 文本 |
| 工作区 | 顶部 `工作区` | 统一 SSH 主机、工程目录、Git 状态以及 Agent / Terminal / SFTP 的当前上下文；可从当前 cwd、主机默认目录、HOME 和远端可访问顶层目录选择搜索范围 |
| 服务发现 | 顶部 `服务` | 只读识别与当前工作区关联的实际监听服务；Linux 远端使用 `ss` + `/proc`，不执行项目脚本、不持续扫描 |
| Local Forward | 顶部 `端口转发`，或服务卡片的 `转发到本机` | 建立 `127.0.0.1:<local> → remoteHost:remotePort`；仅绑定 loopback，runtime 重启后需重建 |
| Server Monitor | 点击左上角状态圆点 | 读取 Linux CPU、内存、磁盘和可用 GPU 信息；使用固定只读探针 |

其中 SFTP、Terminal、Workspace / Service Discovery、Local Forward、服务器状态和主机设置主要属于插件 App UI 能力；模型侧保持较小的 SSH 工具面，避免把所有本地操作能力直接暴露给模型。

工作区不是额外的远端配置实体，而是插件当前的 `host + cwd` 上下文。SSH 登录用户的 HOME（例如 root 用户的 `/root`）只是候选搜索范围之一；工作区面板会同时读取当前 Agent cwd、主机默认目录、HOME 以及远端实际存在且可访问的顶层目录，避免把项目发现固定在登录目录。

详细说明见 [Remote SSH README](apps/codex-remote-ssh/README.md)。

## 配置

常用环境变量见 [.env.example](.env.example)。

Local Runtime 的核心配置：

```text
GATEWAY_PUBLIC_URL=https://runtime.example.com
GATEWAY_LOCAL_WORKDIR=/srv/projects
GATEWAY_LOCAL_WORKDIRS=/opt/apps:/data/repos
GATEWAY_LOCAL_EXEC_USER=remote-agent-runner
GATEWAY_SECURE_COOKIES=true
```

`GATEWAY_LOCAL_WORKDIR` / `GATEWAY_LOCAL_WORKDIRS` 是允许 AI 操作的工程目录边界。不要为了方便直接配置 `/`，除非完整主机访问就是明确目标。

## 安全模型

Remote Runtime 的设计目标是减少远程执行系统中不必要的权限和凭据暴露，但它不是 Shell 沙箱。

- Gateway 控制面与 Local Runtime Shell runner 使用不同 OS 账号。
- runner 不应拥有通用 `sudo` 权限，也不能读取 Gateway SQLite 或环境文件。
- OAuth access token、refresh token、authorization code 和设备凭据只保存不可逆摘要或受限凭据。
- Remote Agent Enrollment Token 一次性使用，注册后转换为独立设备凭据。
- Workspace Root 限制路径范围，但 Shell 仍拥有 runner 系统账号本身的权限。
- Remote SSH 不复制私钥，连接认证继续交给系统 OpenSSH。
- SFTP 上传、下载和大输出不会为了方便直接塞入模型上下文。
- Local Port Forward 只绑定 loopback。

部署到公网前请阅读 [SECURITY.md](SECURITY.md)。

## 支持矩阵

| 组件 | 稳定支持 | 备注 |
| --- | --- | --- |
| Gateway / Local Runtime | Linux + systemd | 生产部署基线 |
| Remote Agent | Linux / macOS / Windows | Python 3.11+ |
| Remote SSH | macOS / Linux | Windows 当前为 Experimental |

## 开发

Python 全量测试：

```bash
.venv/bin/python -m unittest discover -q
```

Remote SSH：

```bash
cd apps/codex-remote-ssh
npm ci
npm run check
```

发布候选统一门禁：

```bash
./scripts/verify-release.sh
```

该门禁包含 Python 测试/编译、Remote SSH fresh install/typecheck/test/build、Git whitespace 检查和 release artifact 可重复构建验证。

官方 Tag 由 GitHub Actions 在 Linux x64、macOS arm64 和 macOS Intel 原生 runner 上构建，并自动上传 Runtime、Remote SSH 平台包、安装器与总校验文件。普通用户只消费 Release artifact，不需要源码构建环境。

开发前请阅读：

- [AGENTS.md](AGENTS.md)：仓库工程边界和验证规则。
- [PROFILE_DEVELOPMENT.md](PROFILE_DEVELOPMENT.md)：新增 Profile / Action 的契约规范。
- [docs/RELEASING.md](docs/RELEASING.md)：维护者发版流程。

## 项目边界

Remote Runtime 不试图成为聊天产品、模型 Runtime、Memory 系统或任意 MCP Server 聚合器。模型、对话和 Agent 编排属于上游；本项目只负责受控地连接真实执行环境。

## License

[Apache License 2.0](LICENSE)
