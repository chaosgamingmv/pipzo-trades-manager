import json
import os
import sys
import time
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


def initialize_mt5():
    if not Path(MT5_PATH).exists():
        err = f"MT5 terminal not found: {MT5_PATH}"
        update_account_status("failed", err)
        log(err)
        return False

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


def send_status():
    if not ensure_connected():
        return
    info = mt5.account_info()
    if not info:
        return

    ps = positions()
    floating = sum(float(p.profit) for p in ps)

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
    req = {
        "action": mt5.TRADE_ACTION_SLTP,
        "symbol": p.symbol,
        "position": p.ticket,
        "sl": float(sl if sl is not None else p.sl),
        "tp": float(tp if tp is not None else p.tp),
        "magic": int(p.magic),
        "comment": "Pipzo master modify",
    }
    r = mt5.order_send(req)
    return bool(r and r.retcode == mt5.TRADE_RETCODE_DONE)


def set_sltp(p, sl_points=0, tp_points=0):
    s = mt5.symbol_info(p.symbol)
    if s is None:
        return False
    point = float(s.point)
    digits = int(s.digits)
    open_price = float(p.price_open)
    sl = float(p.sl)
    tp = float(p.tp)

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
        sl_points = int(float(params.get("sl_points", 0) or 0))
        tp_points = int(float(params.get("tp_points", 0) or 0))

        if side not in ("buy", "sell"):
            return False, "Invalid side. Use buy or sell."

        if sl_points <= 0 and tp_points <= 0:
            return False, "Nothing to modify. Enter SL points or TP points greater than 0."

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
