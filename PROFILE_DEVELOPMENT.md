# Profile 与 Action 设计规范

本文档是 Remote Runtime 扩展 Profile / Action 能力时的权威设计约束。它记录稳定架构、协议边界和设计哲学，不记录开发过程。

## 核心理念

网关是唯一 MCP 出口。远程 Agent 不是 MCP Server，也不运行 LLM；它只维护出站连接、设备身份和实际加载的能力 Handler。

```text
AI / MCP Client
      ↓ 固定 MCP 工具
Gateway：认证、用户隔离、能力目录、路由、结果校验
      ↓ WebSocket Profile/Action 协议
Remote Agent Core
      ↓
Profile → Action → 本地系统能力
```

Profile 是跨语言、跨平台的固定能力契约；Handler 是具体实现。Python、Go、Rust、C 或移动端原生实现可以不同，但使用同一个 Profile ID 时，对外参数、结果、错误和限制必须一致。无法完整实现契约的环境不能声明该 Profile。

## 兼容性规则

兼容性首先保护契约语义，而不是保护旧文件或旧代码继续运行：

1. 只要同一输入的含义、结果、错误或安全边界发生变化，即使 JSON 字段没有变化，也属于破坏性变更。
2. 未发布阶段可以拒绝旧草案，并给出明确的最低版本和重新组装提示；不得为了兼容草案引入双协议分支或保留不安全语义。
3. 正式发布后，破坏性 Profile 变更使用新的主版本 ID，例如 `workspace.v2`；不能让同一个 Profile ID 在不同版本 Handler 上静默表达两套行为。
4. 新增可选运行时元数据、放宽结果校验或修复不改变契约的实现错误，通常属于兼容变更。
5. 新增必填参数、必需 Action、结果字段语义变化和安全策略变化，都必须经过版本升级或迁移设计。
6. `minimum_agent_version` 是网关在过渡期拒绝旧 Handler 的数据驱动机制，检查必须先于 Enrollment Token 消费和 Hub 注册。

## Profile、Action 与 Core

- **Core**：凭据、Manifest、连接、心跳、重连、并发上限、请求路由和取消。
- **Profile**：一组语义相关、权限边界接近的 Action，以及该实现的 runtime 声明。
- **Action**：一个可独立测试和装配的具体操作，例如 `workspace.v1/read`。
- **Common**：真正可复用的底层实现，例如安全路径解析、哈希和原子写入；Common 不是 Profile。

当前远端结构：

```text
remote_agent/profiles/
├── base.py                 # ProfileContext、ActionHandler、ProfileHandler
├── registry.py             # 静态 Profile Factory Registry
├── common/                 # 跨 Action 复用的底层工具
├── shell_v1/
│   ├── profile.py
│   ├── executor.py
│   └── actions/exec.py
└── workspace_v1/
    ├── profile.py
    └── actions/
        ├── read.py
        ├── write.py
        └── edit.py
```

`ProfileHandler` 负责 Action 映射、执行路由和取消路由；每个 Action 实现统一 `ActionHandler` 接口。`registry.py` 使用显式、静态 Factory 装配 Profile，不使用按 ID 展开的条件分支。

这种“可插拔”是源码和安装包级别的静态组合，不是用户运行时插件系统。普通用户不能上传 Handler、动态下载代码、使用 `pip entry_points` 注册能力或改变 MCP `tools/list`。

## 新增 Profile 的准入条件

新增 Profile 前必须先证明：现有 Profile 或 Action 无法在不歪曲契约的情况下表达需求，而且新需求具有独立、稳定的执行模型、数据通道、交互方式、权限边界或外部协议。

开始编码前先回答：

> 现有的 ______ 无法表达 ______，因为 ______；新 Profile 的独立契约是 ______。

写不清楚时不应新增 Profile。以下情况通常不是新 Profile：

- PowerShell、CMD、POSIX sh：属于 `shell.v1` runtime 方言。
- 一个方便调用的 Shell 命令或用户脚本：继续使用 `shell.v1`。
- 编程语言或操作系统差异：属于 Handler 实现或 runtime 元数据。
- 给现有 Action 增加兼容的可选参数：优先扩展现有契约。
- 为了丰富目录而创建的能力：没有真实需求和 Handler 时不创建。

只有 Profile 内所有 Action 都应由声明该 Profile 的 Agent 完整实现。当前协议不支持 Action 子集声明；如果 Action 长期需要独立安装、授权或版本演进，应重新检查 Profile 是否过大，而不是立即增加复杂权限模型。

## 网关与 Agent 的双层定义

网关 `gateway/profiles.py` 是 AI 可见协议的来源，维护名称、说明、Action、参数、返回值、错误、限制、runtime 契约和固定 `mcp_tool`。

安全语义发生破坏性修正且仍沿用未发布的 Profile ID 时，Registry 必须声明最低兼容 Agent 版本，并在首次注册和重连进入 Hub 前拒绝旧实现；网页与能力详情同步暴露该要求。不能只显示升级提示后继续向旧 Handler 路由新契约请求。

远程 Agent Registry 只维护可执行实现 Factory。两边共享 Profile ID、Action 名称和协议语义，但 Agent 不依赖完整网关代码，以便未来使用其他语言实现。

每个对 AI 开放的 Action 必须映射到一个语义明确的固定 MCP 工具。AI 的调用顺序是：

```text
list_agents
→ get_agent_capabilities(agent_id)
→ 读取 Profile Action 中的 mcp_tool
→ 调用固定 MCP 工具
```

工具描述必须要求 AI 先查询能力；网关调用时仍要重新校验用户所有权、Agent Profile、Action 到 MCP 工具的映射及返回结果。描述是引导，不是权限机制。

## `workspace.v1`

`workspace.v1` 是受工作目录约束的远程 UTF-8 文本数据通道，不是上传下载系统，也不是分布式文件系统。它与 `shell.v1` 的区别在于：Shell 接收环境相关命令字符串；Workspace 提供跨平台固定的结构化文件语义。

| Action | 固定 MCP 工具 | 语义 |
| --- | --- | --- |
| `read` | `remote_read_file` | 按行读取文本并返回整个文件的 SHA-256 |
| `write` | `remote_write_file` | 按显式前置条件原子创建或覆盖文本 |
| `edit` | `remote_edit_file` | 按已读取版本精确替换唯一一处文本并返回 diff |

### 工作目录与路径

- 复用 Agent 启动参数 `--workdir`，不增加第二个 Workspace 根目录。
- 工作台只组装 Profile，不把远程机器绝对路径写进 ZIP 或 Manifest。
- MCP 只接受使用 `/` 分隔的工作目录相对路径。
- 拒绝绝对路径、`..` 和解析后逃出工作目录的符号链接。
- Agent runtime 只声明 `scope=workdir`，不向 AI 暴露绝对根路径。

### 文本与限制

- 首版仅支持 UTF-8 文本，不读取图片或任意二进制。
- 单文件最多 8 MiB；单次 write 最多 2 MiB。
- read 默认最多 2000 行，返回内容最多 50 KiB，超出时返回 `truncated=true`。
- edit 保留 UTF-8 BOM 和原有 CRLF/LF 风格。
- edit 的 unified diff 最多 50 KiB，并通过 `diff_truncated` 声明截断。
- 首版 edit 只做精确匹配和换行归一化，不默认启用智能引号、特殊空格等模糊匹配。

### 网络语义

本地文件系统是唯一真实来源，网关不缓存、复制或持久化用户文件。

- write 使用同目录临时文件和原子替换，防止半写文件。
- read 返回整个文件的 SHA-256。
- edit 强制携带最近一次 read 得到的 `expected_sha256`；版本不一致返回 `conflict`。
- write 必须显式携带 `expected_sha256`：`null` 只允许新建，SHA-256 只允许覆盖完全匹配的现有版本；不提供无条件覆盖。
- 网络断线可能产生“本地已执行但响应丢失”，系统不承诺恰好执行一次；调用方应重新 read 验证状态。
- 不引入 CRDT、分布式锁、离线合并、网关文件缓存或请求合并。

### 权限边界

Workspace 的路径限制始终有效于 Workspace Action，但不是操作系统沙箱。如果同一 Agent 同时加载 `shell.v1`，Shell 仍拥有该系统账号的完整权限，可以访问工作目录之外的位置。

- 同时加载 Shell 时，Workspace 提供结构化语义、防误操作和冲突检测，不提供强隔离。
- 只加载 Workspace 时，能力面更窄，但真正抵御本机恶意进程仍需操作系统用户、容器或沙箱。
- 不以 `--workdir` 宣称限制 Shell 权限。

## 扩展方式

新增 Profile：

1. 证明现有 Profile 无法表达需求并定义稳定边界。
2. 在网关 Catalog 注册完整协议和固定 MCP 工具映射。
3. 新建独立 Profile package，并把 Action 拆成单独模块。
4. 在远端静态 Registry 增加 Factory。
5. 只把真正跨 Action 的实现提取到 Common。
6. 更新 Builder，使所选 Profile package 被完整打包。
7. 在 MCP 工具中校验所有权、Profile、Action 映射和结果契约。
8. 为路径、鉴权、路由、冲突、取消、结果限制等关键边界增加测试，并完成真实 Gateway → Agent 调用。

新增 Action：

1. 确认它与 Profile 的语义和权限边界一致。
2. 实现 `ActionHandler` 并在 Profile 中静态装配。
3. 在网关 Catalog 增加契约和固定 MCP 工具。
4. 所有声明该 Profile 的官方 Handler 必须同步实现该 Action。

未来的 `terminal.v1`、`camera.v1`、`mobile.*`、`serial.v1` 或 `artifact.v1` 仍遵循同一结构。持久 PTY、实时媒体、大文件二进制流和硬件协议具有独立数据与生命周期语义，不应塞进 `shell.v1` 或 `workspace.v1`。

## 明确不做

- 不按每台 Agent 动态生成 MCP 工具。
- 不使用万能 `remote_call(profile, action, params)` 替代强类型工具。
- 不支持用户运行时上传、下载或注册自定义 Handler。
- 不实现插件市场、远程代码下载或 Agent 自更新执行器。
- 不把图片、视频和大文件 Base64 塞进普通 Workspace 响应。
- 不因为某个设备类型存在就创建一个无限扩张的“大 Profile”。
