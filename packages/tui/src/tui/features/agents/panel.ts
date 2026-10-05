import {
  panelContentWidth,
  renderPanelHeader,
  renderPanelRow,
  renderPanelFooter,
  renderPanelDivider,
  renderPanelBottom,
} from '../../widgets/panel-frame.js';
import { matchesKey, VStack, type Component } from '../../engine/public.js';
import { TuiSelectionScrollView } from '../../widgets/selection-scroll-view.js';
import { truncateToWidth } from '../../rendering/text.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';
import type { TuiFeatureScreen } from '../../shell/surface-host.js';
import {
  buildAgentView,
  type AgentRowMarker,
  type AgentView,
  type AgentViewEntry,
  type AgentViewRow,
} from './view-model.js';

export interface TuiAgentViewPanelOptions {
  readonly rows: () => readonly AgentViewRow[];
  readonly onOpen: (sessionId: string) => void | Promise<void>;
  readonly onStop: (sessionId: string) => void | Promise<void>;
  readonly onRefresh: () => void | Promise<void>;
  readonly onSend: (
    sessionId: string,
    text: string,
  ) => Promise<{ readonly delivered: boolean; readonly reason?: string }>;
  readonly requestRender: () => void;
}

const GROUP_LABEL: Record<AgentViewRow['state'], string> = {
  'needs-input': 'Needs input',
  working: 'Working',
  idle: 'Idle',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
};

/** `✻` for a live worker, `∙` for a process that is gone, `×` for a failure. */
const MARKER: Record<AgentRowMarker, string> = {
  'busy-mark': '✻',
  'idle-mark': '∙',
  'error-mark': '×',
};

const CONFIRM_WINDOW_MS = 4_000;

/**
 * The agent view: every backgrounded session, grouped and ranked by what needs
 * a human.
 *
 * The spec asks for a promoted `TuiBackgroundWorkPanel` with header counts,
 * grouping, selection, scroll, peek, reply, `Ctrl+X` twice, `Ctrl+R` and a
 * dispatch box. The behaviour that matters is not the layout — it is that
 * every affordance here is safe to press by accident, because this view is
 * opened specifically when something has already gone wrong.
 */
export class TuiAgentViewPanel implements TuiFeatureScreen {
  readonly id = 'agents';
  readonly layoutRoot: Component;
  private readonly bodyViewport: TuiSelectionScrollView;
  private selectedIndex = 0;
  private selectedKey: string | undefined;
  private draftText = '';
  /** Armed `Ctrl+X`, scoped to one session and one short window. */
  private stopArmedFor: { sessionId: string; at: number } | undefined;
  private notice: string | undefined;

  constructor(private readonly options: TuiAgentViewPanelOptions) {
    const header: Component = { render: (w) => this.renderHeader(w), invalidate: () => undefined };
    const body: Component = { render: (w) => this.renderFramedBody(w), invalidate: () => undefined };
    const footer: Component = { render: (w) => this.renderFooter(w), invalidate: () => undefined };
    this.bodyViewport = new TuiSelectionScrollView(body, { primary: true, overscroll: 'contain' });
    this.layoutRoot = new VStack([
      { component: header, basis: 'auto', shrink: 1, minSize: 1 },
      { component: this.bodyViewport, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: footer, basis: 'auto', shrink: 1, minSize: 1 },
    ]);
  }

  invalidate(): void {
    this.layoutRoot.invalidate();
  }

  selectedSessionId(): string | undefined {
    return this.view().rows[this.index()]?.sessionId;
  }

  /**
   * The cursor, clamped to the current row set.
   *
   * Rows disappear whenever a job finishes or is removed, and a bare index then
   * points at nothing — the view would highlight no row while the footer named a
   * session, and Enter would open whichever row happened to land there.
   */
  private index(): number {
    const total = this.view().rows.length;
    return total === 0 ? 0 : Math.min(this.selectedIndex, total - 1);
  }

  /** The dispatch box's current text, and the source of truth for it. */
  draft(): string {
    return this.draftText;
  }

  async handleInput(data: string): Promise<void> {
    const view = this.view();
    this.expireArm();

    // A real escape is the ESC byte or a CSI sequence, never a bare `e`.
    // `matchesKey(data, 'escape')` answers true for a lone `e`, which would
    // swallow the most common letter in English and make the dispatch box
    // silently unusable for any ordinary message.
    if (isEscape(data) || matchesKey(data, 'ctrl+c')) {
      if (this.draftText) return;
      return;
    }
    if (matchesKey(data, 'ctrl+x')) {
      this.armOrStop(view);
      return;
    }
    if (matchesKey(data, 'ctrl+r')) {
      await this.options.onRefresh();
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, 'up') || (data === 'k' && this.draftText.length === 0)) {
      this.move(view, -1);
      return;
    }
    if (matchesKey(data, 'down') || (data === 'j' && this.draftText.length === 0)) {
      this.move(view, 1);
      return;
    }
    if (matchesKey(data, 'backspace')) {
      this.draftText = this.draftText.slice(0, -1);
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, 'enter')) {
      if (this.draftText) {
        await this.send();
        return;
      }
      const selected = view.rows[this.index()];
      if (selected) await this.options.onOpen(selected.sessionId);
      return;
    }
    if (isPrintable(data)) {
      this.draftText += data;
      this.options.requestRender();
    }
  }

  render(width: number): string[] {
    return [
      ...this.renderHeader(width),
      ...this.renderFramedBody(width),
      ...this.renderFooter(width),
    ];
  }

  private async send(): Promise<void> {
    const sessionId = this.selectedSessionId();
    const text = this.draftText;
    if (!sessionId || !text) return;
    const result = await this.options.onSend(sessionId, text);
    if (result.delivered) {
      this.draftText = '';
      this.notice = undefined;
    } else {
      // The message reached the daemon's pending file, not a running Turn.
      // Clearing the draft would tell the user it is running, which is the exact
      // failure this whole design exists to remove.
      this.notice = `Queued — not started yet${result.reason ? ` (${result.reason})` : ''}.`;
    }
    this.options.requestRender();
  }

  private armOrStop(view: AgentView): void {
    const selected = view.rows[this.index()];
    if (!selected) return;
    if (this.stopArmedFor?.sessionId === selected.sessionId) {
      this.stopArmedFor = undefined;
      void this.options.onStop(selected.sessionId);
      this.options.requestRender();
      return;
    }
    this.stopArmedFor = { sessionId: selected.sessionId, at: Date.now() };
    this.options.requestRender();
  }

  private expireArm(): void {
    if (this.stopArmedFor && Date.now() - this.stopArmedFor.at > CONFIRM_WINDOW_MS) {
      this.stopArmedFor = undefined;
    }
  }

  private move(view: AgentView, delta: number): void {
    const total = view.rows.length;
    if (total === 0) return;
    // The confirm is for one specific job. Carrying it across a move would stop
    // a session the user never armed.
    this.stopArmedFor = undefined;
    this.selectedIndex = (this.selectedIndex + delta + total) % total;
    this.bodyViewport.setActiveRow(this.selectedIndex, true);
    this.options.requestRender();
  }

  private view(): AgentView {
    return buildAgentView(this.options.rows());
  }

  private renderHeader(rawWidth: number): string[] {
    const width = normalizeWidth(rawWidth);
    if (width === 0) return [];
    const view = this.view();
    const counts = (Object.keys(GROUP_LABEL) as Array<AgentViewRow['state']>)
      .filter((state) => view.counts[state] > 0)
      .map((state) => `${GROUP_LABEL[state]} ${String(view.counts[state])}`)
      .join(' · ');
    return [renderPanelHeader('Agents', counts || 'none', width)].map((line) =>
      truncateToWidth(line, width, ''),
    );
  }

  private renderFramedBody(rawWidth: number): string[] {
    const width = normalizeWidth(rawWidth);
    if (width === 0) return [];
    const view = this.view();
    this.bodyViewport.setActiveRowPreservingScroll(this.selectedIndex);
    const body = this.renderBody(panelContentWidth(width, width >= 4), view);
    while (body.length < this.bodyViewport.viewportHeight) body.push('');
    return body.map((line) => renderPanelRow(line, width));
  }

  private renderBody(contentWidth: number, view: AgentView): string[] {
    if (view.rows.length === 0) {
      return [truncateToWidth(chalk.hex(colors.dim)('No background sessions'), contentWidth, '')];
    }
    const lines: string[] = [];
    for (const group of view.groups) {
      lines.push(
        truncateToWidth(
          chalk.hex(colors.muted)(`${GROUP_LABEL[group.state]} (${String(group.rows.length)})`),
          contentWidth,
          '',
        ),
      );
      group.rows.forEach((entry) => {
        lines.push(
          truncateToWidth(
            this.renderEntry(entry, entry.sessionId === view.rows[this.index()]?.sessionId, contentWidth),
            contentWidth,
            chalk.hex(colors.dim)('…'),
          ),
        );
      });
    }
    return lines;
  }

  private renderEntry(
    entry: AgentViewEntry,
    selected: boolean,
    width: number,
  ): string {
    const rail = selected ? chalk.bold.hex(colors.signal)('›') : ' ';
    const label = entry.name ?? entry.sessionId;
    const parts = [
      chalk.hex(markerColor(entry.marker))(MARKER[entry.marker]),
      chalk.bold.hex(selected ? colors.signal : colors.text)(sanitizeTerminalText(label)),
    ];
    if (entry.lane) parts.push(chalk.hex(colors.dim)(`[${sanitizeTerminalText(entry.lane)}]`));
    if (entry.flags.length > 0) {
      parts.push(chalk.hex(colors.warning)(entry.flags.join(',')));
    }
    if (entry.summary) {
      parts.push(chalk.hex(colors.muted)(oneLine(entry.summary)));
    }
    return `${rail} ${parts.filter(Boolean).join(' ')}`.slice(0, Math.max(0, width));
  }

  private renderFooter(rawWidth: number): string[] {
    const width = normalizeWidth(rawWidth);
    if (width === 0) return [];
    const selected = this.selectedSessionId();
    const hints = [
      '↑↓ select',
      'Enter open',
      'Ctrl+X twice to stop',
      'Ctrl+R refresh',
      this.draftText ? 'Enter send' : 'Type to dispatch',
    ].filter(Boolean);

    const draftLine = this.draftText
      ? truncateToWidth(`> ${sanitizeTerminalText(this.draftText)}`, panelContentWidth(width), '')
      : truncateToWidth(
          chalk.hex(colors.dim)('> Type a message to send to the selected session'),
          panelContentWidth(width),
          '',
        );
    const notice = this.notice
      ? renderPanelRow(chalk.hex(colors.warning)(this.notice), width)
      : undefined;
    const armed =
      this.stopArmedFor && this.stopArmedFor.sessionId === selected
        ? renderPanelRow(
            chalk.hex(colors.warning)(
              `Press Ctrl+X again to stop ${sanitizeTerminalText(String(selected))}.`,
            ),
            width,
          )
        : undefined;

    return [
      renderPanelDivider(width),
      ...hints
        .map((hint) => renderPanelFooter(hint, panelContentWidth(width)))
        .flat(),
      ...(notice ? [notice] : []),
      ...(armed ? [armed] : []),
      renderPanelRow(draftLine, width),
      renderPanelBottom(width),
    ];
  }
}

function isPrintable(data: string): boolean {
  return data.length > 0 && !data.startsWith('\x1b') && data >= ' ' && !data.startsWith('\x7f');
}

/**
 * A real Esc, not a key that merely starts with the letter.
 *
 * A lone `e` is the first byte of a possible escape sequence only if more bytes
 * follow; on its own it is the letter. Matching the prefix would make every `e`
 * in a dispatched message disappear.
 */
function isEscape(data: string): boolean {
  return data === '\x1b' || data.startsWith('\x1b[') || data.startsWith('\x1bO');
}

function markerColor(marker: AgentRowMarker): string {
  if (marker === 'error-mark') return colors.error;
  if (marker === 'busy-mark') return colors.accent;
  return colors.muted;
}

function oneLine(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, ' ').trim();
}

function normalizeWidth(rawWidth: number): number {
  return Number.isFinite(rawWidth) ? Math.max(0, Math.floor(rawWidth)) : 0;
}
