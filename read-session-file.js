const path = require('path');
const fs = require('fs');

/** Parse a single .jsonl file into a session object (or null if invalid) */
function readSessionFile(filePath, folder, projectPath) {
  const sessionId = path.basename(filePath, '.jsonl');
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    let summary = '';
    let messageCount = 0;
    let textContent = '';
    let slug = null;
    let customTitle = null;
    let aiTitle = null;
    // How full the model's context window was on the last assistant turn.
    // Everything the request carried as input counts: fresh tokens, tokens
    // written to the cache, and tokens read back from it. This reproduces the
    // percentage the CLI prints in its own status line.
    let contextTokens = 0;
    // The window size is not stated anywhere as a number, but the model ids in
    // a `cost-state` entry's modelUsage carry a `[1m]` suffix when the long
    // context is in play — e.g. "claude-opus-5[1m]". That beats guessing from
    // how many tokens a session happened to reach.
    let contextLimit = 0;
    for (const line of lines) {
      const entry = JSON.parse(line);
      const usage = entry.message?.usage;
      if (usage) {
        contextTokens = (usage.input_tokens || 0)
          + (usage.cache_creation_input_tokens || 0)
          + (usage.cache_read_input_tokens || 0);
      }
      if (entry.type === 'cost-state' && entry.modelUsage) {
        for (const model of Object.keys(entry.modelUsage)) {
          if (/\[1m\]/i.test(model)) contextLimit = 1000000;
        }
      }
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
          // Use scheduled task name if present
          const taskMatch = text.match(/<scheduled-task\s+name="([^"]+)"/);
          summary = taskMatch ? 'Scheduled: ' + taskMatch[1] : text.slice(0, 120);
        }
      }
      if (text && textContent.length < 8000) {
        textContent += text.slice(0, 500) + '\n';
      }
    }
    if (!summary || messageCount < 1) return null;
    return {
      sessionId, folder, projectPath,
      summary, firstPrompt: summary,
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      messageCount, textContent, slug, customTitle, aiTitle, contextTokens, contextLimit,
    };
  } catch {
    return null;
  }
}

module.exports = { readSessionFile };
