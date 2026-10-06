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

当前 `0.99.x` 与 Remote Runtime 共用 1.0 RC 版本线。稳定支持 macOS / Linux；Windows 当前为 Experimental。

## 安装发布包

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

UI 支持“直连 / 经跳板机”。跳板模式映射到 OpenSSH `ProxyJump`，例如：

```text
bastion
user@bastion.example.com
```

ProxyJump 只转发 SSH 连接，最终目标机的认证仍由本机 OpenSSH 完成。不要把目标私钥放到跳板机后再依赖嵌套 `ssh` 作为插件连接模型。

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
