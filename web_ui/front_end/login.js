// Login page for the Web UI. It validates the configured secret locally, but
// the backend still needs real session protection before this is more than a
// polite speed bump.
const form = document.getElementById("login-form");
const secret = document.getElementById("secret");
const message = document.getElementById("login-message");

function setMessage(text, ok = false) {
  message.textContent = text;
  message.classList.toggle("ok", ok);
}

async function loadConfig() {
  // Tell the operator whether the login form is actually configured or just a
  // decorative password box.
  try {
    const response = await fetch("/api/auth/config");
    const data = await response.json();
    if (!data.configured) {
      setMessage("No KEYHIVE_WEB_PASSWORD or KEYHIVE_WEB_AUTH_TOKEN is configured yet.");
    }
  } catch {
    setMessage("Could not read auth configuration.");
  }
}

form.addEventListener("submit", async (event) => {
  // This only checks the configured secret. It does not secure the rest of the
  // dashboard yet, so the page is honest about that.
  event.preventDefault();
  setMessage("Checking...");
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ secret: secret.value }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      setMessage(data.detail || "Login failed.");
      return;
    }
    sessionStorage.setItem("keyhive_auth_checked", "true");
    setMessage("Login accepted. Route protection is not enabled yet.", true);
  } catch {
    setMessage("Login request failed.");
  }
});

loadConfig();
