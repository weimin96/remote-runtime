# Remote Runtime repository guide

本文件给在仓库内工作的 Coding Agent / 自动化工具使用。面向普通用户的安装和使用说明以 `README.md` 为准。

## 项目定位

Remote Runtime 是 AI Coding Agent 的远程执行层，不是聊天产品、模型 Runtime、Memory 系统或任意 MCP Server 聚合器。

仓库包含三个主要组件：

- `gateway/`：MCP Gateway、OAuth、Local Runtime、Agent 路由与 Web 管理端。
- `remote_agent/`：主动连接 Gateway 的 Python Remote Agent。
- `apps/codex-remote-ssh/`：基于系统 OpenSSH 的 Codex Remote SSH 插件。

## 修改前

1. 检查 `git status --short --branch`。
2. 阅读与任务相关的源码、测试和公开文档，不根据文件名猜实现。
3. Profile/Action 变更先阅读 `PROFILE_DEVELOPMENT.md`。
4. 发布相关任务先阅读 `docs/RELEASING.md`。

## 架构边界

- Gateway 是 Remote Agent 模式唯一的 MCP 出口；Remote Agent 自身不是 MCP Server。
- Remote Agent Core 只负责连接、凭据、版本和请求生命周期；系统能力属于 Profile/Action。
- 不为每台 Agent 动态生成 MCP 工具。工具保持稳定，设备能力通过 Catalog/Capability 查询发现。
- 不使用万能 `remote_call(profile, action, params)` 替代强类型工具。
- `workspace.v1` 是受路径约束的 UTF-8 文本通道，不是 Shell 沙箱。
- Local Runtime 的 `exec_command` 仍拥有 runner OS 账号本身的权限；Workspace Root 不能替代系统权限隔离。
- Remote SSH 继续复用系统 OpenSSH、ssh-agent、known_hosts 和 ProxyJump，不实现第二套 SSH 协议栈。
- 不为了兼容某一台真实服务器把 IP、域名、用户名、密钥路径或项目目录写死到产品代码。

## 安全要求

- Secret、Token、私钥、数据库、`.env`、`.agent/`、`.mcp.json`、日志和构建产物不得提交。
- 示例地址使用 `example.com` 或 RFC 5737 文档网段，不使用真实基础设施地址。
- Gateway 控制面与 Local Runtime runner 必须保持 OS 账号隔离。
- runner 不得获得通用 root/sudo 权限。
- 新增文件系统写操作必须保留路径边界、并发/版本前置条件和原子写语义。
- 审计日志不得记录 stdin/stdout、密码、Token 或其他明显 Secret 原文。
- 远程下载/升级必须验证 release identity 和 checksum，不能用 `git pull + pip install` 覆盖生产运行目录。

## 兼容性

- 当前 Agent WebSocket Protocol、Agent Core 和 Profile ID 都是公开契约的一部分。
- 同一 Profile ID 不得静默改变参数、结果、错误或安全语义。
- 破坏性 Profile 变更使用新的 Profile 主版本；破坏性传输变更升级协议版本。
- 数据库 schema 必须通过显式顺序 migration 演进；旧二进制不得在未知新 schema 上继续运行。
- 已发布 CLI、systemd service、Python distribution 和插件 ID 属于兼容标识，除非任务明确包含迁移方案，否则不要顺手重命名。

## 验证

Python：

```bash
.venv/bin/python -m unittest discover -q
.venv/bin/python -m compileall -q gateway remote_agent agent.py tests
```

Remote SSH：

```bash
cd apps/codex-remote-ssh
npm ci
npm run check
```

准备发布时：

```bash
./scripts/verify-release.sh
```

修改后至少运行与改动直接相关的测试，并执行：

```bash
git diff --check
git status --short
```

## Git 与发布

- 不提交 `dist/`、`node_modules/`、`.venv/` 或本地运行数据。
- 未明确要求时不要自动 push、tag 或创建 Release。
- 已公开的 Tag 不移动、不覆盖；修复使用新的 PATCH 版本。
- Release artifact 必须来自干净工作树，并通过 `scripts/verify-release.sh`。

保持实现精简：优先扩展已有原语和运行时，不通过新增大量专用工具、兼容分支或服务器特例解决局部问题。
