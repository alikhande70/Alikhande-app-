//+------------------------------------------------------------------+
//|                                      Alikhande/OrderExecutor.mqh  |
//|  The order layer. Everything here exists because of a specific    |
//|  way real EAs lose money.                                         |
//|                                                                   |
//|  Central rule: CTrade::Buy() returning true means the request     |
//|  LEFT THE TERMINAL. It says nothing about the fill. The retcode   |
//|  is the only truth, and it must be classified before it is acted  |
//|  on -- retrying a spec error in a loop is how an EA gets its      |
//|  account rate-limited by the broker.                              |
//+------------------------------------------------------------------+
#ifndef ALIKHANDE_ORDEREXECUTOR_MQH
#define ALIKHANDE_ORDEREXECUTOR_MQH

#include <Trade/Trade.mqh>
#include <Trade/PositionInfo.mqh>
#include <Alikhande/SymbolSpec.mqh>
#include <Alikhande/Logger.mqh>

//+------------------------------------------------------------------+
//| Retcode classification. A bool cannot express "the order may have |
//| filled and I do not know", which is the single most dangerous     |
//| state an EA can be in.                                            |
//+------------------------------------------------------------------+
enum ENUM_RETCODE_CLASS
  {
   RC_SUCCESS,      // filled: done or partial
   //--- A pending order reached the book. It is NOT a position, and it was
   //--- previously folded into RC_SUCCESS, so the caller was told it had a
   //--- fill while every ownership query - which reads PositionsTotal() -
   //--- reported nothing owned. An EA in that state believes its entry never
   //--- happened and is free to send it again.
   RC_PENDING_PLACED,
   RC_RETRYABLE,    // transient; the order provably did NOT execute
   RC_SPEC_ERROR,   // our bug: volume, stops, price, filling mode. Never retry.
   RC_ENVIRONMENT,  // market closed, trading disabled, direction prohibited
   RC_AMBIGUOUS     // may or may not have executed. Resync, never blind-resend.
  };

struct OrderResult
  {
   bool     ok;
   uint     retcode;
   ulong    deal;
   ulong    order;
   double   volume_requested;
   double   volume_filled;
   double   price;
   bool     partial;
   //--- True when the request produced a PENDING ORDER rather than a position.
   //--- Callers must not treat this as an open trade: there is nothing to
   //--- manage, nothing to stop out, and the entry has not happened yet.
   bool     pending;
   string   message;
  };

void OrderResultReset(OrderResult &r)
  {
   r.ok = false; r.retcode = 0; r.deal = 0; r.order = 0;
   r.volume_requested = 0.0; r.volume_filled = 0.0; r.price = 0.0;
   r.partial = false; r.pending = false; r.message = "";
  }

class COrderExecutor
  {
private:
   CTrade            m_trade;
   CPositionInfo     m_pos;
   CSymbolSpec      *m_spec;
   CLogger          *m_log;

   long              m_magic;
   string            m_comment;
   int               m_max_retries;
   int               m_retry_wait_ms;
   long              m_stop_buffer_pts;
   //--- Ceiling on the risk a single position may imply, as a percent of
   //--- equity. 0 disables the guard. See ModifyStops for why it exists.
   double            m_max_risk_pct;
   bool              m_risk_warn;

public:
                     COrderExecutor(void)
     : m_spec(NULL), m_log(NULL), m_magic(0), m_comment("ALK"),
       m_max_retries(3), m_retry_wait_ms(250), m_stop_buffer_pts(10),
       m_max_risk_pct(0.0), m_risk_warn(false) {}

   bool              Init(CSymbolSpec &spec, CLogger &log,
                          const long magic, const string comment,
                          const int deviation_points,
                          const int max_retries, const int retry_wait_ms,
                          const long stop_buffer_points)
     {
      m_spec            = GetPointer(spec);
      m_log             = GetPointer(log);
      m_magic           = magic;
      m_comment         = comment;
      m_max_retries     = (max_retries     > 0 ? max_retries     : 1);
      m_retry_wait_ms   = (retry_wait_ms  >= 0 ? retry_wait_ms   : 0);
      m_stop_buffer_pts = (stop_buffer_points >= 0 ? stop_buffer_points : 0);

      if(!m_spec.IsLoaded())
        {
         m_log.Error("OrderExecutor.Init: symbol spec not loaded");
         return(false);
        }

      //--- Resolve the filling mode ONCE and refuse to start if no legal mode
      //--- exists. Sending an illegal mode produces 10030 on every single tick,
      //--- which looks like a strategy that never trades rather than a config bug.
      ENUM_ORDER_TYPE_FILLING filling;
      string filling_why;
      if(!m_spec.ResolveFilling(filling, filling_why))
        {
         m_log.Error("OrderExecutor.Init: " + filling_why);
         return(false);
        }

      m_trade.SetExpertMagicNumber(m_magic);
      m_trade.SetDeviationInPoints(deviation_points > 0 ? deviation_points : 10);
      m_trade.SetTypeFilling(filling);
      m_trade.SetAsyncMode(false);          // synchronous: we need the retcode
      m_trade.LogLevel(LOG_LEVEL_ERRORS);

      m_log.Info(StringFormat("OrderExecutor ready | magic=%I64d filling=%s (%s) deviation=%d stopBuffer=%dpts",
                              m_magic, EnumToString(filling), filling_why,
                              deviation_points, (int)m_stop_buffer_pts));
      return(true);
     }

   //+---------------------------------------------------------------+
   //| Arm the risk guard. Pass the same percent the RiskManager sizes  |
   //| with, so a stop can never imply more than the position was sized |
   //| for. 0 disables the guard, which is the old behaviour.           |
   //+---------------------------------------------------------------+
   void              SetMaxRiskPercent(const double pct) { m_max_risk_pct = pct; }
   bool              RiskWarningRaised(void) const { return(m_risk_warn); }
   void              ClearRiskWarning(void) { m_risk_warn = false; }

   //+---------------------------------------------------------------+
   //| Money at risk implied by a stop, in the account currency.       |
   //|                                                                 |
   //| THE POINT: this was never recomputed. Risk was worked out once   |
   //| at open, from the stop the entry was sized against, and then     |
   //| treated as a constant for the life of the position. Moving the   |
   //| stop changes the money at risk and nothing noticed - so a        |
   //| trailing routine with a sign error, a break-even step that       |
   //| widened instead of tightened, or a manual adjustment could carry |
   //| several times the configured risk with a correctly-sized lot and |
   //| a clean journal.                                                 |
   //+---------------------------------------------------------------+
   double            RiskAtStop(const double volume, const double entry, const double sl) const
     {
      if(volume <= 0.0 || sl <= 0.0 || entry <= 0.0) return(0.0);
      if(m_spec.TickSize() <= 0.0) return(0.0);
      double distance = MathAbs(entry - sl);
      return(volume * (distance / m_spec.TickSize()) * m_spec.TickValue());
     }

   double            RiskPctAtStop(const double volume, const double entry, const double sl) const
     {
      double eq = AccountInfoDouble(ACCOUNT_EQUITY);
      if(eq <= 0.0) return(0.0);
      return(RiskAtStop(volume, entry, sl) / eq * 100.0);
     }

   //+---------------------------------------------------------------+
   //| Classification. The three-bucket split from the retcode guide,  |
   //| plus a fourth for the genuinely unknowable.                     |
   //+---------------------------------------------------------------+
   static ENUM_RETCODE_CLASS Classify(const uint rc)
     {
      switch(rc)
        {
         case TRADE_RETCODE_DONE:              // 10009
         case TRADE_RETCODE_DONE_PARTIAL:      // 10010
            return(RC_SUCCESS);

         case TRADE_RETCODE_PLACED:            // 10008 - pending, not a fill
            return(RC_PENDING_PLACED);

         //--- Transient. Each of these guarantees the order did NOT execute,
         //--- which is what makes resending safe.
         case TRADE_RETCODE_REQUOTE:           // 10004
         case TRADE_RETCODE_PRICE_CHANGED:     // 10020
         case TRADE_RETCODE_PRICE_OFF:         // 10021
         case TRADE_RETCODE_TOO_MANY_REQUESTS: // 10024
         case TRADE_RETCODE_LOCKED:            // 10028
         case TRADE_RETCODE_CONNECTION:        // 10031
            return(RC_RETRYABLE);

         //--- TIMEOUT: the request was cancelled locally. It may still have
         //--- reached the server and filled. Blind resend is the classic
         //--- double-position bug, so this gets its own class.
         case TRADE_RETCODE_TIMEOUT:           // 10012
            return(RC_AMBIGUOUS);

         //--- Our bugs. Retrying changes nothing except the log volume.
         case TRADE_RETCODE_INVALID:           // 10013
         case TRADE_RETCODE_INVALID_VOLUME:    // 10014
         case TRADE_RETCODE_INVALID_PRICE:     // 10015
         case TRADE_RETCODE_INVALID_STOPS:     // 10016
         case TRADE_RETCODE_NO_MONEY:          // 10019
         case TRADE_RETCODE_INVALID_FILL:      // 10030
         case TRADE_RETCODE_INVALID_CLOSE_VOLUME: // 10038
            return(RC_SPEC_ERROR);

         default:
            //--- Market closed, trading disabled, long/short only, FIFO, etc.
            //--- Adjust behaviour; do not retry, do not treat as a code bug.
            return(RC_ENVIRONMENT);
        }
     }

   static string     ClassName(const ENUM_RETCODE_CLASS c)
     {
      switch(c)
        {
         case RC_SUCCESS:        return("FILLED");
         case RC_PENDING_PLACED: return("PENDING_PLACED");
         case RC_RETRYABLE:   return("RETRYABLE");
         case RC_SPEC_ERROR:  return("SPEC_ERROR");
         case RC_ENVIRONMENT: return("ENVIRONMENT");
         case RC_AMBIGUOUS:   return("AMBIGUOUS");
        }
      return("UNKNOWN");
     }

   //+---------------------------------------------------------------+
   //| Re-derive a stop from a fresh price after a requote.            |
   //|                                                                 |
   //| THE ZERO CASE IS THE POINT. old_sl == 0.0 means "no stop was     |
   //| requested", which is a deliberate state: OpenThenProtect sends   |
   //| an unstopped order on purpose under Instant execution. Treating  |
   //| 0.0 as a stop price makes the distance MathAbs(price - 0) --     |
   //| the entire price -- so a SELL would come back with a stop at     |
   //| twice the market. A BUY would come back at 0.0 and look correct  |
   //| purely by arithmetic coincidence.                                |
   //|                                                                 |
   //| Public and static so it can be asserted directly; the order path |
   //| that uses it needs a trade server and cannot be unit-tested.     |
   //+---------------------------------------------------------------+
   static double     RecomputeStop(const bool is_buy, const double price,
                                   const double old_sl, const double min_dist)
     {
      if(old_sl <= 0.0 || price <= 0.0) return(0.0);
      double dist = MathMax(MathAbs(price - old_sl), min_dist);
      return(is_buy ? price - dist : price + dist);
     }

   //--- Same contract for the target: 0.0 in, 0.0 out.
   static double     RecomputeTarget(const bool is_buy, const double price,
                                     const double old_tp, const double min_dist)
     {
      if(old_tp <= 0.0 || price <= 0.0) return(0.0);
      double dist = MathMax(MathAbs(old_tp - price), min_dist);
      return(is_buy ? price + dist : price - dist);
     }

   //====================================================================
   //  OWNERSHIP
   //====================================================================
   //--- Filter on symbol AND magic, always. Magic alone breaks when the same
   //--- EA runs on several charts; symbol alone lets the EA close a human's
   //--- manual trade.
   bool              Owns(void)
     {
      return(m_pos.Symbol() == m_spec.Name() && m_pos.Magic() == m_magic);
     }

   int               CountOwned(void)
     {
      int n = 0;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
         if(!m_pos.SelectByIndex(i)) continue;
         if(Owns()) n++;
        }
      return(n);
     }

   //+---------------------------------------------------------------+
   //| Pending orders this EA owns.                                    |
   //|                                                                 |
   //| Every other ownership query reads PositionsTotal(), which does  |
   //| not see the order book at all. Without this an EA that has a    |
   //| working order resting at a level believes it owns nothing.      |
   //+---------------------------------------------------------------+
   int               CountOwnedPending(void)
     {
      int n = 0;
      for(int i = OrdersTotal() - 1; i >= 0; i--)
        {
         ulong ticket = OrderGetTicket(i);
         if(ticket == 0) continue;
         if(OrderGetString(ORDER_SYMBOL) != m_spec.Name()) continue;
         if(OrderGetInteger(ORDER_MAGIC)  != m_magic)      continue;
         n++;
        }
      return(n);
     }

   //--- Positions plus resting orders. This is the number to compare against a
   //--- "max concurrent" limit: an order about to become a position is
   //--- exposure the account has already committed to.
   int               CountOwnedExposure(void)
     {
      return(CountOwned() + CountOwnedPending());
     }

   //--- Cancel resting orders. CloseAllOwned closes POSITIONS only, so a risk
   //--- halt that called it alone would leave working orders behind, free to
   //--- fill into the very drawdown that triggered the halt.
   int               CancelAllOwnedPending(const string reason)
     {
      int cancelled = 0;
      for(int i = OrdersTotal() - 1; i >= 0; i--)
        {
         ulong ticket = OrderGetTicket(i);
         if(ticket == 0) continue;
         if(OrderGetString(ORDER_SYMBOL) != m_spec.Name()) continue;
         if(OrderGetInteger(ORDER_MAGIC)  != m_magic)      continue;
         if(m_trade.OrderDelete(ticket))
           {
            m_log.Info(StringFormat("Cancelled pending %I64u - %s", ticket, reason));
            cancelled++;
           }
         else
            m_log.Warn(StringFormat("Cancel pending %I64u failed: retcode=%u (%s)",
                                    ticket, m_trade.ResultRetcode(),
                                    m_trade.ResultRetcodeDescription()));
        }
      return(cancelled);
     }

   double            OwnedVolume(void)
     {
      double v = 0.0;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
         if(!m_pos.SelectByIndex(i)) continue;
         if(Owns()) v += m_pos.Volume();
        }
      return(v);
     }

   //--- True when at least one owned position has no stop loss. Used as a
   //--- safety assertion: a naked position is never an acceptable steady state.
   bool              HasUnprotectedPosition(void)
     {
      for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
         if(!m_pos.SelectByIndex(i)) continue;
         if(!Owns()) continue;
         if(m_pos.StopLoss() <= 0.0) return(true);
        }
      return(false);
     }

   //====================================================================
   //  OPENING
   //====================================================================
   //+---------------------------------------------------------------+
   //| Open a market position sized by the caller.                     |
   //|                                                                 |
   //| sl_distance / tp_distance are PRICE deltas from entry, already  |
   //| risk-sized. They are floored at the broker minimum here, which  |
   //| means the realised risk can exceed the requested risk when the  |
   //| strategy asks for a stop tighter than the broker allows -- the  |
   //| caller is told so it can re-size or skip.                       |
   //+---------------------------------------------------------------+
   bool              OpenMarket(const bool is_buy,
                                const double lots,
                                const double sl_distance,
                                const double tp_distance,
                                OrderResult &out)
     {
      OrderResultReset(out);

      if(lots <= 0.0)
        {
         out.message = "lot size is 0 - refusing to send";
         m_log.Warn(out.message);
         return(false);
        }

      if(!m_spec.TradeAllowed(is_buy))
        {
         out.message = StringFormat("symbol trade mode %d forbids %s",
                                    (int)m_spec.TradeMode(), (is_buy ? "BUY" : "SELL"));
         m_log.Warn(out.message);
         return(false);
        }

      double price = is_buy ? m_spec.Ask() : m_spec.Bid();
      if(price <= 0.0)
        {
         out.message = "no price available";
         m_log.Warn(out.message);
         return(false);
        }

      double min_dist = m_spec.MinStopDistance(m_stop_buffer_pts);
      double sl_dist  = MathMax(sl_distance, min_dist);
      double tp_dist  = (tp_distance > 0.0) ? MathMax(tp_distance, min_dist) : 0.0;

      if(sl_dist > sl_distance + 1e-12)
         m_log.Warn(StringFormat(
            "Requested stop %.1f pts is below the broker minimum %.1f pts; widened. "
            "Realised risk now EXCEEDS the configured risk percent.",
            m_spec.PriceToPoints(sl_distance), m_spec.PriceToPoints(min_dist)));

      double sl = m_spec.NormalizePrice(is_buy ? price - sl_dist : price + sl_dist);
      double tp = 0.0;
      if(tp_dist > 0.0)
         tp = m_spec.NormalizePrice(is_buy ? price + tp_dist : price - tp_dist);

      out.volume_requested = lots;

      if(SendWithRetry(is_buy, lots, sl, tp, out))
         return(true);

      //--- Instant-execution brokers may refuse stops attached to the entry
      //--- request. Detect that specific case and use the open-then-modify
      //--- path instead of giving up.
      if(out.retcode == TRADE_RETCODE_INVALID_STOPS &&
         m_spec.ExecMode() == SYMBOL_TRADE_EXECUTION_INSTANT)
        {
         m_log.Warn("10016 under Instant execution - retrying without attached stops, then modifying.");
         return(OpenThenProtect(is_buy, lots, sl_dist, tp_dist, out));
        }

      return(false);
     }

private:
   //+---------------------------------------------------------------+
   //| Send, read the retcode, and act on its CLASS.                   |
   //+---------------------------------------------------------------+
   bool              SendWithRetry(const bool is_buy, const double lots,
                                   double sl, double tp, OrderResult &out)
     {
      for(int attempt = 1; attempt <= m_max_retries; attempt++)
        {
         bool sent = is_buy
                     ? m_trade.Buy (lots, m_spec.Name(), 0.0, sl, tp, m_comment)
                     : m_trade.Sell(lots, m_spec.Name(), 0.0, sl, tp, m_comment);

         uint rc = m_trade.ResultRetcode();
         out.retcode = rc;
         ENUM_RETCODE_CLASS cls = Classify(rc);

         if(sent && cls == RC_PENDING_PLACED)
           {
            //--- Reported honestly and NOT as a fill. The market path in this
            //--- EA cannot currently produce it, so reaching here means either
            //--- a pending strategy was added or the broker converted the
            //--- request - both worth knowing about loudly.
            out.ok      = false;
            out.pending = true;
            out.order   = m_trade.ResultOrder();
            out.message = StringFormat("PENDING ORDER PLACED (retcode 10008), order=%I64u. "
                                       "This is not a position: no entry has occurred.",
                                       out.order);
            m_log.Warn(out.message);
            return(false);
           }

         if(sent && cls == RC_SUCCESS)
           {
            out.ok            = true;
            out.deal          = m_trade.ResultDeal();
            out.order         = m_trade.ResultOrder();
            out.volume_filled = m_trade.ResultVolume();
            out.price         = m_trade.ResultPrice();
            out.partial       = (rc == TRADE_RETCODE_DONE_PARTIAL) ||
                                (out.volume_filled > 0.0 && out.volume_filled < lots - 1e-8);

            out.message = StringFormat("%s %s lots @ %s deal=%I64u",
                                       (is_buy ? "BUY" : "SELL"),
                                       DoubleToString(out.volume_filled, m_spec.VolumeDigits()),
                                       DoubleToString(out.price, m_spec.Digits_()),
                                       out.deal);
            m_log.Info("FILLED " + out.message);

            if(out.partial)
               m_log.Warn(StringFormat(
                  "PARTIAL FILL: asked %s got %s. Realised risk is smaller than planned "
                  "and any lot-derived figure downstream is now stale.",
                  DoubleToString(lots, m_spec.VolumeDigits()),
                  DoubleToString(out.volume_filled, m_spec.VolumeDigits())));

            return(true);
           }

         out.message = StringFormat("attempt %d/%d retcode=%u [%s] %s",
                                    attempt, m_max_retries, rc, ClassName(cls),
                                    m_trade.ResultRetcodeDescription());

         if(cls == RC_AMBIGUOUS)
           {
            m_log.Error("AMBIGUOUS result (" + out.message + "). The order may have filled. "
                        "NOT resending. Positions will be re-read on the next tick.");
            return(false);
           }

         if(cls != RC_RETRYABLE)
           {
            m_log.Error("Aborting: " + out.message +
                        (cls == RC_SPEC_ERROR
                         ? " | This is a code or spec bug - fix it, do not retry. " + DiagnoseSpecError(rc, lots, sl, tp, is_buy)
                         : " | Environmental - skipping this trade."));
            return(false);
           }

         m_log.Warn("Retrying: " + out.message);
         if(m_retry_wait_ms > 0) Sleep(m_retry_wait_ms);

         //--- Price moved. Re-derive the stops from the FRESH price: resending
         //--- the stale SL/TP after a requote is the one case almost certain to
         //--- fail again, and it turns a transient 10004 into a hard 10016.
         double p = is_buy ? m_spec.Ask() : m_spec.Bid();
         if(p <= 0.0) { m_log.Error("No price on retry - aborting."); return(false); }

         double min_dist = m_spec.MinStopDistance(m_stop_buffer_pts);

         //--- An unstopped request must stay unstopped through the retry.
         //--- See RecomputeStop for why the zero case needs saying out loud.
         double new_sl = RecomputeStop(is_buy, p, sl, min_dist);
         double new_tp = RecomputeTarget(is_buy, p, tp, min_dist);
         sl = (new_sl > 0.0) ? m_spec.NormalizePrice(new_sl) : 0.0;
         tp = (new_tp > 0.0) ? m_spec.NormalizePrice(new_tp) : 0.0;
        }

      m_log.Error("All retries exhausted.");
      return(false);
     }

   //--- Print the numbers that actually identify the cause, so the journal
   //--- answers the question instead of just recording that it was asked.
   string            DiagnoseSpecError(const uint rc, const double lots,
                                       const double sl, const double tp, const bool is_buy)
     {
      if(rc == TRADE_RETCODE_INVALID_VOLUME)
         return(StringFormat("vol=%s min=%s max=%s step=%s",
                             DoubleToString(lots,               m_spec.VolumeDigits()),
                             DoubleToString(m_spec.VolumeMin(), m_spec.VolumeDigits()),
                             DoubleToString(m_spec.VolumeMax(), m_spec.VolumeDigits()),
                             DoubleToString(m_spec.VolumeStep(),m_spec.VolumeDigits())));

      if(rc == TRADE_RETCODE_INVALID_STOPS)
        {
         double p = is_buy ? m_spec.Ask() : m_spec.Bid();
         return(StringFormat("price=%s SL=%s (%.1f pts) TP=%s | stopsLevel=%d pts spread=%d pts",
                             DoubleToString(p,  m_spec.Digits_()),
                             DoubleToString(sl, m_spec.Digits_()),
                             m_spec.PriceToPoints(MathAbs(p - sl)),
                             DoubleToString(tp, m_spec.Digits_()),
                             (int)m_spec.StopsLevel(), (int)m_spec.SpreadPts()));
        }

      if(rc == TRADE_RETCODE_INVALID_FILL)
         return("advertised filling modes: " + m_spec.FillingMaskText());

      if(rc == TRADE_RETCODE_NO_MONEY)
         return(StringFormat("freeMargin=%.2f requested lots=%s",
                             AccountInfoDouble(ACCOUNT_MARGIN_FREE),
                             DoubleToString(lots, m_spec.VolumeDigits())));

      return("");
     }

   //+---------------------------------------------------------------+
   //| Open without stops, then attach them.                           |
   //|                                                                 |
   //| This leaves the position naked for a few hundred milliseconds,  |
   //| which is only acceptable because the alternative under Instant  |
   //| execution is not opening at all. If the protective modify fails,|
   //| the position is CLOSED immediately -- an unprotected position is |
   //| never left running.                                             |
   //+---------------------------------------------------------------+
   bool              OpenThenProtect(const bool is_buy, const double lots,
                                     const double sl_dist, const double tp_dist,
                                     OrderResult &out)
     {
      OrderResultReset(out);
      out.volume_requested = lots;

      //--- Snapshot what we already own BEFORE sending. Identifying the new
      //--- position by "most recent" afterwards is not safe: POSITION_TIME has
      //--- one-second resolution, so a position opened in the same second as an
      //--- existing one is indistinguishable by time, and picking the wrong one
      //--- means attaching this entry's stop to a healthy older position - and,
      //--- if the modify then fails, closing that healthy position while the
      //--- genuinely unprotected one keeps running.
      ulong before[];
      SnapshotOwnedTickets(before);

      if(!SendWithRetry(is_buy, lots, 0.0, 0.0, out))
        {
         m_log.Error("Open-then-protect: the unstopped open also failed.");
         return(false);
        }

      double entry = out.price;
      double sl = m_spec.NormalizePrice(is_buy ? entry - sl_dist : entry + sl_dist);
      double tp = (tp_dist > 0.0)
                  ? m_spec.NormalizePrice(is_buy ? entry + tp_dist : entry - tp_dist)
                  : 0.0;

      ulong ticket = FindNewTicket(before, out.deal);
      if(ticket == 0)
        {
         //--- Close only what appeared since the snapshot. Closing everything
         //--- owned would punish positions that were already correctly stopped.
         m_log.Error("Open-then-protect: cannot identify the new position. "
                     "Closing whatever appeared since the snapshot.");
         CloseTicketsNotIn(before, "unidentifiable position after an unstopped open");
         out.ok = false;
         return(false);
        }

      for(int attempt = 1; attempt <= m_max_retries; attempt++)
        {
         if(m_trade.PositionModify(ticket, sl, tp))
           {
            m_log.Info(StringFormat("Stops attached post-open: SL=%s TP=%s",
                                    DoubleToString(sl, m_spec.Digits_()),
                                    DoubleToString(tp, m_spec.Digits_())));
            return(true);
           }
         m_log.Warn(StringFormat("Protective modify attempt %d/%d failed: retcode=%u (%s)",
                                 attempt, m_max_retries, m_trade.ResultRetcode(),
                                 m_trade.ResultRetcodeDescription()));
         if(m_retry_wait_ms > 0) Sleep(m_retry_wait_ms);
        }

      m_log.Error("Could not attach a stop loss. Closing the position rather than running it naked.");
      ClosePosition(ticket, "no stop loss could be attached");
      out.ok = false;
      return(false);
     }

   //--- Every position this EA owns right now.
   void              SnapshotOwnedTickets(ulong &dst[])
     {
      ArrayResize(dst, 0);
      for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
         if(!m_pos.SelectByIndex(i)) continue;
         if(!Owns()) continue;
         int n = ArraySize(dst);
         ArrayResize(dst, n + 1);
         dst[n] = m_pos.Ticket();
        }
     }

   //--- Close only the owned positions absent from the snapshot.
   int               CloseTicketsNotIn(const ulong &known[], const string reason)
     {
      ulong now_owned[];
      SnapshotOwnedTickets(now_owned);
      int closed = 0;
      for(int i = 0; i < ArraySize(now_owned); i++)
        {
         if(TicketInArray(now_owned[i], known)) continue;
         if(ClosePosition(now_owned[i], reason)) closed++;
        }
      return(closed);
     }

public:
   //--- Pure membership test, public and static so it can be asserted directly.
   //--- The ticket-diff logic is the part of new-position identification that
   //--- can be tested without a trade server.
   static bool       TicketInArray(const ulong needle, const ulong &hay[])
     {
      for(int i = 0; i < ArraySize(hay); i++)
         if(hay[i] == needle) return(true);
      return(false);
     }

   //--- Exactly one ticket present now but absent from `known`, or 0.
   //--- 0 means "cannot identify", which callers must treat as a failure --
   //--- never as "probably the newest one".
   static ulong      SoleNewTicket(const ulong &now_owned[], const ulong &known[])
     {
      ulong found = 0;
      int   count = 0;
      for(int i = 0; i < ArraySize(now_owned); i++)
        {
         if(TicketInArray(now_owned[i], known)) continue;
         found = now_owned[i];
         count++;
        }
      return(count == 1 ? found : 0);
     }

private:
   //+---------------------------------------------------------------+
   //| Identify the position just opened.                              |
   //|                                                                 |
   //| Two routes, in order of reliability:                            |
   //|   1. the deal's DEAL_POSITION_ID -- exact when history is there  |
   //|   2. the ticket that was not owned before the send               |
   //|                                                                 |
   //| Deliberately NOT a route: "the position with the latest time".   |
   //| POSITION_TIME is second-resolution, so two positions opened in    |
   //| the same second are indistinguishable, and guessing wrong here   |
   //| attaches this entry's stop to somebody else's position.          |
   //+---------------------------------------------------------------+
   ulong             FindNewTicket(const ulong &before[], const ulong deal)
     {
      if(deal != 0)
        {
         //--- Defensive: ask for a recent history window before selecting the
         //--- deal. Harmless when the deal is already cached.
         HistorySelect(TimeCurrent() - 3600, TimeCurrent() + 60);
         if(HistoryDealSelect(deal))
           {
            ulong pos_id = (ulong)HistoryDealGetInteger(deal, DEAL_POSITION_ID);
            if(pos_id != 0 && m_pos.SelectByTicket(pos_id) && Owns())
               return(pos_id);
           }
        }

      ulong now_owned[];
      SnapshotOwnedTickets(now_owned);
      ulong sole = SoleNewTicket(now_owned, before);

      if(sole == 0)
         m_log.Error(StringFormat(
            "Cannot identify the new position: owned %d before, %d now, and the deal "
            "lookup did not resolve. Refusing to guess.",
            ArraySize(before), ArraySize(now_owned)));

      return(sole);
     }

public:
   //====================================================================
   //  MODIFY / CLOSE
   //====================================================================
   //+---------------------------------------------------------------+
   //| Modify stops, respecting both broker distance limits.           |
   //|   stops level  -> minimum distance from price (10016)           |
   //|   freeze level -> band where modification is refused (10029)    |
   //| Also skips a modify that would change nothing (10025 log spam). |
   //+---------------------------------------------------------------+
   bool              ModifyStops(const ulong ticket, const double new_sl, const double new_tp)
     {
      if(!m_pos.SelectByTicket(ticket) || !Owns())
        {
         m_log.Warn(StringFormat("ModifyStops: ticket %I64u is not an owned position", ticket));
         return(false);
        }

      bool   is_buy = (m_pos.PositionType() == POSITION_TYPE_BUY);
      double price  = is_buy ? m_spec.Bid() : m_spec.Ask();   // the side the server validates against
      if(price <= 0.0) return(false);

      double sl = (new_sl > 0.0) ? m_spec.NormalizePrice(new_sl) : 0.0;
      double tp = (new_tp > 0.0) ? m_spec.NormalizePrice(new_tp) : 0.0;

      //--- No-change guard: comparing doubles with == would never match.
      double tol = m_spec.Point_() / 2.0;
      if(MathAbs(sl - m_pos.StopLoss()) < tol && MathAbs(tp - m_pos.TakeProfit()) < tol)
         return(true);

      //--- Freeze zone: inside it the server refuses, so do not ask.
      double freeze = m_spec.FreezeDistance();
      if(freeze > 0.0)
        {
         if(m_pos.StopLoss()   > 0.0 && MathAbs(price - m_pos.StopLoss())   < freeze) { m_log.Debug("ModifyStops skipped: SL inside freeze level"); return(false); }
         if(m_pos.TakeProfit() > 0.0 && MathAbs(price - m_pos.TakeProfit()) < freeze) { m_log.Debug("ModifyStops skipped: TP inside freeze level"); return(false); }
        }

      //--- Distance limit, and the stop must be on the correct side.
      double min_dist = m_spec.MinStopDistance(m_stop_buffer_pts);
      if(sl > 0.0)
        {
         if(is_buy  && sl > price - min_dist) { m_log.Debug("ModifyStops skipped: BUY SL too close/above price");  return(false); }
         if(!is_buy && sl < price + min_dist) { m_log.Debug("ModifyStops skipped: SELL SL too close/below price"); return(false); }
        }
      if(tp > 0.0)
        {
         if(is_buy  && tp < price + min_dist) { m_log.Debug("ModifyStops skipped: BUY TP too close");  return(false); }
         if(!is_buy && tp > price - min_dist) { m_log.Debug("ModifyStops skipped: SELL TP too close"); return(false); }
        }

      //--- RE-DERIVE THE RISK THIS STOP IMPLIES. A stop that moves AWAY from
      //--- entry increases the money at risk on an already-sized position.
      //--- Tightening is always allowed; widening is reported, and widening
      //--- past the configured ceiling is refused outright, because there is
      //--- no legitimate routine that does it and every bug that does it costs
      //--- more than the trade was ever meant to.
      if(sl > 0.0)
        {
         double entry   = m_pos.PriceOpen();
         double volume  = m_pos.Volume();
         double old_sl  = m_pos.StopLoss();
         double new_risk = RiskAtStop(volume, entry, sl);
         double old_risk = (old_sl > 0.0) ? RiskAtStop(volume, entry, old_sl) : 0.0;

         if(old_sl > 0.0 && new_risk > old_risk + 1e-8)
           {
            double new_pct = RiskPctAtStop(volume, entry, sl);
            string detail = StringFormat(
               "stop widened on %I64u: risk %.2f -> %.2f %s (%.2f%% of equity)",
               ticket, old_risk, new_risk, AccountInfoString(ACCOUNT_CURRENCY), new_pct);

            if(m_max_risk_pct > 0.0 && new_pct > m_max_risk_pct)
              {
               m_risk_warn = true;
               m_log.Error("REFUSED: " + detail + StringFormat(
                  ". That exceeds the %.2f%% ceiling this position was sized against. "
                  "Tightening a stop is always permitted; widening one past the ceiling "
                  "is a bug in the caller, not a decision to honour.", m_max_risk_pct));
               return(false);
              }
            m_risk_warn = true;
            m_log.Warn("RISK INCREASED - " + detail +
                       ". Within the ceiling, but the position now risks more than it did.");
           }
        }

      if(m_trade.PositionModify(ticket, sl, tp))
        {
         double shown = (sl > 0.0) ? RiskPctAtStop(m_pos.Volume(), m_pos.PriceOpen(), sl) : 0.0;
         m_log.Info(StringFormat("Modified %I64u: SL=%s TP=%s | risk now %.2f%% of equity",
                                 ticket,
                                 DoubleToString(sl, m_spec.Digits_()),
                                 DoubleToString(tp, m_spec.Digits_()), shown));
         return(true);
        }

      uint rc = m_trade.ResultRetcode();
      if(rc == TRADE_RETCODE_NO_CHANGES) return(true);   // harmless
      m_log.Warn(StringFormat("Modify %I64u failed: retcode=%u (%s)",
                              ticket, rc, m_trade.ResultRetcodeDescription()));
      return(false);
     }

   bool              ClosePosition(const ulong ticket, const string reason)
     {
      if(m_trade.PositionClose(ticket))
        {
         m_log.Info(StringFormat("Closed %I64u - %s", ticket, reason));
         return(true);
        }

      uint rc = m_trade.ResultRetcode();
      //--- The position may have hit its stop between our select and our close.
      //--- That is normal, not an incident.
      if(rc == TRADE_RETCODE_POSITION_CLOSED)
        {
         m_log.Debug(StringFormat("Position %I64u was already closed", ticket));
         return(true);
        }

      m_log.Error(StringFormat("Close %I64u failed: retcode=%u (%s)",
                               ticket, rc, m_trade.ResultRetcodeDescription()));
      return(false);
     }

   //--- Iterate DOWNWARDS: the collection shrinks as positions close, and an
   //--- upward loop skips every second position.
   int               CloseAllOwned(const string reason)
     {
      int closed = 0;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
         if(!m_pos.SelectByIndex(i)) continue;
         if(!Owns()) continue;
         if(ClosePosition(m_pos.Ticket(), reason)) closed++;
        }
      return(closed);
     }

   CTrade           *Trade(void) { return(GetPointer(m_trade)); }
  };

#endif // ALIKHANDE_ORDEREXECUTOR_MQH
