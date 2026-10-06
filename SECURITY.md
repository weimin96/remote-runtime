# Security Policy

Remote Runtime 可以执行远程 Shell 命令，因此安全问题应按高影响组件处理。

## Supported versions

安全修复优先进入当前 `0.99.x` RC / 最新发布版本。旧的 Technical Preview 版本可能不会单独回补修复。

## Reporting a vulnerability

请不要在公开 Issue 中提交可直接利用的漏洞、凭据或真实基础设施信息。

优先使用 GitHub 仓库的 **Security → Report a vulnerability** 私密报告入口。报告中建议包含：

- 受影响版本或 commit。
- 复现条件和最小复现步骤。
- 影响范围。
- 是否涉及凭据泄露、权限提升、路径逃逸或远程代码执行。

请使用测试凭据和 `example.com` / RFC 5737 文档地址，不要附带真实 Secret、私钥或生产 Token。

## Deployment guidance

- 公网 Gateway 必须放在 HTTPS 后。
- Local Runtime 应使用独立低权限 runner，不给 runner 通用 sudo/root 权限。
- 不要把 Gateway 数据目录、环境文件或 OAuth 数据暴露给执行账号。
- Workspace Root 只是路径边界，不是 Shell 沙箱。
- Remote SSH 私钥应由系统 OpenSSH / ssh-agent 管理。
- Release 下载和升级应验证 checksum，不要原地覆盖正在运行的环境。

如果怀疑 Secret 已经提交到 Git 历史，请先轮换 Secret，再清理历史；仅删除当前文件不能撤销已经泄露的凭据。
