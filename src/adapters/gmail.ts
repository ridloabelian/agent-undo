import crypto from 'node:crypto';
import { createUnifiedTextDiff } from '../core/diff.js';
import type { MockEmailRow, UndoDatabase } from '../storage/database.js';
import type { ToolDefinition } from '../types.js';

export function createGmailTools(
  db: UndoDatabase,
): Array<ToolDefinition<Record<string, unknown>, unknown>> {
  const listMessages: ToolDefinition<{ folder?: string }, MockEmailRow[]> = {
    name: 'gmail.list_messages',
    description: 'List messages in the local mock Gmail mailbox.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          enum: ['all', 'inbox', 'sent', 'trash'],
          description: 'Mailbox folder filter (defaults to "all").',
        },
      },
    },
    previewDiff: (args) => ({
      title: `List Gmail messages (${args.folder ?? 'all'})`,
      operation: 'read',
      target: `gmail/${args.folder ?? 'all'}`,
      before: null,
      after: null,
      unifiedDiff: `--- gmail/${args.folder ?? 'all'} (read-only query)`,
      reversible: true,
      reversibilityNote: 'Read-only operation; no state is mutated.',
    }),
    execute: (args) => db.listMockEmails(args.folder ?? 'all'),
  };

  const sendEmail: ToolDefinition<
    { to: string; subject: string; body: string; cc?: string },
    { messageId: string; status: string; to: string; subject: string }
  > = {
    name: 'gmail.send_email',
    description:
      'Send an email via local mock Gmail. Protected by grace window; irreversible once sent.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        cc: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
    previewDiff: (args) => {
      const rendered = [
        'From: assistant@acme.local',
        `To: ${args.to}`,
        ...(args.cc ? [`Cc: ${args.cc}`] : []),
        `Subject: ${args.subject}`,
        '',
        args.body,
      ].join('\n');

      return {
        title: `Send email to ${args.to} ("${args.subject}")`,
        operation: 'send',
        target: `mailto:${args.to}`,
        before: null,
        after: {
          to: args.to,
          cc: args.cc ?? null,
          subject: args.subject,
          body: args.body,
        },
        unifiedDiff: createUnifiedTextDiff(
          `gmail/sent/${args.to}`,
          null,
          rendered,
        ),
        reversible: false,
        reversibilityNote:
          'Irreversible once transmitted; use soft-undo during the grace window to cancel.',
      };
    },
    execute: (args) => {
      const id = `msg_${crypto.randomUUID().slice(0, 10)}`;
      db.insertMockEmail({
        id,
        folder: 'sent',
        fromAddr: 'assistant@acme.local',
        toAddr: args.to,
        ccAddr: args.cc ?? null,
        subject: args.subject,
        body: args.body,
        createdAt: new Date().toISOString(),
      });
      return {
        messageId: id,
        status: 'sent',
        to: args.to,
        subject: args.subject,
      };
    },
  };

  const deleteEmail: ToolDefinition<
    { messageId: string; permanent?: boolean },
    { messageId: string; mode: 'trash' | 'permanent' }
  > = {
    name: 'gmail.delete_email',
    description:
      'Move an email to trash or permanently delete it, capturing a snapshot for compensating restore.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        permanent: { type: 'boolean' },
      },
      required: ['messageId'],
    },
    captureSnapshot: (args) => ({
      email: db.getMockEmail(args.messageId),
    }),
    previewDiff: (args) => {
      const existing = db.getMockEmail(args.messageId);
      const beforeText = existing
        ? [
            `ID: ${existing.id}`,
            `Folder: ${existing.folder}`,
            `From: ${existing.fromAddr}`,
            `To: ${existing.toAddr}`,
            `Subject: ${existing.subject}`,
            '',
            existing.body,
          ].join('\n')
        : `(missing message ${args.messageId})`;

      const afterText = args.permanent
        ? null
        : existing
          ? [
              `ID: ${existing.id}`,
              'Folder: trash',
              `From: ${existing.fromAddr}`,
              `To: ${existing.toAddr}`,
              `Subject: ${existing.subject}`,
              '',
              existing.body,
            ].join('\n')
          : null;

      return {
        title: `${args.permanent ? 'Permanently delete' : 'Trash'} email ${args.messageId}`,
        operation: 'delete',
        target: `gmail/message/${args.messageId}`,
        before: existing,
        after: args.permanent
          ? null
          : existing
            ? { ...existing, folder: 'trash' }
            : null,
        unifiedDiff: createUnifiedTextDiff(
          `gmail/messages/${args.messageId}`,
          beforeText,
          afterText,
        ),
        reversible: true,
        reversibilityNote:
          'Reversible via snapshot restore of the original message row and folder.',
      };
    },
    execute: (args) => {
      const existing = db.getMockEmail(args.messageId);
      if (!existing) {
        throw new Error(`Email message "${args.messageId}" does not exist.`);
      }
      if (args.permanent) {
        db.deleteMockEmail(args.messageId);
        return { messageId: args.messageId, mode: 'permanent' };
      }
      db.updateMockEmailFolder(args.messageId, 'trash');
      return { messageId: args.messageId, mode: 'trash' };
    },
    compensate: ({ beforeSnapshot }) => {
      const snap = beforeSnapshot as { email?: MockEmailRow | null } | null;
      if (!snap?.email) {
        throw new Error('Cannot restore email without a pre-delete snapshot.');
      }
      db.insertMockEmail(snap.email);
      return {
        restoredMessageId: snap.email.id,
        restoredFolder: snap.email.folder,
      };
    },
  };

  return [
    listMessages as unknown as ToolDefinition<Record<string, unknown>, unknown>,
    sendEmail as unknown as ToolDefinition<Record<string, unknown>, unknown>,
    deleteEmail as unknown as ToolDefinition<Record<string, unknown>, unknown>,
  ];
}
