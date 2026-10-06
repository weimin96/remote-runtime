# Remote SSH for Codex

Remote SSH 是 Remote Runtime 仓库中的 Codex 插件。它直接复用系统 OpenSSH，而不是实现新的 SSH 协议栈。

主要能力：

- 从 `~/.ssh/config` 发现主机，或在 UI 中维护独立主机配置。
- 标准 SSH 命令执行和长任务增量输出。
- 真实 PTY Terminal 与 Human Takeover。
- SFTP 浏览、上传、下载、重命名、删除和小型文本编辑。
- OpenSSH `ProxyJump` 跳板机。
- loopback-only Local Port Forward。
- Linux CPU / 内存 / 磁盘 / GPU 状态查看。

`1.0.x` 与 Remote Runtime 共用稳定版本线。稳定发布 macOS arm64/x64 与 Linux x64 预编译包；Windows 当前为 Experimental。

## 功能入口

插件把“模型执行能力”和“用户直接操作能力”分开。很多功能只出现在 App UI，不会作为模型工具暴露，因此不要只从工具列表判断插件是否支持某项能力。

| 功能 | 在哪打开 | 行为与边界 |
| --- | --- | --- |
| 主机管理 | 右上角齿轮 | 自动合并 OpenSSH Host 与插件管理主机；可设置用户、端口、IdentityFile 路径和默认目录 |
| ProxyJump | 齿轮 → 添加 / 更新主机 → 连接方式 → `ProxyJump / 经跳板机` | 标准 OpenSSH `-J`，不实现自定义跳板协议 |
| Agent | 顶部 `Agent` | 查看模型命令执行、长任务、输出、取消和 Human Takeover 状态 |
| Terminal | 顶部 `Terminal` | 真实 SSH PTY，会话输入和 resize 直接交给本机 OpenSSH |
| SFTP | 左侧面板 | 文件浏览、上传、下载、mkdir、重命名、删除、小型文本编辑 |
| Workspace | 顶部 `工作区` | 选择 SSH 主机 + 工程目录，读取 Git branch / dirty / ahead / behind，并统一 Agent、Terminal 与 SFTP 工作目录 |
| Service Discovery | 顶部 `服务` | 只读读取与当前工作区关联的进程实际监听端口；Linux 远端依赖 `ss` 和 `/proc` |
| Local Forward | 顶部 `端口转发` | 手动建立 SSH Local Forward；固定监听 `127.0.0.1` |
| 服务一键转发 | 顶部 `服务` → `转发到本机` | 自动选择空闲本地端口，把检测到的远端服务转发到本机；HTTP 服务可直接打开 |
| Server Monitor | 点击左上角状态圆点 | Linux CPU、内存、磁盘、GPU，只运行固定只读探针 |

### 推荐工作流

常见开发服务器可以按下面的顺序使用：

```text
配置 SSH 主机 / ProxyJump
        ↓
选择“工作区”并发现远程工程
        ↓
选择工作区，Agent + Terminal + SFTP 自动使用同一工作目录
        ↓
顶部“服务”读取当前工作区的监听端口
        ↓
点击“转发”把 3000 / 5173 / 8080 等服务映射到本机 127.0.0.1
```

服务发现不会执行 `npm run dev`、`docker compose up` 等启动命令，只读取已经运行的进程和监听端口；也不会在后台持续扫描。

## 一键安装

推荐直接安装 GitHub Release 的预编译包：

```bash
curl -fsSL https://raw.githubusercontent.com/weimin96/remote-runtime/main/install-remote-ssh.sh | bash
```

固定版本：

```bash
curl -fsSL https://raw.githubusercontent.com/weimin96/remote-runtime/main/install-remote-ssh.sh \
  | bash -s -- --version 1.0.1
```

安装器会自动识别 macOS / Linux 与 CPU 架构，从 GitHub Release 下载对应平台 artifact，校验 SHA-256，然后注册 marketplace 并执行：

```text
codex plugin add remote-ssh@remote-agent
```

不会 clone 源码、运行 `npm install` 或在用户机器上编译 `node-pty`。安装后新建一个 Codex thread 即可使用新 runtime。

### 手动安装发布包

GitHub Release 中的：

```text
remote-ssh-v<version>-<commit>-<platform>.tar.gz
```

已经包含 UI/MCP bundle 和对应平台的 `node-pty` native runtime。解压后从包根目录加入 Codex marketplace：

```bash
tar -xzf remote-ssh-v<version>-<commit>-<platform>.tar.gz
cd remote-ssh-v<version>-<commit>-<platform>
codex plugin marketplace add "$PWD"
codex plugin add remote-ssh@remote-agent
```

`remote-ssh@remote-agent` 是已经发布的兼容插件 ID，因此在 1.0 前仍保留该标识。

## 源码开发

```bash
cd apps/codex-remote-ssh
npm ci
npm run check
```

本地安装当前 checkout：

```bash
npm run verify:local
```

`verify:local` 会先执行 typecheck/tests/build，再安装本地 marketplace 版本。它可能重启 Remote SSH MCP runtime，因此会结束当前插件持有的交互终端和端口转发，只用于开发验收。

## SSH 配置

默认读取：

```text
~/.ssh/config
```

也可以通过 `REMOTE_SSH_CONFIG` 指定其他配置文件。

插件管理的主机只持久化主机元数据和 `IdentityFile` 路径，不读取或复制私钥内容。认证、`ssh-agent`、`known_hosts`、算法协商和 Host alias 都继续由系统 OpenSSH 负责。

### Jump Host

入口：右上角齿轮 → `SSH 主机` → `添加 / 更新主机` → `连接方式` → `ProxyJump / 经跳板机`。

跳板模式映射到 OpenSSH `ProxyJump`，例如：

```text
bastion
user@bastion.example.com
```

ProxyJump 只转发 SSH 连接，最终目标机的认证仍由本机 OpenSSH 完成。不要把目标私钥放到跳板机后再依赖嵌套 `ssh` 作为插件连接模型。

如果跳板机与目标机使用不同私钥，推荐在 `~/.ssh/config` 中分别配置 Host alias 与 `IdentityFile`，再在插件中把跳板机填写为该 Host alias。插件不会读取私钥内容。

## Workspace、服务发现与 Local Forward

`工作区` 表示插件当前的 `SSH host + cwd` 上下文，不是在服务器额外创建一个“项目对象”。选中工作区后，Agent、Terminal 和 SFTP 会使用同一个工程目录。

工作区搜索范围不再固定使用 SSH 登录 HOME。打开 `工作区` 后可以直接选择：

- 当前 Agent / Terminal 上下文目录。
- 主机配置的默认目录。
- SSH 登录 HOME。
- 远端实际存在且当前用户可访问的顶层目录，例如 `/opt`、`/srv`、`/home`、`/data` 等；也可以直接输入任意目录。

因此 root 用户登录时 `/root` 只是一项候选范围，而不是唯一能搜索的位置。

选中工作区后，顶部 `服务` 成为独立入口：

- 仅检查与当前 Workspace 关联的进程，不把整台服务器所有监听端口混进列表。
- Linux 远端使用 `ss -ltnp` 和 `/proc/<pid>/cwd` 关联监听端口与项目目录。
- 对 cwd 不在工程目录的进程，还会检查 `/proc/<pid>/exe` 和 cmdline 是否指向当前工作区，减少 systemd / wrapper 启动方式造成的漏检。
- 最多返回有限数量的实际监听服务，不根据 `package.json`、Dockerfile 等配置猜测“可能存在”的服务。
- 常见开发端口会标记为 HTTP 或 TCP；HTTP 服务转发后可从 UI 直接打开。
- 点击服务卡片的 `转发到本机` 时，本地端口使用自动分配；手动端口映射则使用顶部 `端口转发`。

顶部 `端口转发` 对应 SSH Local Forward：

```text
127.0.0.1:<localPort> -> SSH host -> <remoteHost>:<remotePort>
```

默认常见场景是把远端仅监听在 `127.0.0.1` 的开发服务安全地暴露到本机，例如远端 `127.0.0.1:5173` 映射到本机 `127.0.0.1:5173`。Local Forward 生命周期属于当前 Remote SSH runtime；插件 runtime 重启后旧转发会结束，UI 会提示重新创建。

## 模型工具

模型侧保持四个主要原语：

- `ssh.listHosts`
- `ssh.testConnection`
- `ssh.exec`
- `ssh.writeStdin`

`ssh.exec` 支持普通命令、独立命令批量执行和 `tty=true` Human Takeover；长任务统一通过 `ssh.writeStdin` 继续读取、写 stdin 或取消。

SFTP、Terminal、端口转发、主机设置和服务器状态属于 App UI 能力，不额外扩张模型工具面。

## 安全边界

- Remote SSH 使用本机系统 `ssh` / `sftp`。
- 私钥内容不会被复制到插件配置。
- Human Takeover 的用户输入不会作为模型工具参数保存；远端主动回显时会在模型可见 capture 前脱敏。
- Local Port Forward 固定绑定 `127.0.0.1`。
- 文件上传/下载在本地 runtime 与 SFTP 间传输，不把大文件内容塞进模型上下文。
- 服务器状态使用固定只读探针，不接受模型拼接任意探针命令。

## 已知限制

- Remote/Dynamic Port Forward 尚未实现。
- 内置文本编辑面向小型 UTF-8 文件。
- Linux 服务器状态探针不承诺其他操作系统兼容。
- Windows Remote SSH 在完成真实平台回归前仍属于 Experimental。
