# Web UI Prep

## Folders

- `front_end/`: future browser UI for status, logs, run stats, key stats, and service controls.
- `back_end/`: future API layer that should wrap existing KeyHive CLI/service behavior without duplicating scanner logic.

## Integration Points

- `bin/keyhive` for existing scanner/proxy control commands.
- `scripts/run_stats.py` and `data/run_stats.json` for run counters.
- `logs/keyhive-scanner.log` and `journalctl` for scanner logs.
- Proxy HTTP endpoints such as `/health` and `/stats`.
- Systemd units: `api-maker-scheduler.service` and `keyhive-proxy.service`.

## Likely API Endpoints

- `GET /api/status`
- `GET /api/logs/scanner`
- `GET /api/logs/proxy`
- `GET /api/keys/stats`
- `GET /api/proxy/stats`
- `POST /api/scanner/start`
- `POST /api/scanner/stop`
- `POST /api/scanner/restart`
- `POST /api/proxy/start`
- `POST /api/proxy/stop`
- `POST /api/proxy/restart`

## Not Yet

- Do not build frontend pages yet.
- Do not implement backend endpoints yet.
- Do not change scanner/proxy runtime behavior for the UI until the actual design/build pass.
