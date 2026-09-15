//+------------------------------------------------------------------+
//|                                                     RunTests.mq5  |
//|  In-terminal test suite for the Alikhande core library.           |
//|                                                                   |
//|  WHY THIS EXISTS: CI runs on Linux and cannot compile MQL5, so    |
//|  the only place MQL5 semantics can actually be exercised is       |
//|  inside MetaTrader. Attach this script to any chart and read the  |
//|  Experts tab. The last line is "RESULT: PASSED" or               |
//|  "RESULT: FAILED".                                               |
//|                                                                   |
//|  Every assertion below runs against a SYNTHETIC symbol spec built |
//|  from explicit numbers, not from whatever broker is connected.    |
//|  That is deliberate: a test whose expected value depends on the   |
//|  broker proves nothing and fails for the wrong reasons.           |
//|                                                                   |
//|  Not covered here, and not pretended to be: order submission,     |
//|  fills, slippage, and anything requiring a trade server. See      |
//|  docs/TESTING.md.                                                 |
//+------------------------------------------------------------------+
#property copyright "Alikhande-app-"
#property version   "0.1"
#property script_show_inputs
#property description "Runs the Alikhande core library assertions. Read the Experts tab."

#include <Alikhande/Testing/Assert.mqh>
#include <Alikhande/SymbolSpec.mqh>
#include <Alikhande/OrderExecutor.mqh>
#include <Alikhande/SessionClock.mqh>
#include <Alikhande/RiskManager.mqh>
#include <Alikhande/SafetyGate.mqh>

input bool InpVerbose = false;   // Print passing assertions too

CTestRunner T;

//--- Two-digit gold: point 0.01, 100 oz per lot, so a 0.01 move is $1.00/lot.
void MakeGold2Digit(CSymbolSpec &s, const long stops_level = 50,
                    const long filling_mask = SYMBOL_FILLING_FOK,
                    const ENUM_SYMBOL_TRADE_EXECUTION exec = SYMBOL_TRADE_EXECUTION_MARKET,
                    const long spread_pts = 20)
  {
   s.LoadSynthetic("SYNTH_GOLD_2D", 2, 0.01, 0.01, 1.00, 100.0,
                   0.01, 100.0, 0.01, stops_level, 10, filling_mask, exec,
                   SYMBOL_TRADE_MODE_FULL, 0.0, spread_pts);
  }

//====================================================================
void OnStart()
  {
   T.SetVerbose(InpVerbose);
   Print("===================================================================");
   Print(" Alikhande core library test run");
   PrintFormat(" terminal build %d | tester=%s",
               (int)TerminalInfoInteger(TERMINAL_BUILD),
               (MQLInfoInteger(MQL_TESTER) ? "yes" : "no"));
   Print("===================================================================");

   TestVolumeNormalization();
   TestStopDistance();
   TestFillingModeResolution();
   TestRiskMath();
   TestRetcodeClassification();
   TestTradeModeGuards();
   TestSessionWindows();
   TestSafetyGate();
   TestSpecValidation();

   T.Summary();
  }

//====================================================================
//  Volume normalization -- the arithmetic that decides position size
//====================================================================
void TestVolumeNormalization()
  {
   T.Suite("volume normalization");
   CSymbolSpec s; MakeGold2Digit(s);

   T.EqualD(s.NormalizeVolume(0.567, 0.0), 0.56,
            "rounds DOWN to the step, never to nearest (up would exceed the risk budget)");
   T.EqualD(s.NormalizeVolume(0.561, 0.0), 0.56, "just above a step boundary floors down");
   T.EqualD(s.NormalizeVolume(0.560, 0.0), 0.56, "an exact step value is unchanged");

   // 0.29999999997 is what a division actually produces; it must not floor to 0.29.
   T.EqualD(s.NormalizeVolume(0.29999999997, 0.0), 0.30,
            "float residue below a step boundary still floors to that boundary");

   T.EqualD(s.NormalizeVolume(0.004, 0.0), 0.0,
            "below the minimum lot returns 0, meaning DO NOT TRADE - not 'trade the minimum'");
   T.EqualD(s.NormalizeVolume(0.01, 0.0), 0.01, "exactly the minimum lot is allowed");

   T.EqualD(s.NormalizeVolume(500.0, 0.0), 100.0, "clamped to the broker volume maximum");
   T.EqualD(s.NormalizeVolume(5.0, 0.10), 0.10,   "clamped to our own hard cap when it is tighter");
   T.EqualD(s.NormalizeVolume(0.05, 10.0), 0.05,  "a hard cap above the request changes nothing");

   T.EqualD(s.NormalizeVolume(0.0,  0.0), 0.0, "zero request returns zero");
   T.EqualD(s.NormalizeVolume(-1.0, 0.0), 0.0, "a negative request returns zero, never a short");

   // An aggregate symbol limit is a separate, tighter ceiling.
   CSymbolSpec lim;
   lim.LoadSynthetic("SYNTH_LIMITED", 2, 0.01, 0.01, 1.00, 100.0,
                     0.01, 100.0, 0.01, 50, 10, SYMBOL_FILLING_FOK,
                     SYMBOL_TRADE_EXECUTION_MARKET, SYMBOL_TRADE_MODE_FULL, 2.0, 20);
   T.EqualD(lim.NormalizeVolume(50.0, 0.0), 2.0, "SYMBOL_VOLUME_LIMIT caps the volume");

   T.EqualI(s.VolumeDigits(), 2, "volume digits derived from a 0.01 step");
  }

//====================================================================
//  Stop distance -- the usual cause of retcode 10016 on gold
//====================================================================
void TestStopDistance()
  {
   T.Suite("minimum stop distance");

   // stops_level 50 + spread 20 + buffer 10 = 80 points.
   CSymbolSpec s; MakeGold2Digit(s, 50, SYMBOL_FILLING_FOK, SYMBOL_TRADE_EXECUTION_MARKET, 20);
   T.EqualD(s.MinStopDistance(10), 80 * 0.01,
            "stops level + spread + buffer (the spread is included because MT5 "
            "validates a buy's SL against BID, not the ask it entered at)");
   T.EqualD(s.MinStopDistance(0), 70 * 0.01, "a zero buffer still includes the spread");

   // stops_level 0 means DYNAMIC, not unlimited: base becomes spread * 2.
   CSymbolSpec dyn; MakeGold2Digit(dyn, 0, SYMBOL_FILLING_FOK, SYMBOL_TRADE_EXECUTION_MARKET, 20);
   T.EqualD(dyn.MinStopDistance(10), (40 + 20 + 10) * 0.01,
            "stops level 0 is a dynamic spread-tied level, so a spread-proportional floor applies");
   T.Greater(dyn.MinStopDistance(0), 0.0, "a dynamic level never yields a zero minimum");

   // Wider spread must widen the requirement -- this is what breaks at news time.
   CSymbolSpec wide; MakeGold2Digit(wide, 50, SYMBOL_FILLING_FOK, SYMBOL_TRADE_EXECUTION_MARKET, 300);
   T.Greater(wide.MinStopDistance(10), s.MinStopDistance(10),
             "a 300-point news spread demands a wider stop than a 20-point one");

   T.Suite("point / price conversion");
   T.EqualD(s.PointsToPrice(100), 1.00, "100 points on a 2-digit feed is $1.00");
   T.EqualD(s.PriceToPoints(1.00), 100.0, "$1.00 on a 2-digit feed is 100 points");
   T.EqualD(s.PriceToPoints(s.PointsToPrice(37)), 37.0, "the conversion round-trips");
  }

//====================================================================
//  Filling mode -- verified against the official MetaQuotes docs
//====================================================================
void TestFillingModeResolution()
  {
   T.Suite("filling mode resolution");
   ENUM_ORDER_TYPE_FILLING f; string why;

   // Under MARKET execution, RETURN is "disabled regardless of the symbol
   // settings", so only the FOK/IOC bits the symbol advertises are legal.
   CSymbolSpec mk_fok; MakeGold2Digit(mk_fok, 50, SYMBOL_FILLING_FOK, SYMBOL_TRADE_EXECUTION_MARKET);
   T.IsTrue(mk_fok.ResolveFilling(f, why), "Market + FOK advertised resolves");
   T.EqualI((long)f, (long)ORDER_FILLING_FOK, "Market + FOK advertised picks FOK");

   CSymbolSpec mk_ioc; MakeGold2Digit(mk_ioc, 50, SYMBOL_FILLING_IOC, SYMBOL_TRADE_EXECUTION_MARKET);
   T.IsTrue(mk_ioc.ResolveFilling(f, why), "Market + IOC advertised resolves");
   T.EqualI((long)f, (long)ORDER_FILLING_IOC, "Market + IOC advertised picks IOC (never hardcode FOK)");

   // THE REGRESSION TEST. Falling back to RETURN here would be retcode 10030
   // on every single tick, which looks like a strategy that never trades.
   CSymbolSpec mk_none; MakeGold2Digit(mk_none, 50, 0, SYMBOL_TRADE_EXECUTION_MARKET);
   T.IsFalse(mk_none.ResolveFilling(f, why),
             "Market execution with no FOK/IOC advertised is UNRESOLVABLE - RETURN is "
             "disabled under Market execution, so init must fail loudly");

   // BOC is a passive Depth-of-Market policy; it is cancelled if it could
   // execute immediately, which is the opposite of a market entry.
   CSymbolSpec mk_boc; MakeGold2Digit(mk_boc, 50, SYMBOL_FILLING_BOC, SYMBOL_TRADE_EXECUTION_MARKET);
   T.IsFalse(mk_boc.ResolveFilling(f, why), "BOC alone does not make a market order fillable");

   // Under Request / Instant / Exchange, RETURN is permitted by the execution mode.
   CSymbolSpec inst; MakeGold2Digit(inst, 50, 0, SYMBOL_TRADE_EXECUTION_INSTANT);
   T.IsTrue(inst.ResolveFilling(f, why), "Instant execution with an empty mask still resolves");
   T.EqualI((long)f, (long)ORDER_FILLING_RETURN, "Instant + empty mask falls back to RETURN");

   CSymbolSpec exch; MakeGold2Digit(exch, 50, 0, SYMBOL_TRADE_EXECUTION_EXCHANGE);
   T.IsTrue(exch.ResolveFilling(f, why), "Exchange execution with an empty mask resolves");
   T.EqualI((long)f, (long)ORDER_FILLING_RETURN, "Exchange + empty mask falls back to RETURN");

   CSymbolSpec req; MakeGold2Digit(req, 50, 0, SYMBOL_TRADE_EXECUTION_REQUEST);
   T.IsTrue(req.ResolveFilling(f, why), "Request execution with an empty mask resolves");

   // An advertised mode is preferred over the fallback even when RETURN is legal.
   CSymbolSpec inst_fok; MakeGold2Digit(inst_fok, 50, SYMBOL_FILLING_FOK, SYMBOL_TRADE_EXECUTION_INSTANT);
   T.IsTrue(inst_fok.ResolveFilling(f, why), "Instant + FOK resolves");
   T.EqualI((long)f, (long)ORDER_FILLING_FOK, "an advertised mode beats the RETURN fallback");

   // A combined mask is read as a mask, not compared as a number.
   CSymbolSpec both; MakeGold2Digit(both, 50, SYMBOL_FILLING_FOK | SYMBOL_FILLING_IOC,
                                    SYMBOL_TRADE_EXECUTION_MARKET);
   T.IsTrue(both.AllowsFOK(), "a combined mask reports FOK");
   T.IsTrue(both.AllowsIOC(), "a combined mask reports IOC");
   T.IsFalse(both.AllowsBOC(), "a combined mask does not invent BOC");
  }

//====================================================================
//  Risk math
//====================================================================
void TestRiskMath()
  {
   T.Suite("risk math");
   CSymbolSpec s; MakeGold2Digit(s);
   CLogger log; log.Init("TEST", ALOG_ERROR);

   RiskParams p; RiskParamsDefaults(p);
   p.risk_percent = 1.0;
   p.max_lot      = 100.0;
   // Magic 0 keeps these anchors out of any real EA's namespace.
   CRiskManager rm;
   T.IsTrue(rm.Init(s, log, 0, p), "risk manager initialises on a valid spec");

   // A 100-point stop is a $1.00 move; on 100 oz that is $100 per lot.
   double stop_price = s.PointsToPrice(100);
   T.EqualD(rm.LossPerLot(stop_price), 100.0,
            "100-point stop on 2-digit gold costs $100 per 1.00 lot", 1e-6);
   T.EqualD(rm.LossPerLot(s.PointsToPrice(200)), 200.0,
            "loss per lot scales linearly with the stop distance", 1e-6);

   T.EqualD(rm.MoneyAtRisk(0.50, stop_price), 50.0,
            "half a lot risks half the money", 1e-6);
   T.EqualD(rm.MoneyAtRisk(0.0, stop_price), 0.0, "no position risks nothing");

   T.EqualD(rm.LossPerLot(0.0), 0.0, "a zero stop distance yields zero loss per lot");
   T.EqualD(rm.CalcLots(0.0),   0.0, "a zero stop distance refuses to size a trade");
   T.EqualD(rm.CalcLots(-1.0),  0.0, "a negative stop distance refuses to size a trade");

   // CalcLots reads live account equity, so the exact lot is not predictable
   // here. What IS predictable is that the result is a legal volume.
   double lots = rm.CalcLots(stop_price);
   T.IsTrue(lots >= 0.0, "CalcLots never returns a negative volume");
   if(lots > 0.0)
     {
      T.IsTrue(lots >= s.VolumeMin() - 1e-8, "a non-zero result is at least the minimum lot");
      T.IsTrue(lots <= s.VolumeMax() + 1e-8, "a non-zero result is within the volume maximum");
      double steps = lots / s.VolumeStep();
      T.EqualD(steps, MathRound(steps), "a non-zero result is an exact multiple of the volume step", 1e-6);
     }

   // Three-digit gold must give the same money answer for the same price move.
   CSymbolSpec g3;
   g3.LoadSynthetic("SYNTH_GOLD_3D", 3, 0.001, 0.001, 0.10, 100.0,
                    0.01, 100.0, 0.01, 500, 100, SYMBOL_FILLING_FOK,
                    SYMBOL_TRADE_EXECUTION_MARKET, SYMBOL_TRADE_MODE_FULL, 0.0, 200);
   CRiskManager rm3;
   T.IsTrue(rm3.Init(g3, log, 0, p), "risk manager initialises on a 3-digit spec");
   T.EqualD(rm3.LossPerLot(1.00), 100.0,
            "a $1.00 move costs $100 per lot on 3-digit gold too - the money is "
            "the same, only the point count differs", 1e-6);
   T.EqualD(g3.PriceToPoints(1.00), 1000.0, "the same $1.00 move is 1000 points at 3 digits");
  }

//====================================================================
//  Retcode classification -- the policy that decides retry vs abort
//====================================================================
void TestRetcodeClassification()
  {
   T.Suite("retcode classification");

   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_DONE),         (long)RC_SUCCESS, "10009 DONE is success");
   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_PLACED),       (long)RC_SUCCESS, "10008 PLACED is success");
   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_DONE_PARTIAL), (long)RC_SUCCESS, "10010 DONE_PARTIAL is success (and must be noticed)");

   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_REQUOTE),           (long)RC_RETRYABLE, "10004 REQUOTE is retryable");
   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_PRICE_CHANGED),     (long)RC_RETRYABLE, "10020 PRICE_CHANGED is retryable");
   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_PRICE_OFF),         (long)RC_RETRYABLE, "10021 PRICE_OFF is retryable");
   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_TOO_MANY_REQUESTS), (long)RC_RETRYABLE, "10024 TOO_MANY_REQUESTS is retryable");
   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_CONNECTION),        (long)RC_RETRYABLE, "10031 CONNECTION is retryable");

   // The one that matters most. A timeout means the request was cancelled
   // locally -- it may still have reached the server and filled. Resending
   // blindly is the classic double-position bug.
   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_TIMEOUT), (long)RC_AMBIGUOUS,
            "10012 TIMEOUT is AMBIGUOUS, never retryable - the order may have filled");

   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_INVALID_VOLUME), (long)RC_SPEC_ERROR, "10014 INVALID_VOLUME is a bug, not bad luck");
   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_INVALID_STOPS),  (long)RC_SPEC_ERROR, "10016 INVALID_STOPS is a bug, not bad luck");
   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_NO_MONEY),       (long)RC_SPEC_ERROR, "10019 NO_MONEY is a sizing bug");
   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_INVALID_FILL),   (long)RC_SPEC_ERROR, "10030 INVALID_FILL is a filling-mode bug");
   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_INVALID_PRICE),  (long)RC_SPEC_ERROR, "10015 INVALID_PRICE is a bug");

   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_MARKET_CLOSED),   (long)RC_ENVIRONMENT, "10018 MARKET_CLOSED is environmental");
   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_TRADE_DISABLED),  (long)RC_ENVIRONMENT, "10017 TRADE_DISABLED is environmental");
   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_POSITION_CLOSED), (long)RC_ENVIRONMENT, "10036 POSITION_CLOSED is environmental, not an alarm");
   T.EqualI((long)COrderExecutor::Classify(TRADE_RETCODE_LONG_ONLY),       (long)RC_ENVIRONMENT, "10042 LONG_ONLY is environmental");

   // No spec error may ever be classified as retryable: that is how an EA
   // spams a broker into a temporary ban.
   uint spec_errors[] = {TRADE_RETCODE_INVALID, TRADE_RETCODE_INVALID_VOLUME,
                         TRADE_RETCODE_INVALID_PRICE, TRADE_RETCODE_INVALID_STOPS,
                         TRADE_RETCODE_NO_MONEY, TRADE_RETCODE_INVALID_FILL};
   bool any_retryable = false;
   for(int i = 0; i < ArraySize(spec_errors); i++)
      if(COrderExecutor::Classify(spec_errors[i]) == RC_RETRYABLE) any_retryable = true;
   T.IsFalse(any_retryable, "no spec error is ever classified retryable");
  }

//====================================================================
//  Symbol trade-mode guards
//====================================================================
void TestTradeModeGuards()
  {
   T.Suite("symbol trade-mode guards");

   CSymbolSpec full;  MakeGold2Digit(full);
   T.IsTrue(full.TradeAllowed(true),  "FULL permits buying");
   T.IsTrue(full.TradeAllowed(false), "FULL permits selling");

   CSymbolSpec lo;
   lo.LoadSynthetic("SYNTH_LONGONLY", 2, 0.01, 0.01, 1.0, 100.0, 0.01, 100.0, 0.01,
                    50, 10, SYMBOL_FILLING_FOK, SYMBOL_TRADE_EXECUTION_MARKET,
                    SYMBOL_TRADE_MODE_LONGONLY, 0.0, 20);
   T.IsTrue (lo.TradeAllowed(true),  "LONGONLY permits buying");
   T.IsFalse(lo.TradeAllowed(false), "LONGONLY refuses selling (would be retcode 10042)");

   CSymbolSpec so;
   so.LoadSynthetic("SYNTH_SHORTONLY", 2, 0.01, 0.01, 1.0, 100.0, 0.01, 100.0, 0.01,
                    50, 10, SYMBOL_FILLING_FOK, SYMBOL_TRADE_EXECUTION_MARKET,
                    SYMBOL_TRADE_MODE_SHORTONLY, 0.0, 20);
   T.IsFalse(so.TradeAllowed(true),  "SHORTONLY refuses buying (would be retcode 10043)");
   T.IsTrue (so.TradeAllowed(false), "SHORTONLY permits selling");

   CSymbolSpec co;
   co.LoadSynthetic("SYNTH_CLOSEONLY", 2, 0.01, 0.01, 1.0, 100.0, 0.01, 100.0, 0.01,
                    50, 10, SYMBOL_FILLING_FOK, SYMBOL_TRADE_EXECUTION_MARKET,
                    SYMBOL_TRADE_MODE_CLOSEONLY, 0.0, 20);
   T.IsFalse(co.TradeAllowed(true),  "CLOSEONLY refuses new longs");
   T.IsFalse(co.TradeAllowed(false), "CLOSEONLY refuses new shorts");

   CSymbolSpec dis;
   dis.LoadSynthetic("SYNTH_DISABLED", 2, 0.01, 0.01, 1.0, 100.0, 0.01, 100.0, 0.01,
                     50, 10, SYMBOL_FILLING_FOK, SYMBOL_TRADE_EXECUTION_MARKET,
                     SYMBOL_TRADE_MODE_DISABLED, 0.0, 20);
   T.IsFalse(dis.TradeAllowed(true),  "DISABLED refuses everything");
   T.IsFalse(dis.TradeAllowed(false), "DISABLED refuses everything");
  }

//====================================================================
//  Session windows -- including the ones that wrap past midnight
//====================================================================
void TestSessionWindows()
  {
   T.Suite("session windows");

   T.IsTrue (CSessionClock::HourInWindow(10, 8, 21), "10:00 is inside 08:00-21:00");
   T.IsTrue (CSessionClock::HourInWindow( 8, 8, 21), "the start hour is inclusive");
   T.IsFalse(CSessionClock::HourInWindow(21, 8, 21), "the end hour is exclusive");
   T.IsFalse(CSessionClock::HourInWindow( 7, 8, 21), "before the window is outside");
   T.IsFalse(CSessionClock::HourInWindow(22, 8, 21), "after the window is outside");

   // The rollover band wraps midnight: 23:00 -> 01:00.
   T.IsTrue (CSessionClock::HourInWindow(23, 23, 1), "23:00 is inside the wrapping 23-01 band");
   T.IsTrue (CSessionClock::HourInWindow( 0, 23, 1), "00:00 is inside the wrapping band");
   T.IsFalse(CSessionClock::HourInWindow( 1, 23, 1), "01:00 is the exclusive end of the band");
   T.IsFalse(CSessionClock::HourInWindow(12, 23, 1), "midday is outside the wrapping band");
   T.IsFalse(CSessionClock::HourInWindow(22, 23, 1), "22:00 is just before the band");

   T.IsFalse(CSessionClock::HourInWindow(10, 10, 10), "an empty window (start == end) admits nothing");
  }

//====================================================================
//  Safety gate
//====================================================================
void TestSafetyGate()
  {
   T.Suite("safety gate");
   CSafetyGate g;

   // Whatever account the terminal holds, the gate must reach a decision and
   // that decision must be self-consistent.
   bool passed = g.Evaluate(false, "", 0);
   T.EqualI((long)passed, (long)g.Passed(), "Evaluate's return matches Passed()");

   if((bool)MQLInfoInteger(MQL_TESTER))
     {
      T.EqualI((long)g.Verdict(), (long)SAFETY_ALLOW_TESTER, "inside the tester the verdict is ALLOW_TESTER");
      T.IsTrue(g.Passed(), "the tester is always permitted - it cannot touch real money");
     }
   else
     {
      long mode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
      if(mode == ACCOUNT_TRADE_MODE_REAL)
        {
         T.IsFalse(g.Passed(), "a REAL account is blocked without the four-factor override");
         T.EqualI((long)g.Verdict(), (long)SAFETY_BLOCK_REAL, "the verdict names the real-account block");
        }
      else if(mode == ACCOUNT_TRADE_MODE_DEMO)
        {
         T.IsTrue(g.Passed(), "a demo account is permitted");
         T.EqualI((long)g.Verdict(), (long)SAFETY_ALLOW_DEMO, "the verdict names the demo account");
        }
     }

   T.IsFalse(g.RealMoneyAtRisk(),
             "with no override supplied, the gate never reports real money at risk");

   // Requesting live access without the compile-time flag must still fail.
   // ALIKHANDE_ALLOW_LIVE is defined nowhere in this repository, and CI fails
   // the build if it ever is, so this assertion holds by construction.
   CSafetyGate g2;
   g2.Evaluate(true, ALIKHANDE_LIVE_ACK_PHRASE, AccountInfoInteger(ACCOUNT_LOGIN));
   if(!(bool)MQLInfoInteger(MQL_TESTER) &&
      AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL)
      T.IsFalse(g2.Passed(),
                "even a correct phrase and a matching login cannot unlock live trading "
                "while the compile-time flag is absent");

   T.IsTrue(StringLen(ALIKHANDE_LIVE_ACK_PHRASE) > 20,
            "the acknowledgement phrase is long enough that it cannot be typed by accident");
  }

//====================================================================
//  Spec validation -- refusing to run on numbers that break the math
//====================================================================
void TestSpecValidation()
  {
   T.Suite("spec validation");

   CSymbolSpec fresh;
   T.IsFalse(fresh.IsLoaded(), "a fresh spec is not loaded");
   T.EqualD(fresh.NormalizeVolume(1.0, 0.0), 0.0, "an unloaded spec cannot size a position");

   CSymbolSpec ok; MakeGold2Digit(ok);
   T.IsTrue(ok.IsLoaded(), "a synthetic spec reports as loaded");
   T.EqualS(ok.FailReason(), "", "a loaded spec has no failure reason");
   T.EqualI(ok.Digits_(), 2, "digits are preserved");
   T.EqualD(ok.Point_(), 0.01, "point is preserved");
   T.EqualD(ok.TickValue(), 1.00, "tick value is preserved");

   // A real Load() against a name no broker offers must fail, not return zeros.
   CSymbolSpec bad;
   T.IsFalse(bad.Load("NO_SUCH_SYMBOL_ZZZ"), "loading a nonexistent symbol fails");
   T.IsFalse(bad.IsLoaded(), "a failed load leaves the spec unloaded");
   T.IsTrue(StringLen(bad.FailReason()) > 0, "a failed load explains why");
  }
//+------------------------------------------------------------------+
