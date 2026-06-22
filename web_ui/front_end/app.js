const state = {
  status: null,
  page: "dashboard",
  logType: "scanner",
  logLines: 100,
  logText: "",
  logSource: null,
  streamPaused: false,
  maxLogBuffer: 800,
};

const pageCopy = {
  dashboard: "Scanner, proxy, keys, and runtime health.",
  scanner: "API maker service controls, cookie state, and run failures.",
  proxy: "Local AI proxy health, provider routing, and fallback state.",
  logs: "Recent scanner and proxy logs with masked sensitive values.",
  stats: "Run counters, failure points, key stats, and proxy stats.",
  settings: "Runtime paths, service names, ports, and public access warning.",
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function text(value, fallback = "unknown") {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function shortDate(value) {
  if (!value) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function setText(id, value, fallback) {
  const el = $(id);
  if (el) el.textContent = text(value, fallback);
}

function level(value) {
  const normalized = String(value || "").toLowerCase();
  if (["active", "ok", "hf", "success", "enabled", "yes", "true"].includes(normalized)) return "ok";
  if (["nvidia", "warning", "degraded", "fallback"].includes(normalized)) return "warn";
  if (["inactive", "failed", "failure", "disabled", "error", "no", "false"].includes(normalized)) return "bad";
  return "idle";
}

function badge(value) {
  const display = text(value);
  return `<span class="status-badge badge-${level(display)}">${escapeHtml(display)}</span>`;
}

function statusClass(value) {
  return `status-${level(value)}`;
}

function renderDetails(id, rows) {
  const el = $(id);
  if (!el) return;
  const visibleRows = rows.filter((row) => row[1] !== undefined);
  if (!visibleRows.length) {
    el.innerHTML = `<div class="empty-state">No data available.</div>`;
    return;
  }
  el.innerHTML = visibleRows
    .map(([label, value, kind]) => `<dt>${escapeHtml(label)}</dt><dd>${kind === "badge" ? badge(value) : escapeHtml(text(value))}</dd>`)
    .join("");
}

function failureEntries(failures = {}) {
  return [
    ["Cookie", failures.cookie_failures ?? 0],
    ["Selector", failures.selector_failures ?? 0],
    ["Timeouts", failures.timeouts ?? 0],
    ["Email", failures.email_failures ?? 0],
    ["Token", failures.token_failures ?? 0],
    ["Unknown", failures.unknown_failures ?? 0],
  ];
}

function bucketRows(bucket = {}) {
  if (!bucket || Object.keys(bucket).length === 0) return [];
  return [
    ["Started At", shortDate(bucket.started_at)],
    ["Runs Total", bucket.runs_total ?? 0],
    ["Successful Runs", bucket.successful_runs ?? 0],
    ["Unsuccessful Runs", bucket.unsuccessful_runs ?? 0],
    ...failureEntries(bucket.failure_points || {}).map(([label, value]) => [`${label} Failures`, value]),
  ];
}

function statPill(label, value, tone = "") {
  return `<div class="stat-pill ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(text(value, "0"))}</strong></div>`;
}

function renderCompactStats(id, bucket = {}) {
  const el = $(id);
  if (!el) return;
  if (!bucket || bucket.runs_total === undefined) {
    el.innerHTML = `<div class="empty-state">No run stats recorded yet.</div>`;
    return;
  }
  el.innerHTML = [
    statPill("Total", bucket.runs_total ?? 0),
    statPill("Success", bucket.successful_runs ?? 0),
    statPill("Failed", bucket.unsuccessful_runs ?? 0),
  ].join("");
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
    loadRecentFailures();
    $("last-refresh").textContent = `Updated ${new Date().toLocaleTimeString()}`;
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
  setText("dash-scanner-sub", scanner.since || "service");
  setText("dash-proxy", proxy.active);
  $("dash-proxy").className = statusClass(proxy.active);
  setText("dash-proxy-sub", data.proxy_health?.status || "health");
  setText("dash-keys", keys.count ?? 0);
  setText("dash-cookie", cookie.age_human || "missing");
  setText("dash-provider", proxyStats.current_provider || data.proxy_health?.current_provider);
  $("dash-provider").className = statusClass(proxyStats.current_provider || data.proxy_health?.current_provider);
  setText("dash-fallback", proxyStats.fallback_enabled === true ? "enabled" : "disabled");
  $("dash-fallback").className = proxyStats.fallback_enabled === true ? "status-warn" : "status-idle";

  setText("last-run-status", runs.last_run_status);
  $("last-run-status").className = statusClass(runs.last_run_status);
  setText("last-run-failure", runs.last_failure_reason || "none");
  setText("last-run-updated", runs.last_updated || "never");

  renderFailureCounts("recent-failures", runs.all_time?.failure_points || {});
  renderCompactStats("dash-since-summary", runs.since_restart);
  renderCompactStats("dash-all-time-summary", runs.all_time);

  renderDetails("scanner-details", [
    ["Active", scanner.active, "badge"],
    ["Enabled", scanner.enabled, "badge"],
    ["Main PID", scanner.main_pid],
    ["Since", scanner.since],
    ["Sub State", scanner.sub_state, "badge"],
    ["Key Count", keys.count ?? 0],
    ["Keys Modified", keys.modified],
    ["Cookie Age", cookie.age_human],
    ["Cookie Modified", cookie.modified],
    ["Last Run", runs.last_run_status, "badge"],
  ]);
  renderCompactStats("scanner-run-summary", runs.since_restart);
  renderFailureCounts("scanner-failure-summary", runs.since_restart?.failure_points || {});

  renderDetails("proxy-details", [
    ["Active", proxy.active, "badge"],
    ["Enabled", proxy.enabled, "badge"],
    ["Main PID", proxy.main_pid],
    ["Since", proxy.since],
    ["Health", data.proxy_health?.status, "badge"],
    ["Host", data.proxy_health?.host],
    ["Port", data.proxy_health?.port],
    ["Current Provider", proxyStats.current_provider, "badge"],
    ["HF Usable Keys", proxyStats.hf_usable_keys ?? proxyStats.keys_available],
    ["Fallback Enabled", proxyStats.fallback_enabled, "badge"],
    ["NVIDIA Available", proxyStats.nvidia_available, "badge"],
    ["Default Model", proxyStats.default_model],
    ["Fallback Model", proxyStats.nvidia_model],
    ["Active Requests", proxyStats.active_requests],
  ]);

  renderDetails("since-stats", bucketRows(runs.since_restart));
  renderDetails("all-time-stats", bucketRows(runs.all_time));
  renderDetails("key-stats", [
    ["Count", keys.count ?? 0],
    ["Modified", keys.modified],
  ]);
  renderDetails("proxy-stats", [
    ["Current Provider", proxyStats.current_provider, "badge"],
    ["Keys Available", proxyStats.keys_available],
    ["HF Usable Keys", proxyStats.hf_usable_keys],
    ["Fallback", proxyStats.fallback_enabled, "badge"],
    ["Cooling Down", proxyStats.keys_cooling_down],
    ["Active Requests", proxyStats.active_requests],
    ["Last Reload", shortDate(proxyStats.last_reload)],
  ]);
  renderSettings(data.settings || {});
}

function renderFailureCounts(id, failures) {
  const el = $(id);
  if (!el) return;
  const rows = failureEntries(failures);
  if (!rows.some(([_label, value]) => Number(value) > 0)) {
    el.innerHTML = `<div class="empty-state">No failures recorded.</div>`;
    return;
  }
  el.innerHTML = rows
    .map(([label, value]) => `<div class="failure-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");
}

async function loadRecentFailures() {
  const el = $("recent-failures");
  if (!el) return;
  try {
    const failures = await api("/api/failures/recent");
    if (!failures.length) {
      el.innerHTML = `<div class="empty-state">No failures recorded.</div>`;
      return;
    }
    el.innerHTML = failures
      .map((failure) => `
        <article class="failure-card" data-failure="${escapeHtml(failure.category)}">
          <button class="failure-toggle" type="button">
            <span>
              <span class="failure-title">${escapeHtml(failure.label)} · ${escapeHtml(shortDate(failure.timestamp) || "recent")}</span>
              <span class="failure-reason">${escapeHtml(failure.reason || "Open log context")}</span>
            </span>
            <span class="failure-count">${escapeHtml(failure.count)}</span>
          </button>
          <div class="failure-context hidden"></div>
        </article>
      `)
      .join("");
  } catch (error) {
    el.innerHTML = `<div class="empty-state">Failure context unavailable: ${escapeHtml(error.message)}</div>`;
  }
}

async function toggleFailureContext(card) {
  const context = card.querySelector(".failure-context");
  if (!context) return;
  const isOpen = !context.classList.contains("hidden");
  document.querySelectorAll(".failure-context").forEach((el) => el.classList.add("hidden"));
  if (isOpen) return;
  context.classList.remove("hidden");
  context.innerHTML = `<span class="muted">Loading matching log context...</span>`;
  try {
    const data = await api(`/api/failures/${card.dataset.failure}`);
    const lines = data.lines || [];
    context.innerHTML = `
      <div class="muted">${escapeHtml(shortDate(data.timestamp) || "latest match")} · ${escapeHtml(data.category || "failure")} · ${escapeHtml(data.source || "logs")}</div>
      <pre>${escapeHtml(lines.length ? lines.join("\n") : data.reason || "No matching log context found.")}</pre>
    `;
  } catch (error) {
    context.innerHTML = `<div class="error">Could not load log context: ${escapeHtml(error.message)}</div>`;
  }
}

function settingInput(key, schema, value) {
  if (schema.type === "select") {
    return `<select class="setting-control" name="${escapeHtml(key)}">${schema.options
      .map((option) => `<option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option)}</option>`)
      .join("")}</select>`;
  }
  if (schema.type === "bool") {
    return `<select class="setting-control" name="${escapeHtml(key)}">
      <option value="1" ${value === "1" || value === true ? "selected" : ""}>enabled</option>
      <option value="0" ${value === "0" || value === false ? "selected" : ""}>disabled</option>
    </select>`;
  }
  const type = schema.type === "int" || schema.type === "float" ? "number" : "text";
  const step = schema.type === "float" ? "0.1" : "1";
  return `<input class="setting-control" name="${escapeHtml(key)}" type="${type}" step="${step}" value="${escapeHtml(value)}" />`;
}

function renderSettingCard(title, fields, options = {}) {
  const full = options.full ? " full" : "";
  return `<article class="panel settings-card${full}">
    <h2>${escapeHtml(title)}</h2>
    <div class="setting-fields">${fields.join("")}</div>
    ${options.help ? `<p class="setting-help">${escapeHtml(options.help)}</p>` : ""}
  </article>`;
}

function renderReadonlyField(label, value) {
  return `<div class="setting-field"><label>${escapeHtml(label)}</label><div class="setting-readonly">${escapeHtml(text(value))}</div></div>`;
}

function renderEditableField(key, schema, value) {
  return `<div class="setting-field"><label for="${escapeHtml(key)}">${escapeHtml(schema.label)}</label>${settingInput(key, schema, value)}</div>`;
}

function renderSettings(settings) {
  const root = $("settings-sections");
  if (!root) return;
  const schema = settings.schema || {};
  const values = settings.editable || {};
  const files = settings.runtime_files || {};
  const secrets = settings.secrets || {};
  const bySection = { proxy: [], models: [] };
  Object.entries(schema).forEach(([key, field]) => {
    const section = bySection[field.section] ? field.section : "proxy";
    bySection[section].push(renderEditableField(key, field, text(values[key], field.default || "")));
  });
  root.innerHTML = [
    renderSettingCard("Project", [
      renderReadonlyField("Project path", settings.project_path),
      renderReadonlyField("Backend", settings.backend),
    ]),
    renderSettingCard("Scanner", [
      renderReadonlyField("Service", settings.scanner_service),
      renderReadonlyField("Keys file", files.keys),
      renderReadonlyField("Cookie file", files.cookie),
      renderReadonlyField("Run stats", files.run_stats),
    ]),
    renderSettingCard("Proxy", [
      renderReadonlyField("Service", settings.proxy_service),
      renderReadonlyField("Proxy URL", settings.proxy_url),
      renderReadonlyField("Systemd unit", settings.proxy_unit),
      ...bySection.proxy,
    ], { help: "Proxy changes require a proxy restart." }),
    renderSettingCard("Models", bySection.models, { help: "Model/provider changes are written to the whitelisted proxy environment only." }),
    renderSettingCard("Logs", [
      renderReadonlyField("Scanner log", files.scanner_log),
      renderReadonlyField("Browser stream buffer", `${state.maxLogBuffer} lines`),
    ]),
    renderSettingCard("Web UI", [
      renderReadonlyField("Frontend host", settings.frontend_host),
      renderReadonlyField("Frontend port", settings.frontend_port),
      renderReadonlyField("Backend port", settings.frontend_port),
    ]),
    renderSettingCard("Security", [
      renderReadonlyField("AgentMail key", secrets.agentmail_key),
      renderReadonlyField("NVIDIA key", secrets.nvidia_key),
      renderReadonlyField("Gmail accounts", secrets.gmail_accounts),
      renderReadonlyField("Web password/token", secrets.web_password),
      renderReadonlyField("Warning", settings.security_warning),
    ], { full: true }),
  ].join("");
}

function classifyLogLine(line) {
  const lowered = line.toLowerCase();
  if (line.includes("✗") || lowered.includes("error") || lowered.includes("failed") || lowered.includes("timeout")) return "log-error";
  if (line.includes("⚠") || lowered.includes("warn")) return "log-warn";
  if (line.includes("✓") || lowered.includes("started")) return "log-ok";
  return "";
}

function renderLogLines(lines) {
  return lines
    .map((line) => `<span class="log-line ${classifyLogLine(line)}">${escapeHtml(line || " ")}</span>`)
    .join("");
}

async function loadLogs() {
  const output = $("log-output");
  const meta = $("log-meta");
  stopLogStream();
  output.textContent = "Loading logs...";
  try {
    const data = await api(`/api/logs/${state.logType}?lines=${state.logLines}`);
    const lines = data.lines || [];
    state.logText = lines.join("\n");
    output.innerHTML = lines.length ? renderLogLines(lines) : `<span class="log-line">No ${escapeHtml(state.logType)} logs found.</span>`;
    meta.innerHTML = `${escapeHtml(text(data.source))} • ${lines.length} lines • <span class="stream-live">streaming live</span> • emails and token-looking strings are masked`;
    scrollLogsToBottom();
    if (!state.streamPaused) startLogStream();
  } catch (error) {
    state.logText = "";
    output.textContent = `Failed to load logs: ${error.message}`;
    meta.textContent = "Log refresh failed.";
  }
}

function isNearLogBottom() {
  const output = $("log-output");
  return output.scrollHeight - output.scrollTop - output.clientHeight < 80;
}

function trimLogBuffer() {
  const output = $("log-output");
  while (output.children.length > state.maxLogBuffer) {
    output.removeChild(output.firstChild);
  }
  state.logText = Array.from(output.querySelectorAll(".log-line")).map((line) => line.textContent).join("\n");
}

function appendLogLine(line) {
  const output = $("log-output");
  const shouldStick = isNearLogBottom();
  output.insertAdjacentHTML("beforeend", renderLogLines([line]));
  trimLogBuffer();
  if (shouldStick) scrollLogsToBottom();
}

function scrollLogsToBottom() {
  const output = $("log-output");
  output.scrollTop = output.scrollHeight;
}

function stopLogStream() {
  if (state.logSource) {
    state.logSource.close();
    state.logSource = null;
  }
}

function startLogStream() {
  stopLogStream();
  const source = new EventSource(`/api/logs/${state.logType}/stream`);
  state.logSource = source;
  source.addEventListener("line", (event) => {
    const payload = JSON.parse(event.data);
    appendLogLine(payload.line || "");
  });
  source.addEventListener("meta", (event) => {
    const payload = JSON.parse(event.data);
    $("log-meta").innerHTML = `${escapeHtml(payload.source)} • <span class="stream-live">streaming live</span> • emails and token-looking strings are masked`;
  });
  source.onerror = () => {
    $("log-meta").innerHTML = `<span class="stream-paused">stream reconnecting</span>`;
  };
}

async function runControl(action, confirmText) {
  showError(null);
  if (confirmText && !window.confirm(confirmText)) return;
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
  $("page-subtitle").textContent = pageCopy[page] || "";
  if (page === "logs") loadLogs();
  else stopLogStream();
}

document.querySelectorAll(".nav-button").forEach((button) => {
  button.addEventListener("click", () => switchPage(button.dataset.page));
});

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => runControl(button.dataset.action, button.dataset.confirm));
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.logType = tab.dataset.log;
    document.querySelectorAll(".tab").forEach((el) => el.classList.toggle("active", el === tab));
    loadLogs();
  });
});

$("recent-failures").addEventListener("click", (event) => {
  const card = event.target.closest(".failure-card");
  if (card) toggleFailureContext(card);
});

$("log-lines").addEventListener("change", (event) => {
  state.logLines = Number(event.target.value);
  loadLogs();
});

$("stream-toggle").addEventListener("click", () => {
  state.streamPaused = !state.streamPaused;
  $("stream-toggle").textContent = state.streamPaused ? "Resume Stream" : "Pause Stream";
  if (state.streamPaused) {
    stopLogStream();
    $("log-meta").innerHTML = `<span class="stream-paused">stream paused</span>`;
  } else {
    startLogStream();
  }
});

$("jump-latest").addEventListener("click", scrollLogsToBottom);

$("copy-logs").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.logText || "");
    $("log-meta").textContent = "Logs copied to clipboard.";
  } catch {
    $("log-meta").textContent = "Clipboard copy is unavailable in this browser.";
  }
});

$("refresh-button").addEventListener("click", loadStatus);
$("refresh-logs").addEventListener("click", loadLogs);

$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const settings = Object.fromEntries(form.entries());
  $("save-settings").disabled = true;
  $("settings-feedback").textContent = "Saving settings...";
  try {
    const result = await api("/api/settings", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    });
    $("settings-feedback").textContent = `Saved ${result.updated.length} setting(s). Restart required: ${result.restart_required.join(", ") || "none"}.`;
    await loadStatus();
  } catch (error) {
    $("settings-feedback").textContent = `Save failed: ${error.message}`;
  } finally {
    $("save-settings").disabled = false;
  }
});

$("restart-proxy-after-save").addEventListener("click", () => runControl("proxy/restart", "Restart the proxy so saved settings take effect?"));

loadStatus();
setInterval(loadStatus, 30000);
