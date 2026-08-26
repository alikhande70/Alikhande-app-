//+------------------------------------------------------------------+
//|                                                    KeelAgent.mq5 |
//|  Loopback-only MT5 bridge for the Keel personal trading system. |
//+------------------------------------------------------------------+
#property strict
#property version   "0.1.0"
#property description "Keel MT5 bridge. Add 127.0.0.1 to Tools > Options > Expert Advisors > allowed addresses before use."

input string InpDeskHost = "127.0.0.1";
input uint   InpDeskPort = 28761;
input string InpAgentToken = "";
input string InpAgentId = "keel-mt5-agent";
input uint   InpHeartbeatSeconds = 1;

int    g_socket = INVALID_HANDLE;
bool   g_hello_sent = false;
ulong  g_event_seq = 0;
string g_spool_file = "Keel\\agent-events.ndjson";

string JsonEscape(const string value)
  {
   string out=value;
   StringReplace(out,"\\","\\\\");
   StringReplace(out,"\"","\\\"");
   StringReplace(out,"\r","\\r");
   StringReplace(out,"\n","\\n");
   StringReplace(out,"\t","\\t");
   return(out);
  }

string ULongText(const ulong value)
  {
   return(StringFormat("%I64u",value));
  }

string LongText(const long value)
  {
   return(StringFormat("%I64d",value));
  }

string TradeModeText()
  {
   ENUM_ACCOUNT_TRADE_MODE mode=(ENUM_ACCOUNT_TRADE_MODE)AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(mode==ACCOUNT_TRADE_MODE_DEMO) return("demo");
   if(mode==ACCOUNT_TRADE_MODE_CONTEST) return("contest");
   return("real");
  }

string PositionModelText()
  {
   ENUM_ACCOUNT_MARGIN_MODE mode=(ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE);
   if(mode==ACCOUNT_MARGIN_MODE_RETAIL_HEDGING) return("hedging");
   return("netting");
  }

long UnixMillis()
  {
   return((long)TimeTradeServer()*1000);
  }

bool AppendSpool(const string line)
  {
   int handle=FileOpen(g_spool_file,FILE_READ|FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_SHARE_READ,0,CP_UTF8);
   if(handle==INVALID_HANDLE)
     {
      PrintFormat("KeelAgent: unable to open spool, error=%d",GetLastError());
      return(false);
     }
   FileSeek(handle,0,SEEK_END);
   FileWriteString(handle,line+"\r\n");
   FileFlush(handle);
   FileClose(handle);
   return(true);
  }

bool SendLine(const string line)
  {
   if(g_socket==INVALID_HANDLE || !SocketIsConnected(g_socket))
      return(false);

   uchar bytes[];
   int copied=StringToCharArray(line+"\n",bytes,0,-1,CP_UTF8);
   if(copied<=1)
      return(false);
   int length=copied-1;
   int sent=SocketSend(g_socket,bytes,(uint)length);
   if(sent!=length)
     {
      PrintFormat("KeelAgent: socket send failed sent=%d expected=%d error=%d",sent,length,GetLastError());
      return(false);
     }
   return(true);
  }

void CloseSocket()
  {
   if(g_socket!=INVALID_HANDLE)
     {
      SocketClose(g_socket);
      g_socket=INVALID_HANDLE;
     }
   g_hello_sent=false;
  }

bool ConnectDesk()
  {
   if(g_socket!=INVALID_HANDLE && SocketIsConnected(g_socket))
      return(true);

   CloseSocket();
   ResetLastError();
   g_socket=SocketCreate(SOCKET_DEFAULT);
   if(g_socket==INVALID_HANDLE)
     {
      PrintFormat("KeelAgent: SocketCreate failed error=%d",GetLastError());
      return(false);
     }
   SocketTimeouts(g_socket,1000,1000);
   if(!SocketConnect(g_socket,InpDeskHost,InpDeskPort,1000))
     {
      PrintFormat("KeelAgent: connect to %s:%u failed error=%d",InpDeskHost,InpDeskPort,GetLastError());
      CloseSocket();
      return(false);
     }
   return(true);
  }

bool SendHello()
  {
   if(StringLen(InpAgentToken)<16)
     {
      Print("KeelAgent: token must be at least 16 characters; refusing bridge authentication");
      return(false);
     }

   string line=StringFormat(
      "{\"type\":\"hello\",\"protocolVersion\":1,\"token\":\"%s\",\"agentId\":\"%s\",\"terminalBuild\":%d,\"accountLogin\":\"%s\",\"server\":\"%s\",\"tradeMode\":\"%s\",\"positionModel\":\"%s\",\"at\":%I64d}",
      JsonEscape(InpAgentToken),JsonEscape(InpAgentId),(int)TerminalInfoInteger(TERMINAL_BUILD),
      LongText(AccountInfoInteger(ACCOUNT_LOGIN)),JsonEscape(AccountInfoString(ACCOUNT_SERVER)),
      TradeModeText(),PositionModelText(),UnixMillis());
   if(!SendLine(line)) return(false);
   g_hello_sent=true;
   return(true);
  }

void SendHeartbeat()
  {
   if(!ConnectDesk()) return;
   if(!g_hello_sent && !SendHello()) return;

   g_event_seq++;
   bool terminal_connected=(bool)TerminalInfoInteger(TERMINAL_CONNECTED);
   bool trade_allowed=(bool)AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) &&
                      (bool)AccountInfoInteger(ACCOUNT_TRADE_EXPERT);
   long now=UnixMillis();
   string line=StringFormat(
      "{\"type\":\"heartbeat\",\"eventSeq\":\"%s\",\"terminalConnected\":%s,\"tradeAllowed\":%s,\"serverTime\":%I64d,\"at\":%I64d}",
      ULongText(g_event_seq),terminal_connected?"true":"false",trade_allowed?"true":"false",now,now);
   if(!SendLine(line)) CloseSocket();
  }

void EmitTransaction(const MqlTradeTransaction &trans,const MqlTradeRequest &request)
  {
   g_event_seq++;
   long now=UnixMillis();
   string line=StringFormat(
      "{\"type\":\"transaction\",\"eventSeq\":\"%s\",\"validTime\":%I64d,\"transactionType\":\"%s\",\"orderTicket\":\"%s\",\"dealTicket\":\"%s\",\"positionId\":\"%s\",\"symbol\":\"%s\",\"magic\":\"%s\",\"volume\":\"%s\",\"price\":\"%s\"}",
      ULongText(g_event_seq),now,JsonEscape(EnumToString(trans.type)),ULongText(trans.order),ULongText(trans.deal),
      ULongText(trans.position),JsonEscape(trans.symbol),ULongText(request.magic),
      DoubleToString(trans.volume,8),DoubleToString(trans.price,_Digits));

   // Durability ordering: persist and flush before attempting live delivery.
   if(!AppendSpool(line))
     {
      Print("KeelAgent: transaction not transmitted because durable spool write failed");
      return;
     }
   if(ConnectDesk())
     {
      if(!g_hello_sent && !SendHello()) return;
      if(!SendLine(line)) CloseSocket();
     }
  }

int OnInit()
  {
   if(StringLen(InpAgentToken)<16)
     {
      Print("KeelAgent: configure a >=16 character agent token before attaching the EA");
      return(INIT_PARAMETERS_INCORRECT);
     }
   EventSetTimer((int)MathMax(1,InpHeartbeatSeconds));
   SendHeartbeat();
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   CloseSocket();
  }

void OnTimer()
  {
   SendHeartbeat();
   // Command receive/execute is intentionally not enabled in this first bridge stage.
   // Until command parsing, preflight and spool replay are implemented and tested,
   // this EA is observation-only and cannot place or modify orders.
  }

void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
  {
   EmitTransaction(trans,request);
  }
