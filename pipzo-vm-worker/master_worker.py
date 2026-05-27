import json
import os
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path

import requests
from dotenv import load_dotenv


load_dotenv()

API_BASE = os.getenv("API_BASE", "https://pipzo-trades-manager.vercel.app/api").rstrip("/")
EA_API_SECRET = os.getenv("EA_API_SECRET", "").strip()
WORKER_ID = os.getenv("WORKER_ID", "VM-01")
BASE_MT5_DIR = Path(os.getenv("BASE_MT5_DIR", r"C:\Program Files\MetaTrader 5"))
TERMINALS_ROOT = Path(os.getenv("TERMINALS_ROOT", r"C:\PipzoCloud\terminals"))
ACCOUNTS_ROOT = Path(os.getenv("ACCOUNTS_ROOT", r"C:\PipzoCloud\accounts"))
CHECK_SECONDS = int(os.getenv("CHECK_SECONDS", "10"))

running = {}


def log(message):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def api_post(endpoint, payload):
    url = f"{API_BASE}/{endpoint}"
    headers = {
        "Content-Type": "application/json",
        "X-EA-SECRET": EA_API_SECRET,
    }
    response = requests.post(url, headers=headers, json=payload, timeout=25)
    try:
        data = response.json()
    except Exception:
        raise RuntimeError(f"API did not return JSON. HTTP {response.status_code}: {response.text[:300]}")
    if not response.ok:
        raise RuntimeError(f"HTTP {response.status_code}: {data}")
    return data


def validate_config():
    if not EA_API_SECRET:
        raise RuntimeError("EA_API_SECRET missing in .env")
    if not BASE_MT5_DIR.exists():
        raise RuntimeError(f"BASE_MT5_DIR does not exist: {BASE_MT5_DIR}")
    if not (BASE_MT5_DIR / "terminal64.exe").exists():
        raise RuntimeError(f"terminal64.exe not found inside BASE_MT5_DIR: {BASE_MT5_DIR}")


def ensure_dirs():
    TERMINALS_ROOT.mkdir(parents=True, exist_ok=True)
    ACCOUNTS_ROOT.mkdir(parents=True, exist_ok=True)


def copy_terminal_for_account(mt5_login):
    target = TERMINALS_ROOT / str(mt5_login)

    if (target / "terminal64.exe").exists():
        return target

    log(f"Creating terminal folder for {mt5_login}: {target}")
    shutil.copytree(BASE_MT5_DIR, target, dirs_exist_ok=True)
    return target


def claim_next_account():
    try:
        data = api_post("worker_claim_next_account", {
            "worker_id": WORKER_ID,
            "base_terminal_dir": str(TERMINALS_ROOT)
        })
        return data.get("account")
    except Exception as e:
        msg = str(e)
        if "No pending MT5 account found" not in msg and "404" not in msg:
            log(f"Claim account error: {e}")
        return None


def start_account_worker(account):
    # In multi-account mode, one license can have many MT5 accounts.
    # So the running-process key must be the MT5 account id, not license_key.
    account_key = str(account.get("id") or account.get("mt5_login"))
    license_key = account["license_key"]
    mt5_login = str(account["mt5_login"])

    if account_key in running:
        proc = running[account_key]
        if proc.poll() is None:
            return
        else:
            log(f"Worker process ended for {mt5_login}. Restarting.")
            del running[account_key]

    terminal_dir = copy_terminal_for_account(mt5_login)
    account["assigned_terminal_dir"] = str(terminal_dir)

    account_file = ACCOUNTS_ROOT / f"{mt5_login}_{license_key.replace('-', '')}.json"
    account_file.write_text(json.dumps(account, indent=2), encoding="utf-8")

    env = os.environ.copy()
    env["API_BASE"] = API_BASE
    env["EA_API_SECRET"] = EA_API_SECRET
    env["WORKER_ID"] = WORKER_ID

    cmd = ["python", str(Path(__file__).parent / "account_worker.py"), str(account_file)]

    log(f"Starting account worker for MT5 {mt5_login}")
    proc = subprocess.Popen(cmd, env=env)
    running[account_key] = proc


def cleanup_dead_processes():
    dead = []
    for account_key, proc in running.items():
        if proc.poll() is not None:
            dead.append(account_key)

    for account_key in dead:
        log(f"Removing dead worker process for {account_key}")
        del running[account_key]


def main():
    validate_config()
    ensure_dirs()

    log("Pipzo Master Worker started.")
    log(f"WORKER_ID: {WORKER_ID}")
    log(f"BASE_MT5_DIR: {BASE_MT5_DIR}")
    log(f"TERMINALS_ROOT: {TERMINALS_ROOT}")

    while True:
        try:
            cleanup_dead_processes()

            # Claim only accounts that were manually started from the Mini App.
            # The API consumes the Start request after claim, so restarting this master worker
            # will not reopen every old MT5 terminal automatically.
            account = claim_next_account()
            if account:
                start_account_worker(account)

            time.sleep(CHECK_SECONDS)

        except KeyboardInterrupt:
            log("Master worker stopped.")
            break
        except Exception as e:
            log(f"Master worker error: {e}")
            time.sleep(CHECK_SECONDS)


if __name__ == "__main__":
    main()
