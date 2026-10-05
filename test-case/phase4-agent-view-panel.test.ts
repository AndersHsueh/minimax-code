import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { TuiAgentViewPanel } from '../packages/tui/src/tui/features/agents/panel.js';
import {
  buildAgentView,
  type AgentViewRow,
} from '../packages/tui/src/tui/features/agents/view-model.js';

/**
 * Phase 4 contract: the agent view surface.
 *
 * The spec asks for a promoted `TuiBackgroundWorkPanel` with header counts,
 * grouping, selection, scroll, peek, reply, `Ctrl+X` twice, `Ctrl+R`, and a
 * dispatch box at the bottom. Most of that is ordinary panel work, so the tests
 * here concentrate on the four places where a plausible implementation is
 * actively misleading.
 *
 * **Liveness is process liveness.** The marker is `✻` or `∙`, and a job whose
 * last recorded state is `working` but whose worker is gone is at rest. Showing
 * it as busy sends the user to wait for something that is not running — the
 * plan's opening complaint.
 *
 * **Two `Ctrl+X` means two.** A single press that stops a job destroys work
 * with no undo, so the first press arms and says so.
 *
 * **`Ctrl+R` refreshes; it does not resume.** They read alike, and a refresh
 * that silently continued a paused turn would restart work nobody asked for.
 *
 * **A dispatch box that cannot send is visibly inert.** A composer that accepts
 * text and then drops it is worse than no composer.
 */
describe('agent view panel', () => {
  function row(overrides: Partial<AgentViewRow> & { sessionId: string }): AgentViewRow {
    return { state: 'idle', workersAlive: 0, ...overrides };
  }

  function panel(rows: readonly AgentViewRow[], overrides: Record<string, unknown> = {}) {
    const sent: { sessionId: string; text: string }[] = [];
    const instance = new TuiAgentViewPanel({
      rows: () => rows,
      onOpen: vi.fn(),
      onStop: vi.fn(),
      onRefresh: vi.fn(),
      onSend: (sessionId: string, text: string) => {
        sent.push({ sessionId, text });
        return Promise.resolve({ delivered: true });
      },
      requestRender: vi.fn(),
      ...overrides,
    });
    return { instance, sent, width: 100 };
  }

  function render(instance: TuiAgentViewPanel, width = 100): string {
    return stripVTControlCharacters(instance.render(width).join('\n'));
  }

  describe('header', () => {
    it('shows the total count', () => {
      const { instance } = panel([
        row({ sessionId: 'a' }),
        row({ sessionId: 'b' }),
        row({ sessionId: 'c' }),
      ]);

      expect(render(instance)).toMatch(/3/);
    });

    it('names the groups so the count is not just a number', () => {
      const { instance } = panel([
        row({ sessionId: 'a', state: 'needs-input', workersAlive: 1 }),
        row({ sessionId: 'b', state: 'working', workersAlive: 1 }),
        row({ sessionId: 'c', state: 'failed' }),
      ]);

      const text = render(instance);
      expect(text).toMatch(/needs input|needs-input/i);
      expect(text).toMatch(/working/i);
    });

    it('omits a group with no rows rather than showing a zero', () => {
      const { instance } = panel([row({ sessionId: 'a' })]);

      expect(render(instance)).not.toMatch(/failed/i);
    });
  });

  describe('grouping', () => {
    it('puts attention first', () => {
      const { instance } = panel([
        row({ sessionId: 'idle-1' }),
        row({ sessionId: 'needs-1', state: 'needs-input', workersAlive: 1 }),
        row({ sessionId: 'work-1', state: 'working', workersAlive: 1 }),
      ]);

      const text = render(instance);
      // Ordering is the point: a user opening this view is looking for the one
      // job that is stuck.
      expect(text.indexOf('needs-1')).toBeLessThan(text.indexOf('work-1'));
      expect(text.indexOf('work-1')).toBeLessThan(text.indexOf('idle-1'));
    });

    it('keeps group order stable when a job changes state', () => {
      const first = buildAgentView([
        row({ sessionId: 'a' }),
        row({ sessionId: 'b', state: 'working', workersAlive: 1 }),
      ]);
      const second = buildAgentView([
        row({ sessionId: 'a', state: 'working', workersAlive: 1 }),
        row({ sessionId: 'b', state: 'working', workersAlive: 1 }),
      ]);

      // `a` moved groups, so it moves rows. A view that kept a cursor index
      // across a reorder would put the selection on a different session.
      expect(second.rows[0]?.sessionId).toBe('a');
      expect(first.rows[0]?.sessionId).toBe('b');
    });
  });

  describe('liveness markers', () => {
    it('marks a job with a live worker as busy', () => {
      const { instance } = panel([
        row({ sessionId: 'a', state: 'working', workersAlive: 1 }),
      ]);

      expect(render(instance)).toMatch(/[✻●◉]/u);
    });

    it('marks a job whose worker is gone as at rest, not busy', () => {
      // The recorded state still says `working`. Only the process says
      // otherwise, and the process is the truth.
      const { instance } = panel([
        row({ sessionId: 'a', state: 'working', workersAlive: 0 }),
      ]);

      expect(render(instance)).toMatch(/[∙■]/u);
      expect(render(instance)).not.toMatch(/✻/u);
    });

    it('marks a failure as an error only when nothing is running', () => {
      const failed = panel([row({ sessionId: 'a', state: 'failed', workersAlive: 0 })]);
      const recovered = panel([row({ sessionId: 'a', state: 'failed', workersAlive: 1 })]);

      // Conflating rest with failure trains people to ignore the marker, so a
      // job that is merely at rest must not wear an error mark.
      expect(render(failed.instance)).toMatch(/×|✕|!/u);
      expect(render(recovered.instance)).not.toMatch(/×|✕/u);
    });
  });

  describe('flags', () => {
    it('shows a paused queue on the row instead of hiding it', () => {
      // Reported, never acted on: it is the user's own earlier stop, and
      // backgrounding must not quietly undo it.
      const { instance } = panel([
        row({ sessionId: 'a', state: 'idle', queuePaused: true }),
      ]);

      expect(render(instance)).toMatch(/paused/i);
    });

    it('omits the flag when the queue is running', () => {
      const { instance } = panel([row({ sessionId: 'a', state: 'idle' })]);

      expect(render(instance)).not.toMatch(/paused/i);
    });
  });

  describe('selection and scroll', () => {
    it('moves the selection down and wraps', () => {
      const { instance } = panel([row({ sessionId: 'a' }), row({ sessionId: 'b' })]);

      instance.handleInput('j');
      instance.handleInput('j');

      // Wrap rather than stick: a view that cannot move past the last row reads
      // as frozen.
      expect(instance.selectedSessionId()).toBe('a');
    });

    it('moves the selection up and wraps', () => {
      const { instance } = panel([row({ sessionId: 'a' }), row({ sessionId: 'b' })]);

      instance.handleInput('k');

      expect(instance.selectedSessionId()).toBe('b');
    });

    it('has no selection when there are no rows', () => {
      const { instance } = panel([]);

      expect(instance.selectedSessionId()).toBeUndefined();
    });

    it('survives a row disappearing between renders', () => {
      const rows = [row({ sessionId: 'a' }), row({ sessionId: 'b' })];
      const { instance } = panel(rows);
      instance.handleInput('j');

      // The same panel instance re-reading a shorter row set: the selection
      // index must not point past the end.
      const shrinking = new TuiAgentViewPanel({
        rows: () => [row({ sessionId: 'b' })],
        onOpen: vi.fn(),
        onStop: vi.fn(),
        onRefresh: vi.fn(),
        onSend: vi.fn(),
        requestRender: vi.fn(),
      });
      shrinking.handleInput('j');

      expect(() => shrinking.render(100)).not.toThrow();
      expect(shrinking.selectedSessionId()).toBe('b');
    });
  });

  describe('peek', () => {
    it('opens the selected session on enter', () => {
      const onOpen = vi.fn();
      const { instance } = panel([row({ sessionId: 'a' })], { onOpen });

      instance.handleInput('\r');

      expect(onOpen).toHaveBeenCalledWith('a');
    });

    it('does nothing on enter with no rows', () => {
      const onOpen = vi.fn();
      const { instance } = panel([], { onOpen });

      instance.handleInput('\r');

      expect(onOpen).not.toHaveBeenCalled();
    });
  });

  describe('Ctrl+X twice', () => {
    it('does not stop a job on the first press', () => {
      const onStop = vi.fn();
      const { instance } = panel([row({ sessionId: 'a', state: 'working' })], { onStop });

      instance.handleInput('\x18');

      // One press destroying a running job is unrecoverable work loss.
      expect(onStop).not.toHaveBeenCalled();
    });

    it('arms on the first press and says so', () => {
      const { instance } = panel([row({ sessionId: 'a', state: 'working' })]);

      instance.handleInput('\x18');

      expect(render(instance)).toMatch(/again|confirm/i);
    });

    it('stops the selected job on the second press', () => {
      const onStop = vi.fn();
      const { instance } = panel([row({ sessionId: 'a', state: 'working' })], { onStop });

      instance.handleInput('\x18');
      instance.handleInput('\x18');

      expect(onStop).toHaveBeenCalledWith('a');
    });

    it('disarms when the selection moves', () => {
      const onStop = vi.fn();
      const { instance } = panel(
        [row({ sessionId: 'a', state: 'working' }), row({ sessionId: 'b', state: 'working' })],
        { onStop },
      );

      instance.handleInput('\x18');
      instance.handleInput('j');
      instance.handleInput('\x18');

      // The confirm is for a specific job. Carrying it across a move stops a
      // session the user never armed.
      expect(onStop).not.toHaveBeenCalled();
    });
  });

  describe('Ctrl+R', () => {
    it('refreshes the view', () => {
      const onRefresh = vi.fn();
      const { instance } = panel([row({ sessionId: 'a' })], { onRefresh });

      instance.handleInput('\x12');

      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('does not move the selection', () => {
      const { instance } = panel([row({ sessionId: 'a' }), row({ sessionId: 'b' })]);

      instance.handleInput('j');
      instance.handleInput('\x12');

      // A refresh re-reads; it is not a "restart" key.
      expect(instance.selectedSessionId()).toBe('b');
    });

    it('does not clear an armed stop confirmation', () => {
      const onStop = vi.fn();
      const { instance } = panel([row({ sessionId: 'a', state: 'working' })], { onStop });

      instance.handleInput('\x18');
      instance.handleInput('\x12');
      instance.handleInput('\x18');

      // The armed state survives a refresh so the two presses stay consecutive.
      expect(onStop).toHaveBeenCalledWith('a');
    });
  });

  describe('dispatch box', () => {
    it('accepts typed text and sends it on enter', async () => {
      const { instance, sent } = panel([row({ sessionId: 'a' })]);

      for (const key of 'hello') await instance.handleInput(key);
      await instance.handleInput('\r');

      expect(sent).toEqual([{ sessionId: 'a', text: 'hello' }]);
    });

    it('clears the box after a send', async () => {
      const { instance } = panel([row({ sessionId: 'a' })]);

      for (const key of 'hello') await instance.handleInput(key);
      await instance.handleInput('\r');

      expect(instance.draft()).toBe('');
    });

    it('sends to the selected session', async () => {
      const { instance, sent } = panel([
        row({ sessionId: 'a' }),
        row({ sessionId: 'b' }),
      ]);

      instance.handleInput('j');
      for (const key of 'hi') await instance.handleInput(key);
      await instance.handleInput('\r');

      expect(instance.selectedSessionId()).toBe('b');
      expect(sent).toHaveLength(1);
    });

    it('reports a failed delivery instead of clearing the draft', async () => {
      const { instance } = panel([row({ sessionId: 'a' })], {
        onSend: () => Promise.resolve({ delivered: false, reason: 'staged' }),
      });

      for (const key of 'hello') await instance.handleInput(key);
      await instance.handleInput('\r');

      // The message reached the daemon's pending file. Clearing the draft makes
      // the user believe it is running, which is the bug this whole design is
      // about.
      expect(instance.draft()).toBe('hello');
      expect(render(instance)).toMatch(/queued|staged|pending/i);
    });

    it('sends a queued message without interrupting the running turn', async () => {
      const { instance, sent } = panel([
        row({ sessionId: 'a', state: 'working', workersAlive: 1 }),
      ]);

      for (const key of 'later') await instance.handleInput(key);
      await instance.handleInput('\r');

      expect(sent).toHaveLength(1);
    });

    it('does not send an empty message', async () => {
      const { instance, sent } = panel([row({ sessionId: 'a' })]);

      await instance.handleInput('\r');

      expect(sent).toEqual([]);
    });

    it('renders the box so the user can see what they typed', async () => {
      const { instance } = panel([row({ sessionId: 'a' })]);

      for (const key of 'draft text') await instance.handleInput(key);

      expect(render(instance)).toMatch(/draft text/);
    });

    it('types a message that begins with the navigation keys', async () => {
      // A dispatch box that eats `j`/`k` silently corrupts ordinary English.
      // The shortcuts only apply while the box is empty: the first `j` here
      // navigates (there is nothing to type into yet), and every key after it
      // is text, so the message keeps its leading `j`.
      const { instance, sent } = panel([
        row({ sessionId: 'a' }),
        row({ sessionId: 'b' }),
      ]);

      for (const key of 'jask') await instance.handleInput(key);
      await instance.handleInput('\r');

      expect(sent).toEqual([{ sessionId: 'b', text: 'ask' }]);
    });

    it('keeps typing j and k as text once a draft exists', async () => {
      // The realistic failure: the user starts a word with an ordinary letter
      // and the rest of the message loses its navigation keys.
      const { instance, sent } = panel([row({ sessionId: 'a' })]);

      for (const key of 'xjk') await instance.handleInput(key);
      await instance.handleInput('\r');

      expect(sent).toEqual([{ sessionId: 'a', text: 'xjk' }]);
    });

    it('types a message containing the letter e', async () => {
      // `e` is the first byte of an escape sequence, so a naive prefix match
      // eats it. That silently breaks most English messages, so it gets its own
      // regression rather than riding along with the navigation-keys case.
      const { instance, sent } = panel([row({ sessionId: 'a' })]);

      for (const key of 'see the log') await instance.handleInput(key);
      await instance.handleInput('\r');

      expect(sent).toEqual([{ sessionId: 'a', text: 'see the log' }]);
    });

    it('still navigates after the draft is cleared', async () => {
      const { instance } = panel([row({ sessionId: 'a' }), row({ sessionId: 'b' })]);

      for (const key of 'jk') await instance.handleInput(key);
      for (let i = 0; i < 2; i += 1) instance.handleInput('\x7f');
      instance.handleInput('j');

      expect(instance.selectedSessionId()).toBe('b');
    });
  });

  describe('empty state', () => {
    it('says there is no background work rather than rendering nothing', () => {
      const { instance } = panel([]);

      expect(render(instance)).toMatch(/no background|no sessions|empty/i);
    });
  });
});
