//+------------------------------------------------------------------+
//|                                               SymbolSpecDump.mq5  |
//|  Prints every broker-spec value the EA depends on.                |
//|                                                                   |
//|  Run this FIRST on any new broker, symbol or account. Most        |
//|  "my EA doesn't open trades" reports are answered by one of the   |
//|  lines below, and guessing at these values is how an EA ends up   |
//|  sized 100x wrong.                                                |
//|                                                                   |
//|  Attach to the chart of the symbol in question and read the       |
//|  Experts tab.                                                     |
//+------------------------------------------------------------------+
#property copyright "Alikhande-app-"
#property version   "0.1"
#property script_show_inputs
#property description "Dumps the broker specification for the chart symbol."

#include <Alikhande/Logger.mqh>
#include <Alikhande/SymbolSpec.mqh>
#include <Alikhande/SafetyGate.mqh>

input string InpSymbolOverride = "";   // Symbol to inspect (empty = chart symbol)

void OnStart()
  {
   string sym = (InpSymbolOverride == "" ? _Symbol : InpSymbolOverride);

   Print("===================================================================");
   Print(" Alikhande symbol specification dump");
   Print("===================================================================");

   //--- Environment
   long trade_mode  = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   long margin_mode = AccountInfoInteger(ACCOUNT_MARGIN_MODE);
   PrintFormat("ACCOUNT  | login=%I64d server=%s currency=%s leverage=1:%I64d",
               AccountInfoInteger(ACCOUNT_LOGIN),
               AccountInfoString(ACCOUNT_SERVER),
               AccountInfoString(ACCOUNT_CURRENCY),
               AccountInfoInteger(ACCOUNT_LEVERAGE));
   PrintFormat("ACCOUNT  | tradeMode=%s marginMode=%s",
               EnumToString((ENUM_ACCOUNT_TRADE_MODE)trade_mode),
               EnumToString((ENUM_ACCOUNT_MARGIN_MODE)margin_mode));
   PrintFormat("ACCOUNT  | balance=%.2f equity=%.2f freeMargin=%.2f",
               AccountInfoDouble(ACCOUNT_BALANCE),
               AccountInfoDouble(ACCOUNT_EQUITY),
               AccountInfoDouble(ACCOUNT_MARGIN_FREE));
   PrintFormat("ACCOUNT  | tradeAllowed=%s expertAllowed=%s",
               (AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) ? "yes" : "NO"),
               (AccountInfoInteger(ACCOUNT_TRADE_EXPERT)  ? "yes" : "NO"));
   PrintFormat("TERMINAL | build=%d tradeAllowed=%s tester=%s",
               (int)TerminalInfoInteger(TERMINAL_BUILD),
               (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) ? "yes" : "NO"),
               (MQLInfoInteger(MQL_TESTER) ? "yes" : "no"));

   //--- What the safety gate would decide, without actually gating anything.
   CLogger log; log.Init("DUMP", ALOG_INFO);
   CSafetyGate gate;
   gate.Evaluate(false, "", 0);
   PrintFormat("SAFETY   | verdict=%s - %s",
               EnumToString(gate.Verdict()), gate.Detail());

   //--- The spec itself
   CSymbolSpec spec;
   if(!spec.Load(sym))
     {
      Print("SPEC     | FAILED: ", spec.FailReason());
      Print("===================================================================");
      return;
     }
   Print(spec.Describe());

   //--- Derived values, which is where the surprises usually are.
   double min_stop_price = spec.MinStopDistance(10);
   PrintFormat("DERIVED  | min stop distance (incl. spread + 10pt buffer) = %.1f points (%s in price)",
               spec.PriceToPoints(min_stop_price),
               DoubleToString(min_stop_price, spec.Digits_()));

   double loss_per_lot_100pt = (spec.PointsToPrice(100) / spec.TickSize()) * spec.TickValue();
   PrintFormat("DERIVED  | loss on a 100-point stop, 1.00 lot = %.2f %s",
               loss_per_lot_100pt, AccountInfoString(ACCOUNT_CURRENCY));

   //--- Worked sizing example against the live account, so the numbers are real.
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   for(int i = 0; i < 3; i++)
     {
      double risk_pct  = 0.25 * MathPow(2, i);          // 0.25%, 0.50%, 1.00%
      double risk_cash = equity * risk_pct / 100.0;
      double lots_raw  = (loss_per_lot_100pt > 0.0) ? risk_cash / loss_per_lot_100pt : 0.0;
      double lots      = spec.NormalizeVolume(lots_raw, 0.0);
      PrintFormat("SIZING   | risk %.2f%% (%.2f %s) on a 100-pt stop -> raw %.4f -> normalized %s lots",
                  risk_pct, risk_cash, AccountInfoString(ACCOUNT_CURRENCY),
                  lots_raw, DoubleToString(lots, spec.VolumeDigits()));
     }

   //--- Live quote, for a sanity check on digits.
   MqlTick tick;
   if(SymbolInfoTick(sym, tick))
      PrintFormat("QUOTE    | bid=%s ask=%s spread=%d points",
                  DoubleToString(tick.bid, spec.Digits_()),
                  DoubleToString(tick.ask, spec.Digits_()),
                  (int)spec.SpreadPts());

   Print("===================================================================");
  }
//+------------------------------------------------------------------+
