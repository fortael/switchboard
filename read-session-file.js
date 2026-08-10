const path = require('path');
const fs = require('fs');

const SUMMARY_MAX = 120;

// A slash command is not written to the JSONL as the user typed it — the CLI
// wraps it in an envelope naming the command, the message it stood for and its
// arguments. Read as prose that is three tags and two repetitions of the same
// word, so it is read as what it is: the command, and what was passed to it.
const COMMAND_NAME = /<command-name>\s*([^<]+?)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>\s*([^<]*?)\s*<\/command-args>/;

// Tags this file removes to find the text a human wrote. Deliberately the same
// expression as cleanDisplayName in public/utils.js, which still runs over the
// result: the renderer cannot reach this module, and one of the two has to be
// the cleaner that runs before the text is cut short.
const TAG = /<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?\/?>/g;

// The title for one user message, or '' when the message is nothing but markup.
//
// Order matters and is the whole point: cutting to length first and stripping
// tags afterwards leaves whatever tag the cut landed inside — `/clear` became
// "/clear clear </com", because 120 characters of the envelope ended partway
// through `</command-args>` and half a tag matches no tag.
function summarizeUserText(text) {
  const scheduled = text.match(/<scheduled-task\s+name="([^"]+)"/);
  if (scheduled) return ('Scheduled: ' + scheduled[1]).slice(0, SUMMARY_MAX);

  const command = text.match(COMMAND_NAME);
  if (command) {
    const args = text.match(COMMAND_ARGS);
    const name = command[1].startsWith('/') ? command[1] : '/' + command[1];
    return (args && args[1] ? `${name} ${args[1]}` : name).slice(0, SUMMARY_MAX);
  }

  return text.replace(TAG, ' ').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX);
}

/** Parse a single .jsonl file into a session object (or null if invalid) */
function readSessionFile(filePath, folder, projectPath) {
  const sessionId = path.basename(filePath, '.jsonl');
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    let summary = '';
    // The first user message as it was stored, used only if no message in the
    // file yields a title. Stripping markup before cutting means a message that
    // is nothing but markup now summarizes to nothing, and the loop moves on to
    // the next one — which is right until there is no next one, and a session
    // with no summary is dropped from the list entirely.
    let rawFallback = '';
    let messageCount = 0;
    let textContent = '';
    let slug = null;
    let customTitle = null;
    let aiTitle = null;
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.slug && !slug) slug = entry.slug;
      if (entry.type === 'custom-title' && entry.customTitle) {
        customTitle = entry.customTitle;
      }
      if (entry.type === 'ai-title' && entry.aiTitle) {
        aiTitle = entry.aiTitle;
      }
      if (entry.type === 'user' || entry.type === 'assistant' ||
          (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'))) {
        messageCount++;
      }
      const msg = entry.message;
      const text = typeof msg === 'string' ? msg :
        (typeof msg?.content === 'string' ? msg.content :
        (msg?.content?.[0]?.text || ''));
      if (!summary && (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user'))) {
        // Skip local command messages (! prefix) — use the next real user message
        if (text && !/<bash-input>|<bash-stdout>|<local-command-caveat>/.test(text)) {
          if (!rawFallback) rawFallback = text.slice(0, SUMMARY_MAX);
          summary = summarizeUserText(text);
        }
      }
      if (text && textContent.length < 8000) {
        textContent += text.slice(0, 500) + '\n';
      }
    }
    if (!summary) summary = rawFallback;
    if (!summary || messageCount < 1) return null;
    return {
      sessionId, folder, projectPath,
      summary, firstPrompt: summary,
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      messageCount, textContent, slug, customTitle, aiTitle,
    };
  } catch {
    return null;
  }
}

module.exports = { readSessionFile };
