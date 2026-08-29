// Request-specific MT5 margin truth for KeelAgent.mq5.
// Read-only: this file never calls OrderSend or mutates broker state.

bool KeelMarginOrderType(const string side,const string kind,ENUM_ORDER_TYPE &order_type)
  {
   if(side=="buy")
     {
      if(kind=="market")     { order_type=ORDER_TYPE_BUY; return(true); }
      if(kind=="limit")      { order_type=ORDER_TYPE_BUY_LIMIT; return(true); }
      if(kind=="stop")       { order_type=ORDER_TYPE_BUY_STOP; return(true); }
      if(kind=="stop_limit") { order_type=ORDER_TYPE_BUY_STOP_LIMIT; return(true); }
     }
   if(side=="sell")
     {
      if(kind=="market")     { order_type=ORDER_TYPE_SELL; return(true); }
      if(kind=="limit")      { order_type=ORDER_TYPE_SELL_LIMIT; return(true); }
      if(kind=="stop")       { order_type=ORDER_TYPE_SELL_STOP; return(true); }
      if(kind=="stop_limit") { order_type=ORDER_TYPE_SELL_STOP_LIMIT; return(true); }
     }
   return(false);
  }

void KeelSendMarginUnavailable(const string request_id,const string symbol,const string side,
                               const string volume,const string price,const string reason)
  {
   string line=StringFormat(
      "{\"type\":\"result\",\"requestId\":\"%s\",\"result\":{\"status\":\"unavailable\","
      "\"reason\":\"%s\",\"asOfUtcMs\":%I64d,\"requestFingerprint\":{\"symbol\":\"%s\","
      "\"side\":\"%s\",\"volume\":\"%s\",\"price\":\"%s\"}}}",
      JsonEscape(request_id),JsonEscape(reason),UtcMillis(),JsonEscape(symbol),JsonEscape(side),
      JsonEscape(volume),JsonEscape(price));
   if(!SendLine(line)) CloseSocket();
  }

bool KeelHandleCalcMargin(const string command_line,const string request_id)
  {
   string symbol="";
   string side="";
   string kind="";
   string volume_text="";
   string price_text="";

   if(!JsonStringField(command_line,"symbol",symbol) ||
      !JsonStringField(command_line,"side",side) ||
      !JsonStringField(command_line,"kind",kind) ||
      !JsonStringField(command_line,"volume",volume_text) ||
      !JsonStringField(command_line,"price",price_text))
     {
      KeelSendMarginUnavailable(request_id,symbol,side,volume_text,price_text,"invalid_margin_request");
      return(false);
     }

   if(TradeModeText()!="demo")
     {
      KeelSendMarginUnavailable(request_id,symbol,side,volume_text,price_text,"margin_is_demo_only");
      return(false);
     }
   if(!(bool)TerminalInfoInteger(TERMINAL_CONNECTED))
     {
      KeelSendMarginUnavailable(request_id,symbol,side,volume_text,price_text,"terminal_disconnected");
      return(false);
     }

   double volume=StringToDouble(volume_text);
   double price=StringToDouble(price_text);
   if(!MathIsValidNumber(volume) || !MathIsValidNumber(price) || volume<=0.0 || price<=0.0)
     {
      KeelSendMarginUnavailable(request_id,symbol,side,volume_text,price_text,"invalid_margin_numbers");
      return(false);
     }

   if(!SymbolSelect(symbol,true))
     {
      KeelSendMarginUnavailable(request_id,symbol,side,volume_text,price_text,"symbol_not_available");
      return(false);
     }

   ENUM_ORDER_TYPE order_type;
   if(!KeelMarginOrderType(side,kind,order_type))
     {
      KeelSendMarginUnavailable(request_id,symbol,side,volume_text,price_text,"unsupported_margin_order_type");
      return(false);
     }

   double margin=0.0;
   ResetLastError();
   if(!OrderCalcMargin(order_type,symbol,volume,price,margin))
     {
      int error=GetLastError();
      KeelSendMarginUnavailable(request_id,symbol,side,volume_text,price_text,
                                StringFormat("OrderCalcMargin_failed_%d",error));
      return(false);
     }
   if(!MathIsValidNumber(margin) || margin<0.0)
     {
      KeelSendMarginUnavailable(request_id,symbol,side,volume_text,price_text,"OrderCalcMargin_invalid_result");
      return(false);
     }

   // Account currency margin is what OrderCalcMargin returns. Keep a fixed high
   // decimal precision on the wire; the desk parses this as an exact decimal
   // string and applies its own account-currency rounding policy later.
   string margin_text=DoubleToString(margin,8);
   string line=StringFormat(
      "{\"type\":\"result\",\"requestId\":\"%s\",\"result\":{\"status\":\"available\","
      "\"requiredAccountCurrency\":\"%s\",\"source\":\"OrderCalcMargin\",\"asOfUtcMs\":%I64d,"
      "\"requestFingerprint\":{\"symbol\":\"%s\",\"side\":\"%s\",\"volume\":\"%s\","
      "\"price\":\"%s\"}}}",
      JsonEscape(request_id),margin_text,UtcMillis(),JsonEscape(symbol),JsonEscape(side),
      JsonEscape(volume_text),JsonEscape(price_text));
   if(!SendLine(line))
     {
      CloseSocket();
      return(false);
     }
   return(true);
  }
