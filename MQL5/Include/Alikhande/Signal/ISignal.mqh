//+------------------------------------------------------------------+
//|                                    Alikhande/Signal/ISignal.mqh   |
//|  The strategy boundary.                                           |
//|                                                                   |
//|  A signal answers "what do I want and why", never "how is it      |
//|  sent". It returns a stop DISTANCE, not a stop price: prices      |
//|  belong to the execution layer, which alone knows the broker      |
//|  minimum distance, the spread and which side the server           |
//|  validates against.                                               |
//|                                                                   |
//|  An abstract base class is used rather than the `interface`       |
//|  keyword. Both exist in MQL5; a virtual base is the older, more   |
//|  universally supported of the two, and nothing here needs what    |
//|  an interface adds.                                               |
//+------------------------------------------------------------------+
#ifndef ALIKHANDE_ISIGNAL_MQH
#define ALIKHANDE_ISIGNAL_MQH

#include <Alikhande/SymbolSpec.mqh>
#include <Alikhande/Logger.mqh>

enum ENUM_SIGNAL_DIR
  {
   SIGNAL_NONE = 0,
   SIGNAL_BUY  = 1,
   SIGNAL_SELL = -1
  };

struct SignalDecision
  {
   ENUM_SIGNAL_DIR   direction;
   double            sl_distance;   // price delta from entry; > 0 required
   double            tp_distance;   // price delta from entry; 0 = no target
   double            confidence;    // 0..1, for journalling and future filtering
   string            reason;        // human-readable; goes in the trade journal
  };

void SignalDecisionReset(SignalDecision &d)
  {
   d.direction   = SIGNAL_NONE;
   d.sl_distance = 0.0;
   d.tp_distance = 0.0;
   d.confidence  = 0.0;
   d.reason      = "";
  }

//+------------------------------------------------------------------+
//| Base class for every strategy.                                    |
//|                                                                   |
//| CONTRACT for implementers -- violating any of these produces a    |
//| backtest that cannot be reproduced live:                          |
//|                                                                   |
//|   1. Read CLOSED bars only: shift >= 1. Bar 0 is still forming    |
//|      and its value can change after you have acted on it.         |
//|   2. On higher timeframes, shift 1 too. iClose(sym, PERIOD_H4, 0) |
//|      at 09:05 is a bar that will not close until 12:00.           |
//|   3. Create indicator handles in Init, release them in Deinit.    |
//|      Never inside Evaluate -- it leaks until INVALID_HANDLE.      |
//|   4. Always check CopyBuffer's return against the count you asked |
//|      for. A partially filled array read as full is garbage, and   |
//|      it happens on the first ticks after every init.              |
//|   5. If the strategy genuinely needs a live intrabar value (a     |
//|      level breakout, a trailing stop), say so in the reason text  |
//|      and document it -- then the backtest must use real ticks for |
//|      the result to mean anything.                                 |
//+------------------------------------------------------------------+
class CSignalBase
  {
protected:
   CSymbolSpec      *m_spec;
   CLogger          *m_log;
   string            m_name;

public:
                     CSignalBase(const string name) : m_spec(NULL), m_log(NULL), m_name(name) {}
   virtual          ~CSignalBase(void) {}

   string            Name(void) const { return(m_name); }

   //--- Bind shared services. Implementers override OnInit, not this.
   bool              Attach(CSymbolSpec &spec, CLogger &log)
     {
      m_spec = GetPointer(spec);
      m_log  = GetPointer(log);
      return(OnInitSignal());
     }

   virtual bool      OnInitSignal(void)   { return(true); }
   virtual void      OnDeinitSignal(void) {}

   //--- Return false when the strategy cannot decide yet (history not ready,
   //--- indicator not calculated). False is not an error; it means "wait".
   virtual bool      Evaluate(SignalDecision &out) = 0;

   //--- Optional per-tick hook for trailing / break-even logic.
   //--- Returns true when it wants the caller to apply new stops.
   virtual bool      ManageOpen(const ulong ticket, const bool is_buy,
                                const double entry_price, const double current_sl,
                                double &new_sl, double &new_tp)
     {
      return(false);
     }

protected:
   //+---------------------------------------------------------------+
   //| Shared helper: copy an indicator buffer from CLOSED bars with  |
   //| the count check that is so easy to forget.                     |
   //+---------------------------------------------------------------+
   bool              CopyClosed(const int handle, const int buffer_index,
                                const int start_shift, const int count, double &dst[])
     {
      if(handle == INVALID_HANDLE) return(false);
      if(start_shift < 1)
        {
         m_log.Error(m_name + ": CopyClosed called with shift 0 - that is look-ahead. Refusing.");
         return(false);
        }
      ArraySetAsSeries(dst, true);
      int got = CopyBuffer(handle, buffer_index, start_shift, count, dst);
      if(got < count)
        {
         m_log.Debug(StringFormat("%s: indicator not ready (%d/%d values)", m_name, got, count));
         return(false);
        }
      return(true);
     }
  };

#endif // ALIKHANDE_ISIGNAL_MQH
