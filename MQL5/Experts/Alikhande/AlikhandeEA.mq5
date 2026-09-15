//+------------------------------------------------------------------+
//|                                                   AlikhandeEA.mq5 |
//|                                     Alikhande-app- trading system |
//|                                                                   |
//|  This file owns EVENTS AND WIRING ONLY. Every decision lives in   |
//|  Include/Alikhande/. If a handler below stops fitting on one      |
//|  screen, the logic belongs in a module instead.                   |
//|                                                                   |
//|  DEFAULT BEHAVIOUR IS ALERT-ONLY. Out of the box this EA          |
//|  evaluates, logs and alerts, and sends nothing. Execution is an   |
//|  opt-in, and even then the safety gate decides whether the        |
//|  account is allowed to be traded at all.                          |
//|                                                                   |
//|  NOT COMPILED IN THIS ENVIRONMENT. MetaEditor is Windows-only.    |
//|  Compile before use and report any diagnostics. See docs/TESTING. |
//+------------------------------------------------------------------+
#property copyright "Alikhande-app-"
#property link      "https://github.com/alikhande70/Alikhande-app-"
#property version   "0.1"
#property description "Alikhande EA - alert-only by default. Demo and Strategy Tester only."
#property strict

#include <Alikhande/Logger.mqh>
#include <Alikhande/SymbolSpec.mqh>
#include <Alikhande/SafetyGate.mqh>
#include <Alikhande/RiskManager.mqh>
#include <Alikhande/OrderExecutor.mqh>
#include <Alikhande/SessionClock.mqh>
#include <Alikhande/Signal/EmaCrossSignal.mqh>

//====================================================================
//  INPUTS
//====================================================================
enum ENUM_EXECUTION_MODE
  {
   EXEC_ALERT_ONLY = 0,   // evaluate and log; send nothing  (DEFAULT)
   EXEC_TRADE      = 1    // actually send orders, subject to the safety gate
  };

input group                "=== Execution mode ==="
input ENUM_EXECUTION_MODE  InpExecutionMode   = EXEC_ALERT_ONLY;  // Execution mode
input long                 InpMagic           = 20260915;         // Magic number (unique per strategy+symbol)
input string               InpComment         = "ALK";            // Order comment

input group                "=== Live-trading override (leave untouched) ==="
input bool                 InpAllowLive       = false;            // Allow real accounts (needs a source-level flag too)
input string               InpLiveAck         = "";               // Acknowledgement phrase
input long                 InpLivePinnedLogin = 0;                // Account number this override is valid for

input group                "=== Risk ==="
input double               InpRiskPercent     = 0.50;             // Risk per trade (% of equity)
input double               InpMaxLot          = 1.00;             // Hard lot cap
input double               InpDailyLossPct    = 3.00;             // Daily loss kill switch (%, 0 = off)
input double               InpMaxTotalDDPct   = 8.00;             // Total drawdown kill switch (%, 0 = off)
input int                  InpMaxPositions    = 1;                // Max concurrent positions (this EA + symbol)

input group                "=== Execution tuning ==="
input int                  InpDeviationPoints = 30;               // Max slippage (points)
input int                  InpMaxRetries      = 3;                // Retries for transient errors
input int                  InpRetryWaitMs     = 250;              // Wait between retries (ms)
input int                  InpStopBufferPts   = 10;               // Extra points above the broker stops level

input group                "=== Session (broker server time) ==="
input bool                 InpUseSessionFilter= true;             // Restrict trading to a window
input int                  InpSessionStart    = 8;                // Session start hour
input int                  InpSessionEnd      = 21;               // Session end hour (exclusive)
input bool                 InpCloseAtEnd      = false;            // Force-close at the window edge
input bool                 InpBlockRollover   = true;             // Skip the rollover spread blowout
input int                  InpRolloverStart   = 23;               // Rollover start hour
input int                  InpRolloverEnd     = 1;                // Rollover end hour
input int                  InpFridayCutoff    = 20;               // Stop opening after this hour on Friday (24 = off)

input group                "=== Signal: EMA cross (reference only, no proven edge) ==="
input int                  InpFastEMA         = 20;               // Fast EMA period
input int                  InpSlowEMA         = 50;               // Slow EMA period
input int                  InpATRPeriod       = 14;               // ATR period for stop sizing
input double               InpSLxATR          = 1.50;             // Stop loss = N x ATR
input double               InpTPxATR          = 3.00;             // Take profit = N x ATR (0 = none)

input group                "=== Diagnostics ==="
input ENUM_ALIKHANDE_LOG_LEVEL InpLogLevel    = ALOG_INFO;        // Log level

//====================================================================
//  COMPONENTS
//====================================================================
CLogger          g_log;
CSymbolSpec      g_spec;
CSafetyGate      g_gate;
CRiskManager     g_risk;
COrderExecutor   g_exec;
CSessionClock    g_clock;
CEmaCrossSignal *g_signal = NULL;

datetime         g_last_bar_time = 0;
bool             g_resync_needed = false;
bool             g_is_hedging    = false;

//====================================================================
//  INIT
//====================================================================
int OnInit()
  {
   g_log.Init("ALK", InpLogLevel);
   g_log.Info("--- AlikhandeEA starting ---");

   //--- 1. SAFETY FIRST. Nothing else runs until the account is cleared.
   g_gate.Evaluate(InpAllowLive, InpLiveAck, InpLivePinnedLogin);
   g_gate.Report(g_log);
   if(!g_gate.Passed())
      return(INIT_FAILED);

   //--- 2. Broker specification. Refuse to run on unreadable numbers rather
   //---    than computing lot sizes from zeros.
   if(!g_spec.Load(_Symbol))
     {
      g_log.Error("Symbol spec unusable: " + g_spec.FailReason());
      return(INIT_FAILED);
     }
   g_log.Info(g_spec.Describe());

   //--- 3. Account margin model. Netting and hedging are different products:
   //---    on netting a second buy averages into the open position instead of
   //---    creating another, so a "max positions" above 1 cannot mean what it
   //---    says. Detect it and say so rather than silently misbehaving.
   long margin_mode = AccountInfoInteger(ACCOUNT_MARGIN_MODE);
   g_is_hedging = (margin_mode == ACCOUNT_MARGIN_MODE_RETAIL_HEDGING);
   g_log.Info(StringFormat("Account margin mode: %s", (g_is_hedging ? "HEDGING" : "NETTING/EXCHANGE")));
   if(!g_is_hedging && InpMaxPositions > 1)
      g_log.Warn("InpMaxPositions > 1 on a non-hedging account. Additional entries will net into "
                 "the existing position, not open new ones. Treating the limit as 1.");

   //--- 4. Risk.
   RiskParams rp;
   RiskParamsDefaults(rp);
   rp.risk_percent     = InpRiskPercent;
   rp.max_lot          = InpMaxLot;
   rp.daily_loss_pct   = InpDailyLossPct;
   rp.max_total_dd_pct = InpMaxTotalDDPct;
   if(!g_risk.Init(g_spec, g_log, InpMagic, rp))
      return(INIT_FAILED);

   //--- 5. Execution. Fails init when no legal filling mode exists.
   if(!g_exec.Init(g_spec, g_log, InpMagic, InpComment,
                   InpDeviationPoints, InpMaxRetries, InpRetryWaitMs, InpStopBufferPts))
      return(INIT_FAILED);

   //--- 6. Clock.
   SessionParams sp;
   SessionParamsDefaults(sp);
   sp.use_session_filter  = InpUseSessionFilter;
   sp.start_hour          = InpSessionStart;
   sp.end_hour            = InpSessionEnd;
   sp.block_rollover      = InpBlockRollover;
   sp.rollover_start_hour = InpRolloverStart;
   sp.rollover_end_hour   = InpRolloverEnd;
   sp.friday_cutoff_hour  = InpFridayCutoff;
   g_clock.Init(g_log, sp);

   //--- 7. Strategy.
   g_signal = new CEmaCrossSignal(InpFastEMA, InpSlowEMA, InpATRPeriod, InpSLxATR, InpTPxATR);
   if(g_signal == NULL || !g_signal.Attach(g_spec, g_log))
     {
      g_log.Error("Signal initialisation failed");
      return(INIT_FAILED);
     }

   //--- 8. State recovery. Positions survive an EA restart; the EA's memory
   //---    of them does not. Re-read rather than assume a clean slate.
   int owned = g_exec.CountOwned();
   if(owned > 0)
     {
      g_log.Warn(StringFormat("Adopted %d pre-existing position(s) matching magic %I64d on %s after restart.",
                              owned, InpMagic, _Symbol));
      if(g_exec.HasUnprotectedPosition())
         g_log.Error("At least one adopted position has NO STOP LOSS. Attend to it manually.");
     }

   if(InpExecutionMode == EXEC_ALERT_ONLY)
      g_log.Warn("EXECUTION MODE: ALERT-ONLY. Signals will be logged. No orders will be sent.");
   else
      g_log.Warn("EXECUTION MODE: TRADE. Orders will be sent on " + g_gate.Detail());

   g_log.Info("--- initialisation complete ---");
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   if(g_signal != NULL)
     {
      g_signal.OnDeinitSignal();
      delete g_signal;
      g_signal = NULL;
     }
   g_log.Info(StringFormat("--- AlikhandeEA stopped (reason %d) ---", reason));
  }

//====================================================================
//  MAIN LOOP
//====================================================================
void OnTick()
  {
   //--- Kill switches run on EVERY tick, before anything else. A daily limit
   //--- checked only on new bars can be breached and stay breached for an
   //--- entire bar while the EA keeps trading.
   g_risk.Update();
   if(g_risk.LimitBreached())
     {
      if(InpExecutionMode == EXEC_TRADE)
         g_exec.CloseAllOwned("risk limit: " + g_risk.HaltReason());
      return;
     }

   //--- A trade transaction arrived since the last tick; authoritative state
   //--- is re-read here rather than inside the event handler.
   if(g_resync_needed)
     {
      g_resync_needed = false;
      ResyncPositions();
     }

   if(InpCloseAtEnd && !g_clock.InSessionWindow() && InpExecutionMode == EXEC_TRADE)
      g_exec.CloseAllOwned("session window closed");

   //--- Bar-gated from here: the reference strategy decides once per bar.
   if(!IsNewBar()) return;

   ManageOpenPositions();

   if(!TerminalTradingPermitted()) return;

   if(!g_clock.CanOpen())
     {
      g_log.Debug("Not opening: " + g_clock.BlockReason());
      return;
     }

   int effective_max = (g_is_hedging ? InpMaxPositions : 1);
   if(g_exec.CountOwned() >= effective_max) return;

   SignalDecision d;
   if(!g_signal.Evaluate(d))    return;   // not an error: history or indicator not ready
   if(d.direction == SIGNAL_NONE) return;
   if(d.sl_distance <= 0.0)
     {
      g_log.Error("Signal returned a non-positive stop distance - ignoring it.");
      return;
     }

   ActOnSignal(d);
  }

//+------------------------------------------------------------------+
//| Size the trade, then either send it or just announce it.          |
//+------------------------------------------------------------------+
void ActOnSignal(const SignalDecision &d)
  {
   bool   is_buy = (d.direction == SIGNAL_BUY);
   double lots   = g_risk.CalcLots(d.sl_distance);

   if(lots <= 0.0)
     {
      g_log.Warn(StringFormat("Signal ignored: risk budget cannot cover the minimum lot (%s). Stop distance %.1f pts.",
                              DoubleToString(g_spec.VolumeMin(), g_spec.VolumeDigits()),
                              g_spec.PriceToPoints(d.sl_distance)));
      return;
     }

   string headline = StringFormat("%s %s %s lots | SL %.1f pts TP %.1f pts | risk %.2f %s (%.2f%% of equity) | %s",
                                  (is_buy ? "BUY" : "SELL"), _Symbol,
                                  DoubleToString(lots, g_spec.VolumeDigits()),
                                  g_spec.PriceToPoints(d.sl_distance),
                                  g_spec.PriceToPoints(d.tp_distance),
                                  g_risk.MoneyAtRisk(lots, d.sl_distance),
                                  AccountInfoString(ACCOUNT_CURRENCY),
                                  g_risk.RiskPercentOfEquity(lots, d.sl_distance),
                                  d.reason);

   if(InpExecutionMode == EXEC_ALERT_ONLY)
     {
      g_log.Info("[ALERT-ONLY] would open: " + headline);
      if(!(bool)MQLInfoInteger(MQL_TESTER))
         Alert("Alikhande signal: ", headline);
      return;
     }

   double price = is_buy ? g_spec.Ask() : g_spec.Bid();
   if(!g_risk.MarginAffordable(is_buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL, lots, price))
     {
      g_log.Warn("Signal ignored: insufficient free margin for " +
                 DoubleToString(lots, g_spec.VolumeDigits()) + " lots");
      return;
     }

   g_log.Info("Opening: " + headline);

   OrderResult r;
   if(!g_exec.OpenMarket(is_buy, lots, d.sl_distance, d.tp_distance, r))
      g_log.Error("Open failed: " + r.message);
  }

void ManageOpenPositions()
  {
   if(InpExecutionMode != EXEC_TRADE) return;

   //--- A position without a stop is never an acceptable steady state. This is
   //--- a safety assertion, not a strategy feature: it catches an adopted
   //--- position, a server-side SL removal, or a bug in the open path.
   if(g_exec.HasUnprotectedPosition())
      g_log.Error("An owned position has no stop loss. Manual attention required.");

   //--- Trailing / break-even hook. CSignalBase::ManageOpen defaults to
   //--- "no change", so the reference strategy does nothing here.
  }

//====================================================================
//  TRADE EVENTS
//====================================================================
//+------------------------------------------------------------------+
//| OnTradeTransaction is a DOORBELL, not a ledger.                   |
//|                                                                   |
//| MetaQuotes documents that transaction arrival order "is not       |
//| guaranteed", that the queue holds 1024 entries and older ones     |
//| "can be superseded", and that you "cannot rely on 'one request -  |
//| one Trade event'". Any state machine built on these events being  |
//| ordered and complete is wrong by construction.                    |
//|                                                                   |
//| So this handler records only that something happened. The actual  |
//| state is re-read from PositionSelect/History on the next tick.    |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest    &request,
                        const MqlTradeResult     &result)
  {
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD      ||
      trans.type == TRADE_TRANSACTION_POSITION      ||
      trans.type == TRADE_TRANSACTION_ORDER_DELETE  ||
      trans.type == TRADE_TRANSACTION_HISTORY_ADD)
     {
      g_resync_needed = true;
      if(g_log.Wants(ALOG_DEBUG))
         g_log.Debug(StringFormat("Trade transaction %s - resync queued", EnumToString(trans.type)));
     }
  }

void ResyncPositions()
  {
   int    n = g_exec.CountOwned();
   double v = g_exec.OwnedVolume();
   g_log.Debug(StringFormat("Resync: %d owned position(s), %s lots total",
                            n, DoubleToString(v, g_spec.VolumeDigits())));

   if(n > 0 && g_exec.HasUnprotectedPosition())
      g_log.Error("Resync found an owned position with no stop loss.");
  }

//====================================================================
//  HELPERS
//====================================================================
//--- Compare the bar's opening time. Bars() growth is unreliable: history
//--- syncing changes the bar count without a new bar having formed.
bool IsNewBar()
  {
   datetime t = iTime(_Symbol, PERIOD_CURRENT, 0);
   if(t == 0 || t == g_last_bar_time) return(false);
   g_last_bar_time = t;
   return(true);
  }

bool TerminalTradingPermitted()
  {
   if(InpExecutionMode != EXEC_TRADE) return(true);   // alert-only needs no permissions

   if(!(bool)MQLInfoInteger(MQL_TRADE_ALLOWED))
     { g_log.Debug("Blocked: 'Allow Algo Trading' is off for this EA"); return(false); }
   if(!(bool)TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
     { g_log.Debug("Blocked: the terminal's Algo Trading button is off"); return(false); }
   if(!(bool)AccountInfoInteger(ACCOUNT_TRADE_ALLOWED))
     { g_log.Debug("Blocked: trading is disabled for this account"); return(false); }
   //--- Distinct from ACCOUNT_TRADE_ALLOWED: the account may permit manual
   //--- trading while forbidding Expert Advisors.
   if(!(bool)AccountInfoInteger(ACCOUNT_TRADE_EXPERT))
     { g_log.Debug("Blocked: the account forbids Expert Advisors"); return(false); }
   return(true);
  }

//====================================================================
//  OPTIMIZATION CRITERION
//====================================================================
//+------------------------------------------------------------------+
//| Optimizing on Balance-max reliably produces a fragile, high-       |
//| drawdown parameter set that dies out of sample. This criterion     |
//| refuses tiny samples outright, requires a profit factor with some  |
//| margin over 1, and scores return per unit of drawdown weighted by  |
//| sample size.                                                       |
//+------------------------------------------------------------------+
double OnTester()
  {
   double trades = TesterStatistics(STAT_TRADES);
   if(trades < 100) return(0.0);                 // too few trades to mean anything

   double profit = TesterStatistics(STAT_PROFIT);
   double maxdd  = TesterStatistics(STAT_EQUITY_DDREL_PERCENT);
   double pf     = TesterStatistics(STAT_PROFIT_FACTOR);

   if(profit <= 0.0 || maxdd <= 0.0) return(0.0);
   if(pf < 1.05) return(0.0);                    // inside the noise once costs are real

   double calmar = profit / maxdd;               // return per unit of drawdown
   return(calmar * MathSqrt(trades));            // prefer the same edge on more trades
  }
//+------------------------------------------------------------------+
