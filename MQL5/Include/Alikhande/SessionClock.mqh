//+------------------------------------------------------------------+
//|                                       Alikhande/SessionClock.mqh  |
//|  Server time, session windows and the rollover exclusion.         |
//|                                                                   |
//|  TimeCurrent() is BROKER SERVER time -- commonly UTC+2 in winter  |
//|  and UTC+3 in summer, but that is a convention, not a rule, and   |
//|  the broker's DST calendar need not match anyone else's. A        |
//|  session filter written against hardcoded server hours silently   |
//|  shifts by an hour twice a year. This class derives the offset at |
//|  runtime and re-derives it periodically.                          |
//|                                                                   |
//|  TimeLocal() is deliberately never used: on a VPS it is the       |
//|  clock of a machine in a country nobody chose.                    |
//+------------------------------------------------------------------+
#ifndef ALIKHANDE_SESSIONCLOCK_MQH
#define ALIKHANDE_SESSIONCLOCK_MQH

#include <Alikhande/Logger.mqh>

struct SessionParams
  {
   bool     use_session_filter;
   int      start_hour;          // server time, inclusive
   int      end_hour;            // server time, exclusive; < start means it crosses midnight
   bool     block_rollover;      // skip the daily rollover spread blowout
   int      rollover_start_hour; // server time
   int      rollover_end_hour;   // server time
   bool     trade_monday;
   bool     trade_friday;
   int      friday_cutoff_hour;  // stop opening after this server hour on Friday; 24 = no cutoff
  };

void SessionParamsDefaults(SessionParams &p)
  {
   p.use_session_filter  = true;
   p.start_hour          = 8;
   p.end_hour            = 21;
   p.block_rollover      = true;
   p.rollover_start_hour = 23;
   p.rollover_end_hour   = 1;
   p.trade_monday        = true;
   p.trade_friday        = true;
   p.friday_cutoff_hour  = 20;
  }

class CSessionClock
  {
private:
   SessionParams     m_p;
   CLogger          *m_log;

   int               m_gmt_offset_hours;
   datetime          m_offset_checked_at;
   string            m_block_reason;

   static const int  OFFSET_RECHECK_SECONDS;

public:
   //+---------------------------------------------------------------+
   //| Window membership, including windows that wrap past midnight    |
   //| (22 -> 3). Public and static because it is pure: it is the one  |
   //| piece of session logic that can be asserted directly, without   |
   //| a clock, and RunTests.mq5 does exactly that.                    |
   //+---------------------------------------------------------------+
   static bool       HourInWindow(const int hour, const int start, const int end)
     {
      if(start == end) return(false);              // empty window
      if(start < end)  return(hour >= start && hour < end);
      return(hour >= start || hour < end);         // wraps midnight
     }

                     CSessionClock(void) : m_log(NULL), m_gmt_offset_hours(0), m_offset_checked_at(0), m_block_reason("") {}

   void              Init(CLogger &log, const SessionParams &p)
     {
      m_log = GetPointer(log);
      m_p   = p;
      RefreshGMTOffset(true);
      m_log.Info(StringFormat("SessionClock: server GMT offset %+d h | window %02d:00-%02d:00 server | rollover block %s",
                              m_gmt_offset_hours, m_p.start_hour, m_p.end_hour,
                              (m_p.block_rollover ? "on" : "off")));
     }

   int               GMTOffsetHours(void) const { return(m_gmt_offset_hours); }
   string            BlockReason(void)    const { return(m_block_reason); }

   //+---------------------------------------------------------------+
   //| Re-derive the broker's GMT offset. Cheap, but not free, so it   |
   //| is rate-limited rather than run on every tick. DST moves it, so |
   //| it cannot be computed once at OnInit and trusted for months.    |
   //+---------------------------------------------------------------+
   void              RefreshGMTOffset(const bool force = false)
     {
      datetime now = TimeCurrent();
      if(!force && m_offset_checked_at != 0 &&
         (now - m_offset_checked_at) < OFFSET_RECHECK_SECONDS)
         return;

      datetime gmt = TimeGMT();
      if(gmt <= 0 || now <= 0) return;

      //--- Capture "is this the first measurement" BEFORE stamping the clock.
      //--- Testing m_offset_checked_at after assigning `now` to it is always
      //--- true, so the first call compared the real offset against the
      //--- constructor's 0 and announced a DST change that had not happened.
      bool first = (m_offset_checked_at == 0);

      int prev = m_gmt_offset_hours;
      m_gmt_offset_hours  = (int)MathRound((double)(now - gmt) / 3600.0);
      m_offset_checked_at = now;

      if(!first && prev != m_gmt_offset_hours && m_log != NULL)
         m_log.Warn(StringFormat("Broker GMT offset changed %+d h -> %+d h (DST boundary). Session windows now map to different GMT hours.",
                                 prev, m_gmt_offset_hours));
     }

   //--- Server hour of a given time.
   static int        HourOf(const datetime t)
     {
      MqlDateTime d; TimeToStruct(t, d); return(d.hour);
     }
   static int        DayOfWeekOf(const datetime t)
     {
      MqlDateTime d; TimeToStruct(t, d); return(d.day_of_week);   // 0 = Sunday
     }

   //+---------------------------------------------------------------+
   //| May the EA OPEN a new position right now?                       |
   //| Sets BlockReason() so the journal says why, not just "no".      |
   //+---------------------------------------------------------------+
   bool              CanOpen(void)
     {
      RefreshGMTOffset();
      m_block_reason = "";

      datetime now = TimeCurrent();
      int hour = HourOf(now);
      int dow  = DayOfWeekOf(now);

      //--- Saturday and Sunday. Some brokers quote crypto at the weekend;
      //--- for FX and metals this is dead time with pathological spreads.
      if(dow == 0 || dow == 6) { m_block_reason = "weekend"; return(false); }

      if(!m_p.trade_monday && dow == 1) { m_block_reason = "Monday excluded"; return(false); }
      if(!m_p.trade_friday && dow == 5) { m_block_reason = "Friday excluded"; return(false); }

      //--- Do not open a fresh position into the weekend gap.
      if(dow == 5 && m_p.friday_cutoff_hour < 24 && hour >= m_p.friday_cutoff_hour)
        {
         m_block_reason = StringFormat("past Friday cutoff %02d:00 server", m_p.friday_cutoff_hour);
         return(false);
        }

      //--- Rollover: XAUUSD spreads routinely go from ~20 to 300+ points
      //--- here. Anything opened in this band is paying a tax for nothing.
      if(m_p.block_rollover && HourInWindow(hour, m_p.rollover_start_hour, m_p.rollover_end_hour))
        {
         m_block_reason = StringFormat("rollover window %02d:00-%02d:00 server",
                                       m_p.rollover_start_hour, m_p.rollover_end_hour);
         return(false);
        }

      if(m_p.use_session_filter && !HourInWindow(hour, m_p.start_hour, m_p.end_hour))
        {
         m_block_reason = StringFormat("outside session %02d:00-%02d:00 server (now %02d:00)",
                                       m_p.start_hour, m_p.end_hour, hour);
         return(false);
        }

      return(true);
     }

   //--- Inside the configured trading window, ignoring day-of-week rules.
   //--- Used to decide whether to force-close at the window edge.
   bool              InSessionWindow(void)
     {
      if(!m_p.use_session_filter) return(true);
      return(HourInWindow(HourOf(TimeCurrent()), m_p.start_hour, m_p.end_hour));
     }

   bool              InRolloverWindow(void)
     {
      if(!m_p.block_rollover) return(false);
      return(HourInWindow(HourOf(TimeCurrent()), m_p.rollover_start_hour, m_p.rollover_end_hour));
     }

   //--- Server time expressed as GMT, for logs that have to be compared
   //--- against news calendars.
   //--- Kept in `long` throughout. Casting a negative offset to datetime
   //--- first -- brokers west of GMT have one -- is not something to rely on;
   //--- doing the arithmetic in a signed integer type and converting once at
   //--- the end has no such question over it.
   datetime          ToGMT(const datetime server_time) const
     {
      long shifted = (long)server_time - (long)m_gmt_offset_hours * 3600;
      if(shifted < 0) shifted = 0;
      return((datetime)shifted);
     }
  };

const int CSessionClock::OFFSET_RECHECK_SECONDS = 3600;   // hourly is ample for a DST boundary

#endif // ALIKHANDE_SESSIONCLOCK_MQH
