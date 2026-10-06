const state = { user: null, agents: [], keys: [], tokens: [], catalog: [], bundles: [], auditLogs: [], mcpUrl: "", wsUrl: "", authMode: "login", view: "overview", mode: "remote", registrationEnabled: true, mfaRequired: false };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function formatTime(epoch) {
  if (!epoch) return "从未";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(epoch * 1000));
}

function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = error ? "show error" : "show";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.className = ""; }, 2600);
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (response.status === 401 && state.user) {
    showAuth();
    throw new Error("登录已过期");
  }
  if (!response.ok) {
    let message = `请求失败 (${response.status})`;
    try { message = (await response.json()).detail || message; } catch (_) { /* no body */ }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

function showAuth() {
  state.user = null;
  $("#app-view").classList.add("hidden");
  $("#auth-view").classList.remove("hidden");
}

function showApp() {
  $("#auth-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#user-email").textContent = state.user.email;
  $("#mcp-endpoint").textContent = state.mcpUrl;
}

async function loadAll(silent = false) {
  try {
    const session = await api("/session");
    state.mode = session.mode || "remote";
    state.registrationEnabled = session.registration_enabled !== false;
    state.mfaRequired = session.mfa_required === true;
    configureMode();
    if (!session.authenticated) { showAuth(); return; }
    state.user = session.user;
    state.mcpUrl = session.mcp_url;
    state.wsUrl = session.agent_websocket_url;
    if (state.mode === "local") {
      const audit = await api("/audit-logs");
      state.auditLogs = audit.logs || [];
      showApp();
      renderLocal();
      if (!silent) toast("数据已刷新");
      return;
    }
    const [agents, keys, tokens, catalog, bundles] = await Promise.all([api("/agents"), api("/mcp-keys"), api("/enrollment-tokens"), api("/profile-catalog"), api("/agent-bundles")]);
    state.agents = agents.agents;
    state.keys = keys.keys;
    state.tokens = tokens.tokens;
    state.catalog = catalog.profiles;
    state.bundles = bundles.bundles;
    showApp();
    render();
    if (!silent) toast("数据已刷新");
  } catch (error) {
    if (state.user && !silent) toast(error.message, true);
  }
}

function configureMode() {
  const local = state.mode === "local";
  $("#register-tab").classList.toggle("hidden", local || !state.registrationEnabled);
  $("#auth-mfa-label").classList.toggle("hidden", !local || !state.mfaRequired || state.authMode !== "login");
  $("#auth-mfa").required = local && state.mfaRequired && state.authMode === "login";
  if (local && state.authMode !== "login") setAuthMode("login");
  $$("#main-nav button").forEach((button) => {
    button.classList.toggle("hidden", local && button.dataset.view !== "overview");
  });
  $("#page-eyebrow").textContent = local ? "Local Runtime" : "Workspace";
}

function renderLocal() {
  $("#metrics").innerHTML = [
    ["运行模式", "本机", "只操作 Gateway 所在服务器"],
    ["MCP 工具", "3", "exec · stdin · patch"],
    ["审计记录", state.auditLogs.length, "最近最多显示 200 条"],
  ].map(([label, value, note]) => `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`).join("");
  const heading = $("#view-overview .section-heading");
  heading.querySelector("h2").textContent = "本机执行 Runtime";
  heading.querySelector("p").textContent = "ChatGPT 通过 OAuth 访问这台服务器；公网注册和远程 Agent 接口已关闭";
  heading.querySelector("button").classList.add("hidden");
  const audit = state.auditLogs.length ? state.auditLogs.map((item) => `<article class="data-row">
    <div><h3>${escapeHtml(item.tool_name)}</h3><p>${escapeHtml(item.action_summary)}</p></div>
    <code>${item.success ? "OK" : "ERROR"}${item.exit_code === null || item.exit_code === undefined ? "" : ` · exit ${escapeHtml(item.exit_code)}`}</code>
    <time>${formatTime(item.created_at)} · ${escapeHtml(item.duration_ms)} ms</time>
  </article>`).join("") : emptyState("还没有执行记录", "ChatGPT 第一次调用 MCP 工具后会显示审计记录");
  $("#overview-agents").innerHTML = `<div class="endpoint-band"><div><span>MCP Endpoint</span><code>${escapeHtml(state.mcpUrl)}</code></div><button class="secondary copy-endpoint" type="button">复制</button></div><div class="data-list">${audit}</div>`;
  const copy = $("#overview-agents .copy-endpoint");
  if (copy) copy.onclick = () => copyText(state.mcpUrl, "MCP Endpoint 已复制");
}

function emptyState(title, detail) {
  return `<div class="empty"><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></div></div>`;
}

function schemaField(field, required = false) {
  const facts = [`类型：${field.type}`, required ? "必填" : "可选"];
  if (Object.hasOwn(field, "default")) facts.push(`默认：${field.default}`);
  if (Object.hasOwn(field, "minimum")) facts.push(`最小：${field.minimum}`);
  return `<article class="schema-field"><header><code>${escapeHtml(field.name)}</code><span>${escapeHtml(facts.join(" · "))}</span></header><p>${escapeHtml(field.description || "按协议返回该字段。")}</p></article>`;
}

function mcpToolSignature(action) {
  if (!action.mcp_tool) return "";
  const parameters = (action.parameters || []).map((field) => `${field.name}${field.required ? "" : "?"}`);
  return `${action.mcp_tool}(${["agent_id", ...parameters].join(", ")})`;
}

function formatBytes(value) {
  if (Number.isInteger(value) && value % (1024 * 1024) === 0) return `${value / (1024 * 1024)} MiB`;
  return `${value} bytes`;
}

function openProfileDialog(profileId, returnAgentId = "") {
  const profile = state.catalog.find((item) => item.id === profileId);
  if (!profile) return;
  const runtime = profile.runtime_contract || {};
  const limits = profile.limits || {};
  const runtimeFields = (runtime.fields || []).map((field) => schemaField(field, true)).join("");
  const dialects = (runtime.dialects || []).map((dialect) => `<article class="dialect-card">
    <header><strong>${escapeHtml(dialect.label)}</strong><code>${escapeHtml(dialect.id)}</code></header>
    <p>${escapeHtml((dialect.systems || []).join(" / "))}</p>
    <span>检测：${escapeHtml((dialect.detection || []).join(" → "))}</span>
    <span>示例：<code>${escapeHtml(dialect.example)}</code></span>
  </article>`).join("");
  const actions = (profile.actions || []).map((action) => `<section class="protocol-section">
    <div class="protocol-section-head"><div><span>Action</span><h3>${escapeHtml(action.name)}</h3></div><p>${escapeHtml(action.description)}</p></div>
    ${action.mcp_tool ? `<div class="mcp-invocation"><span>MCP 工具</span><code>${escapeHtml(action.mcp_tool)}</code><small>${escapeHtml(mcpToolSignature(action))}</small></div>` : ""}
    <h4>输入参数</h4><div class="schema-list">${(action.parameters || []).map((field) => schemaField(field, field.required)).join("")}</div>
    <h4>返回字段</h4><div class="schema-list">${(action.returns || []).map((field) => schemaField(field, true)).join("")}</div>
    <h4>错误语义</h4><div class="error-list">${(action.errors || []).map((error) => `<div><code>${escapeHtml(error.name)}</code><span>${escapeHtml(error.description)}</span></div>`).join("")}</div>
  </section>`).join("");
  const limitItems = [
    limits.capture_bytes_per_stream ? `stdout / stderr 各最多 ${formatBytes(limits.capture_bytes_per_stream)}` : "",
    limits.truncation_marker ? `截断标记：${limits.truncation_marker}` : "",
    limits.timeout_terminates_process_tree ? "超时、取消或断线会终止本次命令的整个进程树" : "",
    limits.max_concurrent_requests_per_agent ? `同一 Agent 最多同时执行 ${limits.max_concurrent_requests_per_agent} 个请求` : "",
    limits.max_file_bytes ? `单文件最多 ${formatBytes(limits.max_file_bytes)}` : "",
    limits.max_read_bytes ? `单次读取输出最多 ${formatBytes(limits.max_read_bytes)}` : "",
    limits.max_write_bytes ? `单次写入最多 ${formatBytes(limits.max_write_bytes)}` : "",
    limits.atomic_write ? "写入使用原子替换" : "",
    limits.optimistic_concurrency ? "编辑使用版本冲突检测" : "",
  ].filter(Boolean);
  const runtimeTitle = profile.id === "shell.v1" ? "Shell 方言声明" : "运行时声明";
  $("#profile-dialog-eyebrow").textContent = `${profile.id} · ${profile.status === "stable" ? "稳定" : profile.status}`;
  $("#profile-dialog-title").textContent = `${profile.name} 协议`;
  $("#profile-dialog").dataset.returnAgentId = returnAgentId;
  $("#profile-dialog-back").classList.toggle("hidden", !returnAgentId);
  $("#profile-dialog-body").innerHTML = `
    <section class="protocol-lead"><p>${escapeHtml(profile.description)}</p><div>${(profile.runtimes || []).map((item) => `<span>${escapeHtml(item)} 实现</span>`).join("")}${profile.minimum_agent_version ? `<span>Agent ≥ ${escapeHtml(profile.minimum_agent_version)}</span>` : ""}</div></section>
    <section class="protocol-section"><div class="protocol-section-head"><div><span>Runtime</span><h3>${runtimeTitle}</h3></div><p>${escapeHtml(runtime.selection || "Agent 必须声明具体运行时。")}</p></div><div class="schema-list">${runtimeFields}</div><div class="dialect-grid">${dialects}</div></section>
    ${actions}
    <section class="protocol-section"><div class="protocol-section-head"><div><span>Limits</span><h3>执行限制</h3></div></div><ul class="limit-list">${limitItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`;
  $("#profile-dialog").showModal();
}

function profileRuntimeLabel(declaration) {
  if (!declaration?.runtime) return "";
  const osLabels = { windows: "Windows", linux: "Linux", macos: "macOS", posix: "POSIX" };
  const dialectLabels = { powershell: "PowerShell", cmd: "CMD", "posix-sh": "/bin/sh" };
  const runtime = declaration.runtime;
  const labels = [
    osLabels[runtime.os] || runtime.os,
    dialectLabels[runtime.dialect] || runtime.dialect || runtime.engine || runtime.language,
    runtime.scope === "workdir" ? "工作目录" : runtime.scope,
  ].filter(Boolean);
  return [...new Set(labels)].join(" · ");
}

function agentProfileIds(agent) {
  const declarations = agent.profile_declarations || [];
  return (agent.profiles || []).length
    ? agent.profiles
    : declarations.map((declaration) => declaration.id);
}

function agentCapabilitiesButton(agent) {
  const count = agentProfileIds(agent).length;
  return `<button class="capability-summary" data-agent-capabilities="${escapeHtml(agent.id)}" type="button" aria-label="查看 ${escapeHtml(agent.name)} 的能力">${count} 个能力</button>`;
}

function openShellPolicyForm(agentId) {
  const agent = state.agents.find((item) => item.id === agentId);
  const policy = agent?.shell_policy;
  if (!agent || !policy) return;
  $("#agent-capabilities-dialog").close();
  const options = (policy.modes || []).map((option) => `<label class="profile-option policy-option"><input type="radio" name="mode" value="${escapeHtml(option.id)}" ${option.id === policy.mode ? "checked" : ""}><span><strong>${escapeHtml(option.name)}</strong><span>${escapeHtml(option.description)}</span></span></label>`).join("");
  const rules = (policy.rules || []).map((rule) => `<li><strong>${escapeHtml(rule.name)}</strong><span>${escapeHtml(rule.description)}</span></li>`).join("");
  openForm({
    eyebrow: `${agent.name} · shell.v1`,
    title: "配置命令拦截",
    submit: "保存策略",
    fields: `<p class="policy-form-note">标准拦截不限制普通文件删除、项目修改、依赖安装、构建或测试。</p><div class="policy-options">${options}</div><section class="policy-rules"><h3>标准拦截范围</h3><ul>${rules}</ul></section>`,
    onSubmit: async (data) => {
      await api(`/agents/${agentId}/shell-policy`, { method: "PATCH", body: JSON.stringify({ mode: data.get("mode") }) });
      await loadAll(true);
      toast("命令策略已更新");
    },
  });
}

function openAgentCapabilitiesDialog(agentId) {
  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) return;
  const declarations = agent.profile_declarations || [];
  const declarationsById = new Map(declarations.map((declaration) => [declaration.id, declaration]));
  const items = agentProfileIds(agent).map((profileId) => {
    const profile = state.catalog.find((item) => item.id === profileId);
    const runtime = profileRuntimeLabel(declarationsById.get(profileId));
    const actions = (profile?.actions || []).map((action) => `<span><code>${escapeHtml(action.name)}</code>${action.mcp_tool ? ` <small>→</small> <code>${escapeHtml(action.mcp_tool)}</code>` : ""}</span>`).join("");
    const policy = profileId === "shell.v1" && agent.shell_policy
      ? `<section class="shell-policy"><div><strong>命令拦截</strong><span>${escapeHtml(agent.shell_policy.mode === "standard" ? "标准拦截" : "关闭")}</span></div><button class="secondary" data-shell-policy="${escapeHtml(agent.id)}" type="button">配置</button></section>`
      : "";
    return `<article class="agent-capability-item">
      <header><div><h3>${escapeHtml(profile?.name || profileId)}</h3><code>${escapeHtml(profileId)}</code></div>${profile ? `<button class="secondary" data-profile-details="${escapeHtml(profileId)}" type="button">查看协议</button>` : ""}</header>
      <p>${escapeHtml(runtime || "未声明运行时详情")}</p>
      <div class="agent-capability-actions">${actions || "<span>暂无 Action 映射</span>"}</div>
      ${policy}
    </article>`;
  }).join("");
  $("#agent-capabilities-title").textContent = agent.name;
  $("#agent-capabilities-body").innerHTML = items || emptyState("没有可用能力", "该 Agent 尚未声明标准 Profile");
  $("#agent-capabilities-dialog").dataset.agentId = agentId;
  $("#agent-capabilities-dialog").showModal();
}

function agentVersionView(agent) {
  const version = agent.version || {};
  if (!version.agent_version) return { text: "版本未知", status: "unknown", label: "未知版本" };
  const build = String(version.build_id || "");
  const buildLabel = build ? ` · Build ${build.slice(0, 8)}` : "";
  const labels = {
    current: "当前版本",
    update_available: "需要升级",
    incompatible: "协议不兼容",
    newer: "高于网关版本",
    unknown: "未知版本",
  };
  return {
    text: `Agent ${version.agent_version} · Core ${version.core_version} · Protocol ${version.protocol_version}${buildLabel}`,
    status: agent.version_status || "unknown",
    label: labels[agent.version_status] || labels.unknown,
  };
}

function agentCard(agent) {
  const capabilities = agentCapabilitiesButton(agent);
  const upgrade = agent.lifecycle_status === "reenroll_required" ? '<span class="upgrade-badge">需重新注册</span>' : "";
  const version = agentVersionView(agent);
  const lifecycleAction = agent.lifecycle_status === "upgrade_available"
    ? `<button class="secondary" data-copy-upgrade="${agent.id}">Linux 升级命令</button>`
    : agent.lifecycle_status === "reenroll_required"
      ? `<button class="secondary" data-reenroll-agent="${agent.id}">重新接入</button>`
      : "";
  return `<article class="agent-card">
    <div class="agent-title"><h3>${escapeHtml(agent.name)}</h3><p>${escapeHtml(agent.description || "暂无用途描述")}</p><small>${escapeHtml(version.text)}</small></div>
    <div class="agent-meta"><span class="status ${agent.online ? "online" : ""}">${agent.online ? "在线" : "离线"}</span><span class="version-badge ${escapeHtml(version.status)}">${escapeHtml(version.label)}</span>${upgrade}${capabilities}<span>${formatTime(agent.last_seen_at)}</span></div>
    <div class="row-actions">${lifecycleAction}<button class="secondary" data-edit-agent="${agent.id}">编辑</button><button class="danger" data-revoke-agent="${agent.id}">撤销</button></div>
  </article>`;
}

function renderAgents() {
  const content = state.agents.length ? state.agents.map(agentCard).join("") : emptyState("还没有 Agent", "前往 Agent 工作台组装并注册第一台远程设备");
  $("#agents-list").innerHTML = content;
  $("#overview-agents").innerHTML = state.agents.length ? state.agents.slice(0, 4).map(agentCard).join("") : content;
}

function renderMetrics() {
  const online = state.agents.filter((agent) => agent.online).length;
  const activeKeys = state.keys.filter((key) => !key.revoked_at).length;
  $("#metrics").innerHTML = [
    ["Agent 总数", state.agents.length, `${online} 台在线`],
    ["在线 Agent", online, online ? "连接状态正常" : "等待远程设备连接"],
    ["有效 MCP Keys", activeKeys, "可连接 AI 客户端"],
  ].map(([label, value, note]) => `<div class="metric"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join("");
}

function renderKeys() {
  const active = state.keys.filter((key) => !key.revoked_at);
  $("#keys-list").innerHTML = active.length ? active.map((key) => `<article class="data-row">
    <div><h3>${escapeHtml(key.name)}</h3><p>创建于 ${formatTime(key.created_at)}</p></div>
    <code>${escapeHtml(key.prefix)}…</code>
    <time>最近使用：${formatTime(key.last_used_at)}</time>
    <div class="row-actions"><button class="danger" data-revoke-key="${key.id}">撤销</button></div>
  </article>`).join("") : emptyState("没有有效的 MCP Key", "为每个 Claude 或 WorkBuddy 客户端分别创建一个 Key");
}

function tokenStatus(token) {
  if (token.revoked_at) return "已撤销";
  if (token.used_at) return "已使用";
  if (token.expires_at * 1000 < Date.now()) return "已过期";
  return "等待使用";
}

function renderTokens() {
  $("#tokens-list").innerHTML = state.tokens.length ? state.tokens.map((token) => {
    const active = tokenStatus(token) === "等待使用";
    return `<article class="data-row">
      <div><h3>${escapeHtml(token.name)}</h3><p>${escapeHtml(tokenStatus(token))}</p></div>
      <code>${escapeHtml(token.prefix)}…</code>
      <time>有效期至 ${formatTime(token.expires_at)}</time>
      <div class="row-actions">${active ? `<button class="danger" data-revoke-token="${token.id}">撤销</button>` : ""}</div>
    </article>`;
  }).join("") : emptyState("还没有手动接入 Token", "普通用户无需在这里操作，请优先使用 Agent 工作台");
}

function renderBuilder() {
  $("#profile-catalog").innerHTML = state.catalog.length ? state.catalog.map((profile) => `<article class="catalog-item">
    <header><h4>${escapeHtml(profile.name)}</h4><span class="profile">${escapeHtml(profile.id)}</span></header>
    <p>${escapeHtml(profile.description)}</p>
    <div class="profile-contract">${(profile.actions || []).map((action) => {
      const parameters = (action.parameters || []).map((parameter) => `${parameter.name}${parameter.required ? "" : "?"}: ${parameter.type}`).join(" · ");
      const returns = (action.returns || []).map((field) => `${field.name}: ${field.type}`).join(" · ");
      return `<strong>${escapeHtml(action.name)}</strong><code>${escapeHtml(parameters)}</code><span>返回 ${escapeHtml(returns)}</span>${action.mcp_tool ? `<span class="profile-mcp">MCP · <code>${escapeHtml(action.mcp_tool)}</code></span>` : ""}`;
    }).join("")}</div>
    <footer class="catalog-footer"><div class="catalog-meta"><span class="catalog-status">${profile.status === "stable" ? "稳定" : escapeHtml(profile.status)}</span>${profile.runtimes.map((runtime) => `<span>${escapeHtml(runtime)}</span>`).join("")}</div><button class="secondary" data-profile-details="${escapeHtml(profile.id)}" type="button">查看协议</button></footer>
  </article>`).join("") : emptyState("暂无可组装 Profile", "网关管理员尚未发布标准能力");

  $("#bundles-list").innerHTML = state.bundles.length ? state.bundles.map((bundle) => {
    const expired = bundle.expires_at * 1000 <= Date.now();
    return `<article class="data-row">
      <div><h3>${escapeHtml(bundle.name)}</h3><p>${escapeHtml(bundle.description || "暂无用途描述")}</p></div>
      <code>${escapeHtml(bundle.runtime)} · ${escapeHtml(bundle.profiles.join(", "))}</code>
      <time>${expired ? "已过期" : `有效期至 ${formatTime(bundle.expires_at)}`}</time>
      <div class="row-actions">${expired ? "" : `<button class="secondary" data-download-bundle="${bundle.id}">下载 ZIP</button>`}</div>
    </article>`;
  }).join("") : emptyState("还没有组装记录", "选择标准 Profile，生成可独立部署的远程 Agent 包");
}

function render() {
  renderMetrics();
  renderAgents();
  renderKeys();
  renderTokens();
  renderBuilder();
}

function switchView(view) {
  const titles = { overview: "概览", builder: "Agent 工作台", agents: "远程 Agent", keys: "MCP Keys", tokens: "手动接入" };
  state.view = view;
  $$("#main-nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".view").forEach((section) => section.classList.toggle("active", section.id === `view-${view}`));
  $("#page-title").textContent = titles[view];
  $(".sidebar").classList.remove("open");
}

function openForm({ eyebrow, title, fields, submit, onSubmit }) {
  const dialog = $("#form-dialog");
  $("#dialog-eyebrow").textContent = eyebrow;
  $("#dialog-title").textContent = title;
  $("#dialog-submit").textContent = submit;
  $("#dialog-error").textContent = "";
  $("#dialog-fields").innerHTML = fields;
  dialog.onSubmitAction = onSubmit;
  dialog.showModal();
}

function showSecret(title, secret, command = "", commandLabel = "启动命令") {
  $("#secret-title").textContent = title;
  $("#secret-value").value = secret;
  $("#command-value").value = command;
  $("#command-label").textContent = commandLabel;
  $("#copy-command").textContent = `复制${commandLabel}`;
  $("#command-block").classList.toggle("hidden", !command);
  $("#copy-command").classList.toggle("hidden", !command);
  $("#secret-dialog").showModal();
}

async function createKey(name) {
  const result = await api("/mcp-keys", { method: "POST", body: JSON.stringify({ name }) });
  showSecret("MCP Key 已创建", result.secret);
  await loadAll(true);
}

async function createToken(name) {
  const result = await api("/enrollment-tokens", { method: "POST", body: JSON.stringify({ name }) });
  showSecret("手动接入 Token 已创建", result.secret, result.command);
  await loadAll(true);
}

async function createBundle(name, description, profiles) {
  const result = await api("/agent-bundles", {
    method: "POST",
    body: JSON.stringify({ name, description, runtime: "python", profiles }),
  });
  showSecret(
    "设备接入信息已生成",
    result.secret,
    result.install_command || result.command,
    result.install_command ? "Linux 一键安装命令" : "启动命令",
  );
  await loadAll(true);
}

function openBundleForm() {
  const options = state.catalog.map((profile) => `<label class="profile-option"><input type="checkbox" name="profiles" value="${escapeHtml(profile.id)}" ${profile.id === "shell.v1" ? "checked" : ""}><span><strong>${escapeHtml(profile.name)} · ${escapeHtml(profile.id)}</strong><span>${escapeHtml(profile.description)}</span></span></label>`).join("");
  openForm({
    eyebrow: "Python Agent Builder",
    title: "添加远程设备",
    submit: "生成安装命令",
    fields: `<label>Agent 名称<input name="name" required maxlength="80" placeholder="例如 GPU Notebook"></label><label>用途描述<textarea name="description" maxlength="500" rows="3" placeholder="告诉 AI 这台设备适合做什么"></textarea></label><div class="profile-options">${options}</div>`,
    onSubmit: (data) => {
      const profiles = data.getAll("profiles");
      if (!profiles.length) throw new Error("至少选择一个 Profile");
      return createBundle(data.get("name"), data.get("description"), profiles);
    },
  });
}

function bindEvents() {
  $("#login-tab").onclick = () => setAuthMode("login");
  $("#register-tab").onclick = () => setAuthMode("register");
  $("#auth-form").onsubmit = async (event) => {
    event.preventDefault();
    $("#auth-error").textContent = "";
    const button = $("#auth-submit");
    button.disabled = true;
    try {
      await api(`/auth/${state.authMode}`, { method: "POST", body: JSON.stringify({ email: $("#auth-email").value, password: $("#auth-password").value, mfa_code: $("#auth-mfa").value }) });
      await loadAll(true);
    } catch (error) { $("#auth-error").textContent = error.message; }
    finally { button.disabled = false; }
  };
  $("#logout-button").onclick = async () => { try { await api("/auth/logout", { method: "POST" }); } catch (_) { /* session may already be gone */ } showAuth(); };
  $("#refresh-button").onclick = () => loadAll();
  $("#mobile-menu").onclick = () => $(".sidebar").classList.toggle("open");
  $$("#main-nav button").forEach((button) => button.onclick = () => switchView(button.dataset.view));
  $("#new-key-button").onclick = () => openForm({ eyebrow: "MCP Access", title: "创建 MCP Key", submit: "创建 Key", fields: '<label>名称<input name="name" required maxlength="80" placeholder="例如 Claude Desktop"></label>', onSubmit: (data) => createKey(data.get("name")) });
  $$('[data-action="new-bundle"]').forEach((button) => button.onclick = openBundleForm);
  $$('[data-action="new-token"]').forEach((button) => button.onclick = () => openForm({ eyebrow: "Advanced Enrollment", title: "创建手动接入 Token", submit: "创建 Token", fields: '<label>令牌名称或备注<input name="name" required maxlength="80" placeholder="例如 CI 临时环境"></label>', onSubmit: (data) => createToken(data.get("name")) }));
  $$('[data-action="go-builder"]').forEach((button) => button.onclick = () => switchView("builder"));
  $$('[data-action="close-form-dialog"]').forEach((button) => button.onclick = () => $("#form-dialog").close());
  $("#dialog-form").onsubmit = async (event) => {
    event.preventDefault();
    const dialog = $("#form-dialog");
    const button = $("#dialog-submit");
    button.disabled = true;
    try { await dialog.onSubmitAction(new FormData(event.currentTarget)); dialog.close(); }
    catch (error) { $("#dialog-error").textContent = error.message; }
    finally { button.disabled = false; }
  };
  $("#secret-close").onclick = () => $("#secret-dialog").close();
  $("#agent-capabilities-close").onclick = () => $("#agent-capabilities-dialog").close();
  $("#agent-capabilities-done").onclick = () => $("#agent-capabilities-dialog").close();
  $("#profile-dialog-back").onclick = () => {
    const dialog = $("#profile-dialog");
    const agentId = dialog.dataset.returnAgentId;
    dialog.close();
    if (agentId) openAgentCapabilitiesDialog(agentId);
  };
  $("#profile-dialog-close").onclick = () => $("#profile-dialog").close();
  $("#profile-dialog-done").onclick = () => $("#profile-dialog").close();
  $("#copy-secret").onclick = () => copyText($("#secret-value").value, "Secret 已复制");
  $("#copy-command").onclick = () => copyText($("#command-value").value, "启动命令已复制");
  $(".copy-endpoint").onclick = () => copyText(state.mcpUrl, "MCP Endpoint 已复制");
  document.body.onclick = async (event) => {
    const target = event.target;
    const upgradeButton = target.closest("[data-copy-upgrade]");
    if (upgradeButton) {
      const agent = state.agents.find((item) => item.id === upgradeButton.dataset.copyUpgrade);
      if (agent?.managed_upgrade_command) await copyText(agent.managed_upgrade_command, "Linux 升级命令已复制");
      return;
    }
    const reenrollButton = target.closest("[data-reenroll-agent]");
    if (reenrollButton) {
      switchView("builder");
      toast("先添加并确认新设备上线，再撤销旧 Agent；重新接入会生成新的设备凭据");
      return;
    }
    const capabilitiesButton = target.closest("[data-agent-capabilities]");
    if (capabilitiesButton) openAgentCapabilitiesDialog(capabilitiesButton.dataset.agentCapabilities);
    const shellPolicyButton = target.closest("[data-shell-policy]");
    if (shellPolicyButton) {
      openShellPolicyForm(shellPolicyButton.dataset.shellPolicy);
      return;
    }
    const profileButton = target.closest("[data-profile-details]");
    if (profileButton) {
      const capabilitiesDialog = $("#agent-capabilities-dialog");
      const returnAgentId = capabilitiesDialog.open ? capabilitiesDialog.dataset.agentId : "";
      if (capabilitiesDialog.open) capabilitiesDialog.close();
      openProfileDialog(profileButton.dataset.profileDetails, returnAgentId);
    }
    const agentId = target.dataset.editAgent;
    if (agentId) {
      const agent = state.agents.find((item) => item.id === agentId);
      openForm({ eyebrow: "Agent Metadata", title: "编辑 Agent", submit: "保存", fields: `<label>名称<input name="name" value="${escapeHtml(agent.name)}" required maxlength="80"></label><label>用途描述<textarea name="description" maxlength="500" rows="4">${escapeHtml(agent.description)}</textarea></label>`, onSubmit: async (data) => { await api(`/agents/${agentId}`, { method: "PATCH", body: JSON.stringify({ name: data.get("name"), description: data.get("description") }) }); await loadAll(true); } });
    }
    if (target.dataset.revokeAgent && confirm("撤销后该 Agent 的设备凭据将永久失效。继续吗？")) { await api(`/agents/${target.dataset.revokeAgent}`, { method: "DELETE" }); await loadAll(true); toast("Agent 已撤销"); }
    if (target.dataset.revokeKey && confirm("撤销后使用该 Key 的 MCP 客户端将立即失去访问权限。继续吗？")) { await api(`/mcp-keys/${target.dataset.revokeKey}`, { method: "DELETE" }); await loadAll(true); toast("MCP Key 已撤销"); }
    if (target.dataset.revokeToken && confirm("确定撤销这个注册令牌吗？")) { await api(`/enrollment-tokens/${target.dataset.revokeToken}`, { method: "DELETE" }); await loadAll(true); toast("注册令牌已撤销"); }
    if (target.dataset.downloadBundle) { window.location.assign(`/api/agent-bundles/${target.dataset.downloadBundle}/download`); }
  };
}

function setAuthMode(mode) {
  if (mode === "register" && (!state.registrationEnabled || state.mode === "local")) mode = "login";
  state.authMode = mode;
  $("#login-tab").classList.toggle("active", mode === "login");
  $("#register-tab").classList.toggle("active", mode === "register");
  $("#auth-title").textContent = mode === "login" ? "登录网关" : "创建账号";
  $("#auth-submit").textContent = mode === "login" ? "登录" : "注册";
  $("#auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
  const showMfa = state.mode === "local" && state.mfaRequired && mode === "login";
  $("#auth-mfa-label").classList.toggle("hidden", !showMfa);
  $("#auth-mfa").required = showMfa;
  if (!showMfa) $("#auth-mfa").value = "";
  $("#auth-error").textContent = "";
}

async function copyText(value, message) {
  await navigator.clipboard.writeText(value);
  toast(message);
}

bindEvents();
loadAll(true);
setInterval(() => { if (state.user) loadAll(true); }, 15000);
