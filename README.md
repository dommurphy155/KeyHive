![KeyHive Header](assets/header.png)

# KeyHive

> A command-line automation stack for creating Hugging Face API keys with AgentMail burner inboxes, Gmail-backed hCaptcha cookies, Playwright browser automation, and a systemd-friendly scheduler.

![Shell](https://img.shields.io/badge/shell-bash-121820?style=for-the-badge&logo=gnubash)
![Python](https://img.shields.io/badge/python-3.x-121820?style=for-the-badge&logo=python)
![Node](https://img.shields.io/badge/node.js-required-121820?style=for-the-badge&logo=nodedotjs)
![Playwright](https://img.shields.io/badge/playwright-browser%20automation-121820?style=for-the-badge&logo=playwright)

KeyHive is the working name for this `api_maker` repo. It wires together a Bash installer, a `keyhive` CLI, Python AgentMail helpers, Node/Playwright browser automation, and a scheduler that repeatedly runs the key creation flow.

## Quick Links

| Need | Go here |
| --- | --- |
| Install everything | [Quick Setup](#quick-setup) |
| Configure secrets | [Environment Variables](#environment-variables) |
| Run one scan | [Commands / CLI Usage](#commands--cli-usage) |
| Run in the background | [Manual Setup](#manual-setup) |
| Fix common failures | [Troubleshooting](#troubleshooting) |
| Understand the moving parts | [How It Works](#how-it-works) |

## Features

- `keyhive` CLI for manual runs, scheduler control, logs, status, and reporting.
- AgentMail integration for temporary inbox creation and confirmation-link polling.
- Gmail account rotation for hCaptcha accessibility cookie refresh.
- Playwright-powered browser automation for Hugging Face account and token creation.
- Persistent output in `data/keys.txt`.
- Cookie cache at `data/hc_cookie.json`, refreshed when missing or stale.
- Python report script for counting saved keys and estimating rough token value.
- Systemd unit included for long-running scheduler deployments.
- Idempotent installer that preserves existing `.env` values and rewrites only the keys it owns.

## How It Works

1. `scripts/hf_keys.js` checks `data/hc_cookie.json`.
2. If the cookie is missing or older than 24 hours, it runs `scripts/hc_cookie_refresh.js`.
3. `hc_cookie_refresh.js` uses `GMAIL_ACCOUNTS` from `.env` to log into hCaptcha accessibility and save usable cookies.
4. `scripts/burner_email.py` creates an AgentMail inbox using `AGENTMAIL_API_KEY`.
5. The Playwright flow creates a Hugging Face account, confirms it through AgentMail, creates a write token, and appends the token to `data/keys.txt`.
6. `scripts/scheduler.py` runs `hf_keys.js` 10 times per 90-minute cycle, every 9 minutes.
7. `bin/keyhive` wraps the common commands so you do not have to remember script paths like some kind of cursed bash historian.

## Requirements

| Requirement | Why |
| --- | --- |
| Linux | Installer and service files target Linux paths and systemd-style deployments. |
| Bash | `setup/install.sh` and `bin/keyhive` are Bash scripts. |
| Python 3 + pip | AgentMail helper, scheduler, and reporting. |
| Node.js + npm | Playwright automation scripts. |
| Playwright | Browser control for hCaptcha and Hugging Face flows. |
| Google Chrome Stable | Current scripts call `google-chrome-stable` directly. |
| AgentMail API key | Burner inbox creation. |
| NVIDIA API key | Local proxy fallback while Hugging Face keys are being collected. |
| Gmail account credentials | hCaptcha accessibility login flow. |
| Claude Code | Optional local client configured by the installer. |

## Quick Setup

From the project root:

```bash
cd /root/api_maker
chmod +x setup/install.sh
./setup/install.sh
```

The installer will:

- create `.venv` and install Python requirements;
- show a guided Rich setup flow;
- check OS, package manager, Python, Node/npm, Chrome/Chromium, systemd, and project paths;
- create runtime files under `data/`;
- install Node dependencies and Playwright Chromium where available;
- install scanner/proxy systemd units where permissions allow;
- prompt for AgentMail, NVIDIA, and Gmail credentials in that order;
- save `.env` safely with `chmod 600`;
- configure Claude Code to use the local KeyHive proxy.

You need:

- AgentMail API key from your AgentMail dashboard/account, starting with `am_us`.
- NVIDIA API key from NVIDIA Build, starting with `nvapi-`.
- Dedicated Gmail automation accounts. Gmail 2FA must be off for the current login automation flow.

Then start the scanner and proxy:

```bash
keyhive start
keyhive proxy start
keyhive proxy test
```

## Manual Setup

Use this if you want to install things yourself or inspect each step.

```bash
cd ~/api_maker
mkdir -p data
touch data/keys.txt
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r setup/requirements.txt
```

If `package.json` already exists:

```bash
npm install
npx playwright install chromium
```

If `package.json` does not exist yet, install the actual Node packages used by the repo:

```bash
npm init -y
npm install dotenv playwright
npx playwright install chromium
```

Make the CLI executable:

```bash
chmod +x bin/keyhive
sudo ln -sf "$PWD/bin/keyhive" /usr/local/bin/keyhive
```

Optional systemd setup:

```bash
sudo cp systemd/api-maker-scheduler.service /etc/systemd/system/api-maker-scheduler.service
sudo systemctl daemon-reload
sudo systemctl enable api-maker-scheduler.service
sudo systemctl start api-maker-scheduler.service
```

## Environment Variables

Create `.env` in the project root. The installer does this interactively and safely.

| Variable | Required | Used by | Format |
| --- | --- | --- | --- |
| `AGENTMAIL_API_KEY` | Yes | `scripts/burner_email.py` | Must start with `am_us` |
| `NVDA_KEY` | Yes | Proxy fallback | Must start with `nvapi-` |
| `GMAIL_ACCOUNTS` | Yes | `scripts/hc_cookie_refresh.js` | Raw JSON array |
| `KEYHIVE_PROXY_HOST` | No | Proxy | Defaults to `127.0.0.1` |
| `KEYHIVE_PROXY_PORT` | No | Proxy | Defaults to `8787` |
| `KEYHIVE_PROXY_DEFAULT_PROVIDER` | No | Proxy | Defaults to `hf` |
| `KEYHIVE_PROXY_FALLBACK_PROVIDER` | No | Proxy | Defaults to `nvidia` |
| `KEYHIVE_FALLBACK_ENABLED` | No | Proxy fallback | Defaults to `1` |
| `KEYHIVE_FALLBACK_PROVIDER` | No | Proxy fallback | Defaults to `nvidia` |
| `KEYHIVE_FALLBACK_ENTER_AT` | No | Proxy fallback | Defaults to `0` |
| `KEYHIVE_FALLBACK_EXIT_AT` | No | Proxy fallback | Defaults to `10` |
| `KEYHIVE_HF_BASE_URL` | No | Proxy | Defaults to `https://router.huggingface.co/v1` |
| `KEYHIVE_NVIDIA_BASE_URL` | No | Proxy fallback | Defaults to `https://integrate.api.nvidia.com/v1/chat/completions` |
| `KEYHIVE_PROXY_DEFAULT_MODEL` | No | Proxy | Defaults to `zai-org/GLM-5.2` |
| `KEYHIVE_PROXY_NVIDIA_MODEL` | No | Proxy | Defaults to `moonshotai/kimi-k2.6` |
| `DEBUG` | No | Node scripts | Any non-empty value enables extra logs |
| `KEYHIVE_SERVICE` | No | `bin/keyhive` | Overrides `api-maker-scheduler.service` |

Example shape only:

```bash
AGENTMAIL_API_KEY=am_us_your_key_here
NVDA_KEY=nvapi-your_key_here
GMAIL_ACCOUNTS=[{"email":"person@gmail.com","password":"app-or-account-password"}]
```

Do not commit `.env`. It contains live credentials. The repo already ignores it.

## Commands / CLI Usage

```bash
keyhive help
```

| Command | What it does |
| --- | --- |
| `keyhive runs=1` | Run `scripts/hf_keys.js` once. |
| `keyhive runs 3` | Run `scripts/hf_keys.js` three times. |
| `keyhive start` | Start the systemd scheduler service. |
| `keyhive stop` | Stop the scheduler service. |
| `keyhive restart` | Restart the scheduler service. |
| `keyhive status` | Show service state, key count, and cookie age. |
| `keyhive logs` | Show recent service logs. |
| `keyhive logs -f` | Follow service logs. |
| `keyhive logs 200` | Show the last 200 service log lines. |
| `keyhive report` | Run `scripts/count_keys.py`. |
| `keyhive proxy start` | Start the local OpenAI-compatible proxy. |
| `keyhive proxy stop` | Stop the local proxy. |
| `keyhive proxy restart` | Restart the local proxy. |
| `keyhive proxy status` | Show systemd status and `/health`. |
| `keyhive proxy stats` | Show `/stats`. |
| `keyhive proxy test` | Send a tiny local chat completion request. |
| `keyhive tree` | Show a clean project tree without install/runtime noise. |

Direct script commands:

```bash
node scripts/hc_cookie_refresh.js
node scripts/hf_keys.js
.venv/bin/python scripts/burner_email.py create
.venv/bin/python scripts/burner_email.py check
.venv/bin/python scripts/burner_email.py burn
.venv/bin/python scripts/count_keys.py
```

Clean project structure:

```bash
keyhive tree
```

## KeyHive Proxy

KeyHive Proxy exposes a local AI API and forwards chat requests to Hugging Face using tokens from `data/keys.txt`. It binds to `127.0.0.1` by default, watches `data/keys.txt`, and reloads new scanner-generated keys without restarting. If Hugging Face keys are not ready and `NVDA_KEY` exists, it can fall back to NVIDIA.

Base URL:

```text
http://127.0.0.1:8787
```

Control it:

```bash
keyhive proxy start
keyhive proxy status
keyhive proxy fallback
keyhive proxy stats
keyhive proxy logs -f
keyhive proxy stop
```

OpenAI-compatible endpoint:

```text
POST /v1/chat/completions
```

Anthropic-compatible endpoint for Claude Code:

```text
POST /v1/messages
```

Non-streaming example:

```bash
curl -sS http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "Say hello from KeyHive proxy in one sentence."}],
    "max_tokens": 64,
    "stream": false
  }' | python3 -m json.tool
```

Streaming example:

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "Stream a short KeyHive greeting."}],
    "max_tokens": 64,
    "stream": true
  }'
```

Proxy environment defaults:

```bash
KEYHIVE_PROXY_HOST=127.0.0.1
KEYHIVE_PROXY_PORT=8787
KEYHIVE_KEYS_FILE=/root/api_maker/data/keys.txt
KEYHIVE_PROXY_DEFAULT_PROVIDER=hf
KEYHIVE_PROXY_FALLBACK_PROVIDER=nvidia
KEYHIVE_FALLBACK_ENABLED=1
KEYHIVE_FALLBACK_PROVIDER=nvidia
KEYHIVE_FALLBACK_ENTER_AT=0
KEYHIVE_FALLBACK_EXIT_AT=10
KEYHIVE_HF_BASE_URL=https://router.huggingface.co/v1
KEYHIVE_NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1/chat/completions
KEYHIVE_PROXY_DEFAULT_MODEL=zai-org/GLM-5.2
KEYHIVE_PROXY_NVIDIA_MODEL=moonshotai/kimi-k2.6
```

Do not bind this to `0.0.0.0` unless you add real auth and firewalling. Local-only is the sane default.

Claude Code shell config is managed by the installer:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=sk-ant-api03-R2D2C3POfakeDemoKeyOnlyDoNotUse1234567890abcdefABCDEFfakeKEYexample999999999999AA
```

## NVIDIA Fallback

KeyHive normally routes through Hugging Face keys from `data/keys.txt`. If there are `0` usable Hugging Face keys, the proxy can switch to NVIDIA fallback using `NVDA_KEY`. It switches back to Hugging Face only after the pool reaches `10` usable keys, which prevents provider flapping when only one or two keys appear.

```bash
keyhive proxy fallback
keyhive proxy stats
keyhive proxy logs -f
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `Missing AGENTMAIL_API_KEY in .env` | Re-run `./setup/install.sh` or add `AGENTMAIL_API_KEY=...` manually. |
| `GMAIL_ACCOUNTS parse error` | Your JSON is invalid. Re-run the installer; it writes JSON safely. |
| Gmail login fails | Gmail 2FA must be disabled for this automation path. That is ugly, but it is how this flow is currently built. |
| `google-chrome-stable` not found | Install Google Chrome Stable or update the scripts to launch Playwright's bundled Chromium. |
| `node not found` / `npm not found` | Install Node.js and npm, then run `npm install`. |
| `playwright` module missing | Run `npm install dotenv playwright`. |
| `python-dotenv` or `httpx` missing | Run `.venv/bin/python -m pip install -r setup/requirements.txt`. |
| Systemd commands fail | Copy the unit into `/etc/systemd/system/`, run `systemctl daemon-reload`, then retry. |
| Proxy returns `503 no usable keys` | `data/keys.txt` is empty, invalid, or all keys are cooling down. |
| Proxy falls back to NVIDIA | Expected while `data/keys.txt` is empty or all Hugging Face keys are cooling down. |
| Proxy returns `504 upstream request timed out` | Hugging Face did not answer within `KEYHIVE_PROXY_REQUEST_TIMEOUT`. |
| Claude Code does not use the proxy | Run `source ~/.bashrc`, `source ~/.zshrc`, or the file printed by the installer. |
| Cookie keeps refreshing | Check `data/hc_cookie.json` permissions and Gmail account availability. |
| No keys appear in `data/keys.txt` | Run `DEBUG=1 keyhive runs=1` and inspect screenshots/logs in `/root/fail_*.png` and `/root/chrome-*.log`. |

## Security Notes

- `.env` contains AgentMail and Gmail credentials; keep it at `chmod 600`.
- `data/keys.txt` contains generated Hugging Face tokens; treat it as secret material.
- The installer never prints API keys or Gmail passwords back to the terminal.
- Only automate accounts and services you are authorized to use. Provider terms and anti-abuse systems are not decorative wallpaper.
- Gmail 2FA being disabled is a real security downgrade. Use dedicated automation accounts, not personal inboxes.
- Rotate credentials immediately if this machine, `.env`, logs, screenshots, or runtime data are exposed.

## File Structure

```text
api_maker/
├── assets/
│   └── header.png
├── bin/
│   └── keyhive
├── data/
│   ├── .gitkeep
│   ├── hc_cookie.json        # runtime, ignored
│   └── keys.txt              # runtime, ignored
├── proxy/
│   ├── __init__.py
│   ├── hf_client.py
│   ├── key_store.py
│   ├── keyhive_proxy.py
│   └── openai_compat.py
├── scripts/
│   ├── burner_email.py
│   ├── count_keys.py
│   ├── hc_cookie_refresh.js
│   ├── hf_keys.js
│   └── scheduler.py
├── setup/
│   ├── install.sh
│   └── requirements.txt
├── systemd/
│   ├── api-maker-scheduler.service
│   └── keyhive-proxy.service
├── .env                      # local secrets, ignored
└── .gitignore
```

## Credits / Notes

- AgentMail handles temporary inbox creation and message polling.
- Playwright handles browser automation.
- Hugging Face token creation is performed through the browser flow in `scripts/hf_keys.js`.
- The project paths currently assume `/root/api_maker` in several scripts and the systemd unit. The installer resolves its own root dynamically, but the runtime scripts still use the existing absolute paths in places. That should be normalized if this repo needs to move between machines.
