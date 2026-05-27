import json
import os
import sys
import time
import subprocess
import platform
import ctypes
from datetime import datetime
from pathlib import Path

import requests
import MetaTrader5 as mt5
from dotenv import load_dotenv


load_dotenv()

API_BASE = os.getenv("API_BASE", "https://pipzo-trades-manager.vercel.app/api").rstrip("/")
EA_API_SECRET = os.getenv("EA_API_SECRET", "").strip()
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "3"))
MT5_START_WAIT_SECONDS = int(os.getenv("MT5_START_WAIT_SECONDS", "8"))
AUTO_RECONNECT = os.getenv("AUTO_RECONNECT", "true").lower() == "true"
RECONNECT_SECONDS = int(os.getenv("RECONNECT_SECONDS", "10"))

WORKER_ID = os.getenv("WORKER_ID", "VM-01")
BASE_MT5_EXE_NAME = "terminal64.exe"
AUTO_TRADING_CONFIG_NAME = "pipzo_autotrading.ini"
AUTO_TRADING_CONFIG_SECTIONS = {
    "Common": {
        "AutoTrading": "1",
        "EnableExperts": "1",
        "AllowLiveTrading": "1",
    },
    "Experts": {
        "AllowLiveTrading": "1",
        "AllowAlgoTrading": "1",
        "EnableExperts": "1",
        "DisableAlgoTradingByAccount": "0",
        "DisableAlgoTradingByProfile": "0",
        "DisableAlgoTradingBySymbol": "0",
    },
}

if len(sys.argv) < 2:
    raise RuntimeError("Usage: python account_worker.py account.json")

ACCOUNT_FILE = Path(sys.argv[1])


def log(message):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def load_account():
    return json.loads(ACCOUNT_FILE.read_text(encoding="utf-8"))


ACCOUNT = load_account()
ACCOUNT_ID = str(ACCOUNT.get("id") or "")
LICENSE_KEY = ACCOUNT["license_key"]
MT5_LOGIN = int(ACCOUNT["mt5_login"])
MT5_PASSWORD = ACCOUNT["mt5_password"]
MT5_SERVER = ACCOUNT["mt5_server"]
TERMINAL_DIR = Path(ACCOUNT["assigned_terminal_dir"])
MT5_PATH = str(TERMINAL_DIR / BASE_MT5_EXE_NAME)
MT5_PROCESS_PID = None


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


def update_account_status(status, error="", account_name="", broker=""):
    try:
        api_post("worker_update_account_status", {
            "license_key": LICENSE_KEY,
            "mt5_account_id": ACCOUNT_ID,
            "mt5_account": str(MT5_LOGIN),
            "connection_status": status,
            "last_error": error,
            "account_name": account_name,
            "broker": broker
        })
    except Exception as e:
        log(f"Could not update account status: {e}")


def heartbeat(status="running"):
    try:
        api_post("worker_heartbeat", {
            "license_key": LICENSE_KEY,
            "mt5_account_id": ACCOUNT_ID,
            "mt5_account": str(MT5_LOGIN),
            "worker_id": WORKER_ID,
            "worker_pid": os.getpid(),
            "connection_status": status
        })
    except Exception as e:
        log(f"Heartbeat failed: {e}")


def mt5_shutdown():
    try:
        mt5.shutdown()
    except Exception:
        pass



def _set_ini_value(lines, section, key, value):
    """Small INI updater that preserves existing MT5 config lines."""
    section_header = f"[{section}]"
    section_index = None

    for i, line in enumerate(lines):
        if line.strip().lower() == section_header.lower():
            section_index = i
            break

    if section_index is None:
        if lines and lines[-1].strip():
            lines.append("\n")
        lines.append(f"{section_header}\n")
        lines.append(f"{key}={value}\n")
        return lines

    insert_at = len(lines)
    key_index = None

    for i in range(section_index + 1, len(lines)):
        stripped = lines[i].strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            insert_at = i
            break
        if stripped.lower().startswith(f"{key.lower()}="):
            key_index = i
            break

    if key_index is not None:
        lines[key_index] = f"{key}={value}\n"
    else:
        lines.insert(insert_at, f"{key}={value}\n")

    return lines


def write_pipzo_autotrading_config():
    """
    Creates a custom MT5 startup config for this copied /portable terminal.

    MetaTrader 5 supports launching terminal64.exe with /config:<file> and /portable.
    The config is used to pre-load platform settings, including Expert Advisor / Algo Trading
    permissions, so a new terminal copied for a user does not need manual VM access.
    """
    config_path = TERMINAL_DIR / AUTO_TRADING_CONFIG_NAME

    lines = []
    common_candidates = [
        TERMINAL_DIR / "common.ini",
        TERMINAL_DIR / "config" / "common.ini",
        TERMINAL_DIR / "Config" / "common.ini",
    ]

    for candidate in common_candidates:
        if candidate.exists():
            try:
                lines = candidate.read_text(encoding="utf-16", errors="ignore").splitlines(True)
                break
            except Exception:
                try:
                    lines = candidate.read_text(encoding="utf-8", errors="ignore").splitlines(True)
                    break
                except Exception:
                    pass

    if not lines:
        lines = []

    # Login config helps the terminal open directly on the right account.
    login_settings = {
        "Login": str(MT5_LOGIN),
        "Password": str(MT5_PASSWORD),
        "Server": str(MT5_SERVER),
    }

    for section, values in {
        "Common": {**login_settings, **AUTO_TRADING_CONFIG_SECTIONS["Common"]},
        "Experts": AUTO_TRADING_CONFIG_SECTIONS["Experts"],
    }.items():
        for key, value in values.items():
            lines = _set_ini_value(lines, section, key, value)

    config_path.write_text("".join(lines), encoding="utf-8")
    log(f"MT5 auto-trading startup config prepared: {config_path}")
    return config_path


def patch_terminal_config_files():
    """
    Also patches common MT5 config locations inside the copied portable folder.
    This helps if a broker/build ignores some custom config values after first launch.
    """
    candidates = [
        TERMINAL_DIR / "common.ini",
        TERMINAL_DIR / "config" / "common.ini",
        TERMINAL_DIR / "Config" / "common.ini",
    ]

    for config_path in candidates:
        try:
            config_path.parent.mkdir(parents=True, exist_ok=True)

            if config_path.exists():
                try:
                    lines = config_path.read_text(encoding="utf-8", errors="ignore").splitlines(True)
                except Exception:
                    lines = config_path.read_text(encoding="utf-16", errors="ignore").splitlines(True)
            else:
                lines = []

            for section, values in AUTO_TRADING_CONFIG_SECTIONS.items():
                for key, value in values.items():
                    lines = _set_ini_value(lines, section, key, value)

            config_path.write_text("".join(lines), encoding="utf-8")
            log(f"Patched MT5 auto-trading config: {config_path}")
        except Exception as e:
            log(f"Could not patch MT5 config {config_path}: {e}")



def is_windows():
    return platform.system().lower() == "windows"


def find_windows_for_pid(pid):
    """Return visible top-level window handles owned by pid."""
    if not is_windows() or not pid:
        return []

    user32 = ctypes.windll.user32
    handles = []

    EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def callback(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True

        window_pid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(window_pid))

        if int(window_pid.value) == int(pid):
            handles.append(hwnd)

        return True

    user32.EnumWindows(EnumWindowsProc(callback), 0)
    return handles


def focus_window(hwnd):
    """Bring an MT5 window to foreground so Ctrl+E reaches the correct terminal."""
    if not is_windows() or not hwnd:
        return False

    user32 = ctypes.windll.user32
    SW_RESTORE = 9

    try:
        user32.ShowWindow(hwnd, SW_RESTORE)
        time.sleep(0.4)
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.4)
        return True
    except Exception as e:
        log(f"Could not focus MT5 window: {e}")
        return False


def send_ctrl_e_to_focused_window():
    """Sends Ctrl+E, the MT5 Algo Trading hotkey."""
    if not is_windows():
        log("Ctrl+E auto-trading toggle is only supported on Windows.")
        return False

    user32 = ctypes.windll.user32
    KEYEVENTF_KEYUP = 0x0002
    VK_CONTROL = 0x11
    VK_E = 0x45

    try:
        user32.keybd_event(VK_CONTROL, 0, 0, 0)
        time.sleep(0.05)
        user32.keybd_event(VK_E, 0, 0, 0)
        time.sleep(0.05)
        user32.keybd_event(VK_E, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.05)
        user32.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)
        return True
    except Exception as e:
        log(f"Failed sending Ctrl+E: {e}")
        return False


def press_ctrl_e_for_this_terminal():
    """
    Press Ctrl+E only on this account's MT5 process/window.
    This is the same as manually enabling the Algo Trading button in MT5.
    """
    if not is_windows():
        log("Cannot press Ctrl+E because this worker is not running on Windows.")
        return False

    handles = find_windows_for_pid(MT5_PROCESS_PID)

    if not handles:
        log(
            "Could not find visible MT5 window for this account process. "
            "Make sure the worker runs in a logged-in Windows desktop session, not as a hidden service."
        )
        return False

    hwnd = handles[0]

    if not focus_window(hwnd):
        return False

    ok = send_ctrl_e_to_focused_window()
    if ok:
        log("Pressed Ctrl+E on this MT5 terminal to enable Algo Trading.")
    return ok


def bool_from_any(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in ("1", "true", "yes", "on", "enable", "enabled")


def get_algo_trading_allowed():
    try:
        terminal_info = mt5.terminal_info()
        return getattr(terminal_info, "trade_allowed", None) if terminal_info else None
    except Exception:
        return None


def enable_algo_trading_if_needed(reason=""):
    """
    MT5's Auto/Algo Trading switch is the toolbar button toggled by Ctrl+E.
    Config files alone are not always enough for new copied terminals, so we verify
    terminal_info().trade_allowed and only press Ctrl+E when it is OFF.
    """
    try:
        terminal_info = mt5.terminal_info()
    except Exception:
        terminal_info = None

    current = getattr(terminal_info, "trade_allowed", None) if terminal_info else None

    if current is True:
        return True

    if current is None:
        log(
            "Could not read MT5 terminal trade_allowed state. "
            "Skipping Ctrl+E to avoid accidentally toggling Algo Trading off."
        )
        return False

    log(f"MT5 Algo Trading is OFF. Enabling with Ctrl+E. Reason: {reason}")

    if not press_ctrl_e_for_this_terminal():
        return False

    for _ in range(8):
        time.sleep(0.75)
        terminal_info = mt5.terminal_info()
        allowed = getattr(terminal_info, "trade_allowed", None) if terminal_info else None
        if allowed is True:
            log("MT5 Algo Trading is now ON.")
            return True

    terminal_info = mt5.terminal_info()
    allowed = getattr(terminal_info, "trade_allowed", None) if terminal_info else None
    log(f"MT5 Algo Trading still appears OFF after Ctrl+E. trade_allowed={allowed}")
    return False


def set_algo_trading_enabled(desired_enabled):
    desired_enabled = bool_from_any(desired_enabled)
    current = get_algo_trading_allowed()

    if current is desired_enabled:
        log(f"MT5 Algo Trading already {'ON' if desired_enabled else 'OFF'}.")
        return True

    if desired_enabled:
        return enable_algo_trading_if_needed("manual Mini App toggle")

    log("Turning MT5 Algo Trading OFF with Ctrl+E from Mini App request.")

    if not press_ctrl_e_for_this_terminal():
        return False

    for _ in range(8):
        time.sleep(0.75)
        current = get_algo_trading_allowed()
        if current is False:
            log("MT5 Algo Trading is now OFF.")
            return True

    current = get_algo_trading_allowed()
    log(f"MT5 Algo Trading OFF request could not be confirmed. trade_allowed={current}")
    return current is False


def launch_terminal_before_initialize():
    """
    Opens MT5 with /portable and our custom config before Python attaches/logs in.
    This makes the terminal open from Start without requiring manual VM access.
    """
    config_path = write_pipzo_autotrading_config()
    patch_terminal_config_files()

    try:
        global MT5_PROCESS_PID
        proc = subprocess.Popen(
            [MT5_PATH, "/portable", f"/config:{config_path}"],
            cwd=str(TERMINAL_DIR),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        MT5_PROCESS_PID = proc.pid
        log(f"MT5 terminal launched with Pipzo auto-trading config. pid={MT5_PROCESS_PID}")
        time.sleep(MT5_START_WAIT_SECONDS)
    except Exception as e:
        log(f"Could not pre-launch MT5 with config. Python initialize will still try. Error: {e}")

def initialize_mt5():
    if not Path(MT5_PATH).exists():
        err = f"MT5 terminal not found: {MT5_PATH}"
        update_account_status("failed", err)
        log(err)
        return False

    launch_terminal_before_initialize()

    log(f"Connecting account {MT5_LOGIN} using {MT5_PATH}")

    ok = mt5.initialize(
        path=MT5_PATH,
        login=MT5_LOGIN,
        password=MT5_PASSWORD,
        server=MT5_SERVER,
        portable=True
    )

    if not ok:
        err = str(mt5.last_error())
        update_account_status("failed", err)
        log(f"MT5 initialize failed: {err}")
        return False

    info = mt5.account_info()
    if info is None:
        err = f"account_info is None: {mt5.last_error()}"
        update_account_status("failed", err)
        log(err)
        return False

    if int(info.login) != MT5_LOGIN:
        err = f"Account mismatch. Expected {MT5_LOGIN}, got {info.login}"
        update_account_status("failed", err)
        log(err)
        return False

    terminal_info = mt5.terminal_info()
    terminal_trade_allowed = getattr(terminal_info, "trade_allowed", None) if terminal_info else None
    account_trade_allowed = getattr(info, "trade_allowed", None)

    if terminal_trade_allowed is False:
        enable_algo_trading_if_needed("initial MT5 connection")
        terminal_info = mt5.terminal_info()
        terminal_trade_allowed = getattr(terminal_info, "trade_allowed", None) if terminal_info else None

    if terminal_trade_allowed is False or account_trade_allowed is False:
        log(
            "WARNING: MT5 connected but trading permission is still false. "
            f"terminal_trade_allowed={terminal_trade_allowed}, account_trade_allowed={account_trade_allowed}. "
            "If account_trade_allowed is false, check broker/investor password/account permissions. "
            "If terminal_trade_allowed is false, the worker could not toggle Ctrl+E."
        )
    else:
        log(
            "Trading permission check passed. "
            f"terminal_trade_allowed={terminal_trade_allowed}, account_trade_allowed={account_trade_allowed}"
        )

    update_account_status("connected", "", str(info.name), str(info.company))
    heartbeat("connected")
    log(f"Connected {info.login} | {info.company} | Balance {info.balance}")
    return True


def connected():
    try:
        t = mt5.terminal_info()
        a = mt5.account_info()
        return bool(t and a and t.connected)
    except Exception:
        return False


def ensure_connected():
    if connected():
        return True
    if not AUTO_RECONNECT:
        return False
    log("Disconnected. Reconnecting...")
    mt5_shutdown()
    time.sleep(2)
    return initialize_mt5()


def account_type():
    info = mt5.account_info()
    if info is None:
        return "unknown"
    if info.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO:
        return "demo"
    if info.trade_mode == mt5.ACCOUNT_TRADE_MODE_REAL:
        return "real"
    return "unknown"


def positions():
    p = mt5.positions_get()
    return list(p or [])



def side_name(p):
    return "buy" if p.type == mt5.POSITION_TYPE_BUY else "sell"


def current_price_for_position(p):
    tick = mt5.symbol_info_tick(p.symbol)
    if tick is None:
        return None
    # For closing BUY positions, current close price is bid.
    # For closing SELL positions, current close price is ask.
    return float(tick.bid if p.type == mt5.POSITION_TYPE_BUY else tick.ask)


def distance_to_current_price(p):
    price = current_price_for_position(p)
    if price is None:
        return float("inf")
    return abs(float(p.price_open) - price)


def filter_positions(side=None, profit_mode=None):
    filtered = []
    for p in positions():
        if side and side_name(p) != str(side).lower():
            continue
        if profit_mode == "profit" and float(p.profit) <= 0:
            continue
        if profit_mode == "loss" and float(p.profit) >= 0:
            continue
        filtered.append(p)
    return filtered


def positions_closest_to_price(ps):
    return sorted(ps, key=distance_to_current_price)


def close_percent_of_positions(side, profit_mode, percent):
    ps = filter_positions(side=side, profit_mode=profit_mode)
    ps = positions_closest_to_price(ps)

    if not ps:
        return 0, 0, f"No {side.upper()} {profit_mode} trades found."

    percent = float(percent or 100)
    if percent >= 100:
        to_close = len(ps)
    else:
        # Close a percentage of number of trades, starting from trades closest to current price.
        import math
        to_close = max(1, int(math.ceil(len(ps) * (percent / 100.0))))

    selected = ps[:to_close]
    closed = 0
    failed = 0

    for p in selected:
        log(
            f"Side percent close | ticket={p.ticket} | side={side_name(p)} | "
            f"profit={p.profit} | distance={distance_to_current_price(p)} | percent={percent}"
        )
        if close_position(p):
            closed += 1
        else:
            failed += 1

    return closed, failed, f"Closed {closed}/{len(selected)} {side.upper()} {profit_mode} trades closest to current price. Failed: {failed}."


def breakeven_side(side):
    affected = 0
    total = 0
    for p in filter_positions(side=side):
        total += 1
        if breakeven(p):
            affected += 1
    return affected, total


def set_sltp_side(side, sl_points=0, tp_points=0):
    modified = 0
    total = 0
    for p in filter_positions(side=side):
        total += 1
        if set_sltp(p, sl_points, tp_points):
            modified += 1
    return modified, total


def set_sltp_side_price(side, sl_price=0, tp_price=0):
    modified = 0
    total = 0
    failed = 0
    for p in filter_positions(side=side):
        total += 1
        if set_sltp_price(p, sl_price, tp_price):
            modified += 1
        else:
            failed += 1
    return modified, total, failed


def send_status():
    if not ensure_connected():
        return
    info = mt5.account_info()
    if not info:
        return

    ps = positions()
    floating = sum(float(p.profit) for p in ps)

    terminal_info = mt5.terminal_info()
    algo_trading_allowed = getattr(terminal_info, "trade_allowed", None) if terminal_info else None
    account_trade_allowed = getattr(info, "trade_allowed", None)

    api_post("ea_update_status", {
        "license_key": LICENSE_KEY,
        "mt5_account": str(info.login),
        "broker": str(info.company),
        "server_name": str(info.server),
        "account_name": str(info.name),
        "account_type": account_type(),
        "balance": float(info.balance),
        "equity": float(info.equity),
        "margin": float(info.margin),
        "free_margin": float(info.margin_free),
        "floating_profit": floating,
        "open_trades": len(ps),
        "algo_trading_allowed": bool(algo_trading_allowed) if algo_trading_allowed is not None else None,
        "account_trade_allowed": bool(account_trade_allowed) if account_trade_allowed is not None else None,
    })

    heartbeat("connected")
    log(f"Status updated | {info.login} | Open {len(ps)}")


def poll_command():
    if not ensure_connected():
        return None
    info = mt5.account_info()
    data = api_post("ea_poll", {
        "license_key": LICENSE_KEY,
        "mt5_account": str(info.login) if info else ""
    })
    return data.get("command") if data.get("ok") else None


def update_command(command_id, status, result):
    api_post("ea_update_command", {
        "id": command_id,
        "status": status,
        "result": result
    })
    log(f"Command {status}: {result}")


def normalize_volume(symbol, volume):
    """
    Normalize requested volume to the broker's min/max/step.
    For close_half, 0.05 with step 0.01 becomes 0.02.
    """
    s = mt5.symbol_info(symbol)
    if s is None:
        log(f"symbol_info failed for {symbol}: {mt5.last_error()}")
        return 0.0

    volume = float(volume)
    volume_min = float(s.volume_min)
    volume_max = float(s.volume_max)
    volume_step = float(s.volume_step)

    if volume < volume_min:
        log(f"Volume {volume} is below minimum {volume_min} for {symbol}")
        return 0.0

    volume = min(volume, volume_max)

    # Floor to valid step to avoid asking for more than half.
    steps = int((volume + 1e-9) / volume_step)
    normalized = steps * volume_step

    # Use 2 decimals for normal FX/Gold lots, but keep 3 if broker needs it.
    normalized = round(normalized, 3)

    if normalized < volume_min:
        log(f"Normalized volume {normalized} is below minimum {volume_min} for {symbol}")
        return 0.0

    return normalized


def get_filling_modes(symbol):
    """
    Some brokers reject ORDER_FILLING_IOC. Try safe alternatives.
    This fixes commands reaching the worker but closing 0 trades because of filling mode errors.
    """
    info = mt5.symbol_info(symbol)
    modes = []

    if info is not None:
        filling_mode = getattr(info, "filling_mode", None)

        # If broker exposes a mode, try it first.
        if filling_mode in (
            mt5.ORDER_FILLING_FOK,
            mt5.ORDER_FILLING_IOC,
            mt5.ORDER_FILLING_RETURN,
        ):
            modes.append(filling_mode)

    # Fallback list. Duplicates are removed below.
    modes.extend([
        mt5.ORDER_FILLING_IOC,
        mt5.ORDER_FILLING_FOK,
        mt5.ORDER_FILLING_RETURN,
    ])

    unique = []
    for mode in modes:
        if mode not in unique:
            unique.append(mode)
    return unique


def close_position(p, volume=None):
    symbol = str(p.symbol)

    selected = mt5.symbol_select(symbol, True)
    if not selected:
        log(f"symbol_select failed for {symbol}: {mt5.last_error()}")
        return False

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        log(f"No tick for {symbol}: {mt5.last_error()}")
        return False

    vol = float(volume if volume is not None else p.volume)
    vol = normalize_volume(symbol, vol)

    if vol <= 0:
        log(f"Invalid close volume for ticket {p.ticket}: requested={volume}, position_volume={p.volume}")
        return False

    if p.type == mt5.POSITION_TYPE_BUY:
        order_type = mt5.ORDER_TYPE_SELL
        price = tick.bid
    else:
        order_type = mt5.ORDER_TYPE_BUY
        price = tick.ask

    base_req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": vol,
        "type": order_type,
        "position": int(p.ticket),
        "price": price,
        "deviation": 100,
        "magic": int(p.magic),
        "comment": "Pipzo close",
        "type_time": mt5.ORDER_TIME_GTC,
    }

    last_result = None

    for filling_mode in get_filling_modes(symbol):
        req = dict(base_req)
        req["type_filling"] = filling_mode

        result = mt5.order_send(req)
        last_result = result

        if result is None:
            log(f"order_send returned None for ticket {p.ticket}: {mt5.last_error()}")
            continue

        retcode = getattr(result, "retcode", None)
        comment = getattr(result, "comment", "")

        if retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_DONE_PARTIAL):
            log(f"Closed ticket {p.ticket} | symbol={symbol} | volume={vol} | retcode={retcode} | {comment}")
            return True

        log(
            f"Close failed ticket {p.ticket} | symbol={symbol} | volume={vol} | "
            f"filling={filling_mode} | retcode={retcode} | comment={comment} | last_error={mt5.last_error()}"
        )

    if last_result is None:
        log(f"Close failed ticket {p.ticket}: no MT5 result returned")
    return False

def modify_position(p, sl=None, tp=None):
    symbol = str(p.symbol)
    if not mt5.symbol_select(symbol, True):
        log(f"Modify failed ticket {p.ticket}: symbol_select failed for {symbol} | last_error={mt5.last_error()}")
        return False

    info = mt5.symbol_info(symbol)
    digits = int(getattr(info, "digits", 5) or 5) if info else 5

    next_sl = float(sl if sl is not None else p.sl or 0)
    next_tp = float(tp if tp is not None else p.tp or 0)

    if next_sl > 0:
        next_sl = round(next_sl, digits)
    if next_tp > 0:
        next_tp = round(next_tp, digits)

    req = {
        "action": mt5.TRADE_ACTION_SLTP,
        "symbol": symbol,
        "position": int(p.ticket),
        "sl": next_sl,
        "tp": next_tp,
        "magic": int(p.magic),
        "comment": "Pipzo master modify",
    }

    log(
        f"Modify request | ticket={p.ticket} | side={side_name(p)} | symbol={symbol} | "
        f"open={p.price_open} | old_sl={p.sl} | old_tp={p.tp} | new_sl={next_sl} | new_tp={next_tp}"
    )

    r = mt5.order_send(req)
    if r is None:
        log(f"Modify failed ticket {p.ticket}: order_send returned None | last_error={mt5.last_error()}")
        return False

    retcode = getattr(r, "retcode", None)
    comment = getattr(r, "comment", "")

    if retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_DONE_PARTIAL):
        log(f"Modify done ticket {p.ticket} | retcode={retcode} | comment={comment}")
        return True

    log(
        f"Modify failed ticket {p.ticket} | retcode={retcode} | comment={comment} | "
        f"request={req} | last_error={mt5.last_error()}"
    )
    return False


def set_sltp(p, sl_points=0, tp_points=0):
    s = mt5.symbol_info(p.symbol)
    if s is None:
        return False
    point = float(s.point)
    digits = int(s.digits)
    open_price = float(p.price_open)
    sl = float(p.sl or 0)
    tp = float(p.tp or 0)

    if p.type == mt5.POSITION_TYPE_BUY:
        if sl_points > 0:
            sl = round(open_price - sl_points * point, digits)
        if tp_points > 0:
            tp = round(open_price + tp_points * point, digits)
    else:
        if sl_points > 0:
            sl = round(open_price + sl_points * point, digits)
        if tp_points > 0:
            tp = round(open_price - tp_points * point, digits)

    return modify_position(p, sl, tp)


def set_sltp_price(p, sl_price=0, tp_price=0):
    sl = float(p.sl or 0)
    tp = float(p.tp or 0)

    if float(sl_price or 0) > 0:
        sl = float(sl_price)
    if float(tp_price or 0) > 0:
        tp = float(tp_price)

    return modify_position(p, sl, tp)


def breakeven(p):
    if float(p.profit) <= 0:
        return False
    s = mt5.symbol_info(p.symbol)
    if s is None:
        return False
    return modify_position(p, round(float(p.price_open), int(s.digits)), float(p.tp))


def execute_command(command):
    cmd = command.get("command")
    params = command.get("params") or {}

    if cmd not in ("refresh_status", "set_algo_trading"):
        if not enable_algo_trading_if_needed(f"before command {cmd}"):
            return False, "MT5 Algo Trading is OFF. Worker tried Ctrl+E but could not confirm it is ON. Keep the VM user logged in and run the worker in the desktop session."

    if cmd == "set_algo_trading":
        enabled = bool_from_any(params.get("enabled", True))
        ok = set_algo_trading_enabled(enabled)
        send_status()
        state = "ON" if enabled else "OFF"
        return ok, f"Algo Trading turned {state}." if ok else f"Could not turn Algo Trading {state}. Keep the VM user logged in and run the worker in the desktop session."

    ps = positions()

    if cmd == "refresh_status":
        send_status()
        return True, "Status refreshed."

    if cmd == "close_all":
        closed = 0
        total = 0
        for p in ps:
            total += float(p.profit)
            if close_position(p):
                closed += 1
        return True, f"Closed {closed} trades. Floating P/L: {total:.2f}"

    if cmd == "close_profit":
        closed = 0
        total = 0
        for p in ps:
            if float(p.profit) > 0:
                total += float(p.profit)
                if close_position(p):
                    closed += 1
        return True, f"Closed {closed} profitable trades. Profit: {total:.2f}"

    if cmd == "close_loss":
        closed = 0
        total = 0
        for p in ps:
            if float(p.profit) < 0:
                total += float(p.profit)
                if close_position(p):
                    closed += 1
        return True, f"Closed {closed} losing trades. P/L: {total:.2f}"

    if cmd == "close_less_profit":
        max_profit = float(params.get("max_profit", 0))
        closed = 0
        total = 0
        for p in ps:
            profit = float(p.profit)
            if 0 < profit <= max_profit:
                total += profit
                if close_position(p):
                    closed += 1
        return True, f"Closed {closed} trades with profit <= {max_profit:.2f}. Profit: {total:.2f}"

    if cmd == "close_half":
        side = str(params.get("side", "")).lower()
        affected = 0
        failed = 0

        close_ps = ps
        if side in ("buy", "sell"):
            close_ps = [p for p in ps if side_name(p) == side]

        if not close_ps:
            side_label = f" {side.upper()}" if side in ("buy", "sell") else ""
            return True, f"No open{side_label} trades found on this MT5 account."

        for p in close_ps:
            half_volume = float(p.volume) / 2
            vol = normalize_volume(p.symbol, half_volume)

            log(
                f"Close half check | ticket={p.ticket} | symbol={p.symbol} | "
                f"position_volume={p.volume} | requested_half={half_volume} | normalized={vol}"
            )

            if vol > 0 and close_position(p, vol):
                affected += 1
            else:
                failed += 1

        if affected == 0:
            return True, (
                f"Close half reached MT5 but closed 0 of {len(close_ps)} trades. "
                "Check worker log for MT5 retcode/filling-mode reason."
            )

        return True, f"Closed half volume on {affected} trades. Failed: {failed}."

    if cmd == "close_side_profit":
        side = str(params.get("side", "")).lower()
        percent = float(params.get("percent", 100))
        if side not in ("buy", "sell"):
            return False, "Invalid side. Use buy or sell."
        closed, failed, message = close_percent_of_positions(side, "profit", percent)
        return True, message

    if cmd == "breakeven_side":
        side = str(params.get("side", "")).lower()
        if side not in ("buy", "sell"):
            return False, "Invalid side. Use buy or sell."
        affected, total = breakeven_side(side)
        return True, f"Moved {affected}/{total} {side.upper()} trades to breakeven."

    if cmd == "modify_side":
        side = str(params.get("side", "")).lower()
        sl_price = float(params.get("sl_price", 0) or 0)
        tp_price = float(params.get("tp_price", 0) or 0)

        # Backward compatibility for older Mini App builds that sent points.
        sl_points = int(float(params.get("sl_points", 0) or 0))
        tp_points = int(float(params.get("tp_points", 0) or 0))

        if side not in ("buy", "sell"):
            return False, "Invalid side. Use buy or sell."

        if sl_price > 0 or tp_price > 0:
            modified, total, failed = set_sltp_side_price(side, sl_price=max(sl_price, 0), tp_price=max(tp_price, 0))
            changed = []
            if sl_price > 0:
                changed.append(f"SL price {sl_price}")
            if tp_price > 0:
                changed.append(f"TP price {tp_price}")
            changed_text = " and ".join(changed)
            return True, f"Modified {changed_text} on {modified}/{total} {side.upper()} trades. Failed: {failed}."

        if sl_points <= 0 and tp_points <= 0:
            return False, "Nothing to modify. Enter an SL price or TP price first."

        modified, total = set_sltp_side(side, sl_points=max(sl_points, 0), tp_points=max(tp_points, 0))
        changed = []
        if sl_points > 0:
            changed.append(f"SL {sl_points} points")
        if tp_points > 0:
            changed.append(f"TP {tp_points} points")
        changed_text = " and ".join(changed)
        return True, f"Modified {changed_text} on {modified}/{total} {side.upper()} trades."

    if cmd == "breakeven":
        affected = 0
        for p in ps:
            if breakeven(p):
                affected += 1
        return True, f"Moved SL to breakeven on {affected} trades."

    if cmd == "set_sl":
        modified = 0
        sl_points = int(params.get("sl_points", 0))
        for p in ps:
            if set_sltp(p, sl_points, 0):
                modified += 1
        return True, f"Set SL on {modified} trades."

    if cmd == "set_tp":
        modified = 0
        tp_points = int(params.get("tp_points", 0))
        for p in ps:
            if set_sltp(p, 0, tp_points):
                modified += 1
        return True, f"Set TP on {modified} trades."

    if cmd == "set_sltp":
        modified = 0
        sl_points = int(params.get("sl_points", 0))
        tp_points = int(params.get("tp_points", 0))
        for p in ps:
            if set_sltp(p, sl_points, tp_points):
                modified += 1
        return True, f"Modified SL/TP on {modified} trades."

    return False, f"Unknown command: {cmd}"


def main():
    log(f"Account worker starting for license {LICENSE_KEY[:8]}...")

    if not initialize_mt5():
        log("Initial login failed. Will retry if reconnect is enabled.")

    last_status = 0
    last_reconnect = 0

    while True:
        try:
            now = time.time()

            if not connected():
                update_account_status("failed", "MT5 disconnected")
                if AUTO_RECONNECT and now - last_reconnect >= RECONNECT_SECONDS:
                    last_reconnect = now
                    mt5_shutdown()
                    initialize_mt5()
                time.sleep(POLL_SECONDS)
                continue

            if now - last_status >= 5:
                send_status()
                last_status = now

            command = poll_command()
            if command:
                cid = command.get("id")
                cname = command.get("command")
                log(f"Received command: {cname}")
                try:
                    ok, result = execute_command(command)
                    update_command(cid, "executed" if ok else "failed", result)
                    send_status()
                except Exception as e:
                    update_command(cid, "failed", str(e))
                    log(f"Command failed: {e}")

            time.sleep(POLL_SECONDS)

        except KeyboardInterrupt:
            break
        except Exception as e:
            log(f"Worker error: {e}")
            time.sleep(POLL_SECONDS)

    mt5_shutdown()


if __name__ == "__main__":
    main()
