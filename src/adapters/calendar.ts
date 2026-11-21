import crypto from 'node:crypto';
import { createUnifiedTextDiff } from '../core/diff.js';
import type { MockEventRow, UndoDatabase } from '../storage/database.js';
import type { ToolDefinition } from '../types.js';

export function createCalendarTools(
  db: UndoDatabase,
): Array<ToolDefinition<Record<string, unknown>, unknown>> {
  const listEvents: ToolDefinition<Record<string, unknown>, MockEventRow[]> = {
    name: 'calendar.list_events',
    description: 'List calendar events in the local mock Google Calendar.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {},
    },
    previewDiff: () => ({
      title: 'List calendar events',
      operation: 'read',
      target: 'calendar/events',
      before: null,
      after: null,
      unifiedDiff: '--- calendar/events (read-only query)',
      reversible: true,
      reversibilityNote: 'Read-only operation; no state is mutated.',
    }),
    execute: () => db.listMockEvents(),
  };

  const createEvent: ToolDefinition<
    {
      title: string;
      startIso: string;
      endIso: string;
      attendees?: string[];
    },
    MockEventRow
  > = {
    name: 'calendar.create_event',
    description:
      'Create a calendar event. Supports both soft-undo and compensating deletion on rollback.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        startIso: { type: 'string' },
        endIso: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'startIso', 'endIso'],
    },
    previewDiff: (args) => {
      const attendees = args.attendees ?? [];
      const afterText = [
        `Title: ${args.title}`,
        `Start: ${args.startIso}`,
        `End: ${args.endIso}`,
        `Attendees: ${attendees.length > 0 ? attendees.join(', ') : '(none)'}`,
        'Status: confirmed',
      ].join('\n');

      return {
        title: `Create calendar event "${args.title}"`,
        operation: 'create',
        target: `calendar/event/${args.title}`,
        before: null,
        after: { ...args, attendees, status: 'confirmed' },
        unifiedDiff: createUnifiedTextDiff(
          'calendar/new-event',
          null,
          afterText,
        ),
        reversible: true,
        reversibilityNote:
          'Reversible via compensating cancellation/deletion of the created event.',
      };
    },
    execute: (args) => {
      const event: MockEventRow = {
        id: `evt_${crypto.randomUUID().slice(0, 10)}`,
        title: args.title,
        startIso: args.startIso,
        endIso: args.endIso,
        attendees: args.attendees ?? [],
        status: 'confirmed',
        cancelReason: null,
        createdAt: new Date().toISOString(),
      };
      db.insertMockEvent(event);
      return event;
    },
    compensate: ({ executionResult }) => {
      db.deleteMockEvent(executionResult.id);
      return {
        removedEventId: executionResult.id,
        title: executionResult.title,
      };
    },
  };

  const cancelEvent: ToolDefinition<
    { eventId: string; reason?: string },
    { eventId: string; status: 'canceled' }
  > = {
    name: 'calendar.cancel_event',
    description:
      'Cancel an existing calendar event, with snapshot-based rollback back to confirmed.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['eventId'],
    },
    captureSnapshot: (args) => ({
      event: db.getMockEvent(args.eventId),
    }),
    previewDiff: (args) => {
      const existing = db.getMockEvent(args.eventId);
      const beforeText = existing
        ? [
            `ID: ${existing.id}`,
            `Title: ${existing.title}`,
            `Status: ${existing.status}`,
          ].join('\n')
        : `(missing event ${args.eventId})`;
      const afterText = existing
        ? [
            `ID: ${existing.id}`,
            `Title: ${existing.title}`,
            'Status: canceled',
            ...(args.reason ? [`Reason: ${args.reason}`] : []),
          ].join('\n')
        : null;

      return {
        title: `Cancel event ${existing ? `"${existing.title}"` : args.eventId}`,
        operation: 'update',
        target: `calendar/event/${args.eventId}`,
        before: existing,
        after: existing
          ? {
              ...existing,
              status: 'canceled',
              cancelReason: args.reason ?? null,
            }
          : null,
        unifiedDiff: createUnifiedTextDiff(
          `calendar/events/${args.eventId}`,
          beforeText,
          afterText,
        ),
        reversible: true,
        reversibilityNote:
          'Reversible via compensating restore of previous event status.',
      };
    },
    execute: (args) => {
      const existing = db.getMockEvent(args.eventId);
      if (!existing) {
        throw new Error(`Calendar event "${args.eventId}" does not exist.`);
      }
      db.updateMockEventStatus(args.eventId, 'canceled', args.reason ?? null);
      return { eventId: args.eventId, status: 'canceled' };
    },
    compensate: ({ beforeSnapshot }) => {
      const snap = beforeSnapshot as { event?: MockEventRow | null } | null;
      if (!snap?.event) {
        throw new Error('Cannot restore event without a pre-cancel snapshot.');
      }
      db.updateMockEventStatus(
        snap.event.id,
        snap.event.status,
        snap.event.cancelReason,
      );
      return {
        restoredEventId: snap.event.id,
        status: snap.event.status,
      };
    },
  };

  return [
    listEvents as unknown as ToolDefinition<Record<string, unknown>, unknown>,
    createEvent as unknown as ToolDefinition<Record<string, unknown>, unknown>,
    cancelEvent as unknown as ToolDefinition<Record<string, unknown>, unknown>,
  ];
}
