import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import { ListAgentsToolDef, SendMessageToolDef } from './builtin-defs.js';
import type {
  LocalPeerMessagingAdapter,
  LocalPeerSendOutcome,
  LocalPeerSessionSummary,
  LocalRuntimeToolContext,
} from './types.js';

/**
 * §4.2 The two tools a session uses to reach its peers.
 *
 * The user never calls these. They say "ask the session in my other terminal
 * whether the migration finished" and the agent decides to call them, which is
 * why the descriptions carry the judgement and this file carries none of it.
 *
 * Two rules shape the handlers:
 *
 *  - Every failure is a result, not a throw. §4.4 lists the refusals the sender
 *    has to be able to act on — an unknown name, two sessions sharing it, a
 *    target that is not running — and a rejected tool call would replace the
 *    reason with a stack trace.
 *  - The reply is returned, not summarised away. §4.9 gives the sender a reply
 *    address, and the whole point of the call is that the answer arrives in the
 *    conversation that asked for it.
 */

function ok(toolName: string, text: string, details: Record<string, unknown>): ToolResult {
  return { tool_name: toolName, text, content: [{ type: 'text', text }], details };
}

function fail(toolName: string, text: string, details: Record<string, unknown>): ToolResult {
  return {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
    isError: true,
    details,
  };
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation aborted');
}

@bindTool(SendMessageToolDef)
export class SendMessageTool
  implements ToolImpl<typeof SendMessageToolDef.schema, LocalRuntimeToolContext>
{
  constructor(private readonly adapter: LocalPeerMessagingAdapter) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: { to: string; message: string; notify_when_idle?: boolean },
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    abortIfRequested(signal);
    const to = input.to.trim();
    const content = input.message.trim();
    if (!to) return fail(SendMessageToolDef.name, 'No target session was named.', { reason: 'empty-target' });
    if (!content) {
      return fail(SendMessageToolDef.name, 'The message was empty, so nothing was sent.', {
        reason: 'empty-message',
      });
    }

    let outcome: LocalPeerSendOutcome;
    try {
      outcome = await this.adapter.sendMessage(
        {
          fromSessionId: ctx.sessionId,
          to,
          content,
          ...(input.notify_when_idle === true ? { notifyWhenIdle: true } : {}),
        },
        signal,
      );
    } catch (error) {
      // Only wiring faults reach here: the adapter reports ordinary refusals as
      // outcomes. Surfacing the message keeps the model informed rather than
      // handing it a stack it cannot act on.
      return fail(
        SendMessageToolDef.name,
        `Could not reach any session: ${error instanceof Error ? error.message : String(error)}`,
        { reason: 'send-failed', to },
      );
    }
    abortIfRequested(signal);

    if (!outcome.delivered) {
      const extra =
        outcome.candidates && outcome.candidates.length > 0
          ? ` Sessions answering to that name: ${outcome.candidates.join(', ')}.`
          : '';
      return fail(
        SendMessageToolDef.name,
        `Not sent: ${outcome.reason}.${extra}`,
        { reason: outcome.reason, to, ...(outcome.candidates ? { candidates: outcome.candidates } : {}) },
      );
    }

    const where = outcome.targetName ?? outcome.targetSessionId;
    // An empty reply means delivery without an answer, not a silent session. The
    // model has to say which it was, because "sent" and "sent and it answered"
    // lead to different next moves.
    if (!outcome.reply.trim()) {
      return ok(
        SendMessageToolDef.name,
        `Delivered to ${where}. It has not replied yet — it is still working on it or on something else. Do not send this message again; check with it later.`,
        { to, targetSessionId: outcome.targetSessionId, delivered: true, replied: false },
      );
    }
    return ok(
      SendMessageToolDef.name,
      `Sent to ${where}. Its reply:\n\n${outcome.reply}`,
      {
        to,
        targetSessionId: outcome.targetSessionId,
        delivered: true,
        replied: true,
        ...(outcome.targetName ? { targetName: outcome.targetName } : {}),
      },
    );
  }
}

@bindTool(ListAgentsToolDef)
export class ListAgentsTool
  implements ToolImpl<typeof ListAgentsToolDef.schema, LocalRuntimeToolContext>
{
  constructor(private readonly adapter: LocalPeerMessagingAdapter) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: Record<string, never>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    abortIfRequested(signal);
    let peers: LocalPeerSessionSummary[];
    try {
      peers = await this.adapter.listPeers({ selfSessionId: ctx.sessionId }, signal);
    } catch (error) {
      return fail(
        ListAgentsToolDef.name,
        `Could not list sessions: ${error instanceof Error ? error.message : String(error)}`,
        { reason: 'list-failed' },
      );
    }
    abortIfRequested(signal);

    const others = peers.filter((peer) => !peer.isSelf);
    if (others.length === 0) {
      return ok(
        ListAgentsToolDef.name,
        'No other session on this machine is running right now, so there is nobody to message. ' +
          'A session shows up here only while it is running.',
        { peers: [] },
      );
    }

    const lines = others.map((peer) => {
      const name = peer.name ?? '(unnamed)';
      const dir = peer.workspaceDir ? ` — ${peer.workspaceDir}` : '';
      return `- ${name} — ${peer.sessionId}${dir}`;
    });
    return ok(
      ListAgentsToolDef.name,
      `Sessions you can message:\n${lines.join('\n')}\n\nAddress one by its name in SendMessage, or by its session id when two sessions share a name.`,
      { peers: others },
    );
  }
}