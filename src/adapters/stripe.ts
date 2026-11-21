import crypto from 'node:crypto';
import { createUnifiedTextDiff } from '../core/diff.js';
import type { MockChargeRow, UndoDatabase } from '../storage/database.js';
import type { ToolDefinition } from '../types.js';

export function createStripeTools(
  db: UndoDatabase,
): Array<ToolDefinition<Record<string, unknown>, unknown>> {
  const listCharges: ToolDefinition<Record<string, unknown>, MockChargeRow[]> =
    {
      name: 'stripe.list_charges',
      description: 'List charges in the local mock Stripe ledger.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {},
      },
      previewDiff: () => ({
        title: 'List Stripe charges',
        operation: 'read',
        target: 'stripe/charges',
        before: null,
        after: null,
        unifiedDiff: '--- stripe/charges (read-only query)',
        reversible: true,
        reversibilityNote: 'Read-only operation; no state is mutated.',
      }),
      execute: () => db.listMockCharges(),
    };

  const createCharge: ToolDefinition<
    {
      customerId: string;
      amountCents: number;
      currency?: string;
      description: string;
    },
    MockChargeRow
  > = {
    name: 'stripe.create_charge',
    description:
      'Charge a customer via local mock Stripe. Supports soft-undo and automatic refund rollback.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string' },
        amountCents: { type: 'number' },
        currency: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['customerId', 'amountCents', 'description'],
    },
    estimateSpendUsd: (args) =>
      Math.max(0, Number(args.amountCents ?? 0) / 100),
    previewDiff: (args) => {
      const currency = (args.currency ?? 'usd').toUpperCase();
      const usd = (Number(args.amountCents ?? 0) / 100).toFixed(2);
      const afterText = [
        `Customer: ${args.customerId}`,
        `Amount: $${usd} ${currency} (${args.amountCents} cents)`,
        `Description: ${args.description}`,
        'Status: succeeded',
      ].join('\n');

      return {
        title: `Charge ${args.customerId} $${usd} ${currency}`,
        operation: 'payment',
        target: `stripe/customer/${args.customerId}`,
        before: null,
        after: {
          customerId: args.customerId,
          amountCents: args.amountCents,
          currency,
          description: args.description,
        },
        unifiedDiff: createUnifiedTextDiff(
          `stripe/charges/${args.customerId}`,
          null,
          afterText,
        ),
        reversible: true,
        reversibilityNote:
          'Reversible via automatic compensating Stripe refund.',
      };
    },
    execute: (args) => {
      if (!Number.isFinite(args.amountCents) || args.amountCents <= 0) {
        throw new Error('amountCents must be a positive number.');
      }
      const charge: MockChargeRow = {
        id: `ch_${crypto.randomUUID().slice(0, 10)}`,
        customerId: args.customerId,
        amountCents: Math.round(args.amountCents),
        currency: (args.currency ?? 'usd').toLowerCase(),
        description: args.description,
        status: 'succeeded',
        refundId: null,
        refundReason: null,
        createdAt: new Date().toISOString(),
      };
      db.insertMockCharge(charge);
      return charge;
    },
    compensate: ({ executionResult }) => {
      const current = db.getMockCharge(executionResult.id);
      if (!current) {
        throw new Error(`Charge "${executionResult.id}" not found for refund.`);
      }
      if (current.status === 'refunded') {
        return {
          chargeId: current.id,
          refundId: current.refundId,
          status: 'refunded',
        };
      }
      const refundId = `re_${crypto.randomUUID().slice(0, 10)}`;
      db.updateMockChargeRefund(
        current.id,
        refundId,
        'Compensating rollback by agent-undo',
      );
      return {
        chargeId: current.id,
        refundId,
        amountCents: current.amountCents,
        status: 'refunded',
      };
    },
  };

  const refundCharge: ToolDefinition<
    { chargeId: string; reason?: string },
    { chargeId: string; refundId: string; status: 'refunded' }
  > = {
    name: 'stripe.refund_charge',
    description: 'Issue an explicit refund for an existing mock Stripe charge.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        chargeId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['chargeId'],
    },
    previewDiff: (args) => {
      const existing = db.getMockCharge(args.chargeId);
      const beforeText = existing
        ? `Charge: ${existing.id}\nAmount: $${(existing.amountCents / 100).toFixed(2)}\nStatus: ${existing.status}`
        : `(missing charge ${args.chargeId})`;
      const afterText = existing
        ? `Charge: ${existing.id}\nAmount: $${(existing.amountCents / 100).toFixed(2)}\nStatus: refunded`
        : null;

      return {
        title: `Refund charge ${args.chargeId}`,
        operation: 'payment',
        target: `stripe/charge/${args.chargeId}`,
        before: existing,
        after: existing ? { ...existing, status: 'refunded' } : null,
        unifiedDiff: createUnifiedTextDiff(
          `stripe/charges/${args.chargeId}`,
          beforeText,
          afterText,
        ),
        reversible: false,
        reversibilityNote: 'Manual refunds cannot be un-refunded once settled.',
      };
    },
    execute: (args) => {
      const existing = db.getMockCharge(args.chargeId);
      if (!existing) {
        throw new Error(`Charge "${args.chargeId}" does not exist.`);
      }
      if (existing.status === 'refunded') {
        throw new Error(`Charge "${args.chargeId}" is already refunded.`);
      }
      const refundId = `re_${crypto.randomUUID().slice(0, 10)}`;
      db.updateMockChargeRefund(
        args.chargeId,
        refundId,
        args.reason ?? 'requested_by_operator',
      );
      return {
        chargeId: args.chargeId,
        refundId,
        status: 'refunded',
      };
    },
  };

  return [
    listCharges as unknown as ToolDefinition<Record<string, unknown>, unknown>,
    createCharge as unknown as ToolDefinition<Record<string, unknown>, unknown>,
    refundCharge as unknown as ToolDefinition<Record<string, unknown>, unknown>,
  ];
}
