//+------------------------------------------------------------------+
//|                                          Alikhande/SafetyGate.mqh |
//|  Structural prohibition on real-money execution.                  |
//|                                                                   |
//|  PROJECT RULE (owner-imposed, non-negotiable):                    |
//|      This system must never trade a real-money account.           |
//|                                                                   |
//|  A comment cannot enforce that. This gate can. It runs at OnInit  |
//|  and returns INIT_FAILED on a real account, so the EA does not    |
//|  reach OnTick at all -- there is no code path from a live account |
//|  to an order, not a guarded one.                                  |
//|                                                                   |
//|  THE OVERRIDE                                                     |
//|  Escaping the gate requires FOUR independent facts to line up.    |
//|  Any one of them missing blocks the EA:                           |
//|                                                                   |
//|    1. ALIKHANDE_ALLOW_LIVE must be #defined BEFORE this header is |
//|       included. It is not defined anywhere in the repository, so  |
//|       this requires editing source and recompiling. An input      |
//|       toggle alone can never be enough.                           |
//|    2. The EA must pass allow_live = true at runtime.              |
//|    3. The operator must type the acknowledgement phrase exactly.  |
//|    4. The account login must equal a number pinned in the inputs, |
//|       so an override prepared for one account cannot silently run |
//|       on another.                                                 |
//|                                                                   |
//|  Requirements 1 and 4 are what make this structural rather than   |
//|  advisory: 1 cannot be reached from the terminal UI, and 4 means  |
//|  a stolen or copied .ex5 is inert on any other account.           |
//+------------------------------------------------------------------+
#ifndef ALIKHANDE_SAFETYGATE_MQH
#define ALIKHANDE_SAFETYGATE_MQH

#include <Alikhande/Logger.mqh>

//--- The exact phrase required by override requirement 3.
#define ALIKHANDE_LIVE_ACK_PHRASE "I ACCEPT REAL MONEY RISK ON THIS ACCOUNT"

enum ENUM_SAFETY_VERDICT
  {
   SAFETY_ALLOW_TESTER   = 0,  // Strategy Tester: simulated money, always safe
   SAFETY_ALLOW_DEMO     = 1,  // demo account
   SAFETY_ALLOW_CONTEST  = 2,  // contest account: no withdrawable money
   SAFETY_BLOCK_REAL     = 3,  // real account, override absent or incomplete
   SAFETY_BLOCK_UNKNOWN  = 4,  // trade mode unreadable -> fail closed
   SAFETY_ALLOW_LIVE_ACK = 5   // real account, full four-factor override present
  };

class CSafetyGate
  {
private:
   ENUM_SAFETY_VERDICT m_verdict;
   string              m_detail;

   //--- Compile-time half of the override. Not defined in this repository.
   static bool       LiveCompiledIn(void)
     {
      #ifdef ALIKHANDE_ALLOW_LIVE
         return(true);
      #else
         return(false);
      #endif
     }

public:
                     CSafetyGate(void) : m_verdict(SAFETY_BLOCK_UNKNOWN), m_detail("not evaluated") {}

   ENUM_SAFETY_VERDICT Verdict(void) const { return(m_verdict); }
   string              Detail(void)  const { return(m_detail); }

   bool                Passed(void)  const
     {
      return(m_verdict == SAFETY_ALLOW_TESTER  ||
             m_verdict == SAFETY_ALLOW_DEMO    ||
             m_verdict == SAFETY_ALLOW_CONTEST ||
             m_verdict == SAFETY_ALLOW_LIVE_ACK);
     }

   //--- True when real money is genuinely at stake. Callers use this to
   //--- tighten limits further rather than to decide whether to run.
   bool                RealMoneyAtRisk(void) const { return(m_verdict == SAFETY_ALLOW_LIVE_ACK); }

   //+---------------------------------------------------------------+
   //| Evaluate. Call FIRST in OnInit, before anything else.          |
   //|                                                                |
   //| allow_live / ack_phrase / pinned_login are the runtime three   |
   //| quarters of the override; the compile-time define is the       |
   //| fourth and is checked here too.                                |
   //+---------------------------------------------------------------+
   bool                Evaluate(const bool   allow_live,
                                const string ack_phrase,
                                const long   pinned_login)
     {
      //--- The Strategy Tester never touches a real account, whatever the
      //--- terminal is logged into. Checked first so backtesting is never
      //--- blocked by the gate.
      if((bool)MQLInfoInteger(MQL_TESTER))
        {
         m_verdict = SAFETY_ALLOW_TESTER;
         m_detail  = "Strategy Tester - simulated funds";
         return(true);
        }

      long raw = 0;
      if(!AccountInfoInteger(ACCOUNT_TRADE_MODE, raw))
        {
         // Fail closed. An unreadable trade mode is not a reason to assume demo.
         m_verdict = SAFETY_BLOCK_UNKNOWN;
         m_detail  = StringFormat("ACCOUNT_TRADE_MODE unreadable (err=%d) - failing closed", GetLastError());
         return(false);
        }

      ENUM_ACCOUNT_TRADE_MODE mode = (ENUM_ACCOUNT_TRADE_MODE)raw;

      if(mode == ACCOUNT_TRADE_MODE_DEMO)
        {
         m_verdict = SAFETY_ALLOW_DEMO;
         m_detail  = StringFormat("demo account #%I64d (%s)",
                                  AccountInfoInteger(ACCOUNT_LOGIN),
                                  AccountInfoString(ACCOUNT_SERVER));
         return(true);
        }

      if(mode == ACCOUNT_TRADE_MODE_CONTEST)
        {
         m_verdict = SAFETY_ALLOW_CONTEST;
         m_detail  = StringFormat("contest account #%I64d (%s)",
                                  AccountInfoInteger(ACCOUNT_LOGIN),
                                  AccountInfoString(ACCOUNT_SERVER));
         return(true);
        }

      //--- From here the account is REAL. Default answer is no.
      long   login  = AccountInfoInteger(ACCOUNT_LOGIN);
      string server = AccountInfoString(ACCOUNT_SERVER);

      if(!LiveCompiledIn())
        {
         m_verdict = SAFETY_BLOCK_REAL;
         m_detail  = StringFormat(
            "REAL account #%I64d (%s). Blocked: ALIKHANDE_ALLOW_LIVE is not compiled in. "
            "This EA cannot be enabled for live trading from the terminal UI by design.",
            login, server);
         return(false);
        }

      //--- Compile flag present: still require all three runtime factors.
      if(!allow_live)
        {
         m_verdict = SAFETY_BLOCK_REAL;
         m_detail  = StringFormat("REAL account #%I64d (%s). Blocked: live input toggle is off.", login, server);
         return(false);
        }

      if(ack_phrase != ALIKHANDE_LIVE_ACK_PHRASE)
        {
         m_verdict = SAFETY_BLOCK_REAL;
         m_detail  = StringFormat("REAL account #%I64d (%s). Blocked: acknowledgement phrase does not match.", login, server);
         return(false);
        }

      if(pinned_login <= 0 || pinned_login != login)
        {
         m_verdict = SAFETY_BLOCK_REAL;
         m_detail  = StringFormat(
            "REAL account #%I64d (%s). Blocked: pinned login is %I64d. "
            "An override is valid for exactly one account.",
            login, server, pinned_login);
         return(false);
        }

      m_verdict = SAFETY_ALLOW_LIVE_ACK;
      m_detail  = StringFormat("REAL account #%I64d (%s) - four-factor override accepted.", login, server);
      return(true);
     }

   //+---------------------------------------------------------------+
   //| Emit the verdict. A block is logged at ERROR and, outside the  |
   //| tester, raised as an Alert so it cannot be missed.             |
   //+---------------------------------------------------------------+
   void                Report(CLogger &log) const
     {
      if(!Passed())
        {
         log.Error("SAFETY GATE BLOCKED STARTUP: " + m_detail);
         if(!(bool)MQLInfoInteger(MQL_TESTER))
            Alert("Alikhande safety gate blocked startup: ", m_detail);
         return;
        }

      if(m_verdict == SAFETY_ALLOW_LIVE_ACK)
        {
         log.Warn("SAFETY GATE: LIVE TRADING ENABLED - " + m_detail);
         Alert("Alikhande: LIVE TRADING IS ENABLED on ", m_detail);
         return;
        }

      log.Info("Safety gate passed: " + m_detail);
     }
  };

#endif // ALIKHANDE_SAFETYGATE_MQH
