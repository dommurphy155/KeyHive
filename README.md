![KeyHive Header](assets/header.png)

# KeyHive

KeyHive is the working name for this `api_maker` repo. It is a local operator stack for collecting Hugging Face API tokens, storing them in a plain local key pool, and serving those keys through a local OpenAI/Anthropic-compatible proxy with optional NVIDIA fallback.

The repo is not a generic SaaS product. It is a Linux-first automation bundle: Bash installer, Python services, Node browser automation, systemd units, static Web UI, and local runtime state. Treat it like operator tooling, not a polished appliance.

## What It Does

- Runs a scanner that creates Hugging Face accounts/tokens through browser automation.
- Uses AgentMail for temporary inbox creation and Hugging Face confirmation email polling.
- Uses Gmail-backed hCaptcha accessibility cookies and saved Chrome profiles for the CAPTCHA path.
- Saves generated Hugging Face tokens to `data/keys.txt`.
- Runs a local proxy on `127.0.0.1:8787` by default.
- Routes proxy requests through Hugging Face tokens and can fall back to NVIDIA when no usable HF keys are available.
- Provides a static FastAPI Web UI for status, logs, settings, and scanner/proxy controls.
- Provides a `keyhive` CLI wrapper for common scanner, proxy, web, logs, diagnostics, and reporting tasks.

## Repository Structure

```text
api_maker/
├── assets/
│   └── header.png
├── bin/
│   └── keyhive                    # operator CLI wrapper
├── data/
│   └── .gitkeep                   # runtime files are ignored
├── proxy/
│   ├── keyhive_proxy.py            # FastAPI proxy entrypoint
│   ├── key_store.py                # HF token pool loading/removal/cooldown
│   ├── hf_client.py                # Hugging Face router client
│   ├── openai_compat.py            # OpenAI/Anthropic response shaping
│   └── fallback/
│       ├── manager.py              # fallback provider switching logic
│       └── nvidia_client.py        # NVIDIA fallback client
├── scripts/
│   ├── hf_keys.js                  # main HF account/token creation flow
│   ├── hc_cookie_refresh.js         # hCaptcha cookie refresh flow
│   ├── browser_strength.js          # prepares Gmail/browser profiles
│   ├── add_captcha_account.js       # manually add an hCaptcha browser profile
│   ├── burner_email.py              # AgentMail inbox create/check/burn helper
│   ├── scheduler.py                 # repeated scanner runner
│   ├── run_stats.py                 # scanner run counters
│   └── count_keys.py                # key count/value estimate report
├── setup/
│   ├── install.sh                  # bootstrap shell installer
│   ├── installer.py                # interactive Rich installer
│   └── requirements.txt            # Python dependencies
├── systemd/
│   ├── api-maker-scheduler.service
│   ├── keyhive-proxy.service
│   └── keyhive-web.service
├── web_ui/
│   ├── back_end/                   # FastAPI app and service facade
│   └── front_end/                  # static HTML/CSS/JS dashboard
├── package.json                    # Node deps and checks
├── package-lock.json
└── README.md
```

## Main Files

| Path | Purpose |
| --- | --- |
| `bin/keyhive` | Main CLI. Resolves the checkout path, wraps systemd, manual scanner runs, logs, status, proxy checks, web checks, diagnostics, and reports. |
| `setup/install.sh` | Creates `.venv`, installs Python requirements, optionally fills Debian-like package gaps, then launches `setup/installer.py`. |
| `setup/installer.py` | Interactive installer. Creates runtime folders/files, installs Node deps, installs CLI/systemd units where possible, prompts for secrets, writes `.env`, and configures Claude Code proxy env. |
| `scripts/hf_keys.js` | Main scanner flow: refresh/check hCaptcha cookies, create AgentMail inbox, sign up to Hugging Face, confirm email, create/write token. |
| `scripts/hc_cookie_refresh.js` | Refreshes `data/hc_cookie.json` from ready browser profiles and `GMAIL_ACCOUNTS`. |
| `scripts/browser_strength.js` | Logs Gmail accounts into Chrome profiles and writes readiness metadata under `data/browser_strength/`. |
| `scripts/add_captcha_account.js` | Opens a visible Chrome session so an operator can manually prepare an hCaptcha accessibility profile. |
| `scripts/scheduler.py` | Runs `hf_keys.js` 10 times per 90-minute cycle, once every 9 minutes. |
| `proxy/keyhive_proxy.py` | Local FastAPI proxy with `/health`, `/stats`, `/v1/models`, `/v1/chat/completions`, and `/v1/messages`. |
| `web_ui/back_end/app.py` | FastAPI Web UI backend and static frontend server. |
| `web_ui/back_end/services/keyhive_service.py` | Web UI facade around systemd, logs, settings, runtime files, and proxy stats. |

## Dependencies

Runtime assumptions are intentionally Linux-heavy:

- Linux with Bash.
- Python 3 with `venv`/`pip`.
- Node.js and npm.
- Google Chrome Stable available as `google-chrome-stable` for visible browser/profile flows.
- systemd for background scanner/proxy/web services.
- A display at `:1` for the browser automation paths that hard-code it.
- AgentMail API key for burner inboxes.
- NVIDIA API key if you want fallback provider routing.
- Dedicated Gmail or compatible browser profiles for hCaptcha accessibility cookies.

Python packages from `setup/requirements.txt`:

- `httpx`
- `python-dotenv`
- `fastapi`
- `uvicorn[standard]`
- `rich`

Node packages from `package.json`:

- `dotenv`
- `playwright`
- `patchright`

Useful checks:

```bash
npm run check
.venv/bin/python -m pytest scripts/test_fallback_state.py scripts/test_tool_compat.py  # if pytest is installed
```

## Install

From the project root:

```bash
cd /path/to/api_maker
chmod +x setup/install.sh
./setup/install.sh
```

The installer:

- creates `.venv`;
- installs Python requirements;
- installs base Debian packages when `apt-get` is available and packages are missing;
- installs Node dependencies with `npm install`;
- runs `npx playwright install chromium` when `npx` exists;
- creates `data/`, `logs/`, `profiles/google/`, and `profiles/microsoft/`;
- creates `data/keys.txt`, `data/run_stats.lock`, and `data/hc_cookie.json` if missing;
- installs `/usr/local/bin/keyhive` as a symlink to `bin/keyhive`;
- installs scanner/proxy/web systemd units when systemd and permissions allow;
- prompts for AgentMail, NVIDIA, and Gmail accounts;
- writes `.env` with `0600` permissions;
- writes local Claude Code proxy variables into the current shell startup file.

Manual install shape:

```bash
cd /path/to/api_maker
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r setup/requirements.txt
npm install
npx playwright install chromium
chmod +x bin/keyhive
sudo ln -sf "$PWD/bin/keyhive" /usr/local/bin/keyhive
```

## Environment

Create `.env` in the project root. The installer is the safer path because it preserves unrelated keys and sets file mode `0600`.

Required or commonly used values:

| Variable | Required | Default | Used by |
| --- | --- | --- | --- |
| `AGENTMAIL_API_KEY` | Yes | none | `scripts/burner_email.py` |
| `GMAIL_ACCOUNTS` | For automated profile prep | none | `browser_strength.js`, `hc_cookie_refresh.js` |
| `NVDA_KEY` | For NVIDIA fallback | none | `proxy/fallback/nvidia_client.py` |
| `KEYHIVE_KEYS_FILE` | No | `<project>/data/keys.txt` | proxy |
| `KEYHIVE_PROXY_HOST` | No | `127.0.0.1` | proxy |
| `KEYHIVE_PROXY_PORT` | No | `8787` | proxy |
| `KEYHIVE_PROXY_DEFAULT_PROVIDER` | No | `hf` | proxy/settings |
| `KEYHIVE_PROXY_FALLBACK_PROVIDER` | No | `nvidia` | proxy/settings |
| `KEYHIVE_PROXY_RELOAD_SECONDS` | No | `5` | proxy key reload loop |
| `KEYHIVE_PROXY_REQUEST_TIMEOUT` | No | `300` | proxy upstream requests |
| `KEYHIVE_PROXY_MAX_RETRIES` | No | `2` | proxy upstream retries |
| `KEYHIVE_PROXY_MAX_KEY_FAILOVERS` | No | `3` | per-request key failover cap |
| `KEYHIVE_PROXY_DEBUG` | No | `0` | proxy logging |
| `KEYHIVE_FALLBACK_ENABLED` | No | `1` | fallback manager |
| `KEYHIVE_FALLBACK_PROVIDER` | No | `nvidia` | fallback manager |
| `KEYHIVE_FALLBACK_ENTER_AT` | No | `0` | switch to fallback at/below this usable HF key count |
| `KEYHIVE_FALLBACK_EXIT_AT` | No | `10` | switch back to HF at/above this usable HF key count |
| `KEYHIVE_HF_BASE_URL` | No | `https://router.huggingface.co/v1` | HF client |
| `KEYHIVE_NVIDIA_BASE_URL` | No | `https://integrate.api.nvidia.com/v1/chat/completions` | NVIDIA client |
| `KEYHIVE_PROXY_DEFAULT_MODEL` | No | `zai-org/GLM-5.2` | proxy |
| `KEYHIVE_PROXY_NVIDIA_MODEL` | No | `moonshotai/kimi-k2.6` | NVIDIA fallback |
| `KEYHIVE_SERVICE` | No | `api-maker-scheduler.service` | CLI/Web UI |
| `KEYHIVE_PROXY_SERVICE` | No | `keyhive-proxy.service` | CLI/Web UI |
| `KEYHIVE_WEB_SERVICE` | No | `keyhive-web.service` | CLI |
| `KEYHIVE_PROXY_URL` | No | `http://127.0.0.1:8787` | CLI/Web UI |
| `KEYHIVE_WEB_URL` | No | `http://127.0.0.1:8080` | CLI |
| `KEYHIVE_WEB_HOST` | No | `0.0.0.0` | Web UI |
| `KEYHIVE_WEB_PORT` | No | `8080` | Web UI |
| `KEYHIVE_WEB_PASSWORD` | No | none | login check only |
| `KEYHIVE_WEB_AUTH_TOKEN` | No | none | login check only |
| `BROWSER_STRENGTH_CDP_PORT` | No | `9333` | `browser_strength.js` |
| `DEBUG` | No | empty | Node script verbose logs |

Example shape:

```bash
AGENTMAIL_API_KEY=am_us_your_key_here
NVDA_KEY=nvapi-your_key_here
GMAIL_ACCOUNTS=[{"email":"person@gmail.com","password":"password-or-app-secret"}]
KEYHIVE_PROXY_HOST=127.0.0.1
KEYHIVE_PROXY_PORT=8787
```

Do not commit `.env`. It contains live credentials.

## Setup Flow

1. Run `./setup/install.sh`.
2. Provide the AgentMail API key.
3. Provide the NVIDIA key if using fallback.
4. Add Gmail accounts when prompted, or prepare browser profiles manually.
5. Start the proxy:

```bash
keyhive proxy start
keyhive proxy status
keyhive proxy test
```

6. Prepare browser strength profiles if the cookie refresh flow needs them:

```bash
node scripts/browser_strength.js
```

7. Start the scanner:

```bash
keyhive start
keyhive logs -f
```

8. Start the Web UI if you need the dashboard:

```bash
keyhive web start
keyhive web status
```

## `keyhive` CLI

Run `keyhive` with no arguments to open the interactive SSH-friendly menu.

Scanner commands:

| Command | What it does |
| --- | --- |
| `keyhive start` | Start `api-maker-scheduler.service` or `KEYHIVE_SERVICE`. |
| `keyhive stop` | Stop the scanner service. |
| `keyhive restart` | Reset since-restart stats and restart the scanner service. |
| `keyhive status` | Show scanner service state, key count, cookie age, and run stats. |
| `keyhive logs` | Show recent scanner journal logs. |
| `keyhive logs -f` | Follow scanner logs. |
| `keyhive logs 200` | Show last 200 scanner log lines. |
| `keyhive runs=1` | Run `scripts/hf_keys.js` once outside systemd. |
| `keyhive runs 3` | Run `scripts/hf_keys.js` three times outside systemd. |
| `keyhive report` | Run `scripts/count_keys.py`. |

Proxy commands:

| Command | What it does |
| --- | --- |
| `keyhive proxy start` | Start `keyhive-proxy.service` or `KEYHIVE_PROXY_SERVICE`. |
| `keyhive proxy stop` | Stop the proxy service. |
| `keyhive proxy restart` | Restart the proxy service. |
| `keyhive proxy status` | Show systemd state plus `/health`. |
| `keyhive proxy logs` | Show recent proxy journal logs. |
| `keyhive proxy logs -f` | Follow proxy logs. |
| `keyhive proxy stats` | Fetch `/stats`. |
| `keyhive proxy fallback` | Show current fallback/provider status from `/stats`. |
| `keyhive proxy test` | Send a small local chat completion request. |

Web commands:

| Command | What it does |
| --- | --- |
| `keyhive web start` | Start `keyhive-web.service` or `KEYHIVE_WEB_SERVICE`. |
| `keyhive web stop` | Stop the Web UI service. |
| `keyhive web restart` | Restart the Web UI service. |
| `keyhive web status` | Show systemd state plus `/api/status`. |
| `keyhive web logs` | Show recent Web UI journal logs. |

Other commands:

| Command | What it does |
| --- | --- |
| `keyhive doctor` | Check env, dependencies, runtime files, services, proxy, and Claude config. |
| `keyhive tree` | Print a stripped-down repo layout. |
| `keyhive help` | Print CLI help. |

## Scanner

The scanner is `scripts/hf_keys.js`. Its rough flow is:

1. Read `data/hc_cookie.json`.
2. Refresh cookies with `scripts/hc_cookie_refresh.js` when missing, stale, unreadable, or expired.
3. Create a burner inbox with `scripts/burner_email.py create`.
4. Use Patchright/Chromium to run the Hugging Face signup flow.
5. Poll AgentMail for the confirmation link.
6. Create a Hugging Face token.
7. Append the token to `data/keys.txt`.
8. Burn the temporary inbox.

Manual run:

```bash
keyhive runs=1
DEBUG=1 keyhive runs=1
```

Direct run:

```bash
node scripts/hf_keys.js
```

The scheduler runs `hf_keys.js` 10 times per 90-minute cycle, one run every 9 minutes:

```bash
python3 scripts/scheduler.py
```

Under systemd, scanner output is also appended to:

```text
logs/keyhive-scanner.log
```

## Proxy

The proxy is `proxy/keyhive_proxy.py`, served by FastAPI/Uvicorn.

Default base URL:

```text
http://127.0.0.1:8787
```

Endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Basic proxy health and current provider. |
| `GET /stats` | Key pool stats, provider/fallback status, model/config values. |
| `GET /v1/models` | OpenAI-style model list with the configured default model. |
| `POST /v1/chat/completions` | OpenAI-compatible chat completions. Supports streaming. |
| `POST /v1/messages` | Anthropic-shaped messages route for Claude Code compatibility. |

Example:

```bash
curl -sS http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "Say hello from KeyHive."}],
    "max_tokens": 64,
    "stream": false
  }' | python3 -m json.tool
```

The proxy:

- reads tokens from `data/keys.txt`;
- deduplicates tokens on load;
- round-robins usable keys;
- cools keys down on `429`;
- removes keys from `data/keys.txt` on upstream `401`, `403`, or exhausted-credit `402`;
- switches to NVIDIA fallback when fallback is enabled, `NVDA_KEY` is available, and usable HF keys are at/below `KEYHIVE_FALLBACK_ENTER_AT`;
- switches back to HF when usable HF keys reach `KEYHIVE_FALLBACK_EXIT_AT`.

Do not bind this proxy publicly unless you add real auth and firewalling. Local-only is the sane default.

## Web UI

The Web UI is `web_ui/back_end/app.py` plus static files in `web_ui/front_end/`.

Default URL:

```text
http://SERVER_IP:8080
```

Manual run:

```bash
cd /path/to/api_maker
.venv/bin/python -m uvicorn web_ui.back_end.app:app --host 0.0.0.0 --port 8080
```

Useful API checks:

```bash
curl http://127.0.0.1:8080/api/auth/config
curl http://127.0.0.1:8080/api/status
curl http://127.0.0.1:8080/api/scanner/status
curl http://127.0.0.1:8080/api/proxy/status
curl http://127.0.0.1:8080/api/proxy/stats
curl http://127.0.0.1:8080/api/proxy/fallback
curl http://127.0.0.1:8080/api/keys/stats
curl http://127.0.0.1:8080/api/runs/stats
curl http://127.0.0.1:8080/api/logs/scanner
curl http://127.0.0.1:8080/api/logs/proxy
curl http://127.0.0.1:8080/api/failures/recent
curl http://127.0.0.1:8080/api/settings
```

Important: the login route validates `KEYHIVE_WEB_PASSWORD` or `KEYHIVE_WEB_AUTH_TOKEN`, but route protection is not wired up. The API reports `protects_ui: false`. Do not expose this UI to the internet and pretend a login page is security. That is how dashboards become incident reports.

## Systemd

Unit files live in `systemd/`.

| Unit | Purpose |
| --- | --- |
| `api-maker-scheduler.service` | Runs `scripts/scheduler.py` and tees output to `logs/keyhive-scanner.log`. |
| `keyhive-proxy.service` | Runs `python -m proxy.keyhive_proxy`. |
| `keyhive-web.service` | Runs `uvicorn web_ui.back_end.app:app`. |

The files in this directory are templates with `@PROJECT_DIR@`, `@PYTHON_BIN@`, and `@VENV_BIN@` placeholders. The installer renders them into absolute-path service files under `/etc/systemd/system`, which is what systemd requires.

Install/reload through the installer. Copying these templates directly will not work:

```bash
./setup/install.sh
```

Start services:

```bash
keyhive start
keyhive proxy start
keyhive web start
```

Logs:

```bash
journalctl -u api-maker-scheduler.service -b -f -o cat
journalctl -u keyhive-proxy.service -b -f -o cat
journalctl -u keyhive-web.service -b -f -o cat
```

The installer performs this rendering and reloads systemd when permissions allow.

## Logs

| Location | Purpose |
| --- | --- |
| `logs/keyhive-scanner.log` | Flat scanner log written by the scheduler service. |
| `logs/chrome-9333.log` | Chrome logs from profile/cookie flows. |
| `journalctl -u api-maker-scheduler.service` | Scanner service journal. |
| `journalctl -u keyhive-proxy.service` | Proxy journal. |
| `journalctl -u keyhive-web.service` | Web UI journal. |
| `logs/fail_hf_flow.png` | Scanner failure screenshot path used by `hf_keys.js`. |

The Web UI masks common email and Hugging Face token patterns before returning log lines to the browser. That is a safety net, not permission to dump secrets into logs.

## Data

Runtime data is local and ignored by Git.

| Path | Purpose | Sensitive |
| --- | --- | --- |
| `data/keys.txt` | Generated Hugging Face tokens; proxy key pool. | Yes |
| `data/hc_cookie.json` | hCaptcha accessibility cookies. | Yes |
| `data/run_stats.json` | Scanner run counters and failure buckets. | No secrets expected |
| `data/run_stats.lock` | File lock for stats writes. | No |
| `data/.agentmail_state.json` | Current AgentMail inbox id/address. | Potentially |
| `data/.last_key_count` | Previous key count used by reports. | No |
| `data/browser_strength/` | Browser profile readiness metadata, storage state, cookies. | Yes |

## Profiles

Browser profiles live under:

```text
profiles/google/
profiles/microsoft/
```

`browser_strength.js` creates Gmail-backed Chrome profiles and readiness metadata. `hc_cookie_refresh.js` reuses ready profiles and can also discover profile directories on disk.

Prepare profiles from `.env` Gmail accounts:

```bash
node scripts/browser_strength.js
```

Prepare one account:

```bash
node scripts/browser_strength.js --email person@gmail.com
```

Force re-check:

```bash
node scripts/browser_strength.js --force
```

Manually add an hCaptcha accessibility profile:

```bash
node scripts/add_captcha_account.js --email person@gmail.com
```

Profiles contain cookies, sessions, history, and browser state. They are ignored by Git for a reason. Do not ship them around like harmless config.

## Troubleshooting

| Problem | Check/Fix |
| --- | --- |
| `Missing AGENTMAIL_API_KEY in .env` | Re-run `./setup/install.sh` or add `AGENTMAIL_API_KEY=...` to `.env`. |
| `GMAIL_ACCOUNTS parse error` | `GMAIL_ACCOUNTS` must be valid JSON, not shell-ish almost-JSON. Use the installer if in doubt. |
| Gmail login stalls or asks for verification | Use dedicated accounts. The scripts pause for manual action; they do not bypass 2FA/CAPTCHA. |
| `google-chrome-stable` missing | Install Google Chrome Stable or update the scripts; several flows call it directly. |
| `CDP never came alive` | Check `DISPLAY`, Chrome install, port `9333`, and `logs/chrome-9333.log`. |
| `node not found` or `npm not found` | Install Node/npm, then run `npm install`. |
| `Cannot find module 'patchright'` | Run `npm install` from the project root. |
| Python imports missing | Run `.venv/bin/python -m pip install -r setup/requirements.txt`. |
| Scanner service missing | Install/copy the systemd unit, run `sudo systemctl daemon-reload`, then retry. |
| Scanner runs but no keys appear | Run `DEBUG=1 keyhive runs=1`, then inspect `logs/keyhive-scanner.log`, `logs/fail_hf_flow.png`, and browser/profile state. |
| Cookie keeps refreshing | Inspect `data/hc_cookie.json`, profile readiness under `data/browser_strength/`, and Gmail/hCaptcha availability. |
| Proxy returns `503 no usable keys` | `data/keys.txt` is empty, all keys are cooling down, or fallback is unavailable. |
| Proxy uses NVIDIA | Expected when usable HF keys are at/below the fallback enter threshold and `NVDA_KEY` is valid. |
| Proxy returns `504 upstream request timed out` | Upstream provider timed out; inspect proxy logs and `KEYHIVE_PROXY_REQUEST_TIMEOUT`. |
| Claude Code is not using the proxy | Source the shell file the installer edited, then check `ANTHROPIC_BASE_URL`. |
| Web UI login succeeds but UI is still public | Correct. Login validation exists, route protection does not. Firewall it. |

Diagnostics:

```bash
keyhive doctor
keyhive status
keyhive proxy status
keyhive proxy stats
keyhive proxy fallback
keyhive web status
```

## Uninstall / Reset

Stop services:

```bash
keyhive stop || true
keyhive proxy stop || true
keyhive web stop || true
```

Remove installed systemd units:

```bash
sudo rm -f /etc/systemd/system/api-maker-scheduler.service
sudo rm -f /etc/systemd/system/keyhive-proxy.service
sudo rm -f /etc/systemd/system/keyhive-web.service
sudo systemctl daemon-reload
```

Remove CLI symlink:

```bash
sudo rm -f /usr/local/bin/keyhive
```

Reset scanner/proxy runtime data, keeping dependencies:

```bash
rm -f data/keys.txt data/hc_cookie.json data/run_stats.json data/run_stats.lock
rm -f data/.agentmail_state.json data/.last_key_count
rm -rf data/browser_strength profiles logs
mkdir -p data logs profiles/google profiles/microsoft
touch data/keys.txt data/run_stats.lock
printf '[]\n' > data/hc_cookie.json
```

Full local cleanup:

```bash
rm -rf .venv node_modules data/browser_strength profiles logs
rm -f data/keys.txt data/hc_cookie.json data/run_stats.json data/run_stats.lock
rm -f data/.agentmail_state.json data/.last_key_count
```

If the installer configured Claude Code, remove the block between these markers in your shell startup file:

```text
# >>> keyhive proxy env >>>
# <<< keyhive proxy env <<<
```

Do not run reset commands casually on a machine holding useful keys or browser sessions. They delete local state.

## Safety Notes

- `.env`, `data/keys.txt`, `data/hc_cookie.json`, `data/browser_strength/`, and `profiles/` contain credential/session material.
- Keep `.env` at `0600`.
- Never commit runtime state, browser profiles, cookies, screenshots, or logs containing secrets.
- Use dedicated automation accounts. Do not use personal Gmail.
- The Web UI is not protected by real route auth yet.
- The proxy has no built-in client auth. Bind it to localhost unless you add proper controls.
- Provider terms, quotas, anti-abuse systems, and account rules still apply. Automation does not magically make them optional.
- If this host or repo runtime state leaks, rotate AgentMail/NVIDIA/Gmail/Hugging Face credentials immediately.
