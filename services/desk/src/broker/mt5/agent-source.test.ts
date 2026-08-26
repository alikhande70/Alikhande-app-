import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const sourceUrl = new URL('../../../../../mt5/KeelAgent.mq5', import.meta.url);
const orderCheckUrl = new URL('../../../../../mt5/KeelOrderCheck.mqh', import.meta.url);
const snapshotUrl = new URL('../../../../../mt5/KeelSnapshot.mqh', import.meta.url);
const reconcileUrl = new URL('../../../../../mt5/KeelReconcile.mqh', import.meta.url);

async function agentSource(): Promise<string> {
  return readFile(sourceUrl, 'utf8');
}

async function orderCheckSource(): Promise<string> {
  return readFile(orderCheckUrl, 'utf8');
}

async function snapshotSource(): Promise<string> {
  return readFile(snapshotUrl, 'utf8');
}

async function reconcileSource(): Promise<string> {
  return readFile(reconcileUrl, 'utf8');
}

describe('KeelAgent source safety contract', () => {
  it('receives commands through the bounded socket path', async () => {
    const source = await agentSource();
    expect(source).toContain('SocketIsReadable');
    expect(source).toContain('SocketRead');
    expect(source).toContain('KEEL_MAX_LINE_CHARS');
    expect(source).toContain('HandleCommandLine');
  });

  it('flushes a durable command receipt before any execution stage', async () => {
    const source = await agentSource();
    const receipt = source.indexOf('AppendCommandReceipt(line)');
    const precheck = source.indexOf('HandlePlaceOrderPrecheck(line,request_id)');
    expect(receipt).toBeGreaterThan(0);
    expect(precheck).toBeGreaterThan(receipt);
    expect(source).toContain('FileFlush(handle)');
  });

  it('runs OrderCheck only behind the demo gate and persists CHECKED/RESULT', async () => {
    const source = await agentSource();
    const precheck = await orderCheckSource();
    expect(source).toContain('#include "KeelOrderCheck.mqh"');
    expect(source).toContain('HandlePlaceOrderPrecheck(line,request_id)');
    expect(precheck).toContain('TradeModeText()!="demo"');
    expect(precheck).toContain('OrderCheck(request,check)');
    expect(precheck).toContain('"CHECKED"');
    expect(precheck).toContain('"RESULT"');
    expect(precheck).toContain('order_check_passed_execution_not_enabled');
  });

  it('preserves the no-send boundary after adding preflight and reconciliation', async () => {
    const source = await agentSource();
    const precheck = await orderCheckSource();
    const snapshot = await snapshotSource();
    const reconcile = await reconcileSource();
    const combined = `${source}\n${precheck}\n${snapshot}\n${reconcile}`;
    expect(combined).toContain('execution_is_demo_only');
    expect(combined).not.toContain('OrderSend(');
    expect(combined).not.toContain('OrderSendAsync(');
  });

  it('refuses to silently ignore slippage semantics without a reference price', async () => {
    const precheck = await orderCheckSource();
    expect(precheck).toContain('max_slippage_requires_reference_price_semantics');
  });

  it('builds snapshots from authoritative current MT5 state and fails closed', async () => {
    const source = await agentSource();
    const snapshot = await snapshotSource();
    expect(source).toContain('#include "KeelSnapshot.mqh"');
    expect(source).toContain('KeelSendAuthoritativeSnapshot(request_id)');
    expect(snapshot).toContain('PositionsTotal()');
    expect(snapshot).toContain('PositionGetTicket(i)');
    expect(snapshot).toContain('OrdersTotal()');
    expect(snapshot).toContain('OrderGetTicket(i)');
    expect(snapshot).toContain('TerminalInfoInteger(TERMINAL_CONNECTED)');
    expect(snapshot).toContain('authoritative_state_scan_failed');
    expect(snapshot).toContain('snapshot_exceeds_transport_limit');
    expect(snapshot).not.toContain('HistorySelect(');
  });

  it('reconciles from current positions/orders plus explicitly bounded order and deal history', async () => {
    const source = await agentSource();
    const reconcile = await reconcileSource();
    expect(source).toContain('#include "KeelReconcile.mqh"');
    expect(source).toContain('KeelHandleReconcile(line,request_id)');
    expect(reconcile).toContain('HistorySelect(history_from,history_to)');
    expect(reconcile).toContain('HistoryOrdersTotal()');
    expect(reconcile).toContain('HistoryOrderGetTicket(i)');
    expect(reconcile).toContain('HistoryDealsTotal()');
    expect(reconcile).toContain('HistoryDealGetTicket(i)');
    expect(reconcile).toContain('positionsScanned\\\":true');
    expect(reconcile).toContain('ordersScanned\\\":true');
    expect(reconcile).toContain('historySelected\\\":true');
    expect(reconcile).toContain('historyFrom\\\"');
    expect(reconcile).toContain('historyTo\\\"');
    expect(reconcile).toContain('authoritative_reconcile_scan_failed');
    expect(reconcile).toContain('reconcile_exceeds_transport_limit');
  });

  it('keeps duplicate command delivery fail-closed', async () => {
    const source = await agentSource();
    expect(source).toContain('request_already_received_requires_reconciliation');
  });
});
