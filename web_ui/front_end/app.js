const state = {
  status: null,
  page: "dashboard",
  logType: "scanner",
  logLines: 100,
};

const $ = (id) => document.getElementById(id);

function text(value, fallback = "unknown") {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function setText(id, value, fallback) {
  const el = $(id);
  if (el) el.textContent = text(value, fallback);
}

function statusClass(value) {
  return value === "active" || value === "ok" || value === "hf" ? "status-ok" : "status-bad";
}

function renderDetails(id, rows) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = rows
    .map(([label, value]) => `<dt>${label}</dt><dd>${text(value)}</dd>`)
    .join("");
}

function bucketRows(bucket = {}) {
  const failures = bucket.failure_points || {};
  return [
    ["Started At", bucket.started_at],
    ["Runs Total", bucket.runs_total ?? 0],
    ["Successful Runs", bucket.successful_runs ?? 0],
    ["Unsuccessful Runs", bucket.unsuccessful_runs ?? 0],
    ["Cookie Failures", failures.cookie_failures ?? 0],
    ["Selector Failures", failures.selector_failures ?? 0],
    ["Timeouts", failures.timeouts ?? 0],
    ["Email Failures", failures.email_failures ?? 0],
    ["Token Failures", failures.token_failures ?? 0],
    ["Unknown Failures", failures.unknown_failures ?? 0],
  ].filter((row) => row[1] !== undefined);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Accept": "application/json" },
    ...options,
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function showError(error) {
  const banner = $("error-banner");
  banner.textContent = error ? `Error: ${error.message || error}` : "";
  banner.classList.toggle("hidden", !error);
}

async function loadStatus() {
  showError(null);
  $("refresh-button").disabled = true;
  try {
    state.status = await api("/api/status");
    renderStatus();
    $("last-refresh").textContent = new Date().toLocaleTimeString();
  } catch (error) {
    showError(error);
  } finally {
    $("refresh-button").disabled = false;
  }
}

function renderStatus() {
  const data = state.status || {};
  const scanner = data.scanner || {};
  const proxy = data.proxy || {};
  const keys = data.keys || {};
  const cookie = data.cookie || {};
  const proxyStats = data.proxy_stats || {};
  const runs = data.runs || {};

  setText("dash-scanner", scanner.active);
  $("dash-scanner").className = statusClass(scanner.active);
  setText("dash-proxy", proxy.active);
  $("dash-proxy").className = statusClass(proxy.active);
  setText("dash-keys", keys.count ?? 0);
  setText("dash-cookie", cookie.age_human || "missing");
  setText("dash-provider", proxyStats.current_provider || data.proxy_health?.current_provider);
  setText("dash-fallback", proxyStats.fallback_enabled === true ? "enabled" : "disabled");

  setText("last-run-status", runs.last_run_status);
  setText("last-run-failure", runs.last_failure_reason || "none");
  setText("last-run-updated", runs.last_updated || "never");

  renderFailures(runs.all_time?.failure_points || {});

  renderDetails("scanner-details", [
    ["Active", scanner.active],
    ["Enabled", scanner.enabled],
    ["Main PID", scanner.main_pid],
    ["Since", scanner.since],
    ["Sub State", scanner.sub_state],
    ["Key Count", keys.count ?? 0],
    ["Keys Modified", keys.modified],
    ["Cookie Age", cookie.age_human],
    ["Cookie Modified", cookie.modified],
    ["Last Run", runs.last_run_status],
  ]);

  renderDetails("proxy-details", [
    ["Active", proxy.active],
    ["Enabled", proxy.enabled],
    ["Main PID", proxy.main_pid],
    ["Since", proxy.since],
    ["Health", data.proxy_health?.status],
    ["Host", data.proxy_health?.host],
    ["Port", data.proxy_health?.port],
    ["Current Provider", proxyStats.current_provider],
    ["HF Usable Keys", proxyStats.hf_usable_keys ?? proxyStats.keys_available],
    ["Fallback Enabled", proxyStats.fallback_enabled],
    ["NVIDIA Available", proxyStats.nvidia_available],
    ["Default Model", proxyStats.default_model],
    ["Fallback Model", proxyStats.nvidia_model],
  ]);

  renderDetails("since-stats", bucketRows(runs.since_restart));
  renderDetails("all-time-stats", bucketRows(runs.all_time));
  renderDetails("key-stats", [
    ["Count", keys.count ?? 0],
    ["File", keys.file],
    ["Modified", keys.modified],
  ]);
  renderDetails("proxy-stats", [
    ["Current Provider", proxyStats.current_provider],
    ["Keys Available", proxyStats.keys_available],
    ["HF Usable Keys", proxyStats.hf_usable_keys],
    ["Fallback", proxyStats.fallback_enabled],
    ["Cooling Down", proxyStats.keys_cooling_down],
    ["Active Requests", proxyStats.active_requests],
    ["Last Reload", proxyStats.last_reload],
  ]);
  renderDetails("settings-details", settingsRows(data.settings || {}));
}

function renderFailures(failures) {
  const labels = {
    cookie_failures: "Cookie",
    selector_failures: "Selector",
    timeouts: "Timeouts",
    email_failures: "Email",
    token_failures: "Token",
    unknown_failures: "Unknown",
  };
  $("recent-failures").innerHTML = Object.entries(labels)
    .map(([key, label]) => `<div class="failure-row"><span>${label}</span><strong>${failures[key] ?? 0}</strong></div>`)
    .join("");
}

function settingsRows(settings) {
  const files = settings.runtime_files || {};
  return [
    ["Project Path", settings.project_path],
    ["Frontend Host", settings.frontend_host],
    ["Frontend Port", settings.frontend_port],
    ["Backend", settings.backend],
    ["Scanner Service", settings.scanner_service],
    ["Proxy Service", settings.proxy_service],
    ["Proxy URL", settings.proxy_url],
    ["Keys File", files.keys],
    ["Cookie File", files.cookie],
    ["Run Stats File", files.run_stats],
    ["Scanner Log", files.scanner_log],
    ["Security", settings.security_warning],
  ];
}

async function loadLogs() {
  const output = $("log-output");
  output.textContent = "Loading logs...";
  try {
    const data = await api(`/api/logs/${state.logType}?lines=${state.logLines}`);
    const lines = data.lines || [];
    output.textContent = lines.length ? lines.join("\n") : `No ${state.logType} logs found.`;
  } catch (error) {
    output.textContent = `Failed to load logs: ${error.message}`;
  }
}

async function runControl(action) {
  showError(null);
  try {
    await api(`/api/${action}`, { method: "POST" });
    await loadStatus();
    if (state.page === "logs") await loadLogs();
  } catch (error) {
    showError(error);
  }
}

function switchPage(page) {
  state.page = page;
  document.querySelectorAll(".page").forEach((el) => el.classList.toggle("active", el.id === page));
  document.querySelectorAll(".nav-button").forEach((el) => el.classList.toggle("active", el.dataset.page === page));
  $("page-title").textContent = page[0].toUpperCase() + page.slice(1);
  if (page === "logs") loadLogs();
}

document.querySelectorAll(".nav-button").forEach((button) => {
  button.addEventListener("click", () => switchPage(button.dataset.page));
});

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => runControl(button.dataset.action));
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.logType = tab.dataset.log;
    document.querySelectorAll(".tab").forEach((el) => el.classList.toggle("active", el === tab));
    loadLogs();
  });
});

$("log-lines").addEventListener("change", (event) => {
  state.logLines = Number(event.target.value);
  loadLogs();
});

$("refresh-button").addEventListener("click", loadStatus);
$("refresh-logs").addEventListener("click", loadLogs);

loadStatus();
setInterval(loadStatus, 30000);
