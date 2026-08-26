import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const sourceUrl = new URL('../../../../../mt5/KeelAgent.mq5', import.meta.url);

async function agentSource(): Promise<string> {
  return readFile(sourceUrl, 'utf8');
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
    const executionGate = source.indexOf('execution_stage_not_enabled_yet');
    expect(receipt).toBeGreaterThan(0);
    expect(executionGate).toBeGreaterThan(receipt);
    expect(source).toContain('FileFlush(handle)');
  });

  it('preserves the demo-only boundary and still contains no OrderSend path', async () => {
    const source = await agentSource();
    expect(source).toContain('execution_is_demo_only');
    expect(source).not.toContain('OrderSend(');
    expect(source).not.toContain('OrderSendAsync(');
  });

  it('does not fabricate empty snapshot or reconciliation truth', async () => {
    const source = await agentSource();
    expect(source).toContain('authoritative_snapshot_reconcile_not_enabled_yet');
    expect(source).toContain('request_already_received_requires_reconciliation');
  });
});
