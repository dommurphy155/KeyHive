# KeyHive Frontend

Static HTML/CSS/JS served by the FastAPI Web UI app on port `8080`.

Run through systemd:

```bash
cd /path/to/api_maker
keyhive web restart
```

Manual run:

```bash
cd /path/to/api_maker
python3 -m uvicorn web_ui.back_end.app:app --host 0.0.0.0 --port 8080
```

There is no frontend build step yet. The UI is intentionally dependency-free until the dashboard needs enough complexity to justify a frontend toolchain.

Current pages:

- Dashboard
- Scanner
- Proxy
- Logs with SSE live streaming, pause/resume, copy, and jump-to-latest
- Stats
- Settings with boxed sections and whitelisted editable proxy/model fields
- Login placeholder at `/login`

The Web UI is still unauthenticated. Do not expose it long-term without auth and firewalling.
