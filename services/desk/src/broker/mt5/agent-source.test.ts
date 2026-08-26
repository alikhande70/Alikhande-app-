import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const sourceUrl = new URL('../../../../../mt5/KeelAgent.mq5', import.meta.url);
const orderCheckUrl = new URL('../../../../../mt5/KeelOrderCheck.mqh', import.meta.url);

async function agentSource(): Promise<string> {
  return readFile(sourceUrl, 'utf8');
}

async function orderCheckSource(): Promise<string> {
  return readFile(orderCheckUrl, 'utf8');
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

  it('preserves the no-send boundary after adding preflight', async () => {
    const source = await agentSource();
    const precheck = await orderCheckSource();
    const combined = `${source}\n${precheck}`;
    expect(combined).toContain('execution_is_demo_only');
    expect(combined).not.toContain('OrderSend(');
    expect(combined).not.toContain('OrderSendAsync(');
  });

  it('refuses to silently ignore slippage semantics without a reference price', async () => {
    const precheck = await orderCheckSource();
    expect(precheck).toContain('max_slippage_requires_reference_price_semantics');
  });

  it('does not fabricate empty snapshot or reconciliation truth', async () => {
    const source = await agentSource();
    expect(source).toContain('authoritative_snapshot_reconcile_not_enabled_yet');
    expect(source).toContain('request_already_received_requires_reconciliation');
  });
});
