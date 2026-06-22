#!/usr/bin/env python3
"""
AgentMail API wrapper for temporary email management.
Usage:
  python3 burner_email.py create  -> Nukes all existing inboxes, creates fresh one, prints email.
  python3 burner_email.py check   -> Polls the last created inbox for the HF confirmation link.
  python3 burner_email.py burn    -> Deletes the inbox and clears state file.
"""

import asyncio
import re
import time
import os
import sys
import json
from typing import Optional

try:
    from dotenv import load_dotenv
except ImportError:
    print("Error: python-dotenv not installed. Run: pip install python-dotenv", file=sys.stderr)
    sys.exit(1)

try:
    import httpx
except ImportError:
    print("Error: httpx not installed. Run: pip install httpx", file=sys.stderr)
    sys.exit(1)

STATE_FILE = "/root/api_maker/data/.agentmail_state.json"
ENV_FILE = "/root/api_maker/.env"

class AgentMailManager:
    BASE = "https://api.agentmail.to/v0"

    def __init__(self, api_key: str):
        self.api_key = api_key
        self.active: list = []

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}"}

    async def list_inboxes(self) -> list:
        # The wrapper accepts both the raw list response and the older
        # {"inboxes": [...]} envelope because AgentMail has changed shapes before.
        try:
            async with httpx.AsyncClient() as client:
                r = await client.get(f"{self.BASE}/inboxes", headers=self._headers(), timeout=30)
                data = r.json()
                return data if isinstance(data, list) else data.get("inboxes", [])
        except Exception as e:
            print(f"[AgentMail] list_inboxes error: {e}", file=sys.stderr)
            return []

    async def nuke_all(self):
        # The temporary inboxes are disposable, so wipe them before creating a
        # fresh one to reduce cross-run confusion and quota noise.
        try:
            async with httpx.AsyncClient() as client:
                inboxes = await self.list_inboxes()
                for inbox in inboxes:
                    iid = inbox.get("inbox_id") or inbox.get("id")
                    if iid:
                        await client.delete(f"{self.BASE}/inboxes/{iid}", headers=self._headers(), timeout=30)
                print(f"[AgentMail] Nuked {len(inboxes)} inbox(es)", file=sys.stderr)
        except Exception as e:
            print(f"[AgentMail] Nuke warning: {e}", file=sys.stderr)
        self.active = []

    async def create_inbox(self) -> dict:
        # Retry a few times because the upstream API occasionally refuses a
        # fresh inbox until older ones have been cleared out.
        for attempt in range(6):
            try:
                async with httpx.AsyncClient() as client:
                    r = await client.post(f"{self.BASE}/inboxes", headers=self._headers(), timeout=30)
                    r.raise_for_status()
                    data = r.json()
                    self.active.append(data)
                    return data
            except Exception as e:
                print(f"[AgentMail] create_inbox attempt {attempt+1} failed: {e}", file=sys.stderr)
                if "403" in str(e) or "Forbidden" in str(e):
                    print("[AgentMail] 403 hit — nuking all inboxes and waiting 10s…", file=sys.stderr)
                    await self.nuke_all()
                    await asyncio.sleep(10)
                else:
                    await asyncio.sleep(5)
        raise RuntimeError("AgentMail: could not create inbox after 6 attempts")

    async def get_confirmation_link(self, inbox_id: str, timeout: int = 150) -> Optional[str]:
        # Poll the inbox until the Hugging Face confirmation URL appears in the
        # message body, then return the link for the browser flow.
        start = time.time()
        async with httpx.AsyncClient() as client:
            while time.time() - start < timeout:
                try:
                    r = await client.get(f"{self.BASE}/inboxes/{inbox_id}/messages", headers=self._headers(), timeout=30)
                    data = r.json()
                    msgs = data if isinstance(data, list) else data.get("messages", [])
                    for msg in msgs:
                        msg_id = (msg.get("id") or msg.get("message_id") or msg.get("uid") or msg.get("messageId"))
                        if not msg_id:
                            continue

                        mr = await client.get(f"{self.BASE}/inboxes/{inbox_id}/messages/{msg_id}", headers=self._headers(), timeout=30)
                        body = mr.json().get("body", "") or mr.json().get("html", "") or str(mr.json())

                        m = re.search(r'https://huggingface\.co/email_confirmation/[a-zA-Z0-9]+', body)
                        if m:
                            return m.group()

                        m = re.search(r'https://huggingface\.co/[^\s"\'<>]+', body)
                        if m and re.search(r'confirm|verif', m.group(), re.I):
                            return m.group()
                except Exception:
                    pass
                await asyncio.sleep(6)
        return None

    async def delete_inbox(self, inbox_id: str):
        # Inbox cleanup is best-effort; if it fails, the state file still gets
        # removed so later runs do not keep chasing the stale inbox id.
        try:
            async with httpx.AsyncClient() as client:
                r = await client.delete(f"{self.BASE}/inboxes/{inbox_id}", headers=self._headers(), timeout=30)
                print(f"[AgentMail] Burned inbox {inbox_id} (status: {r.status_code})", file=sys.stderr)
        except Exception as e:
            print(f"[AgentMail] Burn error: {e}", file=sys.stderr)


async def cmd_create():
    # Create a fresh disposable inbox and store the inbox id so `check` and
    # `burn` know which mailbox to inspect or delete later.
    load_dotenv(ENV_FILE)
    api_key = os.getenv("AGENTMAIL_API_KEY")
    if not api_key:
        print("Error: AGENTMAIL_API_KEY not found in .env", file=sys.stderr)
        sys.exit(1)

    mgr = AgentMailManager(api_key)
    inboxes = await mgr.list_inboxes()
    print(f"[AgentMail] Found {len(inboxes)} existing inbox(es)", file=sys.stderr)

    # Nuke anything that exists before creating fresh.
    if len(inboxes) >= 1:
        print("[AgentMail] Nuking all existing inboxes before creating fresh...", file=sys.stderr)
        await mgr.nuke_all()
        await asyncio.sleep(2)

    inbox = await mgr.create_inbox()
    inbox_id = inbox.get("inbox_id") or inbox.get("id")

    # Try every plausible field name for the full address because AgentMail has
    # returned several response shapes over time.
    address = inbox.get("address") or inbox.get("email")
    if not address:
        local = (
            inbox.get("local_part")
            or inbox.get("username")
            or inbox.get("local")
            or inbox.get("name")
        )
        domain = inbox.get("domain") or "agentmail.to"
        if not local:
            print(f"[AgentMail] ERROR: Cannot find local part in response: {inbox}", file=sys.stderr)
            sys.exit(1)
        address = f"{local}@{domain}"

    with open(STATE_FILE, "w") as f:
        json.dump({"inbox_id": inbox_id, "address": address}, f)

    print(address)


async def cmd_check():
    # The state file is the only thing that ties this poll back to the inbox
    # created earlier in the run.
    if not os.path.exists(STATE_FILE):
        print("Error: No state file. Run 'create' first.", file=sys.stderr)
        sys.exit(1)

    with open(STATE_FILE) as f:
        state = json.load(f)

    inbox_id = state["inbox_id"]
    load_dotenv(ENV_FILE)
    api_key = os.getenv("AGENTMAIL_API_KEY")
    mgr = AgentMailManager(api_key)

    print(f"[AgentMail] Polling inbox {inbox_id} for confirmation link...", file=sys.stderr)
    link = await mgr.get_confirmation_link(inbox_id)
    if link:
        print(link)
    else:
        print("Error: Timed out waiting for confirmation link.", file=sys.stderr)
        sys.exit(1)


async def cmd_burn():
    """Delete the inbox after use and clean up state."""
    # Best-effort cleanup: delete the remote inbox if possible, then remove the
    # local state file so the next run starts clean.
    if not os.path.exists(STATE_FILE):
        print("[AgentMail] No state file to burn.", file=sys.stderr)
        return

    with open(STATE_FILE) as f:
        state = json.load(f)

    load_dotenv(ENV_FILE)
    api_key = os.getenv("AGENTMAIL_API_KEY")
    if not api_key:
        print("Error: AGENTMAIL_API_KEY not found in .env", file=sys.stderr)
        sys.exit(1)

    mgr = AgentMailManager(api_key)
    inbox_id = state.get("inbox_id")
    if inbox_id:
        await mgr.delete_inbox(inbox_id)

    try:
        os.remove(STATE_FILE)
        print("[AgentMail] State file removed.", file=sys.stderr)
    except Exception:
        pass


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: burner_email.py [create|check|burn]", file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "create":
        asyncio.run(cmd_create())
    elif cmd == "check":
        asyncio.run(cmd_check())
    elif cmd == "burn":
        asyncio.run(cmd_burn())
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)
