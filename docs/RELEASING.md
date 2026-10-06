# Release guide

Remote Runtime 使用 `.github/workflows/release.yml` 完成官方发布。维护者负责版本修改、Release gate 和 Tag；GitHub Actions 在原生平台 runner 上重新验证、构建并发布 artifact。

## Versioning

所有官方组件共享同一产品版本：

- Python package / Gateway
- Remote Agent
- Remote SSH plugin

Tag 格式为 `vMAJOR.MINOR.PATCH`。

- PATCH：Bug fix、安全加固、兼容性修复、内部实现或发布工程调整。
- MINOR：新增向后兼容的公开能力。
- Profile/Protocol 的破坏性变化必须同时调整对应契约版本，不能只修改包版本。

已经推送并对外发布的 Tag 不得移动或复用。

## Release gate

开发阶段可以运行：

```bash
./scripts/verify-release.sh --allow-dirty
```

正式发布前必须在已经提交的干净工作树运行：

```bash
git status --short --branch
./scripts/verify-release.sh
```

门禁包括：

- Python unit tests 和 compileall。
- Gateway 静态 JavaScript 检查。
- Remote SSH 使用独立 npm cache 的 fresh install 验证。
- Remote SSH typecheck / tests / build。
- `git diff --check`。
- Runtime 与当前平台 Remote SSH artifact 的双份可重复构建校验。

Remote SSH 含 `node-pty` native runtime。macOS 和 Linux 发布包必须分别在对应平台构建并实际加载 native module，不能跨平台改文件名冒充产物。

需要只验证 CI 打包流程而不创建 Release 时，可在 GitHub Actions 手动运行 `Release` workflow。`workflow_dispatch` 会执行测试和所有平台构建，但不会发布 Release。

## Version sources

发版前确认这些位置一致：

- `pyproject.toml`
- `remote_agent/core/version.py`
- `remote_agent/manifest.json`
- `gateway/__init__.py`
- `apps/codex-remote-ssh/package.json`
- `apps/codex-remote-ssh/package-lock.json`
- `apps/codex-remote-ssh/.codex-plugin/plugin.json`
- Remote SSH App / server 对外声明的版本

`CORE_VERSION`、`PROTOCOL_VERSION` 只在对应契约真的变化时更新。

## Build artifacts

Runtime：

```bash
python tools/build_local_release.py --output-dir dist/release
```

Remote SSH：

```bash
python tools/build_remote_ssh_release.py --output-dir dist/release
```

典型产物：

```text
remote-agent-gateway-v<version>-<commit>-linux.tar.gz
remote-agent-gateway-v<version>-<commit>-linux.tar.gz.sha256
remote_agent_gateway-<version>-py3-none-any.whl
remote-ssh-v<version>-<commit>-<platform>.tar.gz
remote-ssh-v<version>-<commit>-<platform>.tar.gz.sha256
install-remote-ssh.sh
```

汇总所有平台包后生成总校验文件：

```bash
cd dist/release
sha256sum *.whl *.tar.gz > SHA256SUMS.txt
```

官方 Action 当前生成：

- Linux x64 Remote SSH
- macOS arm64 Remote SSH
- macOS Intel Remote SSH
- Linux Runtime / Python wheel
- `install-remote-ssh.sh`
- `SHA256SUMS.txt`

`dist/` 不提交 Git。

## Tag and GitHub Release

确认版本源一致、`main` 已推送且远端 commit 与本地一致，然后创建 Tag：

```bash
VERSION=<version>
python tools/check_release_version.py "v$VERSION"
git tag -a "v$VERSION" -m "Remote Runtime v$VERSION"
git push origin "v$VERSION"
```

Tag push 会触发 `Release` workflow：

1. Ubuntu fresh runner 依次执行版本校验、Python tests/compile、Remote SSH check、Git whitespace 和 Linux artifact 双份可重复构建校验。
2. Linux/macOS 原生 runner 分别构建 Remote SSH native artifact。
3. Runtime job 构建 wheel / Linux Runtime，并附带一键安装脚本。
4. Publish job 汇总 artifact、生成 `SHA256SUMS.txt` 并创建 GitHub Release。

当前 `0.x` Tag 自动标记为 prerelease；`1.x` 及以上不自动加 prerelease 标记。已经公开的 Tag 不得移动，发布流程修复使用新的 PATCH。

## Release notes

Release Notes 面向用户，至少说明：

- 主要变化。
- 用户可见修复。
- 安全/权限变化。
- 是否需要迁移、重新授权或重新组装 Agent。
- 已知限制。

不要把内部文件名或原始 commit log 当成 Release Notes。

## Post-release verification

发布后检查：

1. Tag 指向预期 commit。
2. Release 的 draft/prerelease 状态正确。
3. 所有平台产物和 checksum 已上传。
4. 从 GitHub 重新下载产物并按 `SHA256SUMS.txt` 验证。
5. `install-remote-ssh.sh --version <version>` 能在至少一个真实支持平台完成 Release artifact 安装 smoke。
6. `main` 与 `origin/main` 同步。
7. 工作树没有 Secret、构建产物或未提交修改。

发现发布错误时发布新的 PATCH；不要重写已经公开的 Tag。
