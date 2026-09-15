//+------------------------------------------------------------------+
//|                                              Alikhande/Logger.mqh |
//|  Level-gated structured logging.                                  |
//|                                                                   |
//|  Why this exists: Print() inside OnTick dominates runtime during  |
//|  optimization (thousands of passes x thousands of ticks). This    |
//|  logger silences itself automatically when MQL_OPTIMIZATION is    |
//|  set, so nobody has to remember to turn logging off before an     |
//|  optimization run.                                                |
//+------------------------------------------------------------------+
#ifndef ALIKHANDE_LOGGER_MQH
#define ALIKHANDE_LOGGER_MQH

// Prefixed members: the MQL5 standard library already defines
// LOG_LEVEL_NO / LOG_LEVEL_ERRORS / LOG_LEVEL_ALL for CTrade.
enum ENUM_ALIKHANDE_LOG_LEVEL
  {
   ALOG_OFF   = 0,   // nothing
   ALOG_ERROR = 1,   // failures that stop an action
   ALOG_WARN  = 2,   // degraded but continuing
   ALOG_INFO  = 3,   // lifecycle and trade events
   ALOG_DEBUG = 4    // per-tick detail; never leave on in a long test
  };

class CLogger
  {
private:
   ENUM_ALIKHANDE_LOG_LEVEL m_level;
   string                   m_tag;
   bool                     m_silenced;   // optimization pass: suppress everything

   bool              Enabled(const ENUM_ALIKHANDE_LOG_LEVEL lvl) const
     {
      if(m_silenced) return(false);
      return((int)lvl <= (int)m_level);
     }

   static string     LevelName(const ENUM_ALIKHANDE_LOG_LEVEL lvl)
     {
      switch(lvl)
        {
         case ALOG_ERROR: return("ERROR");
         case ALOG_WARN:  return("WARN ");
         case ALOG_INFO:  return("INFO ");
         case ALOG_DEBUG: return("DEBUG");
        }
      return("?????");
     }

public:
                     CLogger(void) : m_level(ALOG_INFO), m_tag("ALK"), m_silenced(false) {}

   //--- Call once from OnInit.
   void              Init(const string tag, const ENUM_ALIKHANDE_LOG_LEVEL lvl)
     {
      m_tag   = tag;
      m_level = lvl;
      // An optimization pass runs headless and discards the journal; logging
      // there is pure cost. Visual-mode single tests still log normally.
      m_silenced = (bool)MQLInfoInteger(MQL_OPTIMIZATION);
     }

   void              SetLevel(const ENUM_ALIKHANDE_LOG_LEVEL lvl) { m_level = lvl; }
   ENUM_ALIKHANDE_LOG_LEVEL Level(void) const { return(m_level); }
   bool              IsSilenced(void) const { return(m_silenced); }

   //--- Force logging on even during optimization. Only for debugging a
   //--- specific optimization pass; it will make the run dramatically slower.
   void              ForceUnsilence(void) { m_silenced = false; }

   void              Write(const ENUM_ALIKHANDE_LOG_LEVEL lvl, const string msg) const
     {
      if(!Enabled(lvl)) return;
      Print(m_tag, " | ", LevelName(lvl), " | ", msg);
     }

   void              Error(const string msg) const { Write(ALOG_ERROR, msg); }
   void              Warn (const string msg) const { Write(ALOG_WARN,  msg); }
   void              Info (const string msg) const { Write(ALOG_INFO,  msg); }
   void              Debug(const string msg) const { Write(ALOG_DEBUG, msg); }

   //--- Guard for expensive message construction:
   //---   if(log.Wants(ALOG_DEBUG)) log.Debug(BuildExpensiveString());
   bool              Wants(const ENUM_ALIKHANDE_LOG_LEVEL lvl) const { return(Enabled(lvl)); }
  };

#endif // ALIKHANDE_LOGGER_MQH
