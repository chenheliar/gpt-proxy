const state = {
  initialized: false,
  session: null,
  routes: [],
  editingId: null,
  busy: false,
};

const presets = {
  openai: {
    name: "OpenAI 主通道",
    mountPath: "/openai",
    targetBase: "https://api.openai.com",
    description: "适合对接 OpenAI REST、SSE 和上传类接口。",
    injectHeaders: '{\n  "Authorization": "Bearer sk-..."\n}',
    removeHeaders: '["origin"]',
    stripPrefix: true,
    enabled: true,
  },
  gemini: {
    name: "Gemini 通道",
    mountPath: "/gemini",
    targetBase: "https://generativelanguage.googleapis.com",
    description: "适合转发 Gemini / Generative Language API 请求。",
    injectHeaders: '{\n  "x-goog-api-key": "YOUR_API_KEY"\n}',
    removeHeaders: '["origin"]',
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
    removeHeaders: '["origin"]',
    stripPrefix: true,
    enabled: true,
  },
};

const authView = document.getElementById("auth-view");
const dashboardView = document.getElementById("dashboard-view");
const sessionUser = document.getElementById("session-user");
const statsGrid = document.getElementById("stats-grid");
const routesList = document.getElementById("routes-list");
const routeForm = document.getElementById("route-form");
const editorTitle = document.getElementById("editor-title");
const cancelEditButton = document.getElementById("cancel-edit");
const routePreview = document.getElementById("route-preview");
const toast = document.getElementById("toast");
const logoutButton = document.getElementById("logout-button");
const submitButton = document.getElementById("submit-button");

init().catch((error) => showToast(error.message || "初始化失败", "error"));

async function init() {
  bindEvents();
  await bootstrap();
}

function bindEvents() {
  routeForm.addEventListener("submit", handleRouteSubmit);
  cancelEditButton.addEventListener("click", resetEditor);
  logoutButton.addEventListener("click", handleLogout);

  document.querySelectorAll(".preset").forEach((button) => {
    button.addEventListener("click", () => applyPreset(button.dataset.preset));
  });

  ["route-mountPath", "route-targetBase"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updatePreview);
  });
}

async function bootstrap() {
  try {
    const data = await api("/api/public/bootstrap");
    state.initialized = data.initialized;
    state.session = data.session;

    if (!state.initialized) {
      renderSetup();
      return;
    }

    if (!state.session) {
      renderLogin();
      return;
    }

    await loadDashboard();
  } catch (error) {
    renderFatalState(error.message || "系统初始化失败，请刷新后重试。");
  }
}

function renderFatalState(message) {
  dashboardView.classList.add("hidden");
  authView.classList.remove("hidden");
  authView.innerHTML = `
    <div class="auth-card">
      <span class="eyebrow">System</span>
      <h2>后台暂时不可用</h2>
      <p class="subtle">${escapeHtml(message)}</p>
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
      <h2>初始化管理员账户</h2>
      <p class="subtle">当前 D1 数据库中还没有管理员。创建第一个账号后即可进入完整后台。</p>
      <form id="setup-form" class="auth-form">
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
        <button class="button primary" type="submit" data-auth-submit>创建并登录</button>
      </form>
    </div>
  `;

  document.getElementById("setup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("[data-auth-submit]");

    try {
      setBusy(button, true, "创建中...");
      const form = new FormData(event.currentTarget);
      const payload = Object.fromEntries(form.entries());
      const result = await api("/api/auth/setup", {
        method: "POST",
        body: payload,
      });
      state.initialized = true;
      state.session = result.session;
      showToast("管理员已创建。", "success");
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
      <h2>登录管理后台</h2>
      <p class="subtle">使用你已经初始化的管理员账户进入后台。</p>
      <form id="login-form" class="auth-form">
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
        <button class="button primary" type="submit" data-auth-submit>登录</button>
      </form>
    </div>
  `;

  document.getElementById("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("[data-auth-submit]");

    try {
      setBusy(button, true, "登录中...");
      const form = new FormData(event.currentTarget);
      const payload = Object.fromEntries(form.entries());
      const result = await api("/api/auth/login", {
        method: "POST",
        body: payload,
      });
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
    const overview = await api("/api/overview");
    state.session = overview.user;
    state.routes = overview.routes;
    authView.classList.add("hidden");
    dashboardView.classList.remove("hidden");
    sessionUser.textContent = overview.user.username;
    renderStats(overview.stats);
    renderRoutes();
    resetEditor();
  } catch (error) {
    if (error.status === 401) {
      state.session = null;
      renderLogin();
    }
    showToast(error.message || "加载后台数据失败。", "error");
  }
}

function renderStats(stats) {
  const items = [
    { label: "总路由数", value: stats.totalRoutes },
    { label: "启用中", value: stats.enabledRoutes },
    { label: "已停用", value: stats.disabledRoutes },
  ];

  statsGrid.innerHTML = items
    .map(
      (item) => `
        <div class="surface stat-card">
          <span>${item.label}</span>
          <strong>${item.value}</strong>
        </div>
      `,
    )
    .join("");
}

function renderRoutes() {
  if (!state.routes.length) {
    routesList.innerHTML = `
      <div class="route-card route-card-empty">
        <div class="route-header">
          <div class="route-path">还没有任何路由</div>
        </div>
        <p class="subtle">先从 OpenAI、Gemini、npm 或 Docker 预设开始，或者手动创建一条新规则。</p>
      </div>
    `;
    return;
  }

  routesList.innerHTML = state.routes
    .map(
      (route) => `
        <article class="route-card" data-id="${route.id}">
          <div class="route-header">
            <div class="route-main">
              <div class="route-path wrap-text" title="${escapeHtml(route.mount_path)}">${escapeHtml(route.mount_path)}</div>
              <strong class="route-name wrap-text" title="${escapeHtml(route.name)}">${escapeHtml(route.name)}</strong>
            </div>
            <span class="status-pill ${route.enabled ? "enabled" : "disabled"}">${route.enabled ? "已启用" : "已停用"}</span>
          </div>
          <p class="route-target wrap-text" title="${escapeHtml(route.target_base)}">${escapeHtml(route.target_base)}</p>
          <p class="subtle route-description clamp-3">${escapeHtml(route.description || "未填写描述。")}</p>
          <div class="route-meta">
            <code>${escapeHtml(route.strip_prefix ? "去前缀：开启" : "去前缀：关闭")}</code>
            <span class="linkish wrap-text" title="${window.location.origin}${escapeHtml(route.mount_path)}">${window.location.origin}${escapeHtml(route.mount_path)}</span>
          </div>
          <div class="route-actions">
            <button class="button ghost" type="button" data-action="edit" data-id="${route.id}">
              编辑
            </button>
            <button class="button ghost" type="button" data-action="delete" data-id="${route.id}">
              删除
            </button>
          </div>
        </article>
      `,
    )
    .join("");

  routesList.querySelectorAll("[data-action='edit']").forEach((button) => {
    button.addEventListener("click", () => {
      const route = state.routes.find((item) => item.id === Number(button.dataset.id));
      if (route) populateEditor(route);
    });
  });

  routesList.querySelectorAll("[data-action='delete']").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = Number(button.dataset.id);
      const route = state.routes.find((item) => item.id === id);
      if (!route || !window.confirm(`确定删除路由 ${route.mount_path} 吗？`)) return;

      try {
        setBusy(button, true, "删除中...");
        await api(`/api/routes/${id}`, { method: "DELETE" });
        showToast("路由已删除。", "success");
        await refreshRoutes();
        if (state.editingId === id) resetEditor();
      } catch (error) {
        showToast(error.message || "删除路由失败。", "error");
      } finally {
        setBusy(button, false, "删除");
      }
    });
  });
}

function populateEditor(route) {
  state.editingId = route.id;
  editorTitle.textContent = `编辑路由 #${route.id}`;
  cancelEditButton.classList.remove("hidden");
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
  document.getElementById("route-name").focus();
}

function resetEditor() {
  state.editingId = null;
  editorTitle.textContent = "添加新路由";
  cancelEditButton.classList.add("hidden");
  routeForm.reset();
  document.getElementById("route-id").value = "";
  document.getElementById("route-stripPrefix").checked = true;
  document.getElementById("route-enabled").checked = true;
  document.getElementById("route-injectHeaders").value = "{}";
  document.getElementById("route-removeHeaders").value = "[]";
  submitButton.textContent = "保存路由";
  routeForm.removeAttribute("aria-busy");
  updatePreview();
}

function applyPreset(name) {
  const preset = presets[name];
  if (!preset) return;
  document.getElementById("route-name").value = preset.name;
  document.getElementById("route-mountPath").value = preset.mountPath;
  document.getElementById("route-targetBase").value = preset.targetBase;
  document.getElementById("route-description").value = preset.description;
  document.getElementById("route-injectHeaders").value = preset.injectHeaders;
  document.getElementById("route-removeHeaders").value = preset.removeHeaders;
  document.getElementById("route-stripPrefix").checked = preset.stripPrefix;
  document.getElementById("route-enabled").checked = preset.enabled;
  updatePreview();
  showToast(`已填入 ${preset.name} 预设。`, "info");
}

async function handleRouteSubmit(event) {
  event.preventDefault();
  if (state.busy) return;

  const isEditing = Boolean(state.editingId);
  const payload = {
    name: document.getElementById("route-name").value.trim(),
    mountPath: document.getElementById("route-mountPath").value.trim(),
    targetBase: document.getElementById("route-targetBase").value.trim(),
    description: document.getElementById("route-description").value.trim(),
    injectHeaders: document.getElementById("route-injectHeaders").value.trim() || "{}",
    removeHeaders: document.getElementById("route-removeHeaders").value.trim() || "[]",
    stripPrefix: document.getElementById("route-stripPrefix").checked,
    enabled: document.getElementById("route-enabled").checked,
  };

  try {
    state.busy = true;
    routeForm.setAttribute("aria-busy", "true");
    setBusy(submitButton, true, isEditing ? "更新中..." : "保存中...");

    if (isEditing) {
      await api(`/api/routes/${state.editingId}`, {
        method: "PUT",
        body: payload,
      });
      showToast("路由已更新。", "success");
    } else {
      await api("/api/routes", {
        method: "POST",
        body: payload,
      });
      showToast("路由已创建。", "success");
    }

    await refreshRoutes();
    resetEditor();
  } catch (error) {
    showToast(error.message || "保存路由失败。", "error");
  } finally {
    state.busy = false;
    routeForm.removeAttribute("aria-busy");
    setBusy(submitButton, false, isEditing ? "更新路由" : "保存路由");
  }
}

async function refreshRoutes() {
  const overview = await api("/api/overview");
  state.routes = overview.routes;
  renderStats(overview.stats);
  renderRoutes();
}

async function handleLogout() {
  try {
    setBusy(logoutButton, true, "退出中...");
    await api("/api/auth/logout", { method: "POST" });
    state.session = null;
    state.routes = [];
    renderLogin();
    showToast("已退出登录。", "success");
  } catch (error) {
    showToast(error.message || "退出登录失败。", "error");
  } finally {
    setBusy(logoutButton, false, "退出登录");
  }
}

function updatePreview() {
  const mountPath = document.getElementById("route-mountPath").value.trim() || "/example";
  const targetBase = document.getElementById("route-targetBase").value.trim() || "https://upstream.example.com";
  routePreview.textContent = `${window.location.origin}${mountPath.replace(/\/$/, "")}/v1/example → ${targetBase.replace(/\/$/, "")}/v1/example`;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
    },
    credentials: "same-origin",
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) return {};

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : { success: false, error: await response.text() };

  if (!response.ok || !data.success) {
    const error = new Error(data.error || "请求失败");
    error.status = response.status;
    throw error;
  }

  return data;
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

function escapeHtml(value) {
  return `${value ?? ""}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
