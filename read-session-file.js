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
    // Files this session actually edited, counted from its own transcript
    // rather than from git: a session may be working in a worktree, and each
    // one carries its own set of changes that `git status` on the parent
    // project would not separate.
    const touchedFiles = new Set();
    // Line churn for the whole session, rebuilt from each edit's own result.
    //
    // The `cost-state` entry carries totalLinesAdded/Removed, but it is a
    // checkpoint the CLI writes at the end of a stretch and it resets: two
    // sessions here report 0/0 despite hundreds of edits, and others report
    // only their last stretch. Counting the results reproduces the CLI's own
    // figure exactly where that figure is whole (verified +2860/-313 on one
    // session) and is complete where it is not.
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const line of lines) {
      const entry = JSON.parse(line);
      const usage = entry.message?.usage;
      if (usage) {
        contextTokens = (usage.input_tokens || 0)
          + (usage.cache_creation_input_tokens || 0)
          + (usage.cache_read_input_tokens || 0);
      }
      const result = entry.toolUseResult;
      if (result && typeof result === 'object') {
        if (Array.isArray(result.structuredPatch) && result.structuredPatch.length) {
          for (const hunk of result.structuredPatch) {
            for (const line of hunk.lines || []) {
              if (line.startsWith('+')) linesAdded++;
              else if (line.startsWith('-')) linesRemoved++;
            }
          }
        } else if (typeof result.content === 'string' && result.filePath) {
          // A Write that created the file: no patch to diff against, every
          // line is new.
          linesAdded += result.content.split('\n').length;
        }
      }

      const blocks = entry.message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block?.type !== 'tool_use') continue;
          if (!/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(block.name)) continue;
          const target = block.input?.file_path || block.input?.notebook_path;
          if (target) touchedFiles.add(target);
        }
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
      changedFiles: touchedFiles.size, linesAdded, linesRemoved,
    };
  } catch {
    return null;
  }
}

module.exports = { readSessionFile };
