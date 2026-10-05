import { describe, expect, it } from 'vitest';

import {
  createDefaultTuiKeybindingRegistry,
  formatTuiKeybinding,
  type TuiKeybindingContext,
} from '../packages/tui/src/tui/shell/keybindings.js';

/**
 * Phase 4 contract: `←` on an empty Composer backgrounds the session.
 *
 * The binding is the whole discoverable surface of the feature, and its scope
 * is the part that is easy to get subtly wrong. The plan is explicit — "空
 * composer 上的 `←`" — and the reason is not politeness. `backgroundSession`
 * refuses a non-empty composer because discarding what someone just typed is
 * worse than refusing, so a binding that fires on a full composer would either
 * silently eat the text or pop a refusal the user cannot act on: the `←` is
 * also the caret-movement key, and someone editing a message presses it
 * constantly.
 *
 * So the composer-empty condition has to live in the scope, not in the action
 * handler. A handler-level check would leave the key consumed and the caret
 * dead in exactly the case where the user most needs the caret.
 *
 * See mydocs/supervisor-plan-v2.md Phase 4, §2.1 step 1.
 */
describe('background hand-off keybinding', () => {
  const registry = createDefaultTuiKeybindingRegistry();

  function context(overrides: Partial<TuiKeybindingContext> = {}): TuiKeybindingContext {
    return {
      interactionActive: false,
      hasLiveRun: false,
      composerEmpty: true,
      ...overrides,
    };
  }

  it('registers left-arrow on an empty composer', () => {
    const definition = registry.get('composer.background-session');

    expect(definition).toBeDefined();
    expect(definition?.key).toBe('left');
    expect(definition?.action).toBe('background-session');
  });

  it('resolves to the background action when the composer is empty', () => {
    expect(registry.resolve('\x1b[D', context({ composerEmpty: true }))).toBe(
      'background-session',
    );
  });

  it('does not fire when the composer has text', () => {
    // The refusal exists in `backgroundSession`; the binding must not reach it.
    // A full composer has to keep `←` as caret movement.
    expect(registry.resolve('\x1b[D', context({ composerEmpty: false }))).toBeUndefined();
  });

  it('does not fire while a run is live and the composer is empty', () => {
    // §2.1 step 3 does abort a live Turn — but only through the flow the
    // controller runs. While a Turn is streaming, `←` on an empty composer has
    // to stay available to the live-run handling, or the user loses the key
    // mid-run with no way to see why nothing happened.
    expect(registry.resolve('\x1b[D', context({ hasLiveRun: true }))).not.toBe(
      'background-session',
    );
  });

  it('does not fire while an interaction is active', () => {
    expect(
      registry.resolve('\x1b[D', context({ interactionActive: true, composerEmpty: true })),
    ).not.toBe('background-session');
  });

  it('describes itself in help so the feature is discoverable', () => {
    const definition = registry.get('composer.background-session');

    expect(definition?.description).toBeTruthy();
    expect(definition?.helpOrder).toBeTypeOf('number');
  });

  it('formats to a readable shortcut', () => {
    expect(formatTuiKeybinding('composer.background-session', registry)).not.toBe('Unbound');
  });

  it('does not collide with any other binding', () => {
    // `ctrl+r` already belongs to history search, and a second `←` in a
    // different scope would shadow it during a live run.
    const conflicts = registry.findConflicts({});
    const ours = conflicts.find((conflict) =>
      conflict.ids.includes('composer.background-session'),
    );

    expect(ours).toBeUndefined();
  });

  it('is registered in the default host set the TUI actually builds', () => {
    // The default registry and the host registry are built from the same list;
    // a binding present in one and missing from the other is a binding the
    // feature does not have.
    expect(createDefaultTuiKeybindingRegistry().get('composer.background-session')).toBeDefined();
  });
});
