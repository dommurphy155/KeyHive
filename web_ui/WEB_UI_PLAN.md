# Web UI Integration

## Folders

- `front_end/`: static browser UI for status, logs, run stats, key stats, and service controls.
- `back_end/`: FastAPI app that serves the frontend and exposes same-origin `/api/*` endpoints.

## Integration Points

- `bin/keyhive` for existing scanner/proxy control commands.
- `scripts/run_stats.py` and `data/run_stats.json` for run counters.
- `logs/keyhive-scanner.log` and `journalctl` for scanner logs.
- Proxy HTTP endpoints such as `/health` and `/stats`.
- Systemd units: `api-maker-scheduler.service` and `keyhive-proxy.service`.
- Web systemd unit: `keyhive-web.service`.

## Ports

- Web UI and API: `0.0.0.0:8080`
- Existing local proxy: `127.0.0.1:8787`

The Web UI uses same-origin API calls, so there is no browser-side CORS dependency.

## API Endpoints

- `GET /api/status`
- `GET /api/scanner/status`
- `GET /api/proxy/status`
- `GET /api/proxy/stats`
- `GET /api/proxy/fallback`
- `GET /api/logs/scanner`
- `GET /api/logs/proxy`
- `GET /api/keys/stats`
- `GET /api/runs/stats`
- `GET /api/settings`
- `POST /api/scanner/start`
- `POST /api/scanner/stop`
- `POST /api/scanner/restart`
- `POST /api/proxy/start`
- `POST /api/proxy/stop`
- `POST /api/proxy/restart`

## Pages

- Dashboard
- Scanner
- Proxy
- Logs
- Stats
- Settings

## Not Yet / Safety

- No auth yet. This must not be exposed long-term without authentication and firewalling.
- No manual one-off scanner run button yet; the existing manual run drives browser automation and is not a good unauthenticated web action.
- No live log streaming; the current UI uses refreshable recent-log reads.

## Install Notes

- `setup/install.sh` installs Python requirements used by the Web UI backend.
- `setup/installer.py` prepares Web UI folders, runtime paths, default `KEYHIVE_WEB_*` env values, and installs `keyhive-web.service` with the scanner/proxy units.
- The frontend is static HTML/CSS/JS, so there is no frontend `npm install` step unless a future frontend package is added.
