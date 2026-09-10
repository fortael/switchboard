// message-normalizer.ts — one conversation message in, view items out.
//
// The only TypeScript in the renderer, and it is here for one reason: the
// stream this reads is a discriminated union that the SDK grows between patch
// releases. `SDKMessage` has 39 members today, 28 of them `type: 'system'`
// separated only by `subtype`. A switch on `type` alone silently folds those
// 28 into one branch, and a message type added next week disappears without a
// trace — which is exactly the failure the terminal already taught us to fear.
//
// So there are two guards, and they catch different things:
//
//   Compile time — the `never` assignment in each default branch. Add a member
//   to the union upstream, run `npm run typecheck`, and the build tells you
//   where to decide what it looks like.
//
//   Run time — the `unknown` view item. The types are not the whole truth:
//   live sessions were observed emitting `system:post_turn_summary` and
//   `system:task_summary`, neither of which appears in the shipped `.d.ts`.
//   A card that says "unknown message" is a bug report from the field; a
//   dropped message is silence.
//
// Both modes feed this. A PTY session's transcript entries and an SDK
// session's stream messages are the same conversation in the same shapes —
// see sdk-session.js — so the view has one renderer, not two.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export type ViewItem =
  | { kind: 'text'; role: 'assistant' | 'user'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: unknown; isError: boolean }
  | { kind: 'image'; mediaType: string; data: string }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'turn_end'; ok: boolean; text: string }
  | { kind: 'delta'; target: 'text' | 'thinking' | 'other'; text: string }
  | { kind: 'silent'; reason: string }
  | { kind: 'unknown'; label: string; raw: unknown };

const silent = (reason: string): ViewItem[] => [{ kind: 'silent', reason }];
const notice = (level: 'info' | 'warn' | 'error', text: string): ViewItem[] =>
  [{ kind: 'notice', level, text }];

/** Label a message the way the logs and the unknown card both want it. */
export function messageLabel(message: unknown): string {
  const m = message as { type?: unknown; subtype?: unknown };
  const type = typeof m?.type === 'string' ? m.type : 'malformed';
  const subtype = typeof m?.subtype === 'string' ? `:${m.subtype}` : '';
  return `${type}${subtype}`;
}

function unknown(message: unknown): ViewItem[] {
  return [{ kind: 'unknown', label: messageLabel(message), raw: message }];
}

// ── Content blocks ────────────────────────────────────────────────
// Anthropic Messages API blocks, shared by assistant and user messages.

function normalizeBlocks(content: unknown, role: 'assistant' | 'user'): ViewItem[] {
  if (typeof content === 'string') {
    return content.trim() ? [{ kind: 'text', role, text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const items: ViewItem[] = [];
  for (const raw of content) {
    const block = raw as Record<string, unknown>;
    switch (block?.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.trim()) {
          items.push({ kind: 'text', role, text: block.text });
        }
        break;
      case 'thinking':
        if (typeof block.thinking === 'string' && block.thinking.trim()) {
          items.push({ kind: 'thinking', text: block.thinking });
        }
        break;
      case 'tool_use':
        items.push({
          kind: 'tool_use',
          id: String(block.id ?? ''),
          name: String(block.name ?? 'tool'),
          input: block.input,
        });
        break;
      case 'tool_result':
        items.push({
          kind: 'tool_result',
          toolUseId: String(block.tool_use_id ?? ''),
          content: block.content ?? block.output ?? '',
          isError: block.is_error === true,
        });
        break;
      case 'image': {
        const source = block.source as Record<string, unknown> | undefined;
        if (source && typeof source.data === 'string') {
          items.push({
            kind: 'image',
            mediaType: String(source.media_type ?? 'image/png'),
            data: source.data,
          });
        }
        break;
      }
      // Blocks are their own open set — redacted_thinking, server tool results,
      // whatever ships next. Unlike the message union there is no exhaustive
      // type to check here, so the runtime card is the only guard.
      default:
        items.push({ kind: 'unknown', label: `block:${String(block?.type ?? '?')}`, raw: block });
    }
  }
  return items;
}

// ── system/* ──────────────────────────────────────────────────────

/**
 * Subtypes the CLI really emits that the shipped `.d.ts` does not declare, so
 * the compiler cannot know about them and `default` is the only branch they can
 * reach. Observed in live sessions; each is per-turn bookkeeping the transcript
 * has no use for, and without this every single turn would raise an "unknown
 * message" card and cry wolf.
 *
 * This list is a liability, not a feature: each entry is a place where the app
 * knows something the types do not. When a release declares them, delete the
 * entry and let the switch above handle it — `npm run typecheck` will insist.
 */
const UNDECLARED_SILENT = new Set([
  'post_turn_summary',
  'task_summary',
]);

function normalizeUndeclared(message: { subtype?: unknown }): ViewItem[] {
  return typeof message.subtype === 'string' && UNDECLARED_SILENT.has(message.subtype)
    ? silent(`undeclared:${message.subtype}`)
    : unknown(message);
}

type SystemMessage = Extract<SDKMessage, { type: 'system' }>;

function normalizeSystem(message: SystemMessage): ViewItem[] {
  switch (message.subtype) {
    // Session context, already shown in the header and the status pill.
    case 'init':
    case 'status':
    case 'session_state_changed':
      return silent(message.subtype);

    // Status machinery the sidebar renders, not the transcript.
    case 'hook_started':
    case 'hook_progress':
    case 'hook_response':
    case 'task_started':
    case 'task_updated':
    case 'task_progress':
    case 'task_notification':
    case 'background_tasks_changed':
    case 'thinking_tokens':
    case 'commands_changed':
    case 'files_persisted':
    case 'worker_shutting_down':
    case 'control_request_progress':
      return silent(message.subtype);

    case 'compact_boundary':
      return notice('info', 'Context compacted');

    case 'api_retry':
      return notice('warn', 'Retrying the API request');

    case 'model_refusal_fallback':
      return notice('warn', 'The model declined; continued on the fallback model');

    case 'model_refusal_no_fallback':
      return notice('error', 'The model declined and no fallback was configured');

    case 'permission_denied':
      return notice('warn', 'Permission denied for a tool call');

    case 'mirror_error':
      return notice('error', 'Transcript mirror failed');

    case 'elicitation_complete':
      return silent('elicitation_complete');

    case 'memory_recall':
      return silent('memory_recall');

    case 'plugin_install':
      return notice('info', 'Plugin installed');

    case 'local_command_output':
      return message.content.trim()
        ? [{ kind: 'text', role: 'assistant', text: message.content }]
        : silent('local_command_output');

    case 'informational':
      return typeof message.content === 'string' && message.content.trim()
        ? notice('info', message.content)
        : silent('informational');

    case 'notification':
      // `priority` is the CLI's own ranking; anything it calls immediate is
      // the kind of thing the user is being asked to look at.
      return message.text.trim()
        ? notice(message.priority === 'immediate' ? 'warn' : 'info', message.text)
        : silent('notification');

    default: {
      // Compile time: a new system subtype upstream lands here and fails
      // `npm run typecheck`, naming the member that has no decision yet.
      const _exhaustive: never = message;
      void _exhaustive;
      // Run time: the CLI emits subtypes the shipped types do not declare, so
      // this must still produce something.
      return normalizeUndeclared(message);
    }
  }
}

// ── Stream events ─────────────────────────────────────────────────
//
// One Anthropic Messages API streaming frame. Read structurally rather than
// through the beta union: the interesting part is two fields deep in a shape
// that changes shape per event, the union has a dozen members this view has no
// opinion about, and narrowing all of them to reach `delta.text` buys nothing.
// Anything not recognised is still reported as a delta with no text, which is
// what keeps the "working" indicator alive during a long thinking block.

type DeltaFrame = {
  type?: string;
  delta?: { type?: string; text?: string; thinking?: string };
};

function normalizeStreamEvent(event: unknown): ViewItem {
  const frame = event as DeltaFrame | undefined;
  if (frame?.type === 'content_block_delta') {
    const delta = frame.delta;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return { kind: 'delta', target: 'text', text: delta.text };
    }
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      return { kind: 'delta', target: 'thinking', text: delta.thinking };
    }
  }
  return { kind: 'delta', target: 'other', text: '' };
}

// ── Messages ──────────────────────────────────────────────────────

export function normalize(message: SDKMessage): ViewItem[] {
  switch (message.type) {
    case 'assistant':
      return normalizeBlocks(message.message?.content, 'assistant');

    case 'user':
      return normalizeBlocks(message.message?.content, 'user');

    case 'system':
      return normalizeSystem(message);

    // Token deltas — the answer as it is being written. The view appends these
    // to a paragraph already on screen rather than adding a transcript item;
    // the finished `assistant` message arrives afterwards and replaces it.
    case 'stream_event':
      return [normalizeStreamEvent(message.event)];

    case 'result':
      return [{
        kind: 'turn_end',
        ok: message.subtype === 'success',
        text: 'result' in message && typeof (message as { result?: unknown }).result === 'string'
          ? (message as { result: string }).result
          : '',
      }];

    case 'rate_limit_event':
      return silent('rate_limit_event');

    case 'tool_progress':
    case 'tool_use_summary':
    case 'auth_status':
    case 'prompt_suggestion':
      return silent(message.type);

    case 'conversation_reset':
      return notice('info', 'Conversation reset');

    default: {
      const _exhaustive: never = message;
      void _exhaustive;
      return unknown(message);
    }
  }
}

/**
 * The same for anything that is not a typed SDKMessage — a raw `.jsonl` entry
 * read back from a transcript, or a message from a CLI newer than these types.
 * Nothing is trusted here; everything unrecognised becomes a visible card.
 */
export function normalizeUntyped(message: unknown): ViewItem[] {
  if (!message || typeof message !== 'object') return unknown(message);
  const m = message as { type?: unknown; message?: { content?: unknown } };
  if (typeof m.type !== 'string') return unknown(message);
  return normalize(message as SDKMessage);
}
