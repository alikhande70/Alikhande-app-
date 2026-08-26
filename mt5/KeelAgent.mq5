//+------------------------------------------------------------------+
//|                                                    KeelAgent.mq5 |
//|  Loopback-only MT5 bridge for the Keel personal trading system. |
//+------------------------------------------------------------------+
#property strict
#property version   "0.5.0"
#property description "Keel MT5 bridge. Add 127.0.0.1 to Tools > Options > Expert Advisors > allowed addresses before use."

input string InpDeskHost = "127.0.0.1";
input uint   InpDeskPort = 28761;
input string InpAgentToken = "";
input string InpAgentId = "keel-mt5-agent";
input uint   InpHeartbeatSeconds = 1;

int    g_socket = INVALID_HANDLE;
bool   g_hello_sent = false;
ulong  g_event_seq = 0;
string g_rx_buffer = "";
string g_spool_file = "Keel\\agent-events.ndjson";
string g_command_spool_file = "Keel\\agent-commands.ndjson";
string g_seen_request_ids[];

#define KEEL_PROTOCOL_VERSION 1
#define KEEL_MAX_LINE_CHARS 262144

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

string ULongText(const ulong value) { return(StringFormat("%I64u",value)); }
string LongText(const long value) { return(StringFormat("%I64d",value)); }

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

long UnixMillis() { return((long)TimeTradeServer()*1000); }

bool AppendLineToFile(const string file_name,const string line)
  {
   int handle=FileOpen(file_name,FILE_READ|FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_SHARE_READ,0,CP_UTF8);
   if(handle==INVALID_HANDLE)
     {
      PrintFormat("KeelAgent: unable to open %s, error=%d",file_name,GetLastError());
      return(false);
     }
   FileSeek(handle,0,SEEK_END);
   FileWriteString(handle,line+"\r\n");
   FileFlush(handle);
   FileClose(handle);
   return(true);
  }

bool AppendSpool(const string line) { return(AppendLineToFile(g_spool_file,line)); }
bool AppendCommandReceipt(const string line) { return(AppendLineToFile(g_command_spool_file,line)); }

bool SendLine(const string line)
  {
   if(g_socket==INVALID_HANDLE || !SocketIsConnected(g_socket)) return(false);
   uchar bytes[];
   int copied=StringToCharArray(line+"\n",bytes,0,-1,CP_UTF8);
   if(copied<=1) return(false);
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
   g_rx_buffer="";
  }

bool ConnectDesk()
  {
   if(g_socket!=INVALID_HANDLE && SocketIsConnected(g_socket)) return(true);
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

bool JsonStringField(const string line,const string key,string &value)
  {
   string marker="\""+key+"\":\"";
   int start=StringFind(line,marker);
   if(start<0) return(false);
   start+=StringLen(marker);
   int length=StringLen(line);
   string out="";
   bool escaped=false;
   for(int i=start;i<length;i++)
     {
      ushort ch=(ushort)StringGetCharacter(line,i);
      if(escaped)
        {
         if(ch=='\"' || ch=='\\' || ch=='/') out+=ShortToString(ch);
         else if(ch=='n') out+="\n";
         else if(ch=='r') out+="\r";
         else if(ch=='t') out+="\t";
         else return(false);
         escaped=false;
         continue;
        }
      if(ch=='\\') { escaped=true; continue; }
      if(ch=='\"') { value=out; return(true); }
      if(ch<32) return(false);
      out+=ShortToString(ch);
     }
   return(false);
  }

bool JsonIntegerField(const string line,const string key,long &value)
  {
   string marker="\""+key+\":";
   int start=StringFind(line,marker);
   if(start<0) return(false);
   start+=StringLen(marker);
   int length=StringLen(line);
   int end=start;
   while(end<length)
     {
      ushort ch=(ushort)StringGetCharacter(line,end);
      if(ch<'0' || ch>'9') break;
      end++;
     }
   if(end==start) return(false);
   value=(long)StringToInteger(StringSubstr(line,start,end-start));
   return(true);
  }

bool IsSafeRequestId(const string value)
  {
   int length=StringLen(value);
   if(length<8 || length>128) return(false);
   for(int i=0;i<length;i++)
     {
      ushort ch=(ushort)StringGetCharacter(value,i);
      bool ok=(ch>='a' && ch<='z') || (ch>='A' && ch<='Z') ||
              (ch>='0' && ch<='9') || ch=='-' || ch=='_' || ch==':' || ch=='.';
      if(!ok) return(false);
     }
   return(true);
  }

bool IsAllowedCommand(const string command)
  {
   return(command=="snapshot" || command=="place_order" || command=="cancel_order" ||
          command=="modify_position" || command=="close_position" || command=="reconcile");
  }

bool HasSeenRequestId(const string request_id)
  {
   int count=ArraySize(g_seen_request_ids);
   for(int i=0;i<count;i++) if(g_seen_request_ids[i]==request_id) return(true);
   return(false);
  }

void RememberRequestId(const string request_id)
  {
   int count=ArraySize(g_seen_request_ids);
   ArrayResize(g_seen_request_ids,count+1);
   g_seen_request_ids[count]=request_id;
  }

void LoadSeenRequestIds()
  {
   int handle=FileOpen(g_command_spool_file,FILE_READ|FILE_TXT|FILE_ANSI|FILE_SHARE_READ,0,CP_UTF8);
   if(handle==INVALID_HANDLE) return;
   while(!FileIsEnding(handle))
     {
      string line=FileReadString(handle);
      string request_id="";
      if(JsonStringField(line,"requestId",request_id) && IsSafeRequestId(request_id) && !HasSeenRequestId(request_id))
         RememberRequestId(request_id);
     }
   FileClose(handle);
  }

void SendAmbiguousResult(const string request_id,const string reason)
  {
   string line=StringFormat(
      "{\"type\":\"result\",\"requestId\":\"%s\",\"result\":{\"outcome\":\"ambiguous\",\"reason\":\"%s\",\"serverTime\":%I64d}}",
      JsonEscape(request_id),JsonEscape(reason),UnixMillis());
   if(!SendLine(line)) CloseSocket();
  }

void SendRejectedResult(const string request_id,const string reason)
  {
   string line=StringFormat(
      "{\"type\":\"result\",\"requestId\":\"%s\",\"result\":{\"outcome\":\"rejected\",\"reason\":\"%s\",\"serverTime\":%I64d}}",
      JsonEscape(request_id),JsonEscape(reason),UnixMillis());
   if(!SendLine(line)) CloseSocket();
  }

#include "KeelOrderCheck.mqh"
#include "KeelSnapshot.mqh"
#include "KeelReconcile.mqh"

void HandleCommandLine(const string line)
  {
   if(StringLen(line)<=0 || StringLen(line)>KEEL_MAX_LINE_CHARS)
     {
      Print("KeelAgent: rejected empty/oversized command line");
      return;
     }

   string type="";
   string request_id="";
   string command="";
   long protocol_version=0;
   if(!JsonStringField(line,"type",type) || type!="command" ||
      !JsonIntegerField(line,"protocolVersion",protocol_version) || protocol_version!=KEEL_PROTOCOL_VERSION ||
      !JsonStringField(line,"requestId",request_id) || !IsSafeRequestId(request_id) ||
      !JsonStringField(line,"command",command) || !IsAllowedCommand(command))
     {
      Print("KeelAgent: rejected malformed or unsupported command envelope");
      return;
     }

   if(HasSeenRequestId(request_id))
     {
      SendAmbiguousResult(request_id,"request_already_received_requires_reconciliation");
      return;
     }

   if(!AppendCommandReceipt(line))
     {
      SendAmbiguousResult(request_id,"command_receipt_not_durable");
      return;
     }
   RememberRequestId(request_id);

   if(command=="place_order")
     {
      HandlePlaceOrderPrecheck(line,request_id);
      return;
     }

   if(command=="snapshot")
     {
      KeelSendAuthoritativeSnapshot(request_id);
      return;
     }

   if(command=="reconcile")
     {
      KeelHandleReconcile(line,request_id);
      return;
     }

   if(command=="cancel_order" || command=="modify_position" || command=="close_position")
     {
      if(TradeModeText()!="demo")
        {
         SendRejectedResult(request_id,"execution_is_demo_only");
         return;
        }
      SendAmbiguousResult(request_id,"execution_stage_not_enabled_yet");
      return;
     }
  }

void ReceiveCommands()
  {
   if(g_socket==INVALID_HANDLE || !SocketIsConnected(g_socket)) return;
   uint readable=SocketIsReadable(g_socket);
   while(readable>0)
     {
      uint to_read=(uint)MathMin((double)readable,65536.0);
      uchar bytes[];
      int count=SocketRead(g_socket,bytes,to_read,10);
      if(count<=0) { CloseSocket(); return; }
      string chunk=CharArrayToString(bytes,0,count,CP_UTF8);
      g_rx_buffer+=chunk;
      if(StringLen(g_rx_buffer)>KEEL_MAX_LINE_CHARS)
        {
         Print("KeelAgent: receive buffer exceeded command limit; disconnecting");
         CloseSocket();
         return;
        }
      for(;;)
        {
         int newline=StringFind(g_rx_buffer,"\n");
         if(newline<0) break;
         string line=StringSubstr(g_rx_buffer,0,newline);
         g_rx_buffer=StringSubstr(g_rx_buffer,newline+1);
         StringReplace(line,"\r","");
         if(StringLen(line)>0) HandleCommandLine(line);
        }
      if(g_socket==INVALID_HANDLE || !SocketIsConnected(g_socket)) return;
      readable=SocketIsReadable(g_socket);
     }
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
   LoadSeenRequestIds();
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
   ReceiveCommands();
  }

void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
  {
   EmitTransaction(trans,request);
  }
