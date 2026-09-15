<!--
PROVENANCE -- read before citing anything below.

This document is the raw output of the project's research pass on the MT5/MQL5
platform, archived verbatim on 2026-09-15. It is a RESEARCH RECORD, not a
project decision, and it carries two distinct confidence levels:

  * INDEPENDENTLY VERIFIED by the maintainer, by reading the official page
    directly. Exactly one claim in this report has been through that:

      - SYMBOL_FILLING_MODE carries only FOK(1) / IOC(2) / BOC(4); the official
        symbol-properties page states "Return - No identifier". ORDER_FILLING_RETURN
        is "disabled regardless of the symbol settings" under
        SYMBOL_TRADE_EXECUTION_MARKET.
        Sources, both read directly:
          https://www.mql5.com/en/docs/constants/environment_state/marketinfoconstants
          https://www.mql5.com/en/docs/constants/tradingconstants/orderproperties
        This finding CHANGED THE CODE -- see CSymbolSpec::ResolveFilling and the
        regression test in MQL5/Scripts/Alikhande/RunTests.mq5.

  * UNVERIFIED BY THE MAINTAINER. Everything else. The research pass fetched
    official pages through a summarising layer, so quoted prose is near-verbatim
    rather than certified, and build numbers and dates have not been re-read by
    eye. The report's own caveat section says the same thing; it is preserved.

Treat every other claim here as a LEAD TO CHECK, not as a fact to build on.
Verify against the official page before it changes code or enters user-facing
documentation. The report marks its own gaps as UNVERIFIED -- those are gaps in
the research, and are separate from this blanket maintainer-level caveat.
-->

# MT5 / MQL5 Platform State — Research Report

**Prepared:** 2026-09-15
**Scope:** Factual research only. No project code produced.
**Method:** Official MetaQuotes sources fetched directly (www.metatrader5.com, www.mql5.com/en/docs, www.mql5.com/en/book, official MetaQuotes forum announcements on mql5.com).

---

## ⚠️ Methodological caveat — read first

All web pages in this report were retrieved through a fetch tool that converts the page to markdown and then **summarises it with a small model**. This means:

- **URLs and page existence are reliable** (a 404 is a real 404).
- **Constant names, numeric codes and structural facts are high-confidence** (they are short, literal tokens and were consistent across pages).
- **Text presented in quotation marks below is second-hand**: it is what the fetch layer reported the page as saying. It should be treated as *near-verbatim*, not *certified verbatim*. Before any of these quotes goes into user-facing documentation or a compliance claim, re-read the source page by eye.

Anything I could not confirm is explicitly marked **UNVERIFIED**.

---

## 1. Current MT5 platform state

### Latest build

| Item | Value | Source category |
|---|---|---|
| Latest MetaTrader 5 build | **6180** | (a) Official |
| Release date | **3 September 2026** per the release-notes index; **4 September 2026** ("Friday") per the MetaQuotes forum announcement | (a) Official — but the two official sources disagree by one day |

- (a) **Official** — <https://www.metatrader5.com/en/releasenotes> — release-notes index, build 6180 dated 3 September 2026.
- (a) **Official** — <https://www.mql5.com/en/forum/515552> — MetaQuotes forum announcement "New MetaTrader 5 Platform Build 6180: More AI Features", reported as 4 September 2026.

**Interpretation of the one-day discrepancy:** most likely a publish-date vs. rollout-date difference, or a timezone artefact of the fetch summarisation. Not material for engineering. Do **not** treat either date as precise without eyeballing the page.

**Important nuance:** "latest build" is the *terminal* build published by MetaQuotes. The build a given **broker's server** runs, and the build a given **client installation** runs, are independent and frequently older. Build 5572 (29 Jan 2026) added a warning for servers below build 5200, which confirms MetaQuotes itself expects a long tail of old servers in the field.

### Where the official build/changelog history lives

| Source | URL | Category |
|---|---|---|
| Canonical release-notes index (all builds, with Terminal / MQL5 / MetaEditor / Tester / Web Terminal sections per build) | <https://www.metatrader5.com/en/releasenotes> | (a) Official |
| Per-build permalink pattern | `https://www.metatrader5.com/en/releasenotes/terminal/<internal-id>` — e.g. build 5200 = `/terminal/2400`, build 5260 = `/terminal/2403`. **The trailing number is an internal article id, not the build number** — you cannot construct these URLs by arithmetic. | (a) Official |
| MetaQuotes forum announcements (same content, discussion attached) | <https://www.mql5.com/en/users/metaquotes> and per-build forum threads | (a) Official |

**Recommendation:** scrape/monitor `https://www.metatrader5.com/en/releasenotes` as the single source of truth; the per-build URLs are not predictable.

### Build timeline captured (2025-09 → 2026-09)

All from (a) Official — <https://www.metatrader5.com/en/releasenotes>:

| Build | Date |
|---|---|
| 6180 | 3 Sep 2026 |
| 6140 | 20 Aug 2026 |
| 6090 | 30 Jul 2026 |
| 6060 | 23 Jul 2026 |
| 5830 | 24 Apr 2026 |
| 5800 | 16 Apr 2026 |
| 5660 | 27 Feb 2026 |
| 5640 | 20 Feb 2026 |
| 5572 | 29 Jan 2026 |
| 5430 | 13 Nov 2025 |
| 5370 | 16 Oct 2025 |
| 5320 | 25 Sep 2025 |
| 5260 | 5 Sep 2025 |
| 5200 | 31 Jul 2025 |

This list is what the release-notes index surfaced; it is **not guaranteed exhaustive** (intermediate hotfix builds may exist that the index does not headline).

---

## 2. MQL5 language & API changes affecting EA development

Source for this entire section unless noted: (a) **Official** — <https://www.metatrader5.com/en/releasenotes>

### 2a. Breaking language changes — highest impact on us

These are the items that will actually bite a greenfield EA that pulls in older community code or the MetaQuotes Standard Library patterns.

**Method hiding in inheritance — CHANGED BEHAVIOUR (build 5200, 31 Jul 2025; extended 5260, 5 Sep 2025)**

- Build 5200: *"When a derived class contains a method with the same name as one in the base class, the derived class version is now called by default"* and *"To explicitly call the base class method, a qualifier is now required."*
- Build 5260: *"Previously, if a derived class ... defined a method with the same name as in the base class, overloading was performed ... Now, methods with the same name in a derived class hide base class methods"* and *"To call a hidden base class method, you must explicitly specify its scope."*
- Build 5260 added the **`using` operator**: *"allows you to 'pull' all overloads of a method from the base type."*
- Corroborating (b) community/forum evidence that this was pre-announced for years as the `deprecated behavior, hidden method calling will be disabled in a future MQL compiler version` warning: <https://www.mql5.com/en/forum/479024>, <https://www.mql5.com/en/forum/368815>.
- Official announcement threads: <https://www.mql5.com/en/forum/492297> (5200), <https://www.mql5.com/en/forum/494649> (5260).

**Why it matters to us:** anything that subclasses `CTrade`, `CExpert`, `CObject` etc. and re-declares a same-named method now silently binds differently than it did pre-5200. Old third-party `.mqh` libraries are the risk surface.

**Other tightening (build 5200):**
- *"Duplicate names within the same scope are now prohibited"*
- *"Added strict type checking for default values in enumerations"*
- *"Identical identifiers are now prohibited across different enumerations"*
- *"Introduced stricter requirements for template initializer functions"* / *"All template parameters and arguments must now be specified explicitly"*

### 2b. New API surface directly relevant to EA trading logic

**`SymbolInfoCommissions()` — NEW (build 6060, 23 Jul 2026)**
- (a) Official docs: <https://www.mql5.com/en/docs/marketinformation/symbolinfocommissions>
- Signature: `int SymbolInfoCommissions(string name, MqlCommission &commissions[]);`
- *"Returns commission charging rules for the specified financial instrument."*
- Returns count of rules; `-1` on error; `0` if none.
- Fills `MqlCommission` (fields: `currency`, `mode_range`, `mode_charge`, `mode_entry`, `mode_direction`, `mode_profit`, `tiers[]`) and `MqlCommissionTier`.
- **Significance:** this is the first officially documented way for an EA to read broker commission structure programmatically rather than hard-coding it. Directly relevant to net-expectancy and position-sizing correctness. **Caveat: it only exists on build ≥ 6060**, so any use must be version-guarded.

**New input naming syntax (build 5320, 25 Sep 2025)**
- *"You can now explicitly set a visible name to be displayed in the program properties"* — `input(name="visible name") int InpVar;` replaces the old trailing-comment convention.

**`MathCompareByDigits()` — NEW (build 6140, 20 Aug 2026)** — *"function for number equality comparison by significant digit precision"*. Relevant to price/volume comparison correctness.

**`MQL_LAST_OPENBLAS_ERROR` added to `ENUM_MQL_INFO_INTEGER` (build 6060).**

**`Color2PRGB()` and vector/matrix `NormalizeDouble` (build 5640).**

### 2c. Changes to OrderSend / MqlTradeRequest / filling modes / SYMBOL_* / positions / deals / OnTradeTransaction

**Findings — read carefully, this is largely a negative result:**

Across every 2025-09 → 2026-09 build in the release-notes index I reviewed, I found **no documented change to**:
- the `OrderSend()` / `OrderSendAsync()` signature or semantics,
- the `MqlTradeRequest` structure (no fields added or removed),
- the `ENUM_ORDER_TYPE_FILLING` enumeration,
- `ENUM_ORDER_TYPE`,
- the `SYMBOL_*` enumeration set (other than the *new function* `SymbolInfoCommissions`, which reads a separate structure, not a `SYMBOL_*` property),
- `OnTradeTransaction` / `MqlTradeTransaction`,
- position or deal handling semantics.

**Assessment: the core trading API has been stable through this period.** The 2025–2026 MQL5 work has been concentrated in (i) matrix/vector/OpenBLAS/ONNX numerics, (ii) OOP strictness, (iii) AI Assistant / MCP integration, (iv) MetaEditor tooling.

This is a *confident negative* for MQL5-section entries, but note it is bounded by what the release-notes index surfaces — MetaQuotes does not always document every semantic nuance there. Marked **(a) Official, negative evidence**.

**Adjacent changes that DO affect trading-code behaviour:**

| Build | Change (quoted) | Impact |
|---|---|---|
| 5800 (16 Apr 2026) | *"Fixed data requests via CopyRates. Requests outside available history now correctly return error code -1"* | **Behaviour change.** Code that relied on the old (non-`-1`) return when reading beyond history will now take a different branch. Must handle `-1` from `CopyRates`. |
| 6060 (23 Jul 2026) | *"Fixed initialization of the trading dialog for symbols using Instant Execution"* (terminal-side) | Confirms Instant Execution symbols remain a live, distinct code path. |
| 6060 | *"Fixed initialization of the predefined `_StopFlag` variable for indicators"* | Relevant if we use `_StopFlag` / `IsStopped()` for graceful shutdown. |
| 5430 (13 Nov 2025) | *"Fixed the behavior of IsStopped during forced test termination"* | Same. |
| 5572 (29 Jan 2026) | *"Corrected freeze level check when deleting newly placed pending orders"* (Tester) | Confirms freeze level is enforced in the tester, and was buggy until recently. |
| 5572 | *"Increased the limit for files that can be included in a program as a resource. The new limit is 1 GB"* | Resource embedding. |
| 5660 (27 Feb 2026) | *"Enhanced HTTP and SOCKS5 protocol support... The outdated SOCKS4 protocol is no longer supported"* | Only matters if we use `WebRequest` through a proxy. |
| 5800 / 6060 | *"Updated the default source file encoding format. Files are now saved in UTF-8 without BOM"*; *"Changed .mq5/.mqh encoding to UTF-8 without BOM"* | **Tooling-relevant.** Affects git diffs, CI linting, and any script that parses sources. Plan for UTF-8-no-BOM. |
| 6060 | *"Added UTF-8 support for .mqproj files"* | Project-file tooling. |

### 2d. Deprecated / removed

- **UNVERIFIED as a formal list.** MQL5 has no single official "deprecated functions" page that I could locate. The official compiler-warnings page is <https://www.mql5.com/en/docs/constants/errorswarnings/warningscompile> (a) Official, and it states warnings are informational, not errors.
- The one concrete deprecation I could substantiate is the **hidden-method-call deprecation**, which was warned for years and then **enforced** in build 5200 (section 2a above). That is (a) Official via release notes, corroborated by (b) community forum threads.
- SOCKS4 proxy support removed (build 5660) — (a) Official.
- FTP trading-report publishing removed (build 6060) — (a) Official.
- **I found no evidence of any trading function being deprecated or removed.**

---

## 3. Order execution correctness reference — TRADE_RETCODE_*

**Authoritative page:** (a) **Official** — <https://www.mql5.com/en/docs/constants/errorswarnings/enum_trade_return_codes>

Complete table as retrieved:

| Code | Constant | Official description |
|---|---|---|
| 10004 | `TRADE_RETCODE_REQUOTE` | Requote |
| 10006 | `TRADE_RETCODE_REJECT` | Request rejected |
| 10007 | `TRADE_RETCODE_CANCEL` | Request canceled by trader |
| 10008 | `TRADE_RETCODE_PLACED` | Order placed |
| 10009 | `TRADE_RETCODE_DONE` | Request completed |
| 10010 | `TRADE_RETCODE_DONE_PARTIAL` | Only part of the request was completed |
| 10011 | `TRADE_RETCODE_ERROR` | Request processing error |
| 10012 | `TRADE_RETCODE_TIMEOUT` | Request canceled by timeout |
| 10013 | `TRADE_RETCODE_INVALID` | Invalid request |
| 10014 | `TRADE_RETCODE_INVALID_VOLUME` | Invalid volume in the request |
| 10015 | `TRADE_RETCODE_INVALID_PRICE` | Invalid price in the request |
| 10016 | `TRADE_RETCODE_INVALID_STOPS` | Invalid stops in the request |
| 10017 | `TRADE_RETCODE_TRADE_DISABLED` | Trade is disabled |
| 10018 | `TRADE_RETCODE_MARKET_CLOSED` | Market is closed |
| 10019 | `TRADE_RETCODE_NO_MONEY` | There is not enough money to complete the request |
| 10020 | `TRADE_RETCODE_PRICE_CHANGED` | Prices changed |
| 10021 | `TRADE_RETCODE_PRICE_OFF` | There are no quotes to process the request |
| 10022 | `TRADE_RETCODE_INVALID_EXPIRATION` | Invalid order expiration date in the request |
| 10023 | `TRADE_RETCODE_ORDER_CHANGED` | Order state changed |
| 10024 | `TRADE_RETCODE_TOO_MANY_REQUESTS` | Too frequent requests |
| 10025 | `TRADE_RETCODE_NO_CHANGES` | No changes in request |
| 10026 | `TRADE_RETCODE_SERVER_DISABLES_AT` | Autotrading disabled by server |
| 10027 | `TRADE_RETCODE_CLIENT_DISABLES_AT` | Autotrading disabled by client terminal |
| 10028 | `TRADE_RETCODE_LOCKED` | Request locked for processing |
| 10029 | `TRADE_RETCODE_FROZEN` | Order or position frozen |
| 10030 | `TRADE_RETCODE_INVALID_FILL` | Invalid order filling type |
| 10031 | `TRADE_RETCODE_CONNECTION` | No connection with the trade server |
| 10032 | `TRADE_RETCODE_ONLY_REAL` | Operation is allowed only for live accounts |
| 10033 | `TRADE_RETCODE_LIMIT_ORDERS` | The number of pending orders has reached the limit |
| 10034 | `TRADE_RETCODE_LIMIT_VOLUME` | The volume of orders and positions for the symbol has reached the limit |
| 10035 | `TRADE_RETCODE_INVALID_ORDER` | Incorrect or prohibited order type |
| 10036 | `TRADE_RETCODE_POSITION_CLOSED` | Position with the specified POSITION_IDENTIFIER has already been closed |
| 10038 | `TRADE_RETCODE_INVALID_CLOSE_VOLUME` | A close volume exceeds the current position volume |
| 10039 | `TRADE_RETCODE_CLOSE_ORDER_EXIST` | A close order already exists for a specified position |
| 10040 | `TRADE_RETCODE_LIMIT_POSITIONS` | Limit on simultaneous open positions reached |
| 10041 | `TRADE_RETCODE_REJECT_CANCEL` | The pending order activation request is rejected, the order is canceled |
| 10042 | `TRADE_RETCODE_LONG_ONLY` | "Only long positions are allowed" rule enforced |
| 10043 | `TRADE_RETCODE_SHORT_ONLY` | "Only short positions are allowed" rule enforced |
| 10044 | `TRADE_RETCODE_CLOSE_ONLY` | "Only position closing is allowed" rule enforced |
| 10045 | `TRADE_RETCODE_FIFO_CLOSE` | "Position closing is allowed only by FIFO rule" enforced |
| 10046 | `TRADE_RETCODE_HEDGE_PROHIBITED` | "Opposite positions on a single symbol are disabled" rule enforced |

**Note: 10037 is absent** from the official list — the sequence jumps 10036 → 10038. That is what the page shows; do not invent a 10037.

### Official semantics of OrderSend — critical

(a) **Official** — <https://www.mql5.com/en/docs/trading/ordersend>

- Signature: `bool OrderSend(MqlTradeRequest &request, MqlTradeResult &result);`
- *"In case of a successful basic check of structures (index checking) returns true. However, this is not a sign of successful execution of a trade operation."*
- *"the successful result of the OrderSend() function does not mean that the order has been executed"* — true only means *"the order has been successfully placed in the trading system for further execution."*
- *"we should first check the retcode trade server response code and the retcode_external external system response code (if necessary) available in the obtained result structure."*
- *"It is recommended to check the request before sending it to a trade server. To check requests, use the OrderCheck() function."*
- *"event(s) of executing trades corresponding to an order may happen after sending a response to the OrderSend() call"*, tracked via `OnTradeTransaction`, which *"will be called several times when executing one trade request."*

**Engineering consequence:** the boolean return of `OrderSend` is close to worthless as a success signal. `result.retcode` is the real signal, and even `10009 / TRADE_RETCODE_DONE` is a *server acceptance*, not a settled position — reconciliation must be event-driven.

### OnTradeTransaction — official constraints

(a) **Official** — <https://www.mql5.com/en/docs/event_handlers/ontradetransaction>

```
void OnTradeTransaction(const MqlTradeTransaction& trans,
                        const MqlTradeRequest&     request,
                        const MqlTradeResult&      result);
```
- `request` and `result` are populated **only** for transactions of type `TRADE_TRANSACTION_REQUEST`.
- *"Priority of these transactions' arrival at the terminal is not guaranteed. Thus, you should not expect that one group of transactions will arrive after another one."*
- *"While an MQL5 program handles adding a new order, it can be executed, deleted from the list of open orders and moved to history."*
- *"Transactions queue length comprises 1024 elements. If OnTradeTransaction() handles yet another transaction for too long, the previous ones can be superseded by new transactions."*
- *"One OnTrade() call corresponds to one or several OnTradeTransaction calls"*; *"You cannot rely on the statement 'One request - one Trade event.'"*

**Engineering consequence:** `OnTradeTransaction` is an *unordered, lossy, bounded* event stream. It is a **hint to re-sync**, not a ledger. Any state machine built on strict transaction ordering is incorrect by construction.

---

## 4. Broker specification surface — SYMBOL_* properties an EA must read

**Authoritative page:** (a) **Official** — <https://www.mql5.com/en/docs/constants/environment_state/marketinfoconstants>

### Price / precision — `SymbolInfoInteger` / `SymbolInfoDouble`

| Identifier | Accessor | Official description |
|---|---|---|
| `SYMBOL_DIGITS` | Integer | "Digits after a decimal point" |
| `SYMBOL_POINT` | Double | "Symbol point value" |
| `SYMBOL_TRADE_TICK_SIZE` | Double | "Minimal price change" |
| `SYMBOL_SPREAD` | Integer | "Spread value in points" |
| `SYMBOL_SPREAD_FLOAT` | Integer (bool) | "Indication of a floating spread" |

**Note: `SYMBOL_POINT` and `SYMBOL_TRADE_TICK_SIZE` are distinct properties and are not always equal.** Price normalisation must round to `SYMBOL_TRADE_TICK_SIZE`, not to `SYMBOL_POINT`.

### Contract / valuation

| Identifier | Accessor | Official description |
|---|---|---|
| `SYMBOL_TRADE_CONTRACT_SIZE` | Double | "Trade contract size" |
| `SYMBOL_TRADE_TICK_VALUE` | Double | "Value of SYMBOL_TRADE_TICK_VALUE_PROFIT" |
| `SYMBOL_TRADE_TICK_VALUE_PROFIT` | Double | "Calculated tick price for a profitable position" |
| `SYMBOL_TRADE_TICK_VALUE_LOSS` | Double | "Calculated tick price for a losing position" |
| `SYMBOL_CURRENCY_BASE` | String | "Basic currency of a symbol" |
| `SYMBOL_CURRENCY_PROFIT` | String | "Profit currency" |
| `SYMBOL_CURRENCY_MARGIN` | String | "Margin currency" |

**Note:** `SYMBOL_TRADE_TICK_VALUE` officially aliases the *profit* variant. For **risk sizing on a losing trade**, `SYMBOL_TRADE_TICK_VALUE_LOSS` is the correct input; they differ on instruments where the broker values gains and losses asymmetrically.

### Volume

| Identifier | Accessor | Official description |
|---|---|---|
| `SYMBOL_VOLUME_MIN` | Double | "Minimal volume for a deal" |
| `SYMBOL_VOLUME_MAX` | Double | "Maximal volume for a deal" |
| `SYMBOL_VOLUME_STEP` | Double | "Minimal volume change step for deal execution" |
| `SYMBOL_VOLUME_LIMIT` | Double | "Maximum allowed aggregate volume of open position and pending orders in one direction (buy or sell) for symbol" |

`SYMBOL_VOLUME_LIMIT` is the one most EAs forget; it maps to retcode **10034**.

### Stop placement constraints

| Identifier | Accessor | Official description |
|---|---|---|
| `SYMBOL_TRADE_STOPS_LEVEL` | Integer | "Minimal indention in points from current close price to place Stop orders" |
| `SYMBOL_TRADE_FREEZE_LEVEL` | Integer | "Distance to freeze trade operations in points" |

Maps to retcodes **10016** (stops level violated) and **10029** (freeze level — modification/deletion blocked).

> **UNVERIFIED (model knowledge, could not confirm from the docs page):** the widely-repeated claim that many brokers report `SYMBOL_TRADE_STOPS_LEVEL == 0` while still enforcing a dynamic, spread-dependent minimum server-side. The official page does **not** say this. Treat defensively in code (enforce our own floor) but do not cite it as documented.

### Filling modes — **highest-risk area**

| Identifier | Accessor | Official description |
|---|---|---|
| `SYMBOL_FILLING_MODE` | Integer | "Flags of allowed order filling modes" |

Flag values (a) Official:
- `SYMBOL_FILLING_FOK` = **1** — Fill or Kill
- `SYMBOL_FILLING_IOC` = **2** — Immediate or Cancel
- `SYMBOL_FILLING_BOC` = **4** — Book or Cancel (passive)

`ENUM_ORDER_TYPE_FILLING` (a) Official — <https://www.mql5.com/en/docs/constants/tradingconstants/orderproperties>:

| Constant | Official description | Availability |
|---|---|---|
| `ORDER_FILLING_FOK` | "An order can be executed in the specified volume only. If the necessary amount of a financial instrument is currently unavailable in the market, the order will not be executed." | All execution modes |
| `ORDER_FILLING_IOC` | "A trader agrees to execute a deal with the volume maximally available in the market within that indicated in the order." | All execution modes |
| `ORDER_FILLING_BOC` | "The BoC order assumes that the order can only be placed in the Depth of Market and cannot be immediately executed." | Limit / stop-limit only; Market & Exchange modes, per symbol settings |
| `ORDER_FILLING_RETURN` | "In case of partial filling, an order with remaining volume is not canceled but processed further." | **Disabled in Market Execution mode; enabled in all other modes.** Always available for pending orders regardless of execution type |

> ### 🔴 The critical asymmetry
> **`ORDER_FILLING_RETURN` is NOT a flag in `SYMBOL_FILLING_MODE`.** The `SYMBOL_FILLING_MODE` bitmask only ever carries FOK / IOC / BOC.
> Whether `ORDER_FILLING_RETURN` is legal is derived from **`SYMBOL_TRADE_EXEMODE`** (it is *disabled* under `SYMBOL_TRADE_EXECUTION_MARKET`, allowed otherwise).
> Confirmed (a) Official on both the market-info page and the order-properties page.
>
> **This is the direct cause of retcode 10030 (`TRADE_RETCODE_INVALID_FILL`).** An EA that only reads `SYMBOL_FILLING_MODE` will conclude RETURN is never allowed; an EA that hard-codes RETURN will fail on Market-execution symbols. Correct resolution requires reading **both** `SYMBOL_FILLING_MODE` and `SYMBOL_TRADE_EXEMODE`.

### Execution & trade mode

| Identifier | Accessor | Values |
|---|---|---|
| `SYMBOL_TRADE_MODE` | Integer → `ENUM_SYMBOL_TRADE_MODE` | `SYMBOL_TRADE_MODE_DISABLED`, `_LONGONLY`, `_SHORTONLY`, `_CLOSEONLY`, `_FULL` |
| `SYMBOL_TRADE_EXEMODE` | Integer → `ENUM_SYMBOL_TRADE_EXECUTION` | `SYMBOL_TRADE_EXECUTION_REQUEST`, `_INSTANT`, `_MARKET`, `_EXCHANGE` |

`SYMBOL_TRADE_MODE` maps to retcodes **10042 / 10043 / 10044**.
`SYMBOL_TRADE_EXEMODE` determines whether `price` must be filled in the request (Instant/Request) or is ignored (Market), and gates `ORDER_FILLING_RETURN`.

### Allowed order types / expiration

| Identifier | Flags |
|---|---|
| `SYMBOL_ORDER_MODE` | `SYMBOL_ORDER_MARKET`(1), `SYMBOL_ORDER_LIMIT`(2), `SYMBOL_ORDER_STOP`(4), `SYMBOL_ORDER_STOP_LIMIT`(8), `SYMBOL_ORDER_SL`(16), `SYMBOL_ORDER_TP`(32), `SYMBOL_ORDER_CLOSEBY`(64) |
| `SYMBOL_EXPIRATION_MODE` | `SYMBOL_EXPIRATION_GTC`(1), `SYMBOL_EXPIRATION_DAY`(2), `SYMBOL_EXPIRATION_SPECIFIED`(4), `SYMBOL_EXPIRATION_SPECIFIED_DAY`(8) |
| `SYMBOL_ORDER_GTC_MODE` → `ENUM_SYMBOL_ORDER_GTC_MODE` | `SYMBOL_ORDERS_GTC`, `SYMBOL_ORDERS_DAILY`, `SYMBOL_ORDERS_DAILY_EXCLUDING_STOPS` |

`SYMBOL_ORDER_SL` / `SYMBOL_ORDER_TP` are separately gated — some symbols disallow attached SL/TP entirely. `SYMBOL_EXPIRATION_MODE` maps to retcode **10022**.

### Margin

| Identifier | Accessor | Official description |
|---|---|---|
| `SYMBOL_TRADE_CALC_MODE` | Integer → `ENUM_SYMBOL_CALC_MODE` | "Contract price calculation mode" |
| `SYMBOL_MARGIN_INITIAL` | Double | "Amount in margin currency required for opening position with volume of one lot" |
| `SYMBOL_MARGIN_MAINTENANCE` | Double | "Margin amount in margin currency of symbol, charged from one lot" |
| `SYMBOL_MARGIN_HEDGED` | Double | "Contract size or margin value per one lot of hedged positions (oppositely directed positions)" |

`ENUM_SYMBOL_CALC_MODE` values: `SYMBOL_CALC_MODE_FOREX`, `_FOREX_NO_LEVERAGE`, `_FUTURES`, `_CFD`, `_CFDINDEX`, `_CFDLEVERAGE`, `_EXCH_STOCKS`, `_EXCH_FUTURES`, `_EXCH_FUTURES_FORTS`, `_EXCH_BONDS`, `_EXCH_STOCKS_MOEX`, `_EXCH_BONDS_MOEX`, `_SERV_COLLATERAL`.

**Recommendation:** prefer `OrderCalcMargin()` over hand-rolling margin from these properties — the calc-mode matrix is large and broker-specific. (Note release notes, build 5200: *"Fixed OrderCalcMargin function for accounts with Exchange calculation mode"* — so this function had real bugs as recently as Jul 2025.)

### Swap

| Identifier | Accessor | Notes |
|---|---|---|
| `SYMBOL_SWAP_MODE` | Integer → `ENUM_SYMBOL_SWAP_MODE` | "Swap calculation model" |
| `SYMBOL_SWAP_LONG` / `SYMBOL_SWAP_SHORT` | Double | "Long swap value" / "Short swap value" |
| `SYMBOL_SWAP_SUNDAY` … `SYMBOL_SWAP_SATURDAY` | Double | Per-weekday swap ratios (triple-swap day handling) |

`ENUM_SYMBOL_SWAP_MODE`: `SYMBOL_SWAP_MODE_DISABLED`, `_POINTS`, `_CURRENCY_SYMBOL`, `_CURRENCY_MARGIN`, `_CURRENCY_DEPOSIT`, `_CURRENCY_PROFIT`, `_INTEREST_CURRENT`, `_INTEREST_OPEN`, `_REOPEN_CURRENT`, `_REOPEN_BID`.

**`SYMBOL_SWAP_LONG` is meaningless without `SYMBOL_SWAP_MODE`** — the same numeric value means points, deposit currency, or annual interest percent depending on mode. (Release notes, build 6060: *"Fixed percentage-based swap calculations"* in the Tester — so interest-mode swaps were mis-tested until Jul 2026.)

### Account-level properties (must pair with symbol properties)

(a) **Official** — <https://www.mql5.com/en/docs/constants/environment_state/accountinformation>

| Identifier | Notes |
|---|---|
| `ACCOUNT_MARGIN_MODE` → `ENUM_ACCOUNT_MARGIN_MODE` | `ACCOUNT_MARGIN_MODE_RETAIL_NETTING` — "only one position can exist for one symbol"; `ACCOUNT_MARGIN_MODE_EXCHANGE`; `ACCOUNT_MARGIN_MODE_RETAIL_HEDGING` — "multiple positions can exist for one symbol" |
| `ACCOUNT_TRADE_ALLOWED` | "Allowed trade for the current account" |
| `ACCOUNT_TRADE_EXPERT` | "Allowed trade for an Expert Advisor" |
| `ACCOUNT_LIMIT_ORDERS` | "Maximum allowed number of active pending orders" (→ retcode 10033) |
| `ACCOUNT_CURRENCY`, `ACCOUNT_LEVERAGE` | — |
| `ACCOUNT_MARGIN_SO_MODE` → `ENUM_ACCOUNT_STOPOUT_MODE` | "Mode for setting the minimal allowed margin" |

> **`ACCOUNT_MARGIN_MODE` is architecturally decisive.** Netting vs hedging changes what "close a position" even means: under netting an opposing order nets down an existing position; under hedging it opens a second one. Position-tracking code cannot be written once and work on both unless this is an explicit abstraction. Also note `ACCOUNT_TRADE_EXPERT` is separate from `ACCOUNT_TRADE_ALLOWED`.

---

## 5. Strategy Tester

### Modelling modes — official list (five)

(a) **Official** — <https://www.metatrader5.com/en/terminal/help/algotrading/testing>

| Mode | Official description |
|---|---|
| **Every tick** | "the most accurate but the slowest mode. All ticks are simulated in this mode." |
| **Every tick based on real ticks** | "Testing is performed using real ticks of financial instruments, accumulated by brokers. No simulation is performed." |
| **1 minute OHLC** | "In this mode only 4 prices (Open, High, Low and Close) of each minute bar are emulated." |
| **Open prices only** | "In this mode OHLC prices are also modeled, however only the open price is used for testing/optimization." |
| **Math calculations** | "The tester does not download history data and information on symbols, as well as does not generate ticks. Only functions OnInit(), OnTester() and OnDeinit() are called." |

(a) **Official** — <https://www.metatrader5.com/en/terminal/help/algotrading/tick_generation> corroborates and adds the generation detail; (a) **Official** — <https://www.mql5.com/en/docs/runtime/testing> is the MQL5-reference view.

### Spread handling — important

- <https://www.mql5.com/en/docs/runtime/testing>: *"During testing, the spread is not modeled but is taken from historical data."* and *"In the Strategy Tester, the spread is always considered floating."*
- <https://www.metatrader5.com/en/terminal/help/algotrading/tick_generation>: *"When testing on real ticks, a spread may change within a minute bar, whereas when generating ticks within a minute, a spread fixed in the appropriate bar is used."*

**Consequence:** in every mode except real ticks, spread is effectively **constant within each M1 bar**. Any strategy whose edge is smaller than intra-minute spread variation is untestable in generated-tick modes.

### Execution / latency settings

(a) **Official** — <https://www.metatrader5.com/en/terminal/help/algotrading/testing>. Three delay options:
- **No delay** — "All orders are executed at requested prices without requotes."
- **Random delay** — random delays in the 0–18 second range with a probability distribution.
- **Fixed delay** — preset or custom value.

**Default is effectively a zero-latency, zero-requote world.** Requotes (10004) and price-changed (10020) are largely *not exercised* unless delay is deliberately configured.

### "Tick data quality"

- **There is no MT4-style "modelling quality %" metric in MT5.** I checked <https://www.metatrader5.com/en/terminal/help/algotrading/test_preparation> and <https://www.metatrader5.com/en/terminal/help/algotrading/testing> and found no such metric. **(a) Official — negative evidence.** The community habit of saying "99% quality backtest" is imported from MT4 and is **not an MT5 concept**; see (b) community <https://www.mql5.com/en/blogs/post/762517>.
- What MT5 actually reports is **Ticks** and **Bars** counts, plus the chosen modelling mode.
- History preparation, (a) Official <https://www.metatrader5.com/en/terminal/help/algotrading/test_preparation>: *"From the trading server, M1 bars and tick data for the selected symbol are downloaded to the terminal"*, then *"From the terminal, the history is copied in compressed form to the testing agent."*
- Pre-start history buffer requirements: *"D1 and below — from the beginning of the previous calendar year. This provides at least 1 year of history."*; *"W1 — at least 100 weekly bars (~2 years). MN1 — at least 100 monthly bars (~8 years)."* If insufficient, *"the tester automatically shifts the actual start date forward to the nearest point that meets the requirements."*
  - **Engineering consequence:** the tester may silently move your start date. Backtest date ranges are not guaranteed to be the ones you requested.
- **Real ticks are not guaranteed complete.** (a) Official MQL5 Book <https://www.mql5.com/en/book/automation/tester/tester_ticks>: *"If there is a minute bar in the symbol's history, but no tick data for that minute, the tester will generate ticks in the 'Every tick' mode."* So a "real ticks" run can be **silently hybrid**.
- Tick cache limit, same source: real tick data keeps *"no more than 128,000 ticks"* in the tester cache.
- (a) Official <https://www.mql5.com/en/docs/runtime/testing>: the tester validates ticks against minute-bar parameters, discarding ticks that violate High/Low boundaries and regenerating them.

### Official guidance on tester-vs-live divergence

This is genuinely documented by MetaQuotes, not just community folklore:

- (a) Official <https://www.mql5.com/en/docs/runtime/testing>: *"The refusal to generate additional intermediate ticks between the Open, High, Low, and Close prices, leads to an appearance of rigid determinism in the development of prices."*
- (a) Official <https://www.mql5.com/en/docs/runtime/testing>: *"Note: If the test results of the EA in the rough testing modes ('1 minute OHLC' and 'Open Prices only') seem too good, make sure to test it in the 'Every tick' mode."*
- (a) Official MQL5 Book <https://www.mql5.com/en/book/automation/tester/tester_ticks>: using only OHLC *"makes it possible to create a 'Testing Grail' that shows a nice upward trending balance chart when testing"* but *"When testing such an Expert Advisor on history, everything goes perfectly, but online it will fail."* Cause: between High and Low *"information about the order of their occurrence is lost."*
- (a) Official MQL5 Book recommendation: test *"in the 'Every tick' mode or, better, based on real ticks after finding the optimal Expert Advisor settings on rough testing modes."*
- (a) Official <https://www.metatrader5.com/en/terminal/help/algotrading/tick_generation>: *"The mode of every tick generation is the most accurate, but the slowest one. For quick, but rough testing/optimization, use the 'Open prices only' mode."*

**What MetaQuotes does NOT officially quantify:** slippage, requote frequency, latency, or broker-side rejection rates. Community analysis of those: (b) <https://www.mql5.com/en/blogs/post/767337>, (b) <https://www.mql5.com/en/forum/430831>.

### Recent tester fixes worth knowing (all (a) Official, release notes)

| Build | Fix |
|---|---|
| 6060 | *"Fixed the application of custom spreads in the 'Open prices only' testing mode"* |
| 6060 | *"Fixed percentage-based swap calculations"* |
| 6060 | *"Fixed the application of custom margin settings"* |
| 5800 | *"Fixed CopyTicksRange behavior. Requests for symbols other than the main testing symbol previously returned error 4401"* |
| 5572 | *"Corrected freeze level check when deleting newly placed pending orders"* |
| 5572 | *"Fixed export of forward-testing data"* |
| 5200 | *"Fixed OrderCalcMargin function for accounts with Exchange calculation mode"* |
| 5640 | *"Fixed historical data synchronization issues"* for instruments whose margin currency differs from the deposit currency |

**Implication:** cost modelling in the tester (spread, swap, margin) had *material* bugs fixed as recently as July 2026. Any backtest produced on a build older than 6060 should be regarded with suspicion if the strategy is cost-sensitive.

---

## 6. Toolchain reality check

### Headless / CLI compilation — OFFICIALLY DOCUMENTED ✅

(a) **Official** — <https://www.metatrader5.com/en/metaeditor/help/beginning/integration_ide> ("Integration with other IDEs")

**Note:** the obvious-looking page <https://www.metatrader5.com/en/metaeditor/help/development/compile> documents only the GUI flow and does **not** list CLI flags. <https://www.metatrader5.com/en/metaeditor/help/development/compilation> **404s**. The CLI flags live on the *Integration with other IDEs* page.

Documented keys:

| Flag | Meaning |
|---|---|
| `/compile:"<path>"` | Compile a single source file, **or** a folder (mass compilation of all sources in it) |
| `/include:"<path>"` | Override the include (MQL5) directory |
| `/log` | Write a compilation log — a `<source file name>.log` file is created next to the source |
| `/s` | Syntax check only, no compilation |

Both `metaeditor.exe` and `metaeditor64.exe` are named in the docs.

Documented syntax examples (as retrieved):

```
"C:\Program Files\TradingPlatform\metaeditor64.exe" /compile:"C:\Program Files\TradingPlatform\MQL5\Scripts\myscript.mq5"

"C:\Program Files\TradingPlatform\metaeditor64.exe" /compile:"C:\Program Files\TradingPlatform\MQL5\Scripts"

"C:\Program Files\TradingPlatform\metaeditor64.exe" /compile:"C:\Program Files\TradingPlatform\MQL5\Scripts" /include:"C:\Program Files\TradingPlatform 2\MQL5"

"C:\Program Files\TradingPlatform\metaeditor64.exe" /compile:"C:\Program Files\TradingPlatform\MQL5\Scripts\myscript.mq5" /s /log
```

Documented caveat: *"Re-compilation is not performed if a source file already has the appropriate compiled version."*

**CI-relevant gotchas:**
1. The **incremental-skip behaviour** means a naive CI job can report success without actually recompiling. Delete the `.ex5` (or the whole output) before compiling in CI.
2. `/log` writes the log **next to the source file**, not to stdout. CI must read that `.log` file to get diagnostics.
3. **UNVERIFIED:** the process exit code. I could not find official documentation of what exit code `metaeditor64.exe /compile` returns on compilation failure. Community practice is to parse the `.log` file rather than trust `%ERRORLEVEL%`. **Do not build CI gating on exit code without empirically verifying it first.**
4. **UNVERIFIED:** flags beyond `/compile`, `/include`, `/log`, `/s`. I saw no official `/portable`, `/inc`, or output-path flag for MetaEditor. (`/portable` is documented for the *terminal*, not established here for MetaEditor.)

### Linux support — WINE ONLY, officially

(a) **Official** — <https://www.metatrader5.com/en/terminal/help/start_advanced/install_linux>

- *"The platform runs on Linux using Wine. Wine is a free compatibility layer that allows application software developed for Microsoft Windows to run on Unix-like operating systems."*
- Official one-line installer:
  ```
  wget https://download.terminal.free/cdn/web/metaquotes.software.corp/mt5/mt5linux.sh ; chmod +x mt5linux.sh ; ./mt5linux.sh
  ```
- Supported distributions: *"Ubuntu, Debian, Linux Mint and Fedora"*. The script auto-detects the distro and installs an appropriate Wine package.
- *"If you are prompted to install additional Wine packages (Mono, Gecko), please agree, as these packages are required for platform operation."*
- *"It is highly recommended to always use the latest versions of the operating system and Wine. Timely updates increase platform operation stability and improve performance."*
- Default data folder: `Home directory/.mt5/drive_c/Program Files/MetaTrader 5`

**Conclusion: there is NO native Linux build of MetaTrader 5 or MetaEditor.** MetaQuotes officially supports Linux *via Wine* — it is a MetaQuotes-published, MetaQuotes-scripted Wine install, so it is more than community hackery, but it is emulation, not a native port. Corroborated by (a) Official <https://www.metatrader5.com/en/news/2329> ("Download MetaTrader 5 for macOS and Linux").

That Wine is a real, supported-but-imperfect path is confirmed by release notes themselves: build 5572 (a) Official — *"Fixed text rendering on macOS/Linux using Wine."*

**Running `metaeditor64.exe /compile` under Wine on Linux for CI: UNVERIFIED as officially documented.** MetaQuotes documents (i) the CLI flags on Windows and (ii) that the platform runs under Wine — but I found **no official page that combines them** into a documented headless-Linux build workflow. That combination is (c) community practice / inference. It is very likely to work, but it is not an officially supported, documented toolchain.

---

## Confidence & Sources

**Legend:** (a) = confirmed from official MetaQuotes docs with URL · (b) = community/third-party with URL · (c) = model knowledge, could not verify

| # | Claim | Cat. | Confidence | Source |
|---|---|---|---|---|
| 1 | Latest MT5 build is **6180** | (a) | High | <https://www.metatrader5.com/en/releasenotes> · <https://www.mql5.com/en/forum/515552> |
| 2 | Build 6180 released 3 Sep 2026 (release notes) / 4 Sep 2026 (forum) | (a) | Medium — sources differ by 1 day | same as above |
| 3 | Canonical changelog lives at metatrader5.com/en/releasenotes; per-build URL ids are internal, not derivable | (a) | High | <https://www.metatrader5.com/en/releasenotes/terminal/2400> (=5200), `/2403` (=5260) |
| 4 | Full TRADE_RETCODE_* table incl. 10004/10006/10014/10016/10018/10019/10021/10027/10030 | (a) | High | <https://www.mql5.com/en/docs/constants/errorswarnings/enum_trade_return_codes> |
| 5 | 10037 does not exist in the official list | (a) | High (negative evidence) | same |
| 6 | `OrderSend` returning true ≠ trade executed; must check `result.retcode` | (a) | High | <https://www.mql5.com/en/docs/trading/ordersend> |
| 7 | `OnTradeTransaction` ordering not guaranteed; 1024-element queue can drop events | (a) | High | <https://www.mql5.com/en/docs/event_handlers/ontradetransaction> |
| 8 | `MqlTradeRequest` fields (17 listed); no recent additions | (a) | High | <https://www.mql5.com/en/docs/constants/structures/mqltraderequest> |
| 9 | `SYMBOL_FILLING_MODE` flags are FOK=1, IOC=2, BOC=4 only | (a) | High | <https://www.mql5.com/en/docs/constants/environment_state/marketinfoconstants> |
| 10 | `ORDER_FILLING_RETURN` is not a `SYMBOL_FILLING_MODE` flag; gated by `SYMBOL_TRADE_EXEMODE` (disabled in Market execution) | (a) | High | marketinfoconstants + <https://www.mql5.com/en/docs/constants/tradingconstants/orderproperties> |
| 11 | Full SYMBOL_* broker-spec surface + exact enum identifiers (§4) | (a) | High | <https://www.mql5.com/en/docs/constants/environment_state/marketinfoconstants> |
| 12 | `SYMBOL_TRADE_TICK_VALUE` aliases the *profit* variant; `_LOSS` variant exists separately | (a) | High | same |
| 13 | `ACCOUNT_MARGIN_MODE` netting/exchange/hedging semantics | (a) | High | <https://www.mql5.com/en/docs/constants/environment_state/accountinformation> |
| 14 | Brokers often report stops level 0 but enforce dynamically server-side | (c) | **UNVERIFIED** | Not stated on any official page I read. Code defensively; do not cite as documented. |
| 15 | Five tester modelling modes with official names/descriptions | (a) | High | <https://www.metatrader5.com/en/terminal/help/algotrading/testing> · <https://www.metatrader5.com/en/terminal/help/algotrading/tick_generation> |
| 16 | Spread taken from history, always floating; fixed within an M1 bar except on real ticks | (a) | High | <https://www.mql5.com/en/docs/runtime/testing> · tick_generation |
| 17 | Tester delay options: No delay / Random (0–18s) / Fixed | (a) | High | <https://www.metatrader5.com/en/terminal/help/algotrading/testing> |
| 18 | MT5 has **no** MT4-style "modelling quality %" metric | (a) | Medium-High (negative evidence across 3 pages) | testing · test_preparation · <https://www.mql5.com/en/docs/runtime/testing> |
| 19 | "99% tick quality" is an MT4-era community framing, not MT5 | (b) | Medium | <https://www.mql5.com/en/blogs/post/762517> |
| 20 | Real-tick runs silently fall back to generated ticks for minutes lacking tick data | (a) | High | <https://www.mql5.com/en/book/automation/tester/tester_ticks> |
| 21 | Tester tick cache capped at ~128,000 ticks | (a) | Medium-High | same |
| 22 | Tester silently shifts start date forward if history is insufficient | (a) | High | <https://www.metatrader5.com/en/terminal/help/algotrading/test_preparation> |
| 23 | Official warning that OHLC-only modes enable a "Testing Grail" that fails live | (a) | High | <https://www.mql5.com/en/book/automation/tester/tester_ticks> · <https://www.mql5.com/en/docs/runtime/testing> |
| 24 | MetaQuotes does not officially quantify slippage/requote/latency divergence | (a) | Medium (negative evidence) | — ; community analysis (b) <https://www.mql5.com/en/blogs/post/767337> |
| 25 | CLI compile flags `/compile`, `/include`, `/log`, `/s`; `metaeditor64.exe` named | (a) | High | <https://www.metatrader5.com/en/metaeditor/help/beginning/integration_ide> |
| 26 | `/compile` supports folder mass-compilation | (a) | High | same |
| 27 | Re-compilation skipped if an up-to-date compiled version exists | (a) | High | same |
| 28 | `metaeditor64.exe` exit code on compile failure | (c) | **UNVERIFIED** | Not documented anywhere I found. Parse the `.log`, don't trust `%ERRORLEVEL%` until tested. |
| 29 | Flags beyond `/compile /include /log /s` (e.g. `/portable`, output-dir) | (c) | **UNVERIFIED** | No official MetaEditor page lists others. |
| 30 | Linux support is Wine-based; no native Linux build | (a) | High | <https://www.metatrader5.com/en/terminal/help/start_advanced/install_linux> · <https://www.metatrader5.com/en/news/2329> |
| 31 | Official Wine install script; Ubuntu/Debian/Mint/Fedora | (a) | High | install_linux |
| 32 | Headless compile under Wine on Linux as a documented CI workflow | (c) | **UNVERIFIED** | Officially documented only as two separate facts; the combination is community practice. |
| 33 | Method hiding behaviour changed in build 5200, extended 5260; `using` operator added | (a) | High | <https://www.metatrader5.com/en/releasenotes> · <https://www.mql5.com/en/forum/492297> · <https://www.mql5.com/en/forum/494649> |
| 34 | Stricter template/enum/duplicate-identifier rules in 5200 | (a) | High | <https://www.metatrader5.com/en/releasenotes> |
| 35 | `SymbolInfoCommissions()` is new in build 6060 | (a) | High | release notes + <https://www.mql5.com/en/docs/marketinformation/symbolinfocommissions> |
| 36 | No documented change to OrderSend / MqlTradeRequest / ORDER_FILLING_* / SYMBOL_* enums / OnTradeTransaction in builds 5200→6180 | (a) | Medium-High (negative evidence, bounded by release-note granularity) | <https://www.metatrader5.com/en/releasenotes> |
| 37 | `CopyRates` now returns -1 for out-of-history requests (build 5800) | (a) | High | same |
| 38 | `.mq5`/`.mqh` default encoding is now UTF-8 without BOM (5800/6060) | (a) | High | same |
| 39 | Tester cost-modelling bugs (custom spread in Open-prices mode, % swap, custom margin) fixed only in build 6060 | (a) | High | same |
| 40 | `input(name="...")` syntax added in build 5320 | (a) | High | same |
| 41 | No formal official "deprecated MQL5 functions" list exists | (a)/(c) | Medium — could not locate one | <https://www.mql5.com/en/docs/constants/errorswarnings/warningscompile> |

### Explicitly UNVERIFIED — do not design around these without further work

1. **`metaeditor64.exe` exit-code semantics** (#28) — blocks reliable CI gating. Needs empirical test.
2. **Officially supported headless Linux build workflow** (#32) — exists only as community practice.
3. **Stops level reported as 0 while enforced dynamically** (#14) — widely believed, not documented.
4. **MetaEditor CLI flags beyond the four documented** (#29).
5. **Exhaustiveness of the build list** — the release-notes index may omit hotfix builds.
6. **Exact wording of all quotes** — see the methodological caveat at the top.

