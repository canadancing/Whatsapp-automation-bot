# WhatsApp Daily Auto Message (Mac + Docker + launchd)

This project sends one WhatsApp group message per day using a linked WhatsApp account and a local Evolution API container.

## 1) Prerequisites

- macOS with Docker Desktop running
- Python 3.10+
- A dedicated WhatsApp account (already done)

## 2) Configure environment

```bash
cd /path/to/whatsapp-auto
cp .env.example .env
```

Edit `.env`:

- `EVOLUTION_API_KEY`: your API key
- `EVOLUTION_INSTANCE`: your instance name
- `WHATSAPP_GROUP_JID`: your target group JID (ends with `@g.us`)
- `MESSAGE_TEXT`: the daily message body

## 3) Start Evolution API

```bash
docker compose up -d
```

Then create/connect instance with your Evolution API flow and scan the QR code with the new WhatsApp account.

## 4) Install Python dependency

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 5) Validate with dry-run

```bash
source .venv/bin/activate
python scripts/send_daily_message.py --dry-run
```

## 6) Send once (manual test)

```bash
source .venv/bin/activate
python scripts/send_daily_message.py --force
```

Check logs:

```bash
tail -n 100 state/sender.log
```

## 7) Enable daily schedule (launchd)

Default schedule in plist template is 09:00 local time. To change it, edit:

- `launchd/com.antigravity.whatsapp-auto.plist`

Install:

```bash
source .venv/bin/activate
PYTHON_BIN="$(pwd)/.venv/bin/python" ./scripts/install_launchd.sh
```

Check loaded job:

```bash
launchctl list | rg com.antigravity.whatsapp-auto
```

## Notes

- Daily dedupe state is stored in `state/daily_send_state.json`.
- If the message already sent today, the script exits cleanly without duplicate send.
- Retries use exponential backoff.
- If your Evolution API endpoint differs, update `SEND_ENDPOINT_TEMPLATE` in `.env`.

## macOS one-shot automation (18:58 -> send at 19:00 -> exit)

If you do not want to keep a terminal open, use LaunchAgent:

```bash
cd /path/to/whatsapp-auto
./scripts/install_launch_agent.sh
```

What it does:
- Starts daily at **18:58** (local macOS time).
- Runs `backend/run_daily_once.js`.
- Waits until **19:00** (`DAILY_AUTOMATION_FIRE_TIME`, default `19:00`), sends alerts, then exits.
- Sends Telegram summary when runner starts/completes/fails.

Check status:

```bash
./scripts/launch_agent_status.sh
```

Remove job:

```bash
./scripts/uninstall_launch_agent.sh
```
