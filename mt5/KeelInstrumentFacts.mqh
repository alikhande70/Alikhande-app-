// Broker-observed numerical instrument facts for KeelAgent.mq5.
// No semantic classification and no synthetic margin rate are produced here.

bool KeelAppendUniqueSymbol(string &symbols[],int &count,const string symbol)
  {
   if(symbol=="") return(false);
   for(int i=0;i<count;i++) if(symbols[i]==symbol) return(true);
   ArrayResize(symbols,count+1);
   symbols[count++]=symbol;
   return(true);
  }

//--- Explicit symbol universe -------------------------------------------------
// The tradable set comes from configuration, not from whatever happens to be
// open. Deriving it from positions and orders alone meant a flat account
// published an empty instrument list, so nothing could be sized and no order
// could be placed until a position already existed.
//
// Configured names are resolved against the terminal: a symbol the broker does
// not offer is reported and skipped rather than silently assumed. Symbols
// carrying open positions or orders are still included even when unconfigured,
// because the desk must be able to describe exposure it did not create.
bool KeelResolveConfiguredSymbol(const string symbol)
  {
   if(symbol=="") return(false);
   // SymbolSelect pulls the symbol into Market Watch; without it SymbolInfo*
   // can return stale or zeroed values for an unwatched symbol.
   if(!SymbolSelect(symbol,true))
     {
      PrintFormat("KeelAgent: configured symbol '%s' is not available on this account",symbol);
      return(false);
     }
   return(true);
  }

bool KeelCollectConfiguredSymbols(const string csv,string &symbols[],int &count)
  {
   string parts[];
   int n=StringSplit(csv,',',parts);
   for(int i=0;i<n;i++)
     {
      string symbol=parts[i];
      StringTrimLeft(symbol);
      StringTrimRight(symbol);
      if(symbol=="") continue;
      if(!KeelResolveConfiguredSymbol(symbol)) continue;
      if(!KeelAppendUniqueSymbol(symbols,count,symbol)) return(false);
     }
   return(true);
  }

bool KeelCollectSnapshotSymbols(const string configured_csv,string &symbols[],int &count)
  {
   count=0;
   ArrayResize(symbols,0);
   if(!KeelCollectConfiguredSymbols(configured_csv,symbols,count)) return(false);
   for(int i=0;i<PositionsTotal();i++)
     {
      ResetLastError();
      if(PositionGetTicket(i)==0)
        {
         PrintFormat("KeelAgent: instrument scan PositionGetTicket(%d) failed error=%d",i,GetLastError());
         return(false);
        }
      if(!KeelAppendUniqueSymbol(symbols,count,PositionGetString(POSITION_SYMBOL))) return(false);
     }
   for(int i=0;i<OrdersTotal();i++)
     {
      ResetLastError();
      if(OrderGetTicket(i)==0)
        {
         PrintFormat("KeelAgent: instrument scan OrderGetTicket(%d) failed error=%d",i,GetLastError());
         return(false);
        }
      if(!KeelAppendUniqueSymbol(symbols,count,OrderGetString(ORDER_SYMBOL))) return(false);
     }
   return(true);
  }

bool KeelBuildInstrumentFactsJson(const string configured_csv,string &json)
  {
   string symbols[];
   int count=0;
   if(!KeelCollectSnapshotSymbols(configured_csv,symbols,count)) return(false);

   json="[";
   for(int i=0;i<count;i++)
     {
      string symbol=symbols[i];
      ResetLastError();
      if(!SymbolSelect(symbol,true))
        {
         PrintFormat("KeelAgent: SymbolSelect(%s) failed error=%d",symbol,GetLastError());
         return(false);
        }

      int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
      long trade_mode=SymbolInfoInteger(symbol,SYMBOL_TRADE_MODE);
      long stops_points=SymbolInfoInteger(symbol,SYMBOL_TRADE_STOPS_LEVEL);
      long freeze_points=SymbolInfoInteger(symbol,SYMBOL_TRADE_FREEZE_LEVEL);
      double point=SymbolInfoDouble(symbol,SYMBOL_POINT);
      double tick_size=SymbolInfoDouble(symbol,SYMBOL_TRADE_TICK_SIZE);
      double contract_size=SymbolInfoDouble(symbol,SYMBOL_TRADE_CONTRACT_SIZE);
      double min_volume=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN);
      double max_volume=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MAX);
      double volume_step=SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP);
      double tick_value=SymbolInfoDouble(symbol,SYMBOL_TRADE_TICK_VALUE);

      if(digits<0 || digits>20 || point<=0.0 || tick_size<=0.0 || contract_size<=0.0 ||
         min_volume<=0.0 || max_volume<min_volume || volume_step<=0.0 ||
         stops_points<0 || freeze_points<0)
        {
         PrintFormat("KeelAgent: invalid broker instrument facts for %s",symbol);
         return(false);
        }

      double stops_price=(double)stops_points*point;
      double freeze_price=(double)freeze_points*point;
      long now=UnixMillis();
      string row=StringFormat(
         "{\"symbol\":\"%s\",\"digits\":%d,\"point\":\"%s\",\"tickSize\":\"%s\",\"contractSize\":\"%s\",\"minVolume\":\"%s\",\"maxVolume\":\"%s\",\"volumeStep\":\"%s\",\"stopsLevel\":\"%s\",\"freezeLevel\":\"%s\",\"tradeMode\":%I64d,\"asOf\":%I64d",
         JsonEscape(symbol),digits,KeelDecimal(point,digits),KeelDecimal(tick_size,digits),
         KeelDecimal(contract_size,8),KeelDecimal(min_volume,8),KeelDecimal(max_volume,8),
         KeelDecimal(volume_step,8),KeelDecimal(stops_price,digits),KeelDecimal(freeze_price,digits),
         trade_mode,now);
      if(tick_value>0.0) row+=StringFormat(",\"tickValueAccount\":\"%s\"",KeelDecimal(tick_value,8));
      row+="}";
      if(i>0) json+=",";
      json+=row;
     }
   json+="]";
   return(true);
  }
