//+------------------------------------------------------------------+
//|                             Alikhande/Signal/EmaCrossSignal.mqh   |
//|  Reference implementation of CSignalBase.                         |
//|                                                                   |
//|  THIS IS NOT A TRADING EDGE. A moving-average cross is a          |
//|  reference strategy: it exists to exercise the plumbing end to    |
//|  end and to serve as a worked example of the CSignalBase          |
//|  contract. It has no validated expectancy and must not be         |
//|  treated as one. See docs/STRATEGY.md.                            |
//|                                                                   |
//|  What it does demonstrate correctly:                              |
//|    - handles created in Init, released in Deinit                  |
//|    - closed bars only (shift 1 and 2), so no look-ahead           |
//|    - CopyBuffer return values checked against the requested count |
//|    - ATR-derived stop DISTANCE, leaving prices to the executor    |
//+------------------------------------------------------------------+
#ifndef ALIKHANDE_EMACROSSSIGNAL_MQH
#define ALIKHANDE_EMACROSSSIGNAL_MQH

#include <Alikhande/Signal/ISignal.mqh>

class CEmaCrossSignal : public CSignalBase
  {
private:
   int      m_fast_period;
   int      m_slow_period;
   int      m_atr_period;
   double   m_sl_atr_mult;
   double   m_tp_atr_mult;
   ENUM_TIMEFRAMES m_tf;

   int      m_h_fast;
   int      m_h_slow;
   int      m_h_atr;

public:
                     CEmaCrossSignal(const int fast_period, const int slow_period,
                                     const int atr_period,
                                     const double sl_atr_mult, const double tp_atr_mult,
                                     const ENUM_TIMEFRAMES tf = PERIOD_CURRENT)
     : CSignalBase("EmaCross"),
       m_fast_period(fast_period), m_slow_period(slow_period), m_atr_period(atr_period),
       m_sl_atr_mult(sl_atr_mult), m_tp_atr_mult(tp_atr_mult), m_tf(tf),
       m_h_fast(INVALID_HANDLE), m_h_slow(INVALID_HANDLE), m_h_atr(INVALID_HANDLE) {}

   virtual          ~CEmaCrossSignal(void) { OnDeinitSignal(); }

   virtual bool      OnInitSignal(void) override
     {
      if(m_fast_period < 1 || m_slow_period < 1)
        {
         m_log.Error(m_name + ": EMA periods must be >= 1");
         return(false);
        }
      if(m_fast_period >= m_slow_period)
        {
         m_log.Error(StringFormat("%s: fast period (%d) must be < slow period (%d)",
                                  m_name, m_fast_period, m_slow_period));
         return(false);
        }
      if(m_atr_period < 1 || m_sl_atr_mult <= 0.0)
        {
         m_log.Error(m_name + ": ATR period must be >= 1 and the SL multiplier > 0");
         return(false);
        }

      string sym = m_spec.Name();
      m_h_fast = iMA (sym, m_tf, m_fast_period, 0, MODE_EMA, PRICE_CLOSE);
      m_h_slow = iMA (sym, m_tf, m_slow_period, 0, MODE_EMA, PRICE_CLOSE);
      m_h_atr  = iATR(sym, m_tf, m_atr_period);

      if(m_h_fast == INVALID_HANDLE || m_h_slow == INVALID_HANDLE || m_h_atr == INVALID_HANDLE)
        {
         m_log.Error(StringFormat("%s: indicator handle creation failed, err=%d", m_name, GetLastError()));
         return(false);
        }

      m_log.Info(StringFormat("%s ready: EMA %d/%d, ATR %d, SL %.2fxATR, TP %.2fxATR on %s",
                              m_name, m_fast_period, m_slow_period, m_atr_period,
                              m_sl_atr_mult, m_tp_atr_mult, EnumToString(m_tf)));
      return(true);
     }

   virtual void      OnDeinitSignal(void) override
     {
      if(m_h_fast != INVALID_HANDLE) { IndicatorRelease(m_h_fast); m_h_fast = INVALID_HANDLE; }
      if(m_h_slow != INVALID_HANDLE) { IndicatorRelease(m_h_slow); m_h_slow = INVALID_HANDLE; }
      if(m_h_atr  != INVALID_HANDLE) { IndicatorRelease(m_h_atr);  m_h_atr  = INVALID_HANDLE; }
     }

   virtual bool      Evaluate(SignalDecision &out) override
     {
      SignalDecisionReset(out);

      //--- Shift 1 and 2 are the last two CLOSED bars. Shift 0 is the bar
      //--- currently forming; a cross detected there can un-cross before the
      //--- bar closes, and the EA would already have traded it.
      double fast[], slow[], atr[];
      if(!CopyClosed(m_h_fast, 0, 1, 2, fast)) return(false);
      if(!CopyClosed(m_h_slow, 0, 1, 2, slow)) return(false);
      if(!CopyClosed(m_h_atr,  0, 1, 1, atr))  return(false);

      //--- Series indexing: [0] is the most recent closed bar, [1] the one before.
      double atr_now = atr[0];
      if(atr_now <= 0.0)
        {
         m_log.Debug(m_name + ": ATR is 0 - refusing to size a stop from it");
         return(false);
        }

      bool crossed_up   = (fast[1] <= slow[1]) && (fast[0] >  slow[0]);
      bool crossed_down = (fast[1] >= slow[1]) && (fast[0] <  slow[0]);

      if(!crossed_up && !crossed_down) return(true);   // valid evaluation, no signal

      out.direction   = crossed_up ? SIGNAL_BUY : SIGNAL_SELL;
      out.sl_distance = m_sl_atr_mult * atr_now;
      out.tp_distance = (m_tp_atr_mult > 0.0) ? m_tp_atr_mult * atr_now : 0.0;
      out.confidence  = 0.5;   // no ranking model; a constant is the honest value
      out.reason      = StringFormat("EMA%d %s EMA%d on closed bar | ATR(%d)=%s",
                                     m_fast_period, (crossed_up ? "crossed above" : "crossed below"),
                                     m_slow_period, m_atr_period,
                                     DoubleToString(atr_now, m_spec.Digits_()));
      return(true);
     }
  };

#endif // ALIKHANDE_EMACROSSSIGNAL_MQH
