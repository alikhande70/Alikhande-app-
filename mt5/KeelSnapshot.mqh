// Authoritative current-state snapshot for KeelAgent.mq5.
// Read-only: this file never sends or modifies orders.

string KeelDecimal(const double value,const int digits=8)
  {
   return(DoubleToString(value,digits));
  }

#include "KeelInstrumentFacts.mqh"

string KeelPositionSide(const long type)
  {
   return(type==POSITION_TYPE_BUY ? "buy" : "sell");
  }

string KeelOrderSide(const long type)
  {
   switch((ENUM_ORDER_TYPE)type)
     {
      case ORDER_TYPE_BUY:
      case ORDER_TYPE_BUY_LIMIT:
      case ORDER_TYPE_BUY_STOP:
      case ORDER_TYPE_BUY_STOP_LIMIT:
         return("buy");
      default:
         return("sell");
     }
  }

string KeelOrderState(const long state)
  {
   switch((ENUM_ORDER_STATE)state)
     {
      case ORDER_STATE_STARTED: return("PENDING_SUBMIT");
      case ORDER_STATE_PLACED: return("WORKING");
      case ORDER_STATE_PARTIAL: return("PARTIAL");
      case ORDER_STATE_FILLED: return("FILLED");
      case ORDER_STATE_REQUEST_ADD:
      case ORDER_STATE_REQUEST_MODIFY:
      case ORDER_STATE_REQUEST_CANCEL: return("CANCEL_PENDING");
      case ORDER_STATE_CANCELED:
      case ORDER_STATE_EXPIRED: return("CANCELLED");
      case ORDER_STATE_REJECTED: return("REJECTED");
      default: return("UNKNOWN");
     }
  }

bool KeelBuildPositionsJson(string &json)
  {
   json="[";
   int total=PositionsTotal();
   for(int i=0;i<total;i++)
     {
      ResetLastError();
      ulong ticket=PositionGetTicket(i);
      if(ticket==0)
        {
         PrintFormat("KeelAgent: PositionGetTicket(%d) failed error=%d",i,GetLastError());
         return(false);
        }
      string symbol=PositionGetString(POSITION_SYMBOL);
      if(symbol=="") return(false);
      ulong position_id=(ulong)PositionGetInteger(POSITION_IDENTIFIER);
      ulong magic=(ulong)PositionGetInteger(POSITION_MAGIC);
      long type=PositionGetInteger(POSITION_TYPE);
      double volume=PositionGetDouble(POSITION_VOLUME);
      double entry=PositionGetDouble(POSITION_PRICE_OPEN);
      double sl=PositionGetDouble(POSITION_SL);
      double tp=PositionGetDouble(POSITION_TP);
      double pnl=PositionGetDouble(POSITION_PROFIT);
      long opened=(long)PositionGetInteger(POSITION_TIME_MSC);
      int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);

      string row=StringFormat(
         "{\"ticket\":\"%s\",\"positionId\":\"%s\",\"magic\":\"%s\",\"symbol\":\"%s\",\"canonical\":\"%s\",\"side\":\"%s\",\"volume\":\"%s\",\"entryPrice\":\"%s\",\"unrealisedPnl\":\"%s\",\"openedAt\":%I64d",
         ULongText(ticket),ULongText(position_id),ULongText(magic),JsonEscape(symbol),JsonEscape(symbol),
         KeelPositionSide(type),KeelDecimal(volume,8),KeelDecimal(entry,digits),KeelDecimal(pnl,8),opened);
      if(sl>0.0) row+=StringFormat(",\"stopPrice\":\"%s\"",KeelDecimal(sl,digits));
      if(tp>0.0) row+=StringFormat(",\"takeProfitPrice\":\"%s\"",KeelDecimal(tp,digits));
      row+="}";
      if(i>0) json+=",";
      json+=row;
     }
   json+="]";
   return(true);
  }

bool KeelBuildOrdersJson(string &json)
  {
   json="[";
   int total=OrdersTotal();
   for(int i=0;i<total;i++)
     {
      ResetLastError();
      ulong ticket=OrderGetTicket(i);
      if(ticket==0)
        {
         PrintFormat("KeelAgent: OrderGetTicket(%d) failed error=%d",i,GetLastError());
         return(false);
        }
      string symbol=OrderGetString(ORDER_SYMBOL);
      if(symbol=="") return(false);
      ulong magic=(ulong)OrderGetInteger(ORDER_MAGIC);
      long type=OrderGetInteger(ORDER_TYPE);
      long state=OrderGetInteger(ORDER_STATE);
      double requested=OrderGetDouble(ORDER_VOLUME_INITIAL);
      double remaining=OrderGetDouble(ORDER_VOLUME_CURRENT);
      double filled=MathMax(0.0,requested-remaining);
      double open_price=OrderGetDouble(ORDER_PRICE_OPEN);
      double stop_limit=OrderGetDouble(ORDER_PRICE_STOPLIMIT);
      long created=(long)OrderGetInteger(ORDER_TIME_SETUP_MSC);
      int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);

      string row=StringFormat(
         "{\"ticket\":\"%s\",\"magic\":\"%s\",\"symbol\":\"%s\",\"canonical\":\"%s\",\"side\":\"%s\",\"state\":\"%s\",\"requestedQty\":\"%s\",\"filledQty\":\"%s\",\"createdAt\":%I64d",
         ULongText(ticket),ULongText(magic),JsonEscape(symbol),JsonEscape(symbol),KeelOrderSide(type),
         KeelOrderState(state),KeelDecimal(requested,8),KeelDecimal(filled,8),created);
      if(open_price>0.0) row+=StringFormat(",\"limitPrice\":\"%s\"",KeelDecimal(open_price,digits));
      if(stop_limit>0.0) row+=StringFormat(",\"stopPrice\":\"%s\"",KeelDecimal(stop_limit,digits));
      row+="}";
      if(i>0) json+=",";
      json+=row;
     }
   json+="]";
   return(true);
  }

bool KeelBuildQuotesJson(string &json)
  {
   json="[";
   string symbols[];
   int count=0;

   for(int i=0;i<PositionsTotal();i++)
     {
      if(PositionGetTicket(i)==0) return(false);
      string symbol=PositionGetString(POSITION_SYMBOL);
      bool seen=false;
      for(int j=0;j<count;j++) if(symbols[j]==symbol) { seen=true; break; }
      if(!seen) { ArrayResize(symbols,count+1); symbols[count++]=symbol; }
     }
   for(int i=0;i<OrdersTotal();i++)
     {
      if(OrderGetTicket(i)==0) return(false);
      string symbol=OrderGetString(ORDER_SYMBOL);
      bool seen=false;
      for(int j=0;j<count;j++) if(symbols[j]==symbol) { seen=true; break; }
      if(!seen) { ArrayResize(symbols,count+1); symbols[count++]=symbol; }
     }

   int emitted=0;
   for(int i=0;i<count;i++)
     {
      MqlTick tick;
      ResetLastError();
      if(!SymbolInfoTick(symbols[i],tick))
        {
         PrintFormat("KeelAgent: SymbolInfoTick(%s) failed error=%d",symbols[i],GetLastError());
         return(false);
        }
      int digits=(int)SymbolInfoInteger(symbols[i],SYMBOL_DIGITS);
      string row=StringFormat(
         "{\"canonical\":\"%s\",\"bid\":\"%s\",\"ask\":\"%s\",\"asOf\":%I64d}",
         JsonEscape(symbols[i]),KeelDecimal(tick.bid,digits),KeelDecimal(tick.ask,digits),(long)tick.time_msc);
      if(emitted++>0) json+=",";
      json+=row;
     }
   json+="]";
   return(true);
  }

bool KeelSendAuthoritativeSnapshot(const string request_id)
  {
   if(!(bool)TerminalInfoInteger(TERMINAL_CONNECTED))
     {
      SendAmbiguousResult(request_id,"terminal_disconnected_snapshot_unavailable");
      return(false);
     }

   string server=AccountInfoString(ACCOUNT_SERVER);
   string company=AccountInfoString(ACCOUNT_COMPANY);
   string currency=AccountInfoString(ACCOUNT_CURRENCY);
   if(server=="" || company=="" || currency=="")
     {
      SendAmbiguousResult(request_id,"account_identity_incomplete_snapshot_unavailable");
      return(false);
     }

   string positions="";
   string orders="";
   string quotes="";
   string instrument_facts="";
   if(!KeelBuildPositionsJson(positions) || !KeelBuildOrdersJson(orders) ||
      !KeelBuildQuotesJson(quotes) || !KeelBuildInstrumentFactsJson(InpSymbols,instrument_facts))
     {
      SendAmbiguousResult(request_id,"authoritative_state_scan_failed");
      return(false);
     }

   long now=UnixMillis();
   bool trade_allowed=(bool)AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) &&
                      (bool)AccountInfoInteger(ACCOUNT_TRADE_EXPERT);
   string account=StringFormat(
      "{\"login\":\"%s\",\"server\":\"%s\",\"company\":\"%s\",\"currency\":\"%s\",\"tradeMode\":\"%s\",\"positionModel\":\"%s\",\"balance\":\"%s\",\"equity\":\"%s\",\"marginUsed\":\"%s\",\"marginFree\":\"%s\",\"asOf\":%I64d}",
      LongText(AccountInfoInteger(ACCOUNT_LOGIN)),JsonEscape(server),JsonEscape(company),JsonEscape(currency),
      TradeModeText(),PositionModelText(),KeelDecimal(AccountInfoDouble(ACCOUNT_BALANCE),8),
      KeelDecimal(AccountInfoDouble(ACCOUNT_EQUITY),8),KeelDecimal(AccountInfoDouble(ACCOUNT_MARGIN),8),
      KeelDecimal(AccountInfoDouble(ACCOUNT_MARGIN_FREE),8),now);

   g_event_seq++;
   string line=StringFormat(
      "{\"type\":\"snapshot\",\"requestId\":\"%s\",\"eventSeq\":\"%s\",\"snapshot\":{\"protocolVersion\":1,\"hostId\":\"%s\",\"terminalConnected\":true,\"tradeAllowed\":%s,\"account\":%s,\"instrumentFacts\":%s,\"positions\":%s,\"orders\":%s,\"quotes\":%s,\"observedAt\":%I64d}}",
      JsonEscape(request_id),ULongText(g_event_seq),JsonEscape(InpAgentId),trade_allowed?"true":"false",account,
      instrument_facts,positions,orders,quotes,now);
   if(StringLen(line)>KEEL_MAX_LINE_CHARS)
     {
      SendAmbiguousResult(request_id,"snapshot_exceeds_transport_limit");
      return(false);
     }
   if(!SendLine(line))
     {
      CloseSocket();
      return(false);
     }
   return(true);
  }
