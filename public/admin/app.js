const REQUEST_TIMEOUT_MS = 20000;
const RESERVED_PATHS = ["/admin", "/api", "/functions", "/assets", "/favicon.ico"];

const state = {
  initialized: false,
  setupTokenConfigured: true,
  session: null,
  routes: [],
  editingId: null,
  busy: false,
  isOffline: !navigator.onLine,
  lastFocusedElement: null,
};

const messages = {
  setupTitle: "初始化管理员账户",
  loginTitle: "登录管理后台",
  defaultFormHint: "支持中文、日文、韩文、emoji 和长路径；如果保存失败，当前已填写的内容会继续保留。",
  offline: "当前网络已断开。你仍可查看已加载内容，但刷新和提交暂时无法完成。",
  backOnline: "网络已恢复，可以继续操作。",
  loading: "正在加载数据…",
  noDescription: "未填写描述。",
  unnamedRoute: "未命名路由",
  directPassThrough: "完全透传",
  stripPrefixOn: "去掉前缀",
  stripPrefixOff: "保留前缀",
  enabled: "已启用",
  disabled: "已停用",
  invalidJsonObject: "注入请求头必须是合法的 JSON 对象。",
  invalidJsonArray: "移除请求头必须是合法的 JSON 数组。",
  invalidTargetBase: "目标地址必须是有效的 http 或 https URL。",
  invalidMountPath: "挂载路径必须以 / 开头，且不能与系统保留路径冲突。",
  invalidName: "路由名称至少需要 2 个字符。",
};

const presets = {
  openai: {
    name: "OpenAI 主通道",
    mountPath: "/openai",
    targetBase: "https://api.openai.com",
    description: "适合对接 OpenAI REST、SSE 和上传类接口。",
    injectHeaders: "{}",
    removeHeaders: "[]",
    stripPrefix: true,
    enabled: true,
  },
  gemini: {
    name: "Gemini 通道",
    mountPath: "/gemini",
    targetBase: "https://generativelanguage.googleapis.com",
    description: "适合转发 Gemini / Generative Language API 请求。",
    injectHeaders: "{}",
    removeHeaders: "[]",
    stripPrefix: true,
    enabled: true,
  },
  npm: {
    name: "npm Registry",
    mountPath: "/npm",
    targetBase: "https://registry.npmjs.org",
    description: "用于 npm install、npm view 等包管理请求。",
    injectHeaders: "{}",
    removeHeaders: "[]",
    stripPrefix: true,
    enabled: true,
  },
  docker: {
    name: "Docker Hub Registry",
    mountPath: "/docker",
    targetBase: "https://registry-1.docker.io",
    description: "适合 Docker Registry HTTP API v2 中转。",
    injectHeaders: "{}",
    removeHeaders: "[]",
    stripPrefix: true,
    enabled: true,
  },
};

const authView = document.getElementById("auth-view");
const dashboardView = document.getElementById("dashboard-view");
const networkBanner = document.getElementById("network-banner");
const sessionUser = document.getElementById("session-user");
const statsGrid = document.getElementById("stats-grid");
const routesTableBody = document.getElementById("routes-table-body");
const routesEmpty = document.getElementById("routes-empty");
const tableWrap = document.getElementById("table-wrap");
const routeModal = document.getElementById("route-modal");
const modalTitle = document.getElementById("modal-title");
const routeForm = document.getElementById("route-form");
const routePreview = document.getElementById("route-preview");
const submitButton = document.getElementById("submit-button");
const refreshButton = document.getElementById("refresh-button");
const openCreateButton = document.getElementById("open-create-button");
const emptyCreateButton = document.getElementById("empty-create-button");
const closeModalButton = document.getElementById("close-modal-button");
const cancelModalButton = document.getElementById("cancel-modal-button");
const logoutButton = document.getElementById("logout-button");
const formMessage = document.getElementById("form-message");
const toast = document.getElementById("toast");

init().catch((error) => showToast(error.message || "初始化失败，请刷新页面后重试。", "error"));

async function init() {
  bindEvents();
  updateNetworkBanner();
  await bootstrap();
}

function bindEvents() {
  routeForm.addEventListener("submit", handleRouteSubmit);
  refreshButton.addEventListener("click", handleRefresh);
  openCreateButton.addEventListener("click", openCreateModal);
  emptyCreateButton.addEventListener("click", openCreateModal);
  closeModalButton.addEventListener("click", closeModal);
  cancelModalButton.addEventListener("click", closeModal);
  logoutButton.addEventListener("click", handleLogout);

  routeModal.addEventListener("click", (event) => {
    if (event.target instanceof HTMLElement && event.target.hasAttribute("data-close-modal")) {
      closeModal();
    }
  });

  routesTableBody.addEventListener("click", async (event) => {
    const target = event.target instanceof HTMLElement ? event.target.closest("[data-action]") : null;
    if (!target) return;

    const id = Number(target.dataset.id);
    const route = state.routes.find((item) => item.id === id);
    if (!route) return;

    if (target.dataset.action === "edit") {
      openEditModal(route);
      return;
    }

    if (target.dataset.action === "delete") {
      await deleteRoute(route, target);
    }
  });

  document.querySelectorAll(".preset").forEach((button) => {
    button.addEventListener("click", () => applyPreset(button.dataset.preset));
  });

  document.querySelectorAll("input, textarea").forEach((field) => {
    field.addEventListener("input", () => clearFieldError(field));
  });

  ["route-mountPath", "route-targetBase"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updatePreview);
  });

  window.addEventListener("offline", () => {
    state.isOffline = true;
    updateNetworkBanner();
    showToast(messages.offline, "error");
  });

  window.addEventListener("online", () => {
    state.isOffline = false;
    updateNetworkBanner();
    showToast(messages.backOnline, "success");
  });

  document.addEventListener("keydown", handleDocumentKeydown);
}

function handleDocumentKeydown(event) {
  if (routeModal.classList.contains("hidden")) return;

  if (event.key === "Escape") {
    closeModal();
    return;
  }

  if (event.key === "Tab") {
    trapFocus(event, routeModal);
  }
}

async function bootstrap() {
  try {
    const data = await api("/api/public/bootstrap");
    state.initialized = data.initialized;
    state.setupTokenConfigured = data.setupTokenConfigured !== false;
    state.session = data.session;

    if (!state.initialized) {
      if (!state.setupTokenConfigured) {
        renderFatalState("首次初始化已被保护。请先在 Cloudflare Pages 环境变量中配置 ADMIN_SETUP_TOKEN，再刷新页面继续。");
        return;
      }
      renderSetup();
      return;
    }

    if (!state.session) {
      renderLogin();
      return;
    }

    await loadDashboard();
  } catch (error) {
    renderFatalState(error.message || "系统初始化失败，请刷新页面后重试。");
  }
}

function renderFatalState(message) {
  dashboardView.classList.add("hidden");
  authView.classList.remove("hidden");
  authView.innerHTML = `
    <div class="auth-card">
      <span class="eyebrow">System</span>
      <h2>后台暂时不可用</h2>
      <p class="muted">${escapeHtml(message)}</p>
      <button class="button primary" id="retry-bootstrap" type="button">重新加载</button>
    </div>
  `;

  document.getElementById("retry-bootstrap").addEventListener("click", () => {
    bootstrap().catch((error) => renderFatalState(error.message || "重新加载失败。"));
  });
}

function renderSetup() {
  dashboardView.classList.add("hidden");
  authView.classList.remove("hidden");
  authView.innerHTML = `
    <div class="auth-card">
      <span class="eyebrow">First Run</span>
      <h2>${messages.setupTitle}</h2>
      <p class="muted">当前还没有管理员账户。完成首次创建后，你就可以进入完整后台继续管理。</p>
      <form id="setup-form" class="auth-form" novalidate>
        <label>
          <span>初始化令牌</span>
          <input
            name="setupToken"
            type="password"
            autocomplete="one-time-code"
            maxlength="128"
            placeholder="请输入 ADMIN_SETUP_TOKEN"
            required
          />
        </label>
        <label>
          <span>管理员用户名</span>
          <input
            name="username"
            autocomplete="username"
            maxlength="32"
            pattern="[A-Za-z0-9._-]{3,32}"
            placeholder="admin"
            required
          />
        </label>
        <label>
          <span>登录密码</span>
          <input
            name="password"
            type="password"
            autocomplete="new-password"
            minlength="10"
            maxlength="128"
            placeholder="至少 10 位"
            required
          />
        </label>
        <p class="helper-text">请输入部署时配置的初始化令牌；用户名支持字母、数字、点、下划线和短横线；密码至少 10 位。</p>
        <button class="button primary" type="submit" data-auth-submit>创建并登录</button>
      </form>
    </div>
  `;

  document.getElementById("setup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("[data-auth-submit]");

    try {
      if (state.isOffline) {
        throw new Error(messages.offline);
      }

      setBusy(button, true, "创建中…");
      const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
      const result = await api("/api/auth/setup", { method: "POST", body: payload });
      state.initialized = true;
      state.session = result.session;
      showToast("管理员账户已创建。", "success");
      await loadDashboard();
    } catch (error) {
      showToast(error.message || "初始化管理员失败。", "error");
    } finally {
      setBusy(button, false, "创建并登录");
    }
  });
}

function renderLogin() {
  dashboardView.classList.add("hidden");
  authView.classList.remove("hidden");
  authView.innerHTML = `
    <div class="auth-card">
      <span class="eyebrow">Sign In</span>
      <h2>${messages.loginTitle}</h2>
      <p class="muted">请输入已创建的管理员账户信息，以继续进入后台。</p>
      <form id="login-form" class="auth-form" novalidate>
        <label>
          <span>用户名</span>
          <input
            name="username"
            autocomplete="username"
            maxlength="32"
            pattern="[A-Za-z0-9._-]{3,32}"
            required
          />
        </label>
        <label>
          <span>密码</span>
          <input
            name="password"
            type="password"
            autocomplete="current-password"
            minlength="10"
            maxlength="128"
            required
          />
        </label>
        <p class="helper-text">如果登录状态失效，系统会自动提示你重新登录。</p>
        <button class="button primary" type="submit" data-auth-submit>登录</button>
      </form>
    </div>
  `;

  document.getElementById("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("[data-auth-submit]");

    try {
      if (state.isOffline) {
        throw new Error(messages.offline);
      }

      setBusy(button, true, "登录中…");
      const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
      const result = await api("/api/auth/login", { method: "POST", body: payload });
      state.session = result.session;
      showToast("欢迎回来。", "success");
      await loadDashboard();
    } catch (error) {
      showToast(error.message || "登录失败。", "error");
    } finally {
      setBusy(button, false, "登录");
    }
  });
}

async function loadDashboard() {
  try {
    setBusy(refreshButton, true, "刷新中…");
    const overview = await api("/api/overview");
    state.session = overview.user;
    state.routes = overview.routes;
    authView.classList.add("hidden");
    dashboardView.classList.remove("hidden");
    sessionUser.textContent = overview.user.username;
    renderStats(overview.stats);
    renderRoutes();
    closeModal();
  } catch (error) {
    if (error.status === 401) {
      state.session = null;
      renderLogin();
      return;
    }

    showToast(error.message || "加载后台数据失败。", "error");
  } finally {
    setBusy(refreshButton, false, "刷新数据");
  }
}

function renderStats(stats) {
  const number = new Intl.NumberFormat("zh-CN");
  const items = [
    { label: "总路由数", value: number.format(stats.totalRoutes || 0) },
    { label: "启用中", value: number.format(stats.enabledRoutes || 0) },
    { label: "已停用", value: number.format(stats.disabledRoutes || 0) },
  ];

  statsGrid.innerHTML = items
    .map(
      (item) => `
        <div class="stat-card">
          <span>${item.label}</span>
          <strong>${item.value}</strong>
        </div>
      `,
    )
    .join("");
}

function renderRoutes() {
  const hasRoutes = state.routes.length > 0;
  routesEmpty.classList.toggle("hidden", hasRoutes);
  tableWrap.classList.toggle("hidden", !hasRoutes);

  if (!hasRoutes) {
    routesTableBody.innerHTML = "";
    return;
  }

  routesTableBody.innerHTML = state.routes.map((route) => renderRouteRow(route)).join("");
}

function renderRouteRow(route) {
  const mountPath = escapeHtml(route.mount_path);
  const name = escapeHtml(route.name || messages.unnamedRoute);
  const description = escapeHtml(route.description || messages.noDescription);
  const targetBase = escapeHtml(route.target_base);
  const rewriteState = route.inject_headers && Object.keys(route.inject_headers).length ? "含请求头改写" : messages.directPassThrough;
  const mode = route.strip_prefix ? messages.stripPrefixOn : messages.stripPrefixOff;
  const accessUrl = `${window.location.origin}${route.mount_path}`;

  return `
    <tr>
      <td data-label="挂载路径">
        <div class="cell-title">
          <div class="path-text" title="${mountPath}">${mountPath}</div>
          <div class="helper-inline url-text" title="${escapeHtml(accessUrl)}">${escapeHtml(accessUrl)}</div>
        </div>
      </td>
      <td data-label="名称与说明">
        <div class="cell-title">
          <strong title="${name}">${name}</strong>
          <div class="helper-inline" title="${description}">${description}</div>
        </div>
      </td>
      <td data-label="目标地址">
        <div class="endpoint-text" title="${targetBase}">${targetBase}</div>
      </td>
      <td data-label="转发方式">
        <div class="cell-title">
          <strong>${mode}</strong>
          <div class="helper-inline">${rewriteState}</div>
        </div>
      </td>
      <td data-label="状态">
        <span class="status-badge ${route.enabled ? "enabled" : "disabled"}">${route.enabled ? messages.enabled : messages.disabled}</span>
      </td>
      <td data-label="操作">
        <div class="table-actions">
          <button class="button" type="button" data-action="edit" data-id="${route.id}">编辑</button>
          <button class="button" type="button" data-action="delete" data-id="${route.id}">删除</button>
        </div>
      </td>
    </tr>
  `;
}

function openCreateModal() {
  state.editingId = null;
  modalTitle.textContent = "添加新路由";
  routeForm.reset();
  clearFormState();
  document.getElementById("route-id").value = "";
  document.getElementById("route-stripPrefix").checked = true;
  document.getElementById("route-enabled").checked = true;
  document.getElementById("route-injectHeaders").value = "{}";
  document.getElementById("route-removeHeaders").value = "[]";
  submitButton.textContent = "保存路由";
  updatePreview();
  setModalOpen(true);
  document.getElementById("route-name").focus();
}

function openEditModal(route) {
  state.editingId = route.id;
  modalTitle.textContent = `编辑路由 #${route.id}`;
  clearFormState();
  document.getElementById("route-id").value = route.id;
  document.getElementById("route-name").value = route.name || "";
  document.getElementById("route-mountPath").value = route.mount_path || "";
  document.getElementById("route-targetBase").value = route.target_base || "";
  document.getElementById("route-description").value = route.description || "";
  document.getElementById("route-injectHeaders").value = JSON.stringify(route.inject_headers || {}, null, 2);
  document.getElementById("route-removeHeaders").value = JSON.stringify(route.remove_headers || [], null, 2);
  document.getElementById("route-stripPrefix").checked = Boolean(route.strip_prefix);
  document.getElementById("route-enabled").checked = Boolean(route.enabled);
  submitButton.textContent = "更新路由";
  updatePreview();
  setModalOpen(true);
  document.getElementById("route-name").focus();
}

function closeModal() {
  setModalOpen(false);
}

function setModalOpen(open) {
  if (open) {
    state.lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  routeModal.classList.toggle("hidden", !open);
  routeModal.setAttribute("aria-hidden", String(!open));
  document.body.classList.toggle("modal-open", open);

  if (!open) {
    state.editingId = null;
    if (state.lastFocusedElement) {
      state.lastFocusedElement.focus();
    }
  }
}

function applyPreset(name) {
  const preset = presets[name];
  if (!preset) return;

  if (routeModal.classList.contains("hidden")) {
    openCreateModal();
  }

  document.getElementById("route-name").value = preset.name;
  document.getElementById("route-mountPath").value = preset.mountPath;
  document.getElementById("route-targetBase").value = preset.targetBase;
  document.getElementById("route-description").value = preset.description;
  document.getElementById("route-injectHeaders").value = preset.injectHeaders;
  document.getElementById("route-removeHeaders").value = preset.removeHeaders;
  document.getElementById("route-stripPrefix").checked = preset.stripPrefix;
  document.getElementById("route-enabled").checked = preset.enabled;
  clearFormState();
  updatePreview();
  showToast(`已为你填入“${preset.name}”预设。`, "success");
}

async function handleRouteSubmit(event) {
  event.preventDefault();
  if (state.busy) return;

  try {
    if (state.isOffline) {
      throw new Error(messages.offline);
    }

    const payload = validateRouteForm();
    const isEditing = Boolean(state.editingId);
    state.busy = true;
    routeForm.setAttribute("aria-busy", "true");
    setBusy(submitButton, true, isEditing ? "更新中…" : "保存中…");
    setFormMessage(messages.loading, "info");

    if (isEditing) {
      await api(`/api/routes/${state.editingId}`, { method: "PUT", body: payload });
      showToast("路由已更新。", "success");
    } else {
      await api("/api/routes", { method: "POST", body: payload });
      showToast("路由已创建。", "success");
    }

    await refreshRoutes();
    closeModal();
  } catch (error) {
    setFormMessage(error.message || "保存路由失败。", "error");
    showToast(error.message || "保存路由失败。", "error");
  } finally {
    state.busy = false;
    routeForm.removeAttribute("aria-busy");
    setBusy(submitButton, false, state.editingId ? "更新路由" : "保存路由");
  }
}

function validateRouteForm() {
  const nameField = document.getElementById("route-name");
  const mountPathField = document.getElementById("route-mountPath");
  const targetBaseField = document.getElementById("route-targetBase");
  const injectHeadersField = document.getElementById("route-injectHeaders");
  const removeHeadersField = document.getElementById("route-removeHeaders");

  const name = nameField.value.trim();
  if (name.length < 2) {
    throw withFieldError(nameField, messages.invalidName);
  }

  const mountPath = normalizeMountPath(mountPathField.value.trim());
  if (!isValidMountPath(mountPath)) {
    throw withFieldError(mountPathField, messages.invalidMountPath);
  }

  let targetBase = "";
  try {
    targetBase = normalizeTargetBase(targetBaseField.value.trim());
  } catch {
    throw withFieldError(targetBaseField, messages.invalidTargetBase);
  }

  const injectHeaders = parseJsonField(injectHeadersField, "object", messages.invalidJsonObject);
  const removeHeaders = parseJsonField(removeHeadersField, "array", messages.invalidJsonArray);

  return {
    name,
    mountPath,
    targetBase,
    description: document.getElementById("route-description").value.trim(),
    injectHeaders: JSON.stringify(injectHeaders),
    removeHeaders: JSON.stringify(removeHeaders),
    stripPrefix: document.getElementById("route-stripPrefix").checked,
    enabled: document.getElementById("route-enabled").checked,
  };
}

async function deleteRoute(route, button) {
  if (!window.confirm(`确定删除路由 ${route.mount_path} 吗？`)) return;

  try {
    if (state.isOffline) {
      throw new Error(messages.offline);
    }

    setBusy(button, true, "删除中…");
    await api(`/api/routes/${route.id}`, { method: "DELETE" });
    showToast("路由已删除。", "success");
    await refreshRoutes();
  } catch (error) {
    showToast(error.message || "删除路由失败。", "error");
  } finally {
    setBusy(button, false, "删除");
  }
}

async function refreshRoutes() {
  const overview = await api("/api/overview");
  state.session = overview.user;
  state.routes = overview.routes;
  sessionUser.textContent = overview.user.username;
  renderStats(overview.stats);
  renderRoutes();
}

async function handleRefresh() {
  if (state.isOffline) {
    showToast(messages.offline, "error");
    return;
  }

  await loadDashboard();
  showToast("数据已刷新。", "success");
}

async function handleLogout() {
  try {
    if (state.isOffline) {
      throw new Error(messages.offline);
    }

    setBusy(logoutButton, true, "退出中…");
    await api("/api/auth/logout", { method: "POST" });
    state.session = null;
    state.routes = [];
    closeModal();
    renderLogin();
    showToast("已退出登录。", "success");
  } catch (error) {
    showToast(error.message || "退出登录失败。", "error");
  } finally {
    setBusy(logoutButton, false, "退出登录");
  }
}

function updatePreview() {
  const mountPath = normalizeMountPath(document.getElementById("route-mountPath").value.trim() || "/example");
  const targetBase = document.getElementById("route-targetBase").value.trim() || "https://upstream.example.com";
  routePreview.textContent = `${window.location.origin}${mountPath.replace(/\/$/, "")}/v1/example → ${targetBase.replace(/\/$/, "")}/v1/example`;
}

async function api(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
      },
      credentials: "same-origin",
      signal: controller.signal,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (response.status === 204) {
      return {};
    }

    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await response.json()
      : { success: response.ok, error: await response.text() };

    if (!response.ok || data.success === false) {
      const error = new Error(normalizeApiError(response.status, data?.error));
      error.status = response.status;
      throw error;
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("请求超时，请检查网络后重试。");
    }

    if (!navigator.onLine) {
      throw new Error(messages.offline);
    }

    throw error instanceof Error ? error : new Error("请求失败，请稍后重试。");
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeApiError(status, detail) {
  if (detail && typeof detail === "string" && detail.trim()) {
    return detail.trim();
  }

  if (status === 400) return "请求参数不正确，请检查后重试。";
  if (status === 401) return "登录状态已失效，请重新登录。";
  if (status === 403) return "你没有权限执行此操作。";
  if (status === 404) return "请求的资源不存在。";
  if (status === 429) return "请求过于频繁，请稍后再试。";
  if (status >= 500) return "服务器暂时不可用，请稍后重试。";
  return "请求失败，请稍后重试。";
}

function setBusy(element, busy, label) {
  if (!element) return;
  element.disabled = busy;
  element.setAttribute("aria-disabled", String(busy));
  if (label) {
    element.textContent = label;
  }
}

function showToast(message, tone = "info") {
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 3200);
}

function updateNetworkBanner() {
  if (state.isOffline) {
    networkBanner.textContent = messages.offline;
    networkBanner.dataset.tone = "offline";
    networkBanner.classList.remove("hidden");
    return;
  }

  networkBanner.classList.add("hidden");
}

function clearFormState() {
  routeForm.removeAttribute("aria-busy");
  setFormMessage(messages.defaultFormHint, "info");
  document.querySelectorAll("#route-form input, #route-form textarea").forEach((field) => clearFieldError(field));
}

function setFormMessage(message, tone = "info") {
  formMessage.textContent = message;
  formMessage.dataset.tone = tone;
}

function clearFieldError(field) {
  field.removeAttribute("aria-invalid");
  field.setCustomValidity("");
  if (formMessage.dataset.tone === "error") {
    setFormMessage(messages.defaultFormHint, "info");
  }
}

function withFieldError(field, message) {
  field.setAttribute("aria-invalid", "true");
  field.setCustomValidity(message);
  field.reportValidity();
  field.focus();
  setFormMessage(message, "error");
  return new Error(message);
}

function parseJsonField(field, expectedType, message) {
  const raw = field.value.trim();
  if (!raw) {
    return expectedType === "object" ? {} : [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (expectedType === "object" && Object.prototype.toString.call(parsed) === "[object Object]") {
      return parsed;
    }
    if (expectedType === "array" && Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // ignored intentionally
  }

  throw withFieldError(field, message);
}

function normalizeMountPath(value) {
  if (!value) return "";
  let normalized = value;
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  normalized = normalized.replace(/\/{2,}/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function normalizeTargetBase(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(messages.invalidTargetBase);
  }
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  url.hash = "";
  return url.toString();
}

function isValidMountPath(mountPath) {
  if (!mountPath || mountPath === "/") return false;
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/.test(mountPath)) return false;
  return !RESERVED_PATHS.some((item) => mountPath === item || mountPath.startsWith(`${item}/`));
}

function trapFocus(event, container) {
  const focusable = Array.from(
    container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("disabled") && !element.getAttribute("aria-hidden"));

  if (!focusable.length) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function escapeHtml(value) {
  return `${value ?? ""}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
