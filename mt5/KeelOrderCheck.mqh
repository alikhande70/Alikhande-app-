#ifndef KEEL_ORDER_CHECK_MQH
#define KEEL_ORDER_CHECK_MQH

bool KeelPlainUnsigned(const string value)
  {
   int length=StringLen(value);
   if(length<=0 || length>20) return(false);
   for(int i=0;i<length;i++)
     {
      ushort ch=(ushort)StringGetCharacter(value,i);
      if(ch<'0' || ch>'9') return(false);
     }
   if(length==20 && StringCompare(value,"18446744073709551615")>0) return(false);
   return(true);
  }

bool KeelParseULong(const string value,ulong &out)
  {
   if(!KeelPlainUnsigned(value)) return(false);
   ulong parsed=0;
   int length=StringLen(value);
   for(int i=0;i<length;i++)
     {
      uint digit=(uint)((ushort)StringGetCharacter(value,i)-(ushort)'0');
      parsed=parsed*10+digit;
     }
   out=parsed;
   return(true);
  }

bool KeelPlainPositiveDecimal(const string value,double &out)
  {
   int length=StringLen(value);
   if(length<=0 || length>64) return(false);
   bool dot_seen=false;
   bool digit_seen=false;
   for(int i=0;i<length;i++)
     {
      ushort ch=(ushort)StringGetCharacter(value,i);
      if(ch=='.')
        {
         if(dot_seen || i==0 || i==length-1) return(false);
         dot_seen=true;
         continue;
        }
      if(ch<'0' || ch>'9') return(false);
      digit_seen=true;
     }
   if(!digit_seen) return(false);
   double parsed=StringToDouble(value);
   if(parsed<=0.0 || !MathIsValidNumber(parsed)) return(false);
   out=parsed;
   return(true);
  }

bool KeelOptionalPositiveDecimal(const string line,const string key,double &out,bool &present)
  {
   string text="";
   if(!JsonStringField(line,key,text))
     {
      present=false;
      return(true);
     }
   present=true;
   return(KeelPlainPositiveDecimal(text,out));
  }

bool KeelAppendLifecycle(const string request_id,const string command,const string stage,
                         const string detail,const uint retcode=0)
  {
   string line=StringFormat(
      "{\"recordType\":\"lifecycle\",\"requestId\":\"%s\",\"command\":\"%s\",\"stage\":\"%s\",\"detail\":\"%s\",\"retcode\":%u,\"at\":%I64d}",
      JsonEscape(request_id),JsonEscape(command),JsonEscape(stage),JsonEscape(detail),retcode,UnixMillis());
   return(AppendCommandReceipt(line));
  }

void KeelFinishRejected(const string request_id,const string reason,const uint retcode=0)
  {
   if(!KeelAppendLifecycle(request_id,"place_order","RESULT",reason,retcode))
     {
      SendAmbiguousResult(request_id,"result_not_durable");
      return;
     }
   SendRejectedResult(request_id,reason);
  }

void KeelFinishPrechecked(const string request_id,const uint retcode,const string comment)
  {
   if(!KeelAppendLifecycle(request_id,"place_order","RESULT","order_check_passed_execution_disabled",retcode))
     {
      SendAmbiguousResult(request_id,"result_not_durable");
      return;
     }
   SendAmbiguousResult(request_id,"order_check_passed_execution_not_enabled");
  }

bool KeelSelectFilling(const string symbol,const bool pending,ENUM_ORDER_TYPE_FILLING &out)
  {
   if(pending)
     {
      out=ORDER_FILLING_RETURN;
      return(true);
     }

   ENUM_SYMBOL_TRADE_EXECUTION execution=(ENUM_SYMBOL_TRADE_EXECUTION)SymbolInfoInteger(symbol,SYMBOL_TRADE_EXEMODE);
   if(execution!=SYMBOL_TRADE_EXECUTION_MARKET)
     {
      out=ORDER_FILLING_RETURN;
      return(true);
     }

   long modes=SymbolInfoInteger(symbol,SYMBOL_FILLING_MODE);
   if((modes & SYMBOL_FILLING_FOK)==SYMBOL_FILLING_FOK)
     {
      out=ORDER_FILLING_FOK;
      return(true);
     }
   if((modes & SYMBOL_FILLING_IOC)==SYMBOL_FILLING_IOC)
     {
      out=ORDER_FILLING_IOC;
      return(true);
     }
   return(false);
  }

bool KeelBuildPlaceOrderRequest(const string line,MqlTradeRequest &request,string &reason)
  {
   string client_order_id="";
   string magic_text="";
   string symbol="";
   string side="";
   string kind="";
   string volume_text="";
   string tif="";
   string max_slippage_text="";

   if(!JsonStringField(line,"clientOrderId",client_order_id) || !IsSafeRequestId(client_order_id))
     { reason="invalid_client_order_id"; return(false); }
   if(!JsonStringField(line,"magic",magic_text))
     { reason="missing_magic"; return(false); }
   if(!JsonStringField(line,"symbol",symbol) || StringLen(symbol)>64)
     { reason="invalid_symbol"; return(false); }
   if(!JsonStringField(line,"side",side) || (side!="buy" && side!="sell"))
     { reason="invalid_side"; return(false); }
   if(!JsonStringField(line,"kind",kind) ||
      (kind!="market" && kind!="limit" && kind!="stop" && kind!="stop_limit"))
     { reason="invalid_order_kind"; return(false); }
   if(!JsonStringField(line,"volume",volume_text))
     { reason="missing_volume"; return(false); }
   if(!JsonStringField(line,"timeInForce",tif) || (tif!="GTC" && tif!="DAY"))
     { reason="unsupported_time_in_force"; return(false); }
   if(JsonStringField(line,"maxSlippage",max_slippage_text))
     { reason="max_slippage_requires_reference_price_semantics"; return(false); }

   ulong magic=0;
   double volume=0.0;
   if(!KeelParseULong(magic_text,magic))
     { reason="invalid_magic"; return(false); }
   if(!KeelPlainPositiveDecimal(volume_text,volume))
     { reason="invalid_volume"; return(false); }

   if(!SymbolSelect(symbol,true))
     { reason="symbol_not_available"; return(false); }
   long trade_mode=SymbolInfoInteger(symbol,SYMBOL_TRADE_MODE);
   if(trade_mode==SYMBOL_TRADE_MODE_DISABLED)
     { reason="symbol_trade_disabled"; return(false); }

   double limit_price=0.0;
   double trigger_price=0.0;
   double stop_loss=0.0;
   double take_profit=0.0;
   bool has_limit=false;
   bool has_trigger=false;
   bool has_sl=false;
   bool has_tp=false;
   if(!KeelOptionalPositiveDecimal(line,"limitPrice",limit_price,has_limit) ||
      !KeelOptionalPositiveDecimal(line,"stopTriggerPrice",trigger_price,has_trigger) ||
      !KeelOptionalPositiveDecimal(line,"stopLoss",stop_loss,has_sl) ||
      !KeelOptionalPositiveDecimal(line,"takeProfit",take_profit,has_tp))
     { reason="invalid_price_field"; return(false); }
   if((kind=="limit" || kind=="stop_limit") && !has_limit)
     { reason="limit_price_required"; return(false); }
   if((kind=="stop" || kind=="stop_limit") && !has_trigger)
     { reason="stop_trigger_required"; return(false); }

   ZeroMemory(request);
   request.symbol=symbol;
   request.magic=magic;
   request.volume=volume;
   request.type_time=(tif=="DAY")?ORDER_TIME_DAY:ORDER_TIME_GTC;
   request.sl=has_sl?stop_loss:0.0;
   request.tp=has_tp?take_profit:0.0;
   request.comment="Keel:"+client_order_id;

   bool pending=(kind!="market");
   if(!KeelSelectFilling(symbol,pending,request.type_filling))
     { reason="no_supported_filling_mode"; return(false); }

   MqlTick tick={};
   if(!SymbolInfoTick(symbol,tick))
     { reason="quote_unavailable"; return(false); }

   if(kind=="market")
     {
      request.action=TRADE_ACTION_DEAL;
      request.type=(side=="buy")?ORDER_TYPE_BUY:ORDER_TYPE_SELL;
      request.price=(side=="buy")?tick.ask:tick.bid;
     }
   else
     {
      request.action=TRADE_ACTION_PENDING;
      if(kind=="limit")
        {
         request.type=(side=="buy")?ORDER_TYPE_BUY_LIMIT:ORDER_TYPE_SELL_LIMIT;
         request.price=limit_price;
        }
      else if(kind=="stop")
        {
         request.type=(side=="buy")?ORDER_TYPE_BUY_STOP:ORDER_TYPE_SELL_STOP;
         request.price=trigger_price;
        }
      else
        {
         request.type=(side=="buy")?ORDER_TYPE_BUY_STOP_LIMIT:ORDER_TYPE_SELL_STOP_LIMIT;
         request.price=trigger_price;
         request.stoplimit=limit_price;
        }
     }
   return(true);
  }

void HandlePlaceOrderPrecheck(const string line,const string request_id)
  {
   if(TradeModeText()!="demo")
     {
      KeelFinishRejected(request_id,"execution_is_demo_only");
      return;
     }
   if(!(bool)TerminalInfoInteger(TERMINAL_CONNECTED) ||
      !(bool)AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) ||
      !(bool)AccountInfoInteger(ACCOUNT_TRADE_EXPERT))
     {
      KeelFinishRejected(request_id,"terminal_not_trade_ready");
      return;
     }

   MqlTradeRequest request={};
   string reason="";
   if(!KeelBuildPlaceOrderRequest(line,request,reason))
     {
      KeelFinishRejected(request_id,reason);
      return;
     }

   MqlTradeCheckResult check={};
   ResetLastError();
   bool basic_ok=OrderCheck(request,check);
   string detail=StringFormat("basic=%s;comment=%s",basic_ok?"true":"false",check.comment);
   if(!KeelAppendLifecycle(request_id,"place_order","CHECKED",detail,check.retcode))
     {
      SendAmbiguousResult(request_id,"check_result_not_durable");
      return;
     }

   if(!basic_ok || (check.retcode!=0 && check.retcode!=TRADE_RETCODE_DONE))
     {
      string reject_reason=StringFormat("order_check_rejected_%u_%s",check.retcode,check.comment);
      KeelFinishRejected(request_id,reject_reason,check.retcode);
      return;
     }

   // Intentionally no OrderSend here. Passing OrderCheck proves only that the request
   // is structurally/account-valid at this instant; it does not prove future execution.
   KeelFinishPrechecked(request_id,check.retcode,check.comment);
  }

#endif
