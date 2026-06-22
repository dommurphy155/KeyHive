#!/usr/bin/env python3
from __future__ import annotations

import getpass
import json
import os
import platform
import re
import shutil
import stat
import subprocess
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm, IntPrompt, Prompt
from rich.table import Table


PROJECT_DIR = Path(__file__).resolve().parents[1]
SETUP_DIR = PROJECT_DIR / "setup"
DATA_DIR = PROJECT_DIR / "data"
ENV_FILE = PROJECT_DIR / ".env"
VENV_DIR = PROJECT_DIR / ".venv"
SYSTEMD_DIR = PROJECT_DIR / "systemd"
WEB_UI_DIR = PROJECT_DIR / "web_ui"
WEB_FRONTEND_DIR = WEB_UI_DIR / "front_end"
WEB_BACKEND_DIR = WEB_UI_DIR / "back_end"
PACKAGE_JSON = PROJECT_DIR / "package.json"
KEYHIVE_BIN = PROJECT_DIR / "bin" / "keyhive"
GLOBAL_KEYHIVE = Path("/usr/local/bin/keyhive")

ANTHROPIC_KEY = "sk-ant-api03-R2D2C3POfakeDemoKeyOnlyDoNotUse1234567890abcdefABCDEFfakeKEYexample999999999999AA"
ENV_BLOCK_START = "# >>> keyhive proxy env >>>"
ENV_BLOCK_END = "# <<< keyhive proxy env <<<"

console = Console()


def run(cmd: list[str], *, cwd: Path = PROJECT_DIR, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, check=check, text=True)


def have(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def package_manager() -> str:
    for cmd in ("apt-get", "dnf", "yum", "pacman"):
        if have(cmd):
            return cmd
    return "unknown"


def chrome_status() -> str:
    for cmd in ("google-chrome-stable", "google-chrome", "chromium", "chromium-browser"):
        path = shutil.which(cmd)
        if path:
            return f"{cmd} ({path})"
    return "missing"


def mask(value: str) -> str:
    if len(value) <= 10:
        return value[:2] + "..." + value[-2:]
    return value[:6] + "..." + value[-4:]


def load_env() -> dict[str, str]:
    values: dict[str, str] = {}
    if not ENV_FILE.exists():
        return values
    for line in ENV_FILE.read_text().splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value
    return values


def set_env_values(values: dict[str, str]) -> None:
    existing = ENV_FILE.read_text().splitlines() if ENV_FILE.exists() else []
    remaining = dict(values)
    out: list[str] = []

    for line in existing:
        if "=" not in line or line.lstrip().startswith("#"):
            out.append(line)
            continue
        key = line.split("=", 1)[0]
        if key in remaining:
            out.append(f"{key}={remaining.pop(key)}")
        else:
            out.append(line)

    if remaining and out and out[-1] != "":
        out.append("")
    for key, value in remaining.items():
        out.append(f"{key}={value}")

    ENV_FILE.write_text("\n".join(out) + "\n")
    ENV_FILE.chmod(stat.S_IRUSR | stat.S_IWUSR)


def hidden_prompt(label: str) -> str:
    return getpass.getpass(f"{label}: ").strip()


def show_banner() -> None:
    console.print(
        Panel.fit(
            "[bold gold1]KeyHive[/bold gold1]\nAPI key automation + local AI proxy setup",
            border_style="gold1",
        )
    )


def check_environment() -> None:
    table = Table(title="Environment", show_header=True, header_style="bold cyan")
    table.add_column("Check", style="bold")
    table.add_column("Value")
    table.add_row("OS", f"{platform.system()} {platform.release()}")
    table.add_row("Package manager", package_manager())
    table.add_row("Python", platform.python_version())
    table.add_row("Node", shutil.which("node") or "missing")
    table.add_row("npm", shutil.which("npm") or "missing")
    table.add_row("Chrome/Chromium", chrome_status())
    table.add_row("systemd", shutil.which("systemctl") or "missing")
    table.add_row("Project root", str(PROJECT_DIR))
    table.add_row(".venv", str(VENV_DIR))
    console.print(table)


def ensure_runtime_files() -> None:
    console.print("[bold cyan]Runtime files[/bold cyan]")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (PROJECT_DIR / "logs").mkdir(parents=True, exist_ok=True)
    WEB_FRONTEND_DIR.mkdir(parents=True, exist_ok=True)
    WEB_BACKEND_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "keys.txt").touch(exist_ok=True)
    (DATA_DIR / "run_stats.lock").touch(exist_ok=True)
    if not (DATA_DIR / "hc_cookie.json").exists():
        (DATA_DIR / "hc_cookie.json").write_text("[]\n")
    ENV_FILE.touch(exist_ok=True)
    ENV_FILE.chmod(stat.S_IRUSR | stat.S_IWUSR)
    console.print("[green]Runtime files ready[/green]")


def ensure_package_json() -> None:
    if PACKAGE_JSON.exists():
        return
    PACKAGE_JSON.write_text(
        json.dumps(
            {
                "name": "api_maker",
                "private": True,
                "version": "0.1.0",
                "description": "KeyHive automation scripts for Hugging Face key generation.",
                "scripts": {
                    "check": "node --check scripts/hf_keys.js && node --check scripts/hc_cookie_refresh.js",
                    "run": "node scripts/hf_keys.js",
                },
                "dependencies": {"dotenv": "^16.4.7", "playwright": "^1.49.1"},
            },
            indent=2,
        )
        + "\n"
    )


def install_node_runtime() -> None:
    console.print("[bold cyan]Node runtime[/bold cyan]")
    if not have("node") or not have("npm"):
        console.print("[yellow]node/npm missing; install them before scanner automation.[/yellow]")
        return
    ensure_package_json()
    run(["npm", "install"], check=True)
    if have("npx"):
        run(["npx", "playwright", "install", "chromium"], check=False)
    console.print("[green]Node dependencies ready[/green]")


def install_web_ui_runtime() -> None:
    console.print("[bold cyan]Web UI runtime[/bold cyan]")
    WEB_FRONTEND_DIR.mkdir(parents=True, exist_ok=True)
    WEB_BACKEND_DIR.mkdir(parents=True, exist_ok=True)
    frontend_package = WEB_FRONTEND_DIR / "package.json"
    if frontend_package.exists() and have("npm"):
        run(["npm", "install"], cwd=WEB_FRONTEND_DIR, check=True)
        console.print("[green]Web frontend dependencies ready[/green]")
    else:
        console.print("[green]Web frontend is static; no npm install needed.[/green]")
    console.print("[green]Web backend uses existing Python requirements.[/green]")


def install_systemd_units() -> None:
    console.print("[bold cyan]Systemd services[/bold cyan]")
    if not have("systemctl") or not Path("/etc/systemd/system").exists():
        console.print("[yellow]systemd not available; skipping service install.[/yellow]")
        return
    if os.geteuid() != 0 and not have("sudo"):
        console.print("[yellow]Need root/sudo to install systemd units; skipping.[/yellow]")
        return

    prefix = [] if os.geteuid() == 0 else ["sudo"]
    for unit in ("api-maker-scheduler.service", "keyhive-proxy.service", "keyhive-web.service"):
        src = SYSTEMD_DIR / unit
        if src.exists():
            run(prefix + ["cp", str(src), f"/etc/systemd/system/{unit}"])
            console.print(f"[green]Installed {unit}[/green]")
    run(prefix + ["systemctl", "daemon-reload"], check=False)


def install_cli() -> None:
    KEYHIVE_BIN.chmod(KEYHIVE_BIN.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    if os.geteuid() == 0:
        if GLOBAL_KEYHIVE.exists() or GLOBAL_KEYHIVE.is_symlink():
            GLOBAL_KEYHIVE.unlink()
        GLOBAL_KEYHIVE.symlink_to(KEYHIVE_BIN)
        console.print(f"[green]Installed keyhive -> {GLOBAL_KEYHIVE}[/green]")
    elif have("sudo"):
        run(["sudo", "ln", "-sf", str(KEYHIVE_BIN), str(GLOBAL_KEYHIVE)], check=False)


def prompt_agentmail() -> None:
    console.print(Panel("AgentMail is used for burner inboxes and confirmation emails.\nGet a key from your AgentMail dashboard/account.\nThe key must start with: [bold]am_us[/bold]", border_style="cyan"))
    while True:
        key = hidden_prompt("Enter your AgentMail API key")
        if key and key.startswith("am_us"):
            set_env_values({"AGENTMAIL_API_KEY": key})
            console.print(f"[green]Saved AgentMail key:[/green] {mask(key)}")
            return
        console.print("[red]AgentMail key must not be empty and must start with am_us.[/red]")


def prompt_nvidia() -> None:
    console.print(Panel("NVIDIA API key is used as the free/slow fallback model provider while KeyHive builds Hugging Face keys.\nGo to NVIDIA Build, log in, and click Get API Key.\nThe key must start with: [bold]nvapi-[/bold]", border_style="cyan"))
    while True:
        key = hidden_prompt("Enter your NVIDIA API key")
        if key and key.startswith("nvapi-"):
            set_env_values({"NVDA_KEY": key})
            console.print(f"[green]Saved NVIDIA key:[/green] {mask(key)}")
            return
        console.print("[red]NVIDIA key must not be empty and must start with nvapi-.[/red]")


def read_existing_gmail() -> list[dict[str, str]]:
    raw = load_env().get("GMAIL_ACCOUNTS", "")
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    accounts: list[dict[str, str]] = []
    for item in data:
        if isinstance(item, dict) and item.get("email") and item.get("password"):
            accounts.append({"email": str(item["email"]), "password": str(item["password"])})
    return accounts


def collect_gmail_accounts() -> list[dict[str, str]]:
    count = IntPrompt.ask("How many Gmail accounts do you want to add?", default=1)
    accounts: list[dict[str, str]] = []
    for idx in range(1, count + 1):
        while True:
            email = Prompt.ask(f"Gmail email #{idx}").strip()
            if re.match(r"^[^@\s]+@gmail\.com$", email):
                break
            console.print("[red]Email must be a valid @gmail.com address.[/red]")
        while True:
            password = hidden_prompt(f"Gmail password #{idx}")
            if password:
                break
            console.print("[red]Password cannot be empty.[/red]")
        accounts.append({"email": email, "password": password})
    return accounts


def prompt_gmail() -> None:
    console.print(
        Panel(
            "[bold red]WARNING:[/bold red]\n"
            "Gmail 2FA must be OFF for this automation login flow to work unless the project is changed to use a saved browser profile/session.\n"
            "Use dedicated automation Gmail accounts only.\n"
            "Do not use your personal Gmail account.",
            border_style="red",
        )
    )
    existing = read_existing_gmail()
    if existing:
        choice = Prompt.ask(
            f"Existing Gmail accounts found ({len(existing)}). Keep, replace, or append?",
            choices=["keep", "replace", "append"],
            default="keep",
        )
        if choice == "keep":
            console.print("[green]Keeping existing Gmail accounts.[/green]")
            return
        new_accounts = collect_gmail_accounts()
        accounts = new_accounts if choice == "replace" else existing + new_accounts
    else:
        accounts = collect_gmail_accounts()
    set_env_values({"GMAIL_ACCOUNTS": json.dumps(accounts, separators=(",", ":"))})
    console.print(f"[green]Saved {len(accounts)} Gmail account(s).[/green]")


def configure_proxy_env_defaults() -> None:
    defaults = {
        "KEYHIVE_PROXY_HOST": "127.0.0.1",
        "KEYHIVE_PROXY_PORT": "8787",
        "KEYHIVE_KEYS_FILE": str(DATA_DIR / "keys.txt"),
        "KEYHIVE_PROXY_DEFAULT_PROVIDER": "hf",
        "KEYHIVE_PROXY_FALLBACK_PROVIDER": "nvidia",
        "KEYHIVE_PROXY_RELOAD_SECONDS": "5",
        "KEYHIVE_PROXY_MAX_KEY_FAILOVERS": "3",
        "KEYHIVE_FALLBACK_ENABLED": "1",
        "KEYHIVE_FALLBACK_PROVIDER": "nvidia",
        "KEYHIVE_FALLBACK_ENTER_AT": "0",
        "KEYHIVE_FALLBACK_EXIT_AT": "10",
        "KEYHIVE_HF_BASE_URL": "https://router.huggingface.co/v1",
        "KEYHIVE_NVIDIA_BASE_URL": "https://integrate.api.nvidia.com/v1/chat/completions",
        "KEYHIVE_PROXY_DEFAULT_MODEL": "zai-org/GLM-5.2",
        "KEYHIVE_PROXY_NVIDIA_MODEL": "moonshotai/kimi-k2.6",
        "KEYHIVE_WEB_HOST": "0.0.0.0",
        "KEYHIVE_WEB_PORT": "8080",
        "KEYHIVE_WEB_SERVICE": "keyhive-web.service",
    }
    env = load_env()
    set_env_values({key: env.get(key, value) for key, value in defaults.items()})


def shell_config_path() -> Path:
    shell = Path(os.environ.get("SHELL", "")).name
    home = Path.home()
    if shell == "zsh":
        return home / ".zshrc"
    if shell == "bash":
        return home / ".bashrc"
    return home / ".profile"


def configure_claude_env() -> None:
    target = shell_config_path()
    block = (
        f"{ENV_BLOCK_START}\n\n"
        "export ANTHROPIC_BASE_URL=http://127.0.0.1:8787\n"
        f"export ANTHROPIC_API_KEY={ANTHROPIC_KEY}\n\n"
        f"{ENV_BLOCK_END}"
    )
    text = target.read_text() if target.exists() else ""
    pattern = re.compile(rf"{re.escape(ENV_BLOCK_START)}.*?{re.escape(ENV_BLOCK_END)}", re.S)
    if pattern.search(text):
        text = pattern.sub(block, text)
    else:
        text = text.rstrip() + "\n\n" + block + "\n"
    target.write_text(text)
    console.print(f"[green]Claude proxy environment configured in {target}[/green]")
    console.print(f"Run now: [bold]source {target}[/bold]")


def install_claude_code() -> None:
    console.print("[bold cyan]Claude Code[/bold cyan]")
    if not have("claude"):
        console.print("[yellow]Claude Code not found; installing via claude.ai installer.[/yellow]")
        run(["bash", "-lc", "curl -fsSL https://claude.ai/install.sh | bash"], check=False)
    run(["bash", "-lc", "claude --version || true"], check=False)
    configure_claude_env()


def final_message() -> None:
    console.print(
        Panel(
            "[bold green]KeyHive setup complete.[/bold green]\n\n"
            "The scanner can now build Hugging Face keys in the background.\n"
            "The local proxy is configured at:\n\n"
            "[bold]http://127.0.0.1:8787[/bold]\n\n"
            "Claude Code has been configured to send requests to the local KeyHive proxy.\n"
            "For the first few hours, the proxy may use NVIDIA fallback models while KeyHive collects Hugging Face keys.\n"
            "Fallback mode can be slower depending on provider load. Once Hugging Face keys are available in data/keys.txt, the proxy can route through them automatically.\n\n"
            "[bold]Useful commands[/bold]\n"
            "keyhive start\n"
            "keyhive proxy start\n"
            "keyhive proxy test\n"
            "keyhive proxy stats\n"
            "keyhive web start\n"
            "keyhive web status\n"
            "keyhive logs -f\n"
            "keyhive proxy logs -f\n"
            "keyhive web logs",
            border_style="green",
        )
    )


def main() -> None:
    show_banner()
    check_environment()
    ensure_runtime_files()
    install_node_runtime()
    install_web_ui_runtime()
    install_cli()
    install_systemd_units()
    prompt_agentmail()
    prompt_nvidia()
    prompt_gmail()
    configure_proxy_env_defaults()
    install_claude_code()
    final_message()


if __name__ == "__main__":
    main()
