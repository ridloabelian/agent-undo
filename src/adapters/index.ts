import fs from 'node:fs';
import path from 'node:path';
import type { UndoDatabase } from '../storage/database.js';
import type { ToolDefinition } from '../types.js';
import { createCalendarTools } from './calendar.js';
import { createFilesystemTools } from './filesystem.js';
import { createGmailTools } from './gmail.js';
import { createStripeTools } from './stripe.js';

export {
  createCalendarTools,
  createFilesystemTools,
  createGmailTools,
  createStripeTools,
};

export interface BuiltinAdaptersBundle {
  sandboxDir: string;
  tools: Array<ToolDefinition<Record<string, unknown>, unknown>>;
}

export function createBuiltinAdapters(
  db: UndoDatabase,
  sandboxDir: string = '.agent-undo/sandbox',
): BuiltinAdaptersBundle {
  const resolvedSandbox = path.resolve(sandboxDir);
  fs.mkdirSync(resolvedSandbox, { recursive: true });

  const tools = [
    ...createGmailTools(db),
    ...createCalendarTools(db),
    ...createStripeTools(db),
    ...createFilesystemTools(resolvedSandbox),
  ];

  return {
    sandboxDir: resolvedSandbox,
    tools,
  };
}

/**
 * Recursively lists files in the sandbox directory for inspection.
 */
export function listSandboxFiles(
  sandboxDir: string,
): Array<{ path: string; sizeBytes: number; contentPreview: string }> {
  const root = path.resolve(sandboxDir);
  if (!fs.existsSync(root)) return [];

  const collected: Array<{
    path: string;
    sizeBytes: number;
    contentPreview: string;
  }> = [];

  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const rel = path.relative(root, full);
        const content = fs.readFileSync(full, 'utf8');
        collected.push({
          path: rel,
          sizeBytes: Buffer.byteLength(content, 'utf8'),
          contentPreview: content.slice(0, 400),
        });
      }
    }
  };

  walk(root);
  return collected.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Seeds realistic local demo state idempotently across mock services and sandbox files.
 */
export function seedDemoState(
  db: UndoDatabase,
  sandboxDir: string = '.agent-undo/sandbox',
): void {
  const root = path.resolve(sandboxDir);
  fs.mkdirSync(root, { recursive: true });

  if (db.isMockStateEmpty()) {
    const now = new Date().toISOString();

    db.insertMockEmail({
      id: 'msg_inbox_001',
      folder: 'inbox',
      fromAddr: 'cfo@acme.local',
      toAddr: 'ops@acme.local',
      ccAddr: null,
      subject: 'Q4 Vendor Spend Policy Reminder',
      body: 'Please keep automated agent charges under $100 per session and require review above $50.',
      createdAt: now,
    });

    db.insertMockEmail({
      id: 'msg_inbox_002',
      folder: 'inbox',
      fromAddr: 'security@acme.local',
      toAddr: 'ops@acme.local',
      ccAddr: null,
      subject: 'Audit Log Review Complete',
      body: 'Monthly automated actions must emit SHA-256 hash-chained audit logs.',
      createdAt: now,
    });

    db.insertMockEvent({
      id: 'evt_launch_001',
      title: 'Production Release Readiness Sync',
      startIso: '2026-11-24T10:00:00Z',
      endIso: '2026-11-24T10:45:00Z',
      attendees: ['eng@acme.local', 'security@acme.local'],
      status: 'confirmed',
      cancelReason: null,
      createdAt: now,
    });

    db.insertMockCharge({
      id: 'ch_seed_001',
      customerId: 'cus_acme_cloud',
      amountCents: 1900,
      currency: 'usd',
      description: 'Monthly sandbox compute baseline',
      status: 'succeeded',
      refundId: null,
      refundReason: null,
      createdAt: now,
    });
  }

  const roadmapPath = path.join(root, 'notes', 'roadmap.md');
  if (!fs.existsSync(roadmapPath)) {
    fs.mkdirSync(path.dirname(roadmapPath), { recursive: true });
    fs.writeFileSync(
      roadmapPath,
      [
        '# Q4 Agent Safety Roadmap',
        '',
        '- Roll out transactional firewall v0.1',
        '- Require 30s grace period for external mutations',
        '- Enforce $100 session spend ceiling',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  const readmePath = path.join(root, 'README.txt');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(
      readmePath,
      'Local agent-undo workspace sandbox. Safe for automated demo mutations and rollbacks.\n',
      'utf8',
    );
  }
}
