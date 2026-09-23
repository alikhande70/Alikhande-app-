//+------------------------------------------------------------------+
//|                                        Alikhande/RiskManager.mqh  |
//|  Position sizing and the kill switches that bound a bad day.      |
//|                                                                   |
//|  Two responsibilities, deliberately together because they share   |
//|  the same equity anchors:                                         |
//|    1. How large may this trade be?                                |
//|    2. May this EA trade at all right now?                         |
//|                                                                   |
//|  Both use EQUITY, never balance. An account can breach a daily    |
//|  limit on floating loss without closing a single trade, and every |
//|  prop firm measures it that way.                                  |
//+------------------------------------------------------------------+
#ifndef ALIKHANDE_RISKMANAGER_MQH
#define ALIKHANDE_RISKMANAGER_MQH

#include <Alikhande/SymbolSpec.mqh>
#include <Alikhande/Logger.mqh>

struct RiskParams
  {
   double            risk_percent;      // % of equity risked per trade
   double            max_lot;           // hard cap, 0 = spec limit only
   double            daily_loss_pct;    // kill switch, 0 = off
   double            max_total_dd_pct;  // kill switch from peak equity, 0 = off
   double            margin_headroom;   // fraction of free margin usable, e.g. 0.90
  };

//--- Sensible defaults. Overridden from EA inputs.
void RiskParamsDefaults(RiskParams &p)
  {
   p.risk_percent     = 0.50;
   p.max_lot          = 1.00;
   p.daily_loss_pct   = 3.00;
   p.max_total_dd_pct = 8.00;
   p.margin_headroom  = 0.90;
  }

class CRiskManager
  {
private:
   CSymbolSpec      *m_spec;
   CLogger          *m_log;
   RiskParams        m_p;

   string            m_gv_day_equity;
   string            m_gv_peak_equity;
   string            m_gv_day_stamp;

   bool              m_halted;
   string            m_halt_reason;

   //--- YYYYMMDD as an exact integer. day_of_year was rejected: it repeats
   //--- across years, so an EA restarted exactly one year later would think
   //--- the day had not rolled and would keep a stale loss budget.
   //---
   //--- Returned as long, not double. The value is integral, and integral
   //--- data compared as integers needs no tolerance argument -- the storage
   //--- layer happens to be a double, but the comparison should not be.
   static long       DayStamp(const datetime t)
     {
      MqlDateTime d;
      TimeToStruct(t, d);
      return((long)d.year * 10000 + (long)d.mon * 100 + (long)d.day);
     }

   static double     Equity(void) { return(AccountInfoDouble(ACCOUNT_EQUITY)); }

   //+---------------------------------------------------------------+
   //| Read an equity anchor, re-establishing it if it has vanished.   |
   //|                                                                 |
   //| GlobalVariableGet returns 0 for a variable that does not exist, |
   //| and the previous code guarded with `if(anchor > 0.0)` -- so a    |
   //| missing anchor SILENTLY DISABLED the kill switch it belonged to. |
   //| Terminal globals are user-visible and user-deletable (F3), and   |
   //| clearing them is an ordinary tidy-up action. An EA whose daily    |
   //| loss limit quietly stops existing because of a stray keypress is |
   //| worse than one that has no limit at all, because the operator    |
   //| still believes there is one.                                     |
   //|                                                                 |
   //| Re-anchoring to current equity does hand out a fresh budget, so  |
   //| it is logged at ERROR rather than passed over. The alternatives   |
   //| are worse: silence hides it, and halting outright turns a stray  |
   //| keypress into a dead EA.                                         |
   //+---------------------------------------------------------------+
   double            ReadAnchor(const string key, const string label)
     {
      if(GlobalVariableCheck(key))
        {
         double v = GlobalVariableGet(key);
         if(v > 0.0) return(v);
        }

      double eq = Equity();
      GlobalVariableSet(key, eq);
      m_log.Error(StringFormat(
         "%s anchor was missing and has been re-established at %s. THE CORRESPONDING "
         "LOSS BUDGET HAS BEEN RESET. If you did not clear the terminal's global "
         "variables, this kill switch was not protecting the account.",
         label, DoubleToString(eq, 2)));
      return(eq);
     }

public:
                     CRiskManager(void) : m_spec(NULL), m_log(NULL), m_halted(false), m_halt_reason("") {}

   //+---------------------------------------------------------------+
   //| Keys are per magic+symbol so two EAs on one account do not      |
   //| share a kill switch and silently halt each other.               |
   //+---------------------------------------------------------------+
   bool              Init(CSymbolSpec &spec, CLogger &log, const long magic, const RiskParams &p)
     {
      m_spec = GetPointer(spec);
      m_log  = GetPointer(log);
      m_p    = p;

      if(!m_spec.IsLoaded())
        {
         m_log.Error("RiskManager.Init: symbol spec not loaded");
         return(false);
        }
      if(m_p.risk_percent <= 0.0)
        {
         m_log.Error("RiskManager.Init: risk_percent must be > 0");
         return(false);
        }
      if(m_p.margin_headroom <= 0.0 || m_p.margin_headroom > 1.0)
         m_p.margin_headroom = 0.90;

      string base = StringFormat("ALK_%I64d_%s_", magic, m_spec.Name());
      m_gv_day_equity  = base + "DAYEQ";
      m_gv_peak_equity = base + "PEAKEQ";
      m_gv_day_stamp   = base + "DAYSTAMP";

      // In the tester, anchors from a previous pass must not leak into this
      // one -- an inherited halt flag would make pass N look flat for reasons
      // that have nothing to do with pass N's parameters.
      if((bool)MQLInfoInteger(MQL_TESTER))
        {
         GlobalVariableDel(m_gv_day_equity);
         GlobalVariableDel(m_gv_peak_equity);
         GlobalVariableDel(m_gv_day_stamp);
        }

      double eq = Equity();
      if(!GlobalVariableCheck(m_gv_day_equity))  GlobalVariableSet(m_gv_day_equity,  eq);
      if(!GlobalVariableCheck(m_gv_peak_equity)) GlobalVariableSet(m_gv_peak_equity, eq);
      if(!GlobalVariableCheck(m_gv_day_stamp))   GlobalVariableSet(m_gv_day_stamp,   (double)DayStamp(TimeCurrent()));

      // Re-derive the halt state from the persisted anchors rather than
      // starting optimistic: a restart mid-drawdown must not resume trading.
      m_halted = false;
      if(LimitBreached())
         m_log.Warn("Risk limit already breached at init - trading halted. Reason: " + m_halt_reason);

      return(true);
     }

   bool              IsHalted(void)   const { return(m_halted); }
   string            HaltReason(void) const { return(m_halt_reason); }

   double            DayStartEquity(void) const { return(GlobalVariableGet(m_gv_day_equity));  }
   double            PeakEquity(void)     const { return(GlobalVariableGet(m_gv_peak_equity)); }

   //+---------------------------------------------------------------+
   //| Call once per tick, before any trading decision.                |
   //+---------------------------------------------------------------+
   void              Update(void)
     {
      RollDayIfNeeded();
      UpdatePeakEquity();
     }

   void              RollDayIfNeeded(void)
     {
      long now_stamp = DayStamp(TimeCurrent());

      //--- A missing stamp is NOT a new day, and saying so would be a lie in
      //--- the journal. Both cases re-anchor, but only one of them is routine.
      bool stamp_missing = !GlobalVariableCheck(m_gv_day_stamp);
      long stored_stamp  = stamp_missing ? 0 : (long)GlobalVariableGet(m_gv_day_stamp);

      if(!stamp_missing && now_stamp == stored_stamp) return;

      double eq = Equity();
      GlobalVariableSet(m_gv_day_stamp,  (double)now_stamp);
      GlobalVariableSet(m_gv_day_equity, eq);
      m_halted      = false;
      m_halt_reason = "";

      if(stamp_missing)
         m_log.Error(StringFormat(
            "Day stamp was missing - re-anchored to %I64d at equity %s. THE DAILY LOSS "
            "BUDGET HAS BEEN RESET and any halt has been cleared. This is not a new "
            "trading day; the terminal's global variables were removed.",
            now_stamp, DoubleToString(eq, 2)));
      else
         m_log.Info(StringFormat("New trading day (%I64d) - daily equity anchor reset to %s",
                                 now_stamp, DoubleToString(eq, 2)));
     }

   void              UpdatePeakEquity(void)
     {
      double eq   = Equity();
      double peak = ReadAnchor(m_gv_peak_equity, "Peak equity");
      if(eq > peak) GlobalVariableSet(m_gv_peak_equity, eq);
     }

   //+---------------------------------------------------------------+
   //| Kill switches. Latches m_halted for the daily limit so the      |
   //| message is printed once, not once per tick.                     |
   //+---------------------------------------------------------------+
   bool              LimitBreached(void)
     {
      double eq = Equity();

      if(m_p.daily_loss_pct > 0.0)
        {
         double day_eq = ReadAnchor(m_gv_day_equity, "Daily equity");
         if(day_eq > 0.0)
           {
            double dd = (day_eq - eq) / day_eq * 100.0;
            if(dd >= m_p.daily_loss_pct)
              {
               if(!m_halted)
                 {
                  m_halt_reason = StringFormat("daily loss %.2f%% >= limit %.2f%%", dd, m_p.daily_loss_pct);
                  m_log.Error("DAILY LOSS LIMIT HIT: " + m_halt_reason + " - halted until the next trading day");
                 }
               m_halted = true;
               return(true);
              }
           }
        }

      if(m_p.max_total_dd_pct > 0.0)
        {
         double peak = ReadAnchor(m_gv_peak_equity, "Peak equity");
         if(peak > 0.0)
           {
            double dd = (peak - eq) / peak * 100.0;
            if(dd >= m_p.max_total_dd_pct)
              {
               if(!m_halted)
                 {
                  m_halt_reason = StringFormat("total drawdown %.2f%% from peak >= limit %.2f%%", dd, m_p.max_total_dd_pct);
                  m_log.Error("TOTAL DRAWDOWN LIMIT HIT: " + m_halt_reason);
                 }
               m_halted = true;
               return(true);
              }
           }
        }

      return(m_halted);
     }

   //+---------------------------------------------------------------+
   //| Risk-based lot size.                                            |
   //|                                                                 |
   //|   loss_per_lot = (stop distance / tick size) * tick value       |
   //|   lots         = risk money / loss_per_lot                      |
   //|                                                                 |
   //| Derived entirely from broker spec, so it is correct on any       |
   //| symbol and any account currency. No pip-value constants, no      |
   //| hardcoded contract sizes -- those are how a lot size ends up     |
   //| 100x too large.                                                 |
   //|                                                                 |
   //| Returns 0.0 when the risk budget cannot cover the minimum lot.   |
   //| 0.0 means "do not trade", never "trade the minimum".             |
   //+---------------------------------------------------------------+
   double            CalcLots(const double sl_distance_price) const
     {
      if(sl_distance_price <= 0.0) return(0.0);

      double loss_per_lot = LossPerLot(sl_distance_price);
      if(loss_per_lot <= 0.0) return(0.0);

      double risk_money = Equity() * m_p.risk_percent / 100.0;
      if(risk_money <= 0.0) return(0.0);

      return(m_spec.NormalizeVolume(risk_money / loss_per_lot, m_p.max_lot));
     }

   double            LossPerLot(const double sl_distance_price) const
     {
      if(m_spec.TickSize() <= 0.0) return(0.0);
      return((sl_distance_price / m_spec.TickSize()) * m_spec.TickValue());
     }

   //--- Money genuinely at risk for the lot that will actually be sent.
   //--- Recomputed after normalization because rounding down changes it.
   double            MoneyAtRisk(const double lots, const double sl_distance_price) const
     {
      return(lots * LossPerLot(sl_distance_price));
     }

   double            RiskPercentOfEquity(const double lots, const double sl_distance_price) const
     {
      double eq = Equity();
      if(eq <= 0.0) return(0.0);
      return(MoneyAtRisk(lots, sl_distance_price) / eq * 100.0);
     }

   //+---------------------------------------------------------------+
   //| Pre-flight margin check. Catches retcode 10019 before it is     |
   //| sent, and catches a sizing bug that produced an absurd lot.     |
   //+---------------------------------------------------------------+
   bool              MarginAffordable(const ENUM_ORDER_TYPE type, const double lots, const double price) const
     {
      double margin = 0.0;
      if(!OrderCalcMargin(type, m_spec.Name(), lots, price, margin))
        {
         m_log.Warn(StringFormat("OrderCalcMargin failed (err=%d) - refusing the trade", GetLastError()));
         return(false);
        }

      double free_margin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
      if(free_margin <= 0.0) return(false);

      // margin == 0 is legitimate (a fully offsetting order on a netting
      // account, or a zero-margin instrument), so it is not a failure.
      return(margin <= free_margin * m_p.margin_headroom);
     }
  };

#endif // ALIKHANDE_RISKMANAGER_MQH
