//+------------------------------------------------------------------+
//|                                    Alikhande/Testing/Assert.mqh   |
//|  A minimal assertion harness that runs inside MetaTrader.         |
//|                                                                   |
//|  MQL5 has no mainstream unit-test framework, and CI cannot even    |
//|  compile MQL5 outside Windows. So the tests that exercise real     |
//|  MQL5 semantics have to run where MQL5 runs: inside the terminal,  |
//|  as a script, with the results read from the Experts tab.         |
//|                                                                   |
//|  Output is deliberately greppable. Every failing line begins with  |
//|  "FAIL", and the last line is PASSED or FAILED, so a harness       |
//|  driving the terminal headlessly can parse the log.               |
//+------------------------------------------------------------------+
#ifndef ALIKHANDE_ASSERT_MQH
#define ALIKHANDE_ASSERT_MQH

class CTestRunner
  {
private:
   int      m_passed;
   int      m_failed;
   string   m_suite;
   bool     m_verbose;

   void              Pass(const string label)
     {
      m_passed++;
      if(m_verbose) Print("  pass | ", m_suite, " :: ", label);
     }

   void              Fail(const string label, const string detail)
     {
      m_failed++;
      Print("FAIL | ", m_suite, " :: ", label, " | ", detail);
     }

public:
                     CTestRunner(void) : m_passed(0), m_failed(0), m_suite("(none)"), m_verbose(false) {}

   void              SetVerbose(const bool v) { m_verbose = v; }
   int               Passed(void) const { return(m_passed); }
   int               Failed(void) const { return(m_failed); }

   void              Suite(const string name)
     {
      m_suite = name;
      Print("--- ", name, " ---");
     }

   //--- Boolean expectation.
   void              IsTrue(const bool cond, const string label)
     {
      if(cond) Pass(label);
      else     Fail(label, "expected true, got false");
     }

   void              IsFalse(const bool cond, const string label)
     {
      if(!cond) Pass(label);
      else      Fail(label, "expected false, got true");
     }

   //--- Doubles are compared against a tolerance, never with ==.
   //--- The default is tight enough to catch a real error and loose enough
   //--- to survive the last bit of a division.
   void              EqualD(const double actual, const double expected,
                            const string label, const double tol = 1e-9)
     {
      if(MathAbs(actual - expected) <= tol) Pass(label);
      else Fail(label, StringFormat("expected %.10f, got %.10f (tolerance %.1e)",
                                    expected, actual, tol));
     }

   void              NotEqualD(const double actual, const double unexpected,
                               const string label, const double tol = 1e-9)
     {
      if(MathAbs(actual - unexpected) > tol) Pass(label);
      else Fail(label, StringFormat("expected a value other than %.10f", unexpected));
     }

   void              EqualI(const long actual, const long expected, const string label)
     {
      if(actual == expected) Pass(label);
      else Fail(label, StringFormat("expected %I64d, got %I64d", expected, actual));
     }

   void              EqualS(const string actual, const string expected, const string label)
     {
      if(actual == expected) Pass(label);
      else Fail(label, "expected '" + expected + "', got '" + actual + "'");
     }

   void              Greater(const double actual, const double threshold, const string label)
     {
      if(actual > threshold) Pass(label);
      else Fail(label, StringFormat("expected > %.10f, got %.10f", threshold, actual));
     }

   //+---------------------------------------------------------------+
   //| Final report. Returns true when everything passed, so a caller  |
   //| can use it as an exit condition.                                |
   //+---------------------------------------------------------------+
   bool              Summary(void)
     {
      Print("===================================================================");
      PrintFormat("Alikhande test run: %d passed, %d failed, %d total",
                  m_passed, m_failed, m_passed + m_failed);
      if(m_failed == 0)
        {
         Print("RESULT: PASSED");
         Print("===================================================================");
         return(true);
        }
      Print("RESULT: FAILED");
      Print("===================================================================");
      return(false);
     }
  };

#endif // ALIKHANDE_ASSERT_MQH
