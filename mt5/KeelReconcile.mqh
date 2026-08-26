// Authoritative reconciliation for KeelAgent.mq5.
// Read-only. Uses current positions/orders plus explicitly bounded MT5 history.

bool KeelReconcileSideFromOrderType(const long type,string &side)
  {
   switch((ENUM_ORDER_TYPE)type)
     {
      case ORDER_TYPE_BUY:
      case ORDER_TYPE_BUY_LIMIT:
      case ORDER_TYPE_BUY_STOP:
      case ORDER_TYPE_BUY_STOP_LIMIT:
         side="buy";
         return(true);
      case ORDER_TYPE_SELL:
      case ORDER_TYPE_SELL_LIMIT:
      case ORDER_TYPE_SELL_STOP:
      case ORDER_TYPE_SELL_STOP_LIMIT:
         side="sell";
         return(true);
      default:
         return(false);
     }
  }

bool KeelReconcileSideFromDealType(const long type,string &side)
  {
   switch((ENUM_DEAL_TYPE)type)
     {
      case DEAL_TYPE_BUY: side="buy"; return(true);
      case DEAL_TYPE_SELL: side="sell"; return(true);
      default: return(false);
     }
  }

void KeelAppendCandidate(string &json,int &emitted,const string row)
  {
   if(emitted++>0) json+=",";
   json+=row;
  }

bool KeelBuildCurrentPositionCandidates(string &json,int &emitted)
  {
   int total=PositionsTotal();
   for(int i=0;i<total;i++)
     {
      ResetLastError();
      ulong ticket=PositionGetTicket(i);
      if(ticket==0) return(false);
      string symbol=PositionGetString(POSITION_SYMBOL);
      if(symbol=="") return(false);
      ulong position_id=(ulong)PositionGetInteger(POSITION_IDENTIFIER);
      ulong magic=(ulong)PositionGetInteger(POSITION_MAGIC);
      long type=PositionGetInteger(POSITION_TYPE);
      string side=(type==POSITION_TYPE_BUY ? "buy" : "sell");
      double volume=PositionGetDouble(POSITION_VOLUME);
      double price=PositionGetDouble(POSITION_PRICE_OPEN);
      long when=(long)PositionGetInteger(POSITION_TIME_MSC);
      int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
      string row=StringFormat(
         "{\"kind\":\"position\",\"ticket\":\"%s\",\"magic\":\"%s\",\"symbol\":\"%s\",\"side\":\"%s\",\"volume\":\"%s\",\"price\":\"%s\",\"serverTime\":%I64d,\"positionId\":\"%s\"}",
         ULongText(ticket),ULongText(magic),JsonEscape(symbol),side,KeelDecimal(volume,8),
         KeelDecimal(price,digits),when,ULongText(position_id));
      KeelAppendCandidate(json,emitted,row);
     }
   return(true);
  }

bool KeelBuildCurrentOrderCandidates(string &json,int &emitted)
  {
   int total=OrdersTotal();
   for(int i=0;i<total;i++)
     {
      ResetLastError();
      ulong ticket=OrderGetTicket(i);
      if(ticket==0) return(false);
      string side="";
      if(!KeelReconcileSideFromOrderType(OrderGetInteger(ORDER_TYPE),side)) continue;
      string symbol=OrderGetString(ORDER_SYMBOL);
      if(symbol=="") return(false);
      ulong magic=(ulong)OrderGetInteger(ORDER_MAGIC);
      ulong position_id=(ulong)OrderGetInteger(ORDER_POSITION_ID);
      double volume=OrderGetDouble(ORDER_VOLUME_INITIAL);
      double price=OrderGetDouble(ORDER_PRICE_OPEN);
      long when=(long)OrderGetInteger(ORDER_TIME_SETUP_MSC);
      int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
      string row=StringFormat(
         "{\"kind\":\"order\",\"ticket\":\"%s\",\"magic\":\"%s\",\"symbol\":\"%s\",\"side\":\"%s\",\"volume\":\"%s\",\"price\":\"%s\",\"serverTime\":%I64d,\"positionId\":\"%s\"}",
         ULongText(ticket),ULongText(magic),JsonEscape(symbol),side,KeelDecimal(volume,8),
         KeelDecimal(price,digits),when,ULongText(position_id));
      KeelAppendCandidate(json,emitted,row);
     }
   return(true);
  }

bool KeelBuildHistoryCandidates(const datetime history_from,const datetime history_to,string &json,int &emitted)
  {
   ResetLastError();
   if(!HistorySelect(history_from,history_to))
     {
      PrintFormat("KeelAgent: HistorySelect failed error=%d",GetLastError());
      return(false);
     }

   int order_total=HistoryOrdersTotal();
   for(int i=0;i<order_total;i++)
     {
      ResetLastError();
      ulong ticket=HistoryOrderGetTicket(i);
      if(ticket==0) return(false);
      string side="";
      if(!KeelReconcileSideFromOrderType(HistoryOrderGetInteger(ticket,ORDER_TYPE),side)) continue;
      string symbol=HistoryOrderGetString(ticket,ORDER_SYMBOL);
      if(symbol=="") continue;
      ulong magic=(ulong)HistoryOrderGetInteger(ticket,ORDER_MAGIC);
      ulong position_id=(ulong)HistoryOrderGetInteger(ticket,ORDER_POSITION_ID);
      double volume=HistoryOrderGetDouble(ticket,ORDER_VOLUME_INITIAL);
      double price=HistoryOrderGetDouble(ticket,ORDER_PRICE_OPEN);
      long when=(long)HistoryOrderGetInteger(ticket,ORDER_TIME_SETUP_MSC);
      int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
      string row=StringFormat(
         "{\"kind\":\"order\",\"ticket\":\"%s\",\"magic\":\"%s\",\"symbol\":\"%s\",\"side\":\"%s\",\"volume\":\"%s\",\"price\":\"%s\",\"serverTime\":%I64d,\"positionId\":\"%s\"}",
         ULongText(ticket),ULongText(magic),JsonEscape(symbol),side,KeelDecimal(volume,8),
         KeelDecimal(price,digits),when,ULongText(position_id));
      KeelAppendCandidate(json,emitted,row);
     }

   int deal_total=HistoryDealsTotal();
   for(int i=0;i<deal_total;i++)
     {
      ResetLastError();
      ulong ticket=HistoryDealGetTicket(i);
      if(ticket==0) return(false);
      string side="";
      if(!KeelReconcileSideFromDealType(HistoryDealGetInteger(ticket,DEAL_TYPE),side)) continue;
      string symbol=HistoryDealGetString(ticket,DEAL_SYMBOL);
      if(symbol=="") continue;
      ulong magic=(ulong)HistoryDealGetInteger(ticket,DEAL_MAGIC);
      ulong position_id=(ulong)HistoryDealGetInteger(ticket,DEAL_POSITION_ID);
      double volume=HistoryDealGetDouble(ticket,DEAL_VOLUME);
      double price=HistoryDealGetDouble(ticket,DEAL_PRICE);
      long when=(long)HistoryDealGetInteger(ticket,DEAL_TIME_MSC);
      int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
      string row=StringFormat(
         "{\"kind\":\"deal\",\"ticket\":\"%s\",\"magic\":\"%s\",\"symbol\":\"%s\",\"side\":\"%s\",\"volume\":\"%s\",\"price\":\"%s\",\"serverTime\":%I64d,\"positionId\":\"%s\"}",
         ULongText(ticket),ULongText(magic),JsonEscape(symbol),side,KeelDecimal(volume,8),
         KeelDecimal(price,digits),when,ULongText(position_id));
      KeelAppendCandidate(json,emitted,row);
     }
   return(true);
  }

bool KeelHandleReconcile(const string command_line,const string request_id)
  {
   if(!(bool)TerminalInfoInteger(TERMINAL_CONNECTED))
     {
      SendAmbiguousResult(request_id,"terminal_disconnected_reconcile_unavailable");
      return(false);
     }

   string magic="";
   string symbol="";
   string side="";
   string volume="";
   long sent_not_before=0;
   long sent_not_after=0;
   if(!JsonStringField(command_line,"magic",magic) ||
      !JsonStringField(command_line,"symbol",symbol) ||
      !JsonStringField(command_line,"side",side) ||
      !JsonStringField(command_line,"volume",volume) ||
      !JsonIntegerField(command_line,"sentNotBefore",sent_not_before) ||
      !JsonIntegerField(command_line,"sentNotAfter",sent_not_after) ||
      sent_not_before<=0 || sent_not_after<sent_not_before)
     {
      SendRejectedResult(request_id,"invalid_reconcile_request");
      return(false);
     }

   // Guard the local send window by 60 seconds on either side. HistorySelect uses
   // server-time seconds, while the wire contract carries milliseconds.
   long from_ms=MathMax((long)0,sent_not_before-60000);
   long now_ms=UnixMillis();
   long to_ms=MathMax(sent_not_after+60000,now_ms);
   datetime history_from=(datetime)(from_ms/1000);
   datetime history_to=(datetime)(to_ms/1000);

   string candidates="[";
   int emitted=0;
   bool positions_ok=KeelBuildCurrentPositionCandidates(candidates,emitted);
   bool orders_ok=positions_ok && KeelBuildCurrentOrderCandidates(candidates,emitted);
   bool history_ok=orders_ok && KeelBuildHistoryCandidates(history_from,history_to,candidates,emitted);
   candidates+="]";

   if(!positions_ok || !orders_ok || !history_ok)
     {
      SendAmbiguousResult(request_id,"authoritative_reconcile_scan_failed");
      return(false);
     }

   long observed_at=UnixMillis();
   string line=StringFormat(
      "{\"type\":\"result\",\"requestId\":\"%s\",\"result\":{\"observation\":{\"observedAt\":%I64d,\"connected\":true,\"positionsScanned\":true,\"ordersScanned\":true,\"historySelected\":true,\"historyFrom\":%I64d,\"historyTo\":%I64d,\"candidates\":%s}}}",
      JsonEscape(request_id),observed_at,(long)history_from*1000,(long)history_to*1000,candidates);
   if(StringLen(line)>KEEL_MAX_LINE_CHARS)
     {
      SendAmbiguousResult(request_id,"reconcile_exceeds_transport_limit");
      return(false);
     }
   if(!SendLine(line))
     {
      CloseSocket();
      return(false);
     }
   return(true);
  }
