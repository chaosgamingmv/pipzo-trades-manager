//+------------------------------------------------------------------+
//| Pipzo Vercel Telegram Mini App MT5 Trade Manager                  |
//| Uses Vercel Node.js API + Supabase backend.                       |
//+------------------------------------------------------------------+
#property strict
#include <Trade/Trade.mqh>

CTrade trade;

input string ApiBaseUrl = "https://pipzo-trades-manager.vercel.app/api";
input string LicenseKey = "PZ-XXXX-XXXXXX-XX";
input string EaApiSecret = "CHANGE_THIS_TO_A_LONG_RANDOM_SECRET";

input bool Manage_Current_Symbol_Only = false;
input int Magic_Number_Filter = -1; // -1 = all
input int Poll_Seconds = 3;

datetime lastPoll = 0;
datetime lastStatus = 0;

int OnInit()
{
   EventSetTimer(1);
   Print("Pipzo Vercel Trade Manager started.");
   Print("Allow WebRequest URL in MT5 settings: ", ApiBaseUrl);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTick(){}

void OnTimer()
{
   if(TimeCurrent() - lastStatus >= 5)
   {
      SendStatus();
      lastStatus = TimeCurrent();
   }

   if(TimeCurrent() - lastPoll >= Poll_Seconds)
   {
      PollCommand();
      lastPoll = TimeCurrent();
   }
}

bool HttpPost(string endpoint, string payload, string &response)
{
   string url = ApiBaseUrl + endpoint;
   string headers =
      "Content-Type: application/json\r\n" +
      "X-EA-SECRET: " + EaApiSecret + "\r\n";

   char post[];
   StringToCharArray(payload, post, 0, WHOLE_ARRAY, CP_UTF8);

   char result[];
   string resultHeaders;

   ResetLastError();
   int code = WebRequest("POST", url, headers, 15000, post, result, resultHeaders);

   if(code == -1)
   {
      Print("WebRequest failed. Error: ", GetLastError(), " URL: ", url);
      return false;
   }

   response = CharArrayToString(result, 0, -1, CP_UTF8);

   if(code < 200 || code >= 300)
   {
      Print("HTTP error ", code, ": ", response);
      return false;
   }

   return true;
}

string JsonEscape(string s)
{
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\n", "\\n");
   StringReplace(s, "\r", "\\r");
   return s;
}

string ExtractString(string json, string key)
{
   string pattern = "\"" + key + "\":";
   int p = StringFind(json, pattern);
   if(p < 0) return "";

   p += StringLen(pattern);

   while(p < StringLen(json) && StringGetCharacter(json, p) == ' ') p++;

   if(p >= StringLen(json)) return "";

   if(StringGetCharacter(json, p) == '"')
   {
      p++;
      int e = p;
      while(e < StringLen(json))
      {
         if(StringGetCharacter(json, e) == '"' && StringGetCharacter(json, e-1) != '\\')
            break;
         e++;
      }
      return StringSubstr(json, p, e-p);
   }

   int e = p;
   while(e < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, e);
      if(ch == ',' || ch == '}' || ch == '\n' || ch == '\r')
         break;
      e++;
   }

   string v = StringSubstr(json, p, e-p);
   StringTrimLeft(v);
   StringTrimRight(v);
   return v;
}

string ExtractObject(string json, string key)
{
   string pattern = "\"" + key + "\":";
   int p = StringFind(json, pattern);
   if(p < 0) return "";

   p += StringLen(pattern);
   while(p < StringLen(json) && StringGetCharacter(json, p) == ' ') p++;

   if(p >= StringLen(json) || StringGetCharacter(json, p) != '{') return "";

   int start = p;
   int depth = 0;

   for(int i = p; i < StringLen(json); i++)
   {
      ushort ch = StringGetCharacter(json, i);
      if(ch == '{') depth++;
      if(ch == '}') depth--;
      if(depth == 0)
         return StringSubstr(json, start, i-start+1);
   }

   return "";
}

double ExtractParamDouble(string json, string key, double defValue=0)
{
   string params = ExtractObject(json, "params");
   if(params == "") return defValue;
   string v = ExtractString(params, key);
   if(v == "") return defValue;
   return StringToDouble(v);
}

bool CanManagePosition()
{
   string symbol = PositionGetString(POSITION_SYMBOL);
   long magic = PositionGetInteger(POSITION_MAGIC);

   if(Manage_Current_Symbol_Only && symbol != _Symbol)
      return false;

   if(Magic_Number_Filter != -1 && magic != Magic_Number_Filter)
      return false;

   return true;
}

void PollCommand()
{
   string response;
   string payload = "{"
      "\"license_key\":\"" + JsonEscape(LicenseKey) + "\","
      "\"mt5_account\":\"" + IntegerToString((int)AccountInfoInteger(ACCOUNT_LOGIN)) + "\""
   "}";

   if(!HttpPost("/ea_poll", payload, response))
      return;

   string commandObj = ExtractObject(response, "command");
   if(commandObj == "" || StringFind(response, "\"command\":null") >= 0)
      return;

   string id = ExtractString(commandObj, "id");
   string command = ExtractString(commandObj, "command");

   if(id == "" || command == "")
      return;

   Print("Executing command: ", command);

   string result = "";
   bool ok = ExecuteCommand(command, commandObj, result);

   UpdateCommand(id, ok ? "executed" : "failed", result);
}

bool ExecuteCommand(string command, string commandJson, string &result)
{
   if(command == "close_all")
      return CloseAllTrades(result);

   if(command == "close_profit")
      return CloseProfitTrades(result);

   if(command == "close_loss")
      return CloseLossTrades(result);

   if(command == "close_half")
      return CloseHalfTrades(result);

   if(command == "close_less_profit")
   {
      double maxProfit = ExtractParamDouble(commandJson, "max_profit", 0);
      return CloseLessProfitTrades(maxProfit, result);
   }

   if(command == "breakeven")
      return MoveSLToBreakeven(result);

   if(command == "set_sl")
   {
      int sl = (int)ExtractParamDouble(commandJson, "sl_points", 0);
      return SetSLTPForTrades(sl, 0, result);
   }

   if(command == "set_tp")
   {
      int tp = (int)ExtractParamDouble(commandJson, "tp_points", 0);
      return SetSLTPForTrades(0, tp, result);
   }

   if(command == "set_sltp")
   {
      int sl = (int)ExtractParamDouble(commandJson, "sl_points", 0);
      int tp = (int)ExtractParamDouble(commandJson, "tp_points", 0);
      return SetSLTPForTrades(sl, tp, result);
   }

   if(command == "refresh_status")
   {
      SendStatus();
      result = "Status refreshed.";
      return true;
   }

   result = "Unknown command.";
   return false;
}

void UpdateCommand(string id, string status, string resultText)
{
   string response;
   string payload = "{"
      "\"id\":\"" + JsonEscape(id) + "\","
      "\"status\":\"" + status + "\","
      "\"result\":\"" + JsonEscape(resultText) + "\""
   "}";

   HttpPost("/ea_update_command", payload, response);
}

bool CloseAllTrades(string &result)
{
   int closed = 0;
   double totalProfit = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && CanManagePosition())
      {
         totalProfit += PositionGetDouble(POSITION_PROFIT);
         if(trade.PositionClose(ticket))
            closed++;
      }
   }

   result = "Closed " + IntegerToString(closed) + " trades. Floating P/L: " + DoubleToString(totalProfit, 2);
   return true;
}

bool CloseProfitTrades(string &result)
{
   int closed = 0;
   double totalProfit = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && CanManagePosition())
      {
         double profit = PositionGetDouble(POSITION_PROFIT);
         if(profit > 0)
         {
            totalProfit += profit;
            if(trade.PositionClose(ticket))
               closed++;
         }
      }
   }

   result = "Closed " + IntegerToString(closed) + " profitable trades. Profit: " + DoubleToString(totalProfit, 2);
   return true;
}

bool CloseLossTrades(string &result)
{
   int closed = 0;
   double totalProfit = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && CanManagePosition())
      {
         double profit = PositionGetDouble(POSITION_PROFIT);
         if(profit < 0)
         {
            totalProfit += profit;
            if(trade.PositionClose(ticket))
               closed++;
         }
      }
   }

   result = "Closed " + IntegerToString(closed) + " losing trades. P/L: " + DoubleToString(totalProfit, 2);
   return true;
}

bool CloseLessProfitTrades(double maxProfit, string &result)
{
   int closed = 0;
   double totalProfit = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && CanManagePosition())
      {
         double profit = PositionGetDouble(POSITION_PROFIT);
         if(profit > 0 && profit <= maxProfit)
         {
            totalProfit += profit;
            if(trade.PositionClose(ticket))
               closed++;
         }
      }
   }

   result = "Closed " + IntegerToString(closed) + " trades with profit <= " + DoubleToString(maxProfit, 2) + ". Profit: " + DoubleToString(totalProfit, 2);
   return true;
}

bool CloseHalfTrades(string &result)
{
   int affected = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && CanManagePosition())
      {
         string symbol = PositionGetString(POSITION_SYMBOL);
         double volume = PositionGetDouble(POSITION_VOLUME);
         double half = NormalizeVolume(symbol, volume / 2.0);
         double minLot = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);

         if(half >= minLot && half < volume)
         {
            if(trade.PositionClosePartial(ticket, half))
               affected++;
         }
      }
   }

   result = "Closed half volume on " + IntegerToString(affected) + " trades.";
   return true;
}

bool SetSLTPForTrades(int slPoints, int tpPoints, string &result)
{
   int modified = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && CanManagePosition())
      {
         string symbol = PositionGetString(POSITION_SYMBOL);
         long type = PositionGetInteger(POSITION_TYPE);
         double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
         double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
         int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);

         double currentSL = PositionGetDouble(POSITION_SL);
         double currentTP = PositionGetDouble(POSITION_TP);

         double sl = currentSL;
         double tp = currentTP;

         if(type == POSITION_TYPE_BUY)
         {
            if(slPoints > 0) sl = NormalizeDouble(openPrice - slPoints * point, digits);
            if(tpPoints > 0) tp = NormalizeDouble(openPrice + tpPoints * point, digits);
         }
         else if(type == POSITION_TYPE_SELL)
         {
            if(slPoints > 0) sl = NormalizeDouble(openPrice + slPoints * point, digits);
            if(tpPoints > 0) tp = NormalizeDouble(openPrice - tpPoints * point, digits);
         }

         if(trade.PositionModify(ticket, sl, tp))
            modified++;
      }
   }

   result = "Modified SL/TP on " + IntegerToString(modified) + " trades.";
   return true;
}

bool MoveSLToBreakeven(string &result)
{
   int modified = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && CanManagePosition())
      {
         double profit = PositionGetDouble(POSITION_PROFIT);
         if(profit <= 0) continue;

         string symbol = PositionGetString(POSITION_SYMBOL);
         int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
         double openPrice = NormalizeDouble(PositionGetDouble(POSITION_PRICE_OPEN), digits);
         double tp = PositionGetDouble(POSITION_TP);

         if(trade.PositionModify(ticket, openPrice, tp))
            modified++;
      }
   }

   result = "Moved SL to breakeven on " + IntegerToString(modified) + " trades.";
   return true;
}

double NormalizeVolume(string symbol, double volume)
{
   double minLot = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxLot = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);

   if(volume < minLot) return 0;
   if(volume > maxLot) volume = maxLot;

   double normalized = MathFloor(volume / step) * step;

   int lotDigits = 2;
   if(step == 0.1) lotDigits = 1;
   else if(step == 0.01) lotDigits = 2;
   else if(step == 0.001) lotDigits = 3;

   return NormalizeDouble(normalized, lotDigits);
}

void SendStatus()
{
   string response;

   double floating = 0;
   int count = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && CanManagePosition())
      {
         floating += PositionGetDouble(POSITION_PROFIT);
         count++;
      }
   }

   string accountType = AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO ? "demo" : "real";

   string payload = "{"
      "\"license_key\":\"" + JsonEscape(LicenseKey) + "\","
      "\"mt5_account\":\"" + IntegerToString((int)AccountInfoInteger(ACCOUNT_LOGIN)) + "\","
      "\"broker\":\"" + JsonEscape(AccountInfoString(ACCOUNT_COMPANY)) + "\","
      "\"server_name\":\"" + JsonEscape(AccountInfoString(ACCOUNT_SERVER)) + "\","
      "\"account_name\":\"" + JsonEscape(AccountInfoString(ACCOUNT_NAME)) + "\","
      "\"account_type\":\"" + accountType + "\","
      "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ","
      "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ","
      "\"margin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN), 2) + ","
      "\"free_margin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_FREEMARGIN), 2) + ","
      "\"floating_profit\":" + DoubleToString(floating, 2) + ","
      "\"open_trades\":" + IntegerToString(count) +
   "}";

   HttpPost("/ea_update_status", payload, response);
}
