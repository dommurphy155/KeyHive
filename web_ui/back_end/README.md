# KeyHive Web Backend

FastAPI app for the KeyHive Web UI. It serves the static frontend and exposes a small whitelisted API around existing KeyHive systemd services, runtime files, and proxy endpoints.

Implemented Web UI helpers include SSE log streams, recent failure log-context lookup, and whitelisted settings writes for safe proxy/model configuration. Secret values are reported only as configured/missing counts or states.

Run locally:

```bash
cd /root/api_maker
python3 -m uvicorn web_ui.back_end.app:app --host 0.0.0.0 --port 8080
```

The app intentionally does not return raw keys or secret values. It is currently unauthenticated and must not be exposed long-term without auth and firewalling.
