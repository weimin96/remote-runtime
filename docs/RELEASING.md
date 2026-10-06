# Release guide

Remote Runtime 当前由维护者显式执行测试、构建、Tag 和 GitHub Release；仓库不依赖 GitHub Actions 完成发布。

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
```

汇总所有平台包后生成总校验文件：

```bash
cd dist/release
sha256sum *.whl *.tar.gz > SHA256SUMS.txt
```

`dist/` 不提交 Git。

## Tag and GitHub Release

确认 `main` 已推送且远端 commit 与本地一致，然后：

```bash
VERSION=<version>
git tag -a "v$VERSION" -m "Remote Runtime v$VERSION"
git push origin "v$VERSION"
```

创建 RC / prerelease：

```bash
gh release create "v$VERSION" \
  dist/release/*.whl \
  dist/release/*.tar.gz \
  dist/release/*.tar.gz.sha256 \
  dist/release/SHA256SUMS.txt \
  --repo weimin96/remote-runtime \
  --verify-tag \
  --prerelease \
  --generate-notes \
  --title "Remote Runtime v$VERSION"
```

1.0 stable 或其他稳定 Release 必须显式决定，不从版本号或提交信息自动推断。

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
5. `main` 与 `origin/main` 同步。
6. 工作树没有 Secret、构建产物或未提交修改。

发现发布错误时发布新的 PATCH；不要重写已经公开的 Tag。
