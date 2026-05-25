import os
import time
from datetime import datetime

import requests
import MetaTrader5 as mt5
from dotenv import load_dotenv


load_dotenv()

API_BASE = os.getenv("API_BASE", "https://pipzo-trades-manager.vercel.app/api").rstrip("/")
LICENSE_KEY = os.getenv("LICENSE_KEY", "").strip()
EA_API_SECRET = os.getenv("EA_API_SECRET", "").strip()
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "3"))

MANAGE_CURRENT_SYMBOL_ONLY = os.getenv("MANAGE_CURRENT_SYMBOL_ONLY", "false").lower() == "true"
MANAGE_SYMBOL = os.getenv("MANAGE_SYMBOL", "").strip()
MAGIC_NUMBER_FILTER = int(os.getenv("MAGIC_NUMBER_FILTER", "-1"))


def log(message: str):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def api_post(endpoint: str, payload: dict) -> dict:
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


def worker_update_account_status(status: str, error: str = "", account_name: str = "", broker: str = ""):
    try:
        api_post("worker_update_account_status", {
            "license_key": LICENSE_KEY,
            "connection_status": status,
            "last_error": error,
            "account_name": account_name,
            "broker": broker
        })
    except Exception as e:
        log(f"Could not update account connection status: {e}")


def get_cloud_account():
    data = api_post("worker_get_account", {
        "license_key": LICENSE_KEY
    })

    if not data.get("ok"):
        raise RuntimeError(data.get("message", "Could not get MT5 account"))

    return data.get("account")


def initialize_mt5_with_cloud_account() -> bool:
    account = get_cloud_account()

    login = int(account["mt5_login"])
    password = account["mt5_password"]
    server = account["mt5_server"]

    log(f"Connecting MT5 account {login} on server {server}...")

    if mt5.initialize(login=login, password=password, server=server):
        info = mt5.account_info()
        if info:
            worker_update_account_status(
                "connected",
                "",
                str(info.name),
                str(info.company)
            )
            log(f"Connected: {info.login} | {info.company} | Balance: {info.balance}")
            return True

    err = str(mt5.last_error())
    worker_update_account_status("failed", err)
    log(f"MT5 login failed: {err}")
    return False


def get_account_type() -> str:
    account = mt5.account_info()
    if account is None:
        return "unknown"

    if account.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO:
        return "demo"
    if account.trade_mode == mt5.ACCOUNT_TRADE_MODE_REAL:
        return "real"
    return "unknown"


def should_manage_position(position) -> bool:
    if MANAGE_CURRENT_SYMBOL_ONLY:
        if not MANAGE_SYMBOL:
            return False
        if position.symbol != MANAGE_SYMBOL:
            return False

    if MAGIC_NUMBER_FILTER != -1 and position.magic != MAGIC_NUMBER_FILTER:
        return False

    return True


def get_positions():
    positions = mt5.positions_get()
    if positions is None:
        return []
    return [p for p in positions if should_manage_position(p)]


def send_status():
    account = mt5.account_info()
    if account is None:
        log("No MT5 account info.")
        return

    positions = get_positions()
    floating_profit = sum(float(p.profit) for p in positions)

    payload = {
        "license_key": LICENSE_KEY,
        "mt5_account": str(account.login),
        "broker": str(account.company),
        "server_name": str(account.server),
        "account_name": str(account.name),
        "account_type": get_account_type(),
        "balance": float(account.balance),
        "equity": float(account.equity),
        "margin": float(account.margin),
        "free_margin": float(account.margin_free),
        "floating_profit": floating_profit,
        "open_trades": len(positions),
    }

    data = api_post("ea_update_status", payload)
    if data.get("ok"):
        log(f"Status updated. Balance: {account.balance} | Equity: {account.equity} | Open trades: {len(positions)}")


def poll_command():
    account = mt5.account_info()
    mt5_account = str(account.login) if account else ""

    data = api_post("ea_poll", {
        "license_key": LICENSE_KEY,
        "mt5_account": mt5_account,
    })

    return data.get("command") if data.get("ok") else None


def update_command(command_id: str, status: str, result: str):
    data = api_post("ea_update_command", {
        "id": command_id,
        "status": status,
        "result": result,
    })

    if data.get("ok"):
        log(f"Command updated: {status} | {result}")


def normalize_volume(symbol: str, volume: float) -> float:
    symbol_info = mt5.symbol_info(symbol)
    if symbol_info is None:
        return 0.0

    min_lot = float(symbol_info.volume_min)
    max_lot = float(symbol_info.volume_max)
    step = float(symbol_info.volume_step)

    if volume < min_lot:
        return 0.0

    if volume > max_lot:
        volume = max_lot

    normalized = int(volume / step) * step
    return round(normalized, 3)


def close_position(position) -> bool:
    symbol = position.symbol
    ticket = position.ticket
    volume = float(position.volume)

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        log(f"No tick data for {symbol}")
        return False

    if position.type == mt5.POSITION_TYPE_BUY:
        order_type = mt5.ORDER_TYPE_SELL
        price = tick.bid
    else:
        order_type = mt5.ORDER_TYPE_BUY
        price = tick.ask

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": order_type,
        "position": ticket,
        "price": price,
        "deviation": 50,
        "magic": int(position.magic),
        "comment": "Pipzo cloud close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    if result is None:
        log(f"Close failed for {ticket}: order_send None | {mt5.last_error()}")
        return False

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        log(f"Close failed for {ticket}: retcode={result.retcode}, comment={result.comment}")
        return False

    return True


def close_partial(position, close_volume: float) -> bool:
    symbol = position.symbol
    ticket = position.ticket

    close_volume = normalize_volume(symbol, close_volume)

    if close_volume <= 0 or close_volume >= float(position.volume):
        log(f"Invalid partial volume for {ticket}: {close_volume}")
        return False

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        log(f"No tick data for {symbol}")
        return False

    if position.type == mt5.POSITION_TYPE_BUY:
        order_type = mt5.ORDER_TYPE_SELL
        price = tick.bid
    else:
        order_type = mt5.ORDER_TYPE_BUY
        price = tick.ask

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": float(close_volume),
        "type": order_type,
        "position": ticket,
        "price": price,
        "deviation": 50,
        "magic": int(position.magic),
        "comment": "Pipzo cloud partial",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    if result is None:
        log(f"Partial close failed for {ticket}: order_send None | {mt5.last_error()}")
        return False

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        log(f"Partial close failed for {ticket}: retcode={result.retcode}, comment={result.comment}")
        return False

    return True


def modify_position(position, sl=None, tp=None) -> bool:
    request = {
        "action": mt5.TRADE_ACTION_SLTP,
        "symbol": position.symbol,
        "position": position.ticket,
        "sl": float(sl if sl is not None else position.sl),
        "tp": float(tp if tp is not None else position.tp),
        "magic": int(position.magic),
        "comment": "Pipzo cloud modify",
    }

    result = mt5.order_send(request)
    if result is None:
        log(f"Modify failed for {position.ticket}: order_send None | {mt5.last_error()}")
        return False

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        log(f"Modify failed for {position.ticket}: retcode={result.retcode}, comment={result.comment}")
        return False

    return True


def set_sltp_for_position(position, sl_points: int = 0, tp_points: int = 0) -> bool:
    symbol_info = mt5.symbol_info(position.symbol)
    if symbol_info is None:
        return False

    point = float(symbol_info.point)
    digits = int(symbol_info.digits)
    open_price = float(position.price_open)

    sl = float(position.sl)
    tp = float(position.tp)

    if position.type == mt5.POSITION_TYPE_BUY:
        if sl_points > 0:
            sl = round(open_price - sl_points * point, digits)
        if tp_points > 0:
            tp = round(open_price + tp_points * point, digits)
    else:
        if sl_points > 0:
            sl = round(open_price + sl_points * point, digits)
        if tp_points > 0:
            tp = round(open_price - tp_points * point, digits)

    return modify_position(position, sl=sl, tp=tp)


def move_to_breakeven(position) -> bool:
    if float(position.profit) <= 0:
        return False

    symbol_info = mt5.symbol_info(position.symbol)
    if symbol_info is None:
        return False

    digits = int(symbol_info.digits)
    open_price = round(float(position.price_open), digits)

    return modify_position(position, sl=open_price, tp=float(position.tp))


def execute_command(command: dict) -> tuple[bool, str]:
    cmd = command.get("command")
    params = command.get("params") or {}
    positions = get_positions()

    if cmd == "refresh_status":
        send_status()
        return True, "Status refreshed."

    if cmd == "close_all":
        closed = 0
        total_profit = 0.0
        for p in positions:
            total_profit += float(p.profit)
            if close_position(p):
                closed += 1
        return True, f"Closed {closed} trades. Floating P/L: {total_profit:.2f}"

    if cmd == "close_profit":
        closed = 0
        total_profit = 0.0
        for p in positions:
            if float(p.profit) > 0:
                total_profit += float(p.profit)
                if close_position(p):
                    closed += 1
        return True, f"Closed {closed} profitable trades. Profit: {total_profit:.2f}"

    if cmd == "close_loss":
        closed = 0
        total_loss = 0.0
        for p in positions:
            if float(p.profit) < 0:
                total_loss += float(p.profit)
                if close_position(p):
                    closed += 1
        return True, f"Closed {closed} losing trades. P/L: {total_loss:.2f}"

    if cmd == "close_less_profit":
        max_profit = float(params.get("max_profit", 0))
        closed = 0
        total_profit = 0.0
        for p in positions:
            profit = float(p.profit)
            if 0 < profit <= max_profit:
                total_profit += profit
                if close_position(p):
                    closed += 1
        return True, f"Closed {closed} trades with profit <= {max_profit:.2f}. Profit: {total_profit:.2f}"

    if cmd == "close_half":
        affected = 0
        for p in positions:
            if close_partial(p, float(p.volume) / 2.0):
                affected += 1
        return True, f"Closed half volume on {affected} trades."

    if cmd == "breakeven":
        affected = 0
        for p in positions:
            if move_to_breakeven(p):
                affected += 1
        return True, f"Moved SL to breakeven on {affected} trades."

    if cmd == "set_sl":
        sl_points = int(params.get("sl_points", 0))
        modified = 0
        for p in positions:
            if set_sltp_for_position(p, sl_points=sl_points, tp_points=0):
                modified += 1
        return True, f"Set SL on {modified} trades."

    if cmd == "set_tp":
        tp_points = int(params.get("tp_points", 0))
        modified = 0
        for p in positions:
            if set_sltp_for_position(p, sl_points=0, tp_points=tp_points):
                modified += 1
        return True, f"Set TP on {modified} trades."

    if cmd == "set_sltp":
        sl_points = int(params.get("sl_points", 0))
        tp_points = int(params.get("tp_points", 0))
        modified = 0
        for p in positions:
            if set_sltp_for_position(p, sl_points=sl_points, tp_points=tp_points):
                modified += 1
        return True, f"Modified SL/TP on {modified} trades."

    return False, f"Unknown command: {cmd}"


def validate_config():
    if not LICENSE_KEY:
        raise RuntimeError("LICENSE_KEY is missing in .env. For now, put the activated license key here.")
    if not EA_API_SECRET:
        raise RuntimeError("EA_API_SECRET is missing in .env")
    if not API_BASE:
        raise RuntimeError("API_BASE is missing in .env")


def main():
    validate_config()

    log("Starting Pipzo Cloud Worker...")
    log(f"API_BASE: {API_BASE}")
    log(f"LICENSE_KEY: {LICENSE_KEY[:8]}...")

    if not initialize_mt5_with_cloud_account():
        return

    last_status = 0

    while True:
        try:
            now = time.time()

            if now - last_status >= 5:
                send_status()
                last_status = now

            command = poll_command()

            if command:
                command_id = command.get("id")
                command_name = command.get("command")

                log(f"Received command: {command_name}")

                try:
                    ok, result_text = execute_command(command)
                    update_command(command_id, "executed" if ok else "failed", result_text)
                    send_status()
                except Exception as e:
                    update_command(command_id, "failed", str(e))
                    log(f"Command failed: {e}")

            time.sleep(POLL_SECONDS)

        except KeyboardInterrupt:
            log("Worker stopped by user.")
            break

        except Exception as e:
            log(f"Worker error: {e}")
            time.sleep(POLL_SECONDS)

    mt5.shutdown()


if __name__ == "__main__":
    main()
