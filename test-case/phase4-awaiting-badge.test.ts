import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { createAwaitingBadgeBinding } from '../packages/tui/src/tui/controller/product/awaiting-badge.js';
import {
  awaitingBadge,
  type AgentViewRow,
} from '../packages/tui/src/tui/features/agents/view-model.js';

/**
 * Phase 4 contract: the footer's `← N awaiting`.
 *
 * The spec is one line — "订阅 daemon 推送,**不需要轮询**;daemon 不在线时不显示"
 * — and every clause is a correctness requirement rather than a preference.
 *
 * **It counts what needs a human, not what exists.** A badge over the job count
 * would appear for sessions that are fine, and a badge people learn to ignore
 * is worse than no badge.
 *
 * **It disappears when the supervisor cannot be reached.** A badge that could
 * not ask must not report "nothing is waiting" — the one moment that claim is
 * dangerous is exactly when a job is parked on a question nobody has seen.
 *
 * **It is fed by push.** A poll makes the badge wrong for up to one interval,
 * and a supervisor that dies mid-poll would leave the last count frozen on
 * screen, claiming an answer exists that can no longer be given.
 */
describe('footer awaiting badge', () => {
  function row(overrides: Partial<AgentViewRow> & { sessionId: string }): AgentViewRow {
    return { state: 'idle', workersAlive: 0, ...overrides };
  }

  describe('counting', () => {
    it('counts only sessions waiting on a human', () => {
      const badge = awaitingBadge(
        [
          row({ sessionId: 'a', state: 'needs-input', workersAlive: 1 }),
          row({ sessionId: 'b', state: 'working', workersAlive: 1 }),
          row({ sessionId: 'c', state: 'completed' }),
        ],
        true,
      );

      expect(badge).toEqual({ visible: true, count: 1 });
    });

    it('hides itself when nothing is waiting', () => {
      const badge = awaitingBadge([row({ sessionId: 'a', state: 'working' })], true);

      expect(badge.visible).toBe(false);
    });

    it('hides itself with no sessions at all', () => {
      expect(awaitingBadge([], true).visible).toBe(false);
    });

    it('counts a failed session as not needing input', () => {
      // A failure is reported in the view. A badge for it would cry wolf.
      const badge = awaitingBadge([row({ sessionId: 'a', state: 'failed' })], true);

      expect(badge.visible).toBe(false);
    });
  });

  describe('reachability', () => {
    it('hides itself when the supervisor is unreachable', () => {
      // The dangerous case: a job is parked on a permission question and the
      // badge claims nothing is waiting, because it could not ask.
      const badge = awaitingBadge(
        [row({ sessionId: 'a', state: 'needs-input', workersAlive: 1 })],
        false,
      );

      expect(badge).toEqual({ visible: false, count: 0 });
    });

    it('reports zero rather than the last known count when unreachable', () => {
      const badge = awaitingBadge(
        [row({ sessionId: 'a', state: 'needs-input' }), row({ sessionId: 'b', state: 'needs-input' })],
        false,
      );

      // A stale count would be a lie with a number attached.
      expect(badge.count).toBe(0);
    });
  });

  describe('push binding', () => {
    it('renders the arrow and the count', () => {
      const binding = createAwaitingBadgeBinding({
        reachable: () => true,
        rows: () => [row({ sessionId: 'a', state: 'needs-input' })],
      });
      binding.start();

      expect(stripVTControlCharacters(binding.label() ?? '')).toBe('← 1 awaiting');
    });

    it('renders nothing when no job needs input', () => {
      const binding = createAwaitingBadgeBinding({
        reachable: () => true,
        rows: () => [row({ sessionId: 'a', state: 'working' })],
      });
      binding.start();

      expect(binding.label()).toBeUndefined();
    });

    it('renders nothing when the supervisor is unreachable', () => {
      const binding = createAwaitingBadgeBinding({
        reachable: () => false,
        rows: () => [row({ sessionId: 'a', state: 'needs-input' })],
      });
      binding.start();

      expect(binding.label()).toBeUndefined();
    });

    it('applies a pushed count without asking again', () => {
      // The subscription is the point. A binding that recomputed on a timer
      // would be a poll wearing a push's name.
      const asks = vi.fn(() => [
        row({ sessionId: 'a', state: 'needs-input' }),
      ]);
      const binding = createAwaitingBadgeBinding({
        reachable: () => true,
        rows: () => [],
        load: asks,
      });
      binding.start();
      binding.applyPush({ count: 3, sessionIds: ['a', 'b', 'c'] });

      expect(asks).toHaveBeenCalledTimes(1);
      expect(binding.label()).toBe('← 3 awaiting');
    });

    it('clears the badge when the push says the count reached zero', () => {
      const binding = createAwaitingBadgeBinding({
        reachable: () => true,
        rows: () => [row({ sessionId: 'a', state: 'needs-input' })],
      });
      binding.start();
      expect(binding.label()).toBe('← 1 awaiting');

      binding.applyPush({ count: 0, sessionIds: [] });

      expect(binding.label()).toBeUndefined();
    });

    it('hides the badge when the connection drops', () => {
      const binding = createAwaitingBadgeBinding({
        reachable: () => true,
        rows: () => [row({ sessionId: 'a', state: 'needs-input' })],
      });
      binding.start();
      binding.applyPush({ count: 2, sessionIds: ['a', 'b'] });
      expect(binding.label()).toBe('← 2 awaiting');

      binding.markUnreachable();

      // A frozen count is worse than none: it tells the user to go look at
      // something the supervisor can no longer act on.
      expect(binding.label()).toBeUndefined();
    });

    it('keeps the count for the sessions the push named', () => {
      const binding = createAwaitingBadgeBinding({
        reachable: () => true,
        rows: () => [],
      });
      binding.start();
      binding.applyPush({ count: 1, sessionIds: ['a'] });

      expect(binding.pendingSessionIds()).toEqual(['a']);
    });

    it('stops listening after it is stopped', () => {
      const onPush = vi.fn();
      const binding = createAwaitingBadgeBinding({
        reachable: () => true,
        rows: () => [],
        onPush,
      });
      binding.start();
      binding.stop();
      binding.applyPush({ count: 1, sessionIds: ['a'] });

      // A disposed subscription that still repaints is a leak with a repaint.
      expect(binding.label()).toBeUndefined();
    });

    it('shows nothing before the subscription starts', () => {
      // Rows are available locally, so it is tempting to render from them
      // immediately. That is exactly the "nothing is waiting" claim the badge
      // must never make without having asked.
      const binding = createAwaitingBadgeBinding({
        reachable: () => true,
        rows: () => [row({ sessionId: 'a', state: 'needs-input' })],
      });

      expect(binding.label()).toBeUndefined();
    });
  });
});
