const form = document.getElementById("login-form");
const secret = document.getElementById("secret");
const message = document.getElementById("login-message");

function setMessage(text, ok = false) {
  message.textContent = text;
  message.classList.toggle("ok", ok);
}

async function loadConfig() {
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
