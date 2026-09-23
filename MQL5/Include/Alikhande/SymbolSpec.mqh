//+------------------------------------------------------------------+
//|                                          Alikhande/SymbolSpec.mqh |
//|  Broker specification cache.                                      |
//|                                                                   |
//|  Every number an EA needs about an instrument is read from the    |
//|  broker once, at OnInit, and never hardcoded. XAUUSD is 2 digits  |
//|  on some brokers and 3 on others; contract size is 100 oz on most |
//|  and 10 oz on mini accounts. A constant baked into the code is a  |
//|  bug waiting for the user to change broker.                       |
//|                                                                   |
//|  Deliberate omission: there is no "pip" here. On a 2-digit gold   |
//|  feed "10 pips" means nothing unambiguous. Everything in this     |
//|  project is measured in POINTS or in PRICE, and the conversion is |
//|  explicit.                                                        |
//+------------------------------------------------------------------+
#ifndef ALIKHANDE_SYMBOLSPEC_MQH
#define ALIKHANDE_SYMBOLSPEC_MQH

class CSymbolSpec
  {
private:
   bool     m_loaded;
   string   m_fail_reason;

   //--- identity
   string   m_name;
   int      m_digits;
   double   m_point;

   //--- money math
   double   m_tick_size;      // SYMBOL_TRADE_TICK_SIZE  - minimum price change
   double   m_tick_value;     // value of one tick per 1.0 lot, in account currency
   double   m_contract_size;

   //--- volume
   double   m_vol_min;
   double   m_vol_max;
   double   m_vol_step;
   double   m_vol_limit;      // aggregate cap for the symbol; 0 = unlimited
   int      m_vol_digits;     // decimals implied by the step

   //--- execution constraints
   long     m_stops_level;    // points; 0 means dynamic (spread-tied)
   long     m_freeze_level;   // points
   long     m_filling_mask;   // SYMBOL_FILLING_MODE bit mask
   ENUM_SYMBOL_TRADE_EXECUTION m_exec_mode;
   ENUM_SYMBOL_TRADE_MODE      m_trade_mode;
   ENUM_SYMBOL_SWAP_MODE       m_swap_mode;

   //--- Test seam only: >= 0 makes SpreadPts() return this instead of asking
   //--- the terminal. A broker-loaded spec always leaves it at -1.
   long     m_spread_override;

   static int        DigitsFromStep(const double step)
     {
      if(step <= 0.0) return(0);
      double d = -MathLog10(step);
      int    n = (int)MathRound(d);
      if(n < 0) n = 0;
      if(n > 8) n = 8;
      return(n);
     }

public:
                     CSymbolSpec(void) { Reset(); }

   void              Reset(void)
     {
      m_loaded = false; m_fail_reason = "not loaded";
      m_name = ""; m_digits = 0; m_point = 0.0;
      m_tick_size = 0.0; m_tick_value = 0.0; m_contract_size = 0.0;
      m_vol_min = 0.0; m_vol_max = 0.0; m_vol_step = 0.0; m_vol_limit = 0.0; m_vol_digits = 0;
      m_stops_level = 0; m_freeze_level = 0; m_filling_mask = 0;
      m_exec_mode  = SYMBOL_TRADE_EXECUTION_MARKET;
      m_trade_mode = SYMBOL_TRADE_MODE_DISABLED;
      m_swap_mode  = SYMBOL_SWAP_MODE_DISABLED;
      m_spread_override = -1;
     }

   //+---------------------------------------------------------------+
   //| Load. Returns false with a readable reason on failure, so the  |
   //| EA can abort at OnInit instead of trading on zeros.            |
   //+---------------------------------------------------------------+
   bool              Load(const string sym)
     {
      Reset();

      // A symbol absent from Market Watch returns 0 for tick value, which
      // turns the lot-size division into inf or 0. Select it first.
      if(!(bool)SymbolInfoInteger(sym, SYMBOL_SELECT))
        {
         if(!SymbolSelect(sym, true))
           {
            m_fail_reason = "symbol '" + sym + "' cannot be selected in Market Watch";
            return(false);
           }
        }

      m_name          = sym;
      m_digits        = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      m_point         = SymbolInfoDouble (sym, SYMBOL_POINT);
      m_tick_size     = SymbolInfoDouble (sym, SYMBOL_TRADE_TICK_SIZE);

      // TICK_VALUE_LOSS is the value used when the position moves against you,
      // which is exactly the number risk sizing must use. It differs from
      // TICK_VALUE_PROFIT on instruments with an asymmetric conversion.
      m_tick_value    = SymbolInfoDouble (sym, SYMBOL_TRADE_TICK_VALUE_LOSS);
      if(m_tick_value <= 0.0)
         m_tick_value = SymbolInfoDouble (sym, SYMBOL_TRADE_TICK_VALUE);

      m_contract_size = SymbolInfoDouble (sym, SYMBOL_TRADE_CONTRACT_SIZE);
      m_vol_min       = SymbolInfoDouble (sym, SYMBOL_VOLUME_MIN);
      m_vol_max       = SymbolInfoDouble (sym, SYMBOL_VOLUME_MAX);
      m_vol_step      = SymbolInfoDouble (sym, SYMBOL_VOLUME_STEP);
      m_vol_limit     = SymbolInfoDouble (sym, SYMBOL_VOLUME_LIMIT);
      m_stops_level   = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL);
      m_freeze_level  = SymbolInfoInteger(sym, SYMBOL_TRADE_FREEZE_LEVEL);
      m_filling_mask  = SymbolInfoInteger(sym, SYMBOL_FILLING_MODE);
      m_exec_mode     = (ENUM_SYMBOL_TRADE_EXECUTION)SymbolInfoInteger(sym, SYMBOL_TRADE_EXEMODE);
      m_trade_mode    = (ENUM_SYMBOL_TRADE_MODE)     SymbolInfoInteger(sym, SYMBOL_TRADE_MODE);
      m_swap_mode     = (ENUM_SYMBOL_SWAP_MODE)      SymbolInfoInteger(sym, SYMBOL_SWAP_MODE);

      m_vol_digits    = DigitsFromStep(m_vol_step);

      //--- Refuse to run on a spec that would silently corrupt the math.
      if(m_point <= 0.0)      { m_fail_reason = "SYMBOL_POINT is 0";              return(false); }
      if(m_tick_size <= 0.0)  { m_fail_reason = "SYMBOL_TRADE_TICK_SIZE is 0";    return(false); }
      if(m_tick_value <= 0.0) { m_fail_reason = "tick value is 0 (symbol not in Market Watch, or unsupported conversion)"; return(false); }
      if(m_vol_step <= 0.0)   { m_fail_reason = "SYMBOL_VOLUME_STEP is 0";        return(false); }
      if(m_vol_min <= 0.0)    { m_fail_reason = "SYMBOL_VOLUME_MIN is 0";         return(false); }
      if(m_vol_max < m_vol_min) { m_fail_reason = "SYMBOL_VOLUME_MAX < SYMBOL_VOLUME_MIN"; return(false); }

      m_loaded = true;
      m_fail_reason = "";
      return(true);
     }

   //+---------------------------------------------------------------+
   //| TEST SEAM. Builds a spec from explicit values instead of from   |
   //| a broker, so the volume, stop-distance and filling-mode logic   |
   //| can be asserted against known inputs with no terminal           |
   //| connection and no dependence on whichever broker happens to be  |
   //| logged in.                                                      |
   //|                                                                 |
   //| Used only by Scripts/Alikhande/RunTests.mq5. Nothing in the EA  |
   //| path calls it; a synthetic spec has no live Bid/Ask, so it      |
   //| cannot be used to trade even by accident.                       |
   //+---------------------------------------------------------------+
   void     LoadSynthetic(const string name, const int digits, const double point,
                          const double tick_size, const double tick_value,
                          const double contract_size,
                          const double vol_min, const double vol_max, const double vol_step,
                          const long stops_level, const long freeze_level,
                          const long filling_mask,
                          const ENUM_SYMBOL_TRADE_EXECUTION exec_mode,
                          const ENUM_SYMBOL_TRADE_MODE trade_mode = SYMBOL_TRADE_MODE_FULL,
                          const double vol_limit = 0.0,
                          const long spread_points = 0)
     {
      Reset();
      m_name = name; m_digits = digits; m_point = point;
      m_tick_size = tick_size; m_tick_value = tick_value; m_contract_size = contract_size;
      m_vol_min = vol_min; m_vol_max = vol_max; m_vol_step = vol_step; m_vol_limit = vol_limit;
      m_stops_level = stops_level; m_freeze_level = freeze_level;
      m_filling_mask = filling_mask; m_exec_mode = exec_mode; m_trade_mode = trade_mode;
      m_vol_digits = DigitsFromStep(vol_step);
      m_spread_override = (spread_points >= 0 ? spread_points : 0);
      m_loaded = true; m_fail_reason = "";
     }

   //--- accessors
   bool     IsLoaded(void)     const { return(m_loaded); }
   string   FailReason(void)   const { return(m_fail_reason); }
   string   Name(void)         const { return(m_name); }
   int      Digits_(void)      const { return(m_digits); }      // Digits() is a global MQL5 function
   double   Point_(void)       const { return(m_point); }       // Point()  is a global MQL5 function
   double   TickSize(void)     const { return(m_tick_size); }
   double   TickValue(void)    const { return(m_tick_value); }
   double   ContractSize(void) const { return(m_contract_size); }
   double   VolumeMin(void)    const { return(m_vol_min); }
   double   VolumeMax(void)    const { return(m_vol_max); }
   double   VolumeStep(void)   const { return(m_vol_step); }
   double   VolumeLimit(void)  const { return(m_vol_limit); }
   int      VolumeDigits(void) const { return(m_vol_digits); }
   long     StopsLevel(void)   const { return(m_stops_level); }
   long     FreezeLevel(void)  const { return(m_freeze_level); }
   long     FillingMask(void)  const { return(m_filling_mask); }
   ENUM_SYMBOL_TRADE_EXECUTION ExecMode(void)  const { return(m_exec_mode); }
   ENUM_SYMBOL_TRADE_MODE      TradeMode(void) const { return(m_trade_mode); }
   ENUM_SYMBOL_SWAP_MODE       SwapMode(void)  const { return(m_swap_mode); }

   //--- live values (not cached: these change every tick)
   double   Ask(void)    const { return(SymbolInfoDouble (m_name, SYMBOL_ASK)); }
   double   Bid(void)    const { return(SymbolInfoDouble (m_name, SYMBOL_BID)); }
   long     SpreadPts(void) const
     {
      if(m_spread_override >= 0) return(m_spread_override);
      return(SymbolInfoInteger(m_name, SYMBOL_SPREAD));
     }

   //--- conversions, always explicit about the unit
   double   PointsToPrice(const double points) const { return(points * m_point); }
   double   PriceToPoints(const double price)  const { return(m_point > 0.0 ? price / m_point : 0.0); }
   double   NormalizePrice(const double price) const { return(NormalizeDouble(price, m_digits)); }

   //--- Can this symbol be traded at all, in the direction we want?
   bool     TradeAllowed(const bool is_buy) const
     {
      if(m_trade_mode == SYMBOL_TRADE_MODE_DISABLED)  return(false);
      if(m_trade_mode == SYMBOL_TRADE_MODE_CLOSEONLY) return(false);
      if(m_trade_mode == SYMBOL_TRADE_MODE_LONGONLY  && !is_buy) return(false);
      if(m_trade_mode == SYMBOL_TRADE_MODE_SHORTONLY &&  is_buy) return(false);
      return(true);
     }

   //+---------------------------------------------------------------+
   //| Minimum legal distance from price to SL/TP, as a PRICE delta.  |
   //|                                                                |
   //| The spread is added deliberately. MT5 validates a BUY's stop   |
   //| against BID, not against the ASK you entered at, so a stop      |
   //| placed at (ask - dist) sits only (dist - spread) from the level |
   //| the server actually checks. Omitting the spread is the usual    |
   //| reason a stop passes in the tester and returns 10016 live.      |
   //|                                                                |
   //| stops_level == 0 means the broker uses a dynamic, spread-tied   |
   //| level rather than "no limit", so a spread-proportional floor    |
   //| replaces the zero.                                              |
   //+---------------------------------------------------------------+
   double   MinStopDistance(const long extra_buffer_points) const
     {
      double spread_pts = (double)SpreadPts();
      double base_pts   = (double)m_stops_level;
      if(base_pts <= 0.0)
         base_pts = spread_pts * 2.0;
      return((base_pts + spread_pts + (double)extra_buffer_points) * m_point);
     }

   //--- Freeze zone: inside it the server refuses modify/close (retcode 10029).
   double   FreezeDistance(void) const { return((double)m_freeze_level * m_point); }

   //+---------------------------------------------------------------+
   //| Clamp to [min,max] and round DOWN to the volume step.          |
   //| Down, never to nearest: rounding up silently exceeds the       |
   //| intended risk, which is the one error never worth making.      |
   //| Returns 0.0 when the request cannot reach the minimum lot.     |
   //+---------------------------------------------------------------+
   double   NormalizeVolume(const double lots, const double hard_cap) const
     {
      if(!m_loaded || m_vol_step <= 0.0) return(0.0);
      if(lots <= 0.0) return(0.0);

      double cap = m_vol_max;
      if(hard_cap    > 0.0 && hard_cap    < cap) cap = hard_cap;
      if(m_vol_limit > 0.0 && m_vol_limit < cap) cap = m_vol_limit;

      double capped = MathMin(lots, cap);

      // 1e-8 absorbs float residue so 0.29999999997 against a 0.01 step
      // floors to 0.30 rather than 0.29.
      double steps  = MathFloor(capped / m_vol_step + 1e-8);
      double result = NormalizeDouble(steps * m_vol_step, m_vol_digits);

      if(result < m_vol_min - 1e-8) return(0.0);
      return(result);
     }

   bool     AllowsFOK(void) const { return((m_filling_mask & SYMBOL_FILLING_FOK) != 0); }
   bool     AllowsIOC(void) const { return((m_filling_mask & SYMBOL_FILLING_IOC) != 0); }
   bool     AllowsBOC(void) const { return((m_filling_mask & SYMBOL_FILLING_BOC) != 0); }

   string   FillingMaskText(void) const
     {
      string s = "";
      if(AllowsFOK()) s += "FOK ";
      if(AllowsIOC()) s += "IOC ";
      if(AllowsBOC()) s += "BOC ";
      if(s == "") s = "(none advertised) ";
      return(s);
     }

   //+---------------------------------------------------------------+
   //| Resolve the filling mode for a MARKET order.                    |
   //|                                                                 |
   //| Two official rules govern this, and getting either wrong is a    |
   //| guaranteed retcode 10030:                                        |
   //|                                                                  |
   //|  (a) SYMBOL_FILLING_MODE is a mask of FOK(1) / IOC(2) / BOC(4)   |
   //|      ONLY. RETURN has "No identifier" in it -- so the absence of |
   //|      a RETURN bit says nothing about whether RETURN is legal.    |
   //|                                                                  |
   //|  (b) RETURN's legality comes from SYMBOL_TRADE_EXEMODE instead:  |
   //|      it is permitted under Request / Instant / Exchange, and     |
   //|      "disabled regardless of the symbol settings" under Market.  |
   //|      Under Market, only the FOK/IOC bits the symbol actually     |
   //|      advertises are legal.                                       |
   //|                                                                  |
   //| Sources (verified 2026-09-15):                                   |
   //|   mql5.com/en/docs/constants/tradingconstants/orderproperties    |
   //|   mql5.com/en/docs/constants/environment_state/marketinfoconstants|
   //|                                                                  |
   //| BOC is never selected here: it is a Depth-of-Market passive      |
   //| placement policy and is cancelled if it could execute at once,   |
   //| which is the opposite of what a market entry wants.              |
   //|                                                                  |
   //| Returns false when nothing legal can be chosen, so OnInit can    |
   //| abort instead of sending an illegal mode on every tick.          |
   //+---------------------------------------------------------------+
   bool     ResolveFilling(ENUM_ORDER_TYPE_FILLING &out, string &why) const
     {
      if(m_exec_mode == SYMBOL_TRADE_EXECUTION_MARKET)
        {
         if(AllowsFOK()) { out = ORDER_FILLING_FOK; why = "Market execution, symbol advertises FOK"; return(true); }
         if(AllowsIOC()) { out = ORDER_FILLING_IOC; why = "Market execution, symbol advertises IOC"; return(true); }

         out = ORDER_FILLING_IOC;   // placeholder; caller must not use it
         why = "Market execution but the symbol advertises neither FOK nor IOC, "
               "and RETURN is disabled under Market execution. No legal filling mode exists "
               "for a market order on this symbol - check the broker's symbol configuration.";
         return(false);
        }

      //--- Request / Instant / Exchange: RETURN is permitted by the execution
      //--- mode itself. Prefer an advertised FOK/IOC, fall back to RETURN.
      if(AllowsFOK()) { out = ORDER_FILLING_FOK;    why = "symbol advertises FOK";                       return(true); }
      if(AllowsIOC()) { out = ORDER_FILLING_IOC;    why = "symbol advertises IOC";                       return(true); }
      out = ORDER_FILLING_RETURN; why = "no FOK/IOC advertised; RETURN is legal under this exec mode";   return(true);
     }

   //--- Convenience wrapper. Callers that must not proceed on failure
   //--- should use ResolveFilling() and check its return value.
   ENUM_ORDER_TYPE_FILLING PickFilling(void) const
     {
      ENUM_ORDER_TYPE_FILLING f;
      string why;
      ResolveFilling(f, why);
      return(f);
     }

   //--- Multi-line dump for the journal. Read this first when a bug smells spec-related.
   string   Describe(void) const
     {
      if(!m_loaded) return("SPEC not loaded: " + m_fail_reason);
      string s = "";
      s += StringFormat("SPEC %s | digits=%d point=%s tickSize=%s tickValue=%.5f contract=%.2f",
                        m_name, m_digits,
                        DoubleToString(m_point,     m_digits + 2),
                        DoubleToString(m_tick_size, m_digits + 2),
                        m_tick_value, m_contract_size);
      s += StringFormat("\n     vol min/max/step/limit = %s / %s / %s / %s",
                        DoubleToString(m_vol_min,   m_vol_digits),
                        DoubleToString(m_vol_max,   m_vol_digits),
                        DoubleToString(m_vol_step,  m_vol_digits),
                        DoubleToString(m_vol_limit, m_vol_digits));
      s += StringFormat("\n     stopsLevel=%d freezeLevel=%d spreadNow=%d execMode=%d tradeMode=%d swapMode=%d",
                        (int)m_stops_level, (int)m_freeze_level, (int)SpreadPts(),
                        (int)m_exec_mode, (int)m_trade_mode, (int)m_swap_mode);
      ENUM_ORDER_TYPE_FILLING f; string why;
      bool resolved = ResolveFilling(f, why);
      s += "\n     filling advertised: " + FillingMaskText() +
           "| exec=" + EnumToString(m_exec_mode) +
           " -> " + (resolved ? EnumToString(f) : "UNRESOLVABLE") + " (" + why + ")";
      return(s);
     }
  };

#endif // ALIKHANDE_SYMBOLSPEC_MQH
