// message-render.js — conversation blocks as DOM nodes.
//
// Lifted out of JsonlViewerApp.vue unchanged. It was the only place that knew
// how a thinking block, a tool call or a screenshot looks, and the SDK-backed
// session view needs exactly the same answers: same markup, same `jsonl-*`
// classes, same stylesheet. Two renderers would have drifted within a week.
//
// Everything here is pure — DOM in, DOM out, no component state — which is why
// it could move as-is. The transcript viewer reads these shapes out of a
// `.jsonl` on disk; an SDK session receives them live over `sdk-message`. They
// are the same shapes, so this is the same code.

// ── Helpers ───────────────────────────────────────────────────────
function escHtml(str) {
  return window.escapeHtml ? window.escapeHtml(str) : str;
}

function renderJsonlText(text) {
  if (window.marked) {
    const escaped = text.replace(/<(\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?\/?)\>/g, '&lt;$1&gt;');
    return window.marked.parse(escaped);
  }
  let html = escHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="jsonl-code-block"><code>$2</code></pre>');
  html = html.replace(/`([^`]+)`/g, '<code class="jsonl-inline-code">$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return html;
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function makeInlineContent(className, bodyContent) {
  const wrapper = document.createElement('div');
  wrapper.className = className;
  const body = document.createElement('pre');
  body.className = 'jsonl-tool-body';
  body.style.display = '';
  if (typeof bodyContent === 'string') {
    body.textContent = bodyContent;
  } else {
    try { body.textContent = JSON.stringify(bodyContent, null, 2); } catch { body.textContent = String(bodyContent); }
  }
  wrapper.appendChild(body);
  return wrapper;
}

function makeCollapsible(className, headerText, bodyContent, startExpanded) {
  const wrapper = document.createElement('div');
  wrapper.className = className;
  const header = document.createElement('div');
  header.className = 'jsonl-toggle' + (startExpanded ? ' expanded' : '');
  header.textContent = headerText;
  const body = document.createElement('pre');
  body.className = 'jsonl-tool-body';
  body.style.display = startExpanded ? '' : 'none';
  if (typeof bodyContent === 'string') {
    body.textContent = bodyContent;
  } else {
    try { body.textContent = JSON.stringify(bodyContent, null, 2); } catch { body.textContent = String(bodyContent); }
  }
  header.onclick = () => {
    const showing = body.style.display !== 'none';
    body.style.display = showing ? 'none' : '';
    header.classList.toggle('expanded', !showing);
  };
  wrapper.appendChild(header);
  wrapper.appendChild(body);
  return wrapper;
}

function toolBlock(color, label, summary, content) {
  const el = document.createElement('div');
  el.className = 'jsonl-tool-block';
  const header = document.createElement('div');
  header.className = 'jsonl-tool-header';
  header.innerHTML = '<span class="jsonl-tool-bullet" style="color:' + color + '">●</span>'
    + '<span class="jsonl-tool-name">' + escHtml(label) + '</span>'
    + (summary ? '<span class="jsonl-tool-summary">' + summary + '</span>' : '');
  el.appendChild(header);
  if (content) {
    const body = document.createElement('div');
    body.className = 'jsonl-tool-content';
    if (typeof content === 'string') {
      body.innerHTML = content;
    } else {
      body.appendChild(content);
    }
    el.appendChild(body);
  }
  return el;
}

/**
 * Fold a tool block's body away and make its header the toggle.
 *
 * The transcript viewer leaves calls open — it is a document you read top to
 * bottom. A chat is not: a turn that touched nine files would be nine screens
 * of diff between two sentences, so there the call is a line you can open.
 * Tools that render as a single line (Read, Glob) have no body and stay as
 * they are; folding a header with nothing behind it is a lie.
 */
function collapseToolBlock(el) {
  const header = el.querySelector('.jsonl-tool-header');
  const body = el.querySelector('.jsonl-tool-content');
  if (!header || !body || body.parentNode !== el) return el;

  el.classList.add('jsonl-tool-block--foldable');
  body.style.display = 'none';
  header.onclick = () => {
    const showing = body.style.display !== 'none';
    body.style.display = showing ? 'none' : '';
    el.classList.toggle('is-open', !showing);
  };
  return el;
}

function shortPath(p) {
  return (p || '').split('/').slice(-3).join('/');
}

const toolRenderers = {
  Read(input) {
    const path = input.file_path || '';
    let range = '';
    if (input.offset || input.limit) {
      const start = input.offset || 0;
      range = input.limit ? `:${start}-${start + input.limit}` : `:${start}`;
    }
    return toolBlock('#8888a0', 'Read', '<code>' + escHtml(shortPath(path) + range) + '</code>', null);
  },

  Edit(input) {
    const path = input.file_path || '';
    let content = null;
    if (input.old_string != null && input.new_string != null) {
      const diff = document.createElement('pre');
      diff.className = 'jsonl-tool-diff';
      let html = '';
      for (const line of input.old_string.split('\n')) {
        html += '<span class="jsonl-diff-del">- ' + escHtml(line) + '</span>\n';
      }
      for (const line of input.new_string.split('\n')) {
        html += '<span class="jsonl-diff-add">+ ' + escHtml(line) + '</span>\n';
      }
      diff.innerHTML = html;
      content = diff;
    }
    return toolBlock('#e0a040', 'Edit', '<code>' + escHtml(shortPath(path)) + '</code>', content);
  },

  Write(input) {
    const path = input.file_path || '';
    const lines = (input.content || '').split('\n').length;
    const detail = '<code>' + escHtml(shortPath(path)) + '</code> <span class="jsonl-tool-detail">' + lines + ' lines</span>';
    let content = null;
    if (input.content) {
      content = makeCollapsible('jsonl-tool-result', 'Content', input.content, true);
    }
    return toolBlock('#60c060', 'Write', detail, content);
  },

  Bash(input) {
    const cmd = input.command || '';
    const pre = document.createElement('pre');
    pre.className = 'jsonl-tool-cmd-block';
    pre.textContent = cmd;
    return toolBlock('#80c0e0', 'Bash', null, pre);
  },

  Grep(input) {
    const pattern = input.pattern || '';
    const path = input.path || '';
    const sp = path ? shortPath(path) : '';
    const summary = '<code>' + escHtml(pattern) + (sp ? ' in ' + escHtml(sp) : '') + '</code>';
    return toolBlock('#c090e0', 'Grep', summary, null);
  },

  Glob(input) {
    const pattern = input.pattern || '';
    return toolBlock('#c090e0', 'Glob', '<code>' + escHtml(pattern) + '</code>', null);
  },

  Agent(input) {
    const desc = input.description || '';
    const type = input.subagent_type || '';
    const summary = (type ? '<span class="jsonl-tool-detail">' + escHtml(type) + '</span> ' : '')
      + escHtml(desc);
    return toolBlock('#f0a050', 'Agent', summary, null);
  },
};

function renderMcpAction(name, input) {
  const action = input.action;
  const shortName = name.replace(/^mcp__/, '').split('__').pop();
  const actionLabels = {
    type: 'Type', screenshot: 'Screenshot', click: 'Click', scroll: 'Scroll',
    hover: 'Hover', drag: 'Drag', key: 'Key', wait: 'Wait',
    javascript_exec: 'JS Exec', navigate: 'Navigate',
  };
  const label = actionLabels[action] || action;
  let summary = '<span class="jsonl-tool-detail">' + escHtml(shortName) + '</span>';
  let content = null;

  if (action === 'type' && input.text) {
    summary += ' <code>' + escHtml(input.text.length > 80 ? input.text.slice(0, 80) + '...' : input.text) + '</code>';
  } else if (action === 'click' && (input.x != null || input.selector)) {
    const target = input.selector || `(${input.x}, ${input.y})`;
    summary += ' <code>' + escHtml(target) + '</code>';
  } else if (action === 'key' && input.key) {
    summary += ' <code>' + escHtml(input.key) + '</code>';
  } else if (action === 'navigate' && input.url) {
    summary += ' <code>' + escHtml(input.url.length > 80 ? input.url.slice(0, 80) + '...' : input.url) + '</code>';
  } else if (action === 'scroll') {
    const dir = input.direction || (input.deltaY > 0 ? 'down' : 'up');
    summary += ' <span class="jsonl-tool-detail">' + escHtml(dir) + '</span>';
  } else if (action === 'javascript_exec' && input.text) {
    const pre = document.createElement('pre');
    pre.className = 'jsonl-tool-cmd-block';
    pre.textContent = input.text;
    content = pre;
  }

  return toolBlock('#c090e0', label, summary, content);
}

function renderToolUse(block) {
  const name = block.name || 'unknown';
  const input = block.input || {};
  const renderer = toolRenderers[name];
  if (renderer) {
    try { return renderer(input, block); } catch {}
  }
  if (input.action) {
    try { return renderMcpAction(name, input, block); } catch {}
  }
  return toolBlock('#8888a0', name, '', makeCollapsible('jsonl-tool-result', 'Input', input, true));
}

function renderLocalCommand({ cmd, output }) {
  const pre = document.createElement('pre');
  pre.className = 'jsonl-tool-cmd-block';
  pre.textContent = cmd;

  const el = toolBlock('#80c0e0', 'Bash', '<span class="jsonl-tool-detail">local</span>', pre);

  if (output) {
    let contentEl = el.querySelector('.jsonl-tool-content');
    if (!contentEl) {
      contentEl = document.createElement('div');
      contentEl.className = 'jsonl-tool-content';
      el.appendChild(contentEl);
    }
    const resultPre = document.createElement('pre');
    resultPre.className = 'jsonl-tool-cmd-block';
    resultPre.textContent = output;
    contentEl.appendChild(resultPre);
  }

  return el;
}

function getEntryText(entry) {
  if (!entry) return null;
  const content = entry.message?.content || entry.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return null;
}

function mergeLocalCommandEntries(entries) {
  const result = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    const text = getEntryText(entry);

    if (text && (/<local-command-caveat>/.test(text) || /<bash-input>/.test(text))) {
      let combined = '';
      const start = i;
      while (i < entries.length) {
        const t = getEntryText(entries[i]);
        if (!t) break;
        if (i > start && !/<bash-input>|<bash-stdout>|<bash-stderr>|<local-command-caveat>/.test(t)) break;
        combined += t + '\n';
        i++;
        if (/<\/bash-stdout>|<\/bash-stderr>/.test(t)) break;
      }

      const inputMatch = combined.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
      if (inputMatch) {
        const cmd = inputMatch[1].trim();
        const stdoutMatch = combined.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/);
        const stderrMatch = combined.match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/);
        const stdout = stdoutMatch ? stdoutMatch[1].trim() : '';
        const stderr = stderrMatch ? stderrMatch[1].trim() : '';
        const output = [stdout, stderr].filter(Boolean).join('\n');
        result.push({ _localCmd: { cmd, output }, type: 'local-command' });
      } else {
        for (let j = start; j < i; j++) result.push(entries[j]);
      }
    } else {
      result.push(entry);
      i++;
    }
  }
  return result;
}

function mergeLocalCommandBlocks(blocks) {
  const hasLocalCmd = blocks.some(b => b.type === 'text' && b.text && /<bash-input>/.test(b.text));
  if (!hasLocalCmd) return blocks;

  let combined = '';
  for (const b of blocks) {
    if (b.type === 'text' && b.text) combined += b.text + '\n';
  }

  const inputMatch = combined.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
  if (!inputMatch) return blocks;

  const cmd = inputMatch[1].trim();
  const stdoutMatch = combined.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/);
  const stderrMatch = combined.match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/);
  const stdout = stdoutMatch ? stdoutMatch[1].trim() : '';
  const stderr = stderrMatch ? stderrMatch[1].trim() : '';
  const output = [stdout, stderr].filter(Boolean).join('\n');

  const merged = { type: 'text', text: combined, _localCmd: { cmd, output } };
  const result = [];
  let replacedText = false;
  for (const b of blocks) {
    if (b.type === 'text') {
      if (!replacedText) { result.push(merged); replacedText = true; }
    } else {
      result.push(b);
    }
  }
  return result;
}

function extractImages(data) {
  const images = [];
  if (!data) return images;
  if (typeof data === 'string') {
    const imgMatches = data.matchAll(/\{"type"\s*:\s*"image"\s*,\s*"source"\s*:\s*\{[^}]*"data"\s*:\s*"([^"]+)"[^}]*\}/g);
    for (const m of imgMatches) {
      const base64 = m[1];
      const mediaMatch = m[0].match(/"media_type"\s*:\s*"([^"]+)"/);
      const mediaType = mediaMatch ? mediaMatch[1] : 'image/jpeg';
      images.push({ src: `data:${mediaType};base64,${base64}` });
    }
    return images;
  }
  if (Array.isArray(data)) {
    for (const block of data) {
      if (block.type === 'image' && block.source?.data) {
        const mediaType = block.source.media_type || 'image/jpeg';
        images.push({ src: `data:${mediaType};base64,${block.source.data}` });
      }
    }
  }
  return images;
}

function extractResultText(data) {
  if (!data) return null;
  if (typeof data === 'string') {
    const cleaned = data.replace(/\{"type"\s*:\s*"image"\s*,\s*"source"\s*:\s*\{[^}]*\}\s*\}/g, '').trim();
    return cleaned || null;
  }
  if (Array.isArray(data)) {
    const texts = data.filter(b => b.type === 'text' || b.text).map(b => b.text || JSON.stringify(b));
    return texts.length ? texts.join('\n') : null;
  }
  return JSON.stringify(data, null, 2);
}

function renderToolResult(resultData, container) {
  const images = extractImages(resultData);
  const textParts = extractResultText(resultData);
  if (textParts) {
    container.appendChild(makeInlineContent('jsonl-tool-result', textParts));
  }
  for (const img of images) {
    const imgEl = document.createElement('img');
    imgEl.className = 'jsonl-tool-screenshot';
    imgEl.src = img.src;
    if (img.alt) imgEl.alt = img.alt;
    imgEl.onclick = () => {
      const overlay = document.createElement('div');
      overlay.className = 'jsonl-screenshot-fullscreen';
      const fullImg = document.createElement('img');
      fullImg.src = img.src;
      overlay.appendChild(fullImg);
      overlay.onclick = () => overlay.remove();
      document.body.appendChild(overlay);
    };
    container.appendChild(imgEl);
  }
}

export {
  escHtml,
  renderJsonlText,
  formatDuration,
  makeInlineContent,
  makeCollapsible,
  toolBlock,
  collapseToolBlock,
  shortPath,
  renderMcpAction,
  renderToolUse,
  renderLocalCommand,
  mergeLocalCommandBlocks,
  extractImages,
  extractResultText,
  renderToolResult,
  getEntryText,
  mergeLocalCommandEntries,
};

// ── ViewItem bridge ───────────────────────────────────────────────
// message-normalizer.ts turns one stream message into a list of ViewItems;
// this turns those into the same nodes the transcript viewer builds by hand.
// The normalizer decides *what* a message is — including that it is something
// this build has never seen — and this decides what it looks like.

/** An unrecognised message, rendered so it cannot be missed. */
function renderUnknown(item) {
  const el = document.createElement('div');
  el.className = 'jsonl-entry jsonl-assistant';
  let raw;
  try { raw = JSON.stringify(item.raw, null, 2); } catch { raw = String(item.raw); }
  const box = makeCollapsible('jsonl-unknown', `Unknown message · ${item.label}`, raw, false);
  el.appendChild(box);
  return el;
}

function renderNotice(item) {
  const el = document.createElement('div');
  el.className = 'jsonl-entry jsonl-meta-entry jsonl-notice jsonl-notice--' + item.level;
  el.textContent = item.text;
  return el;
}

/**
 * @param {Array} items      ViewItems from normalize()
 * @param {Map}   [toolResults] tool_use_id → result, so a call and its result
 *                            render as one block the way the transcript does
 * @param {{ foldTools?: boolean }} [opts]
 * @returns {DocumentFragment}
 */
function renderViewItems(items, toolResults, opts) {
  const fold = !!opts?.foldTools;
  const frag = document.createDocumentFragment();
  for (const item of items) {
    switch (item.kind) {
      case 'text': {
        const el = document.createElement('div');
        el.className = 'jsonl-entry ' + (item.role === 'user' ? 'jsonl-user' : 'jsonl-assistant');
        const text = document.createElement('div');
        text.className = 'jsonl-text';
        text.innerHTML = renderJsonlText(item.text.trim());
        el.appendChild(text);
        frag.appendChild(el);
        break;
      }
      case 'thinking': {
        const el = document.createElement('div');
        el.className = 'jsonl-entry jsonl-assistant';
        el.appendChild(makeCollapsible('jsonl-thinking', 'Thinking', item.text, false));
        frag.appendChild(el);
        break;
      }
      case 'tool_use': {
        const el = document.createElement('div');
        el.className = 'jsonl-entry jsonl-assistant';
        const toolEl = renderToolUse({ name: item.name, input: item.input, id: item.id });
        if (item.id && toolResults && toolResults.has(item.id)) {
          let content = toolEl.querySelector('.jsonl-tool-content');
          if (!content) {
            content = document.createElement('div');
            content.className = 'jsonl-tool-content';
            toolEl.appendChild(content);
          }
          renderToolResult(toolResults.get(item.id), content);
          toolResults.delete(item.id);
        }
        el.appendChild(fold ? collapseToolBlock(toolEl) : toolEl);
        frag.appendChild(el);
        break;
      }
      case 'tool_result': {
        // Already folded into its call above when the pair was seen together.
        if (item.toolUseId && toolResults && !toolResults.has(item.toolUseId)) break;
        const el = document.createElement('div');
        el.className = 'jsonl-entry jsonl-assistant';
        el.appendChild(makeCollapsible('jsonl-tool-result', 'Tool Result', item.content, false));
        frag.appendChild(el);
        break;
      }
      case 'image': {
        const el = document.createElement('div');
        el.className = 'jsonl-entry jsonl-assistant';
        const img = document.createElement('img');
        img.className = 'jsonl-tool-screenshot jsonl-clickable-img';
        img.src = `data:${item.mediaType};base64,${item.data}`;
        el.appendChild(img);
        frag.appendChild(el);
        break;
      }
      case 'notice':
        frag.appendChild(renderNotice(item));
        break;
      case 'unknown':
        frag.appendChild(renderUnknown(item));
        break;
      // 'delta', 'silent' and 'turn_end' change the view's state rather than
      // adding to the transcript; the caller handles them.
      default:
        break;
    }
  }
  return frag;
}

// ── Transcript entries ────────────────────────────────────────────
// One line of a `.jsonl` as it sits on disk. The chat view uses this to paint
// a session's history before it starts receiving live messages, so a session
// opened in the new view reads back exactly as it does in the old one.

function renderJsonlEntry(entry, toolResultMap, opts) {
  if (entry._localCmd) {
    return renderLocalCommand(entry._localCmd);
  }

  const ts = entry.timestamp;
  const timeStr = ts ? new Date(ts).toLocaleTimeString() : '';

  if (entry.type === 'custom-title') {
    const div = document.createElement('div');
    div.className = 'jsonl-entry jsonl-meta-entry';
    div.innerHTML = '<span class="jsonl-meta-icon">T</span> Title set: <strong>' + escHtml(entry.customTitle || '') + '</strong>';
    return div;
  }

  if (entry.type === 'system') {
    const div = document.createElement('div');
    div.className = 'jsonl-entry jsonl-meta-entry';
    if (entry.subtype === 'turn_duration') {
      div.innerHTML = '<span class="jsonl-meta-icon">&#9201;</span> Turn duration: <strong>' + formatDuration(entry.durationMs) + '</strong>'
        + (timeStr ? ' <span class="jsonl-ts">' + timeStr + '</span>' : '');
    } else if (entry.subtype === 'local_command') {
      const cmdMatch = (entry.content || '').match(/<command-name>(.*?)<\/command-name>/);
      const cmd = cmdMatch ? cmdMatch[1] : entry.content || 'unknown';
      div.innerHTML = '<span class="jsonl-meta-icon">$</span> Command: <code class="jsonl-inline-code">' + escHtml(cmd) + '</code>'
        + (timeStr ? ' <span class="jsonl-ts">' + timeStr + '</span>' : '');
    } else {
      return null;
    }
    return div;
  }

  if (entry.type === 'progress') {
    const data = entry.data;
    if (!data || typeof data !== 'object') return null;
    if (data.type === 'bash_progress') {
      const div = document.createElement('div');
      div.className = 'jsonl-entry jsonl-meta-entry';
      const elapsed = data.elapsedTimeSeconds ? ` (${data.elapsedTimeSeconds}s, ${data.totalLines || 0} lines)` : '';
      div.innerHTML = '<span class="jsonl-meta-icon">&#9658;</span> Bash output' + escHtml(elapsed);
      if (data.output || data.fullOutput) {
        const output = data.fullOutput || data.output || '';
        div.appendChild(makeCollapsible('jsonl-tool-result', 'Output', output, true));
      }
      return div;
    }
    return null;
  }

  let role = null;
  let contentBlocks = null;

  if (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user')) {
    role = 'user';
    contentBlocks = entry.message?.content || entry.content;
  } else if (entry.type === 'assistant' || (entry.type === 'message' && entry.role === 'assistant')) {
    role = 'assistant';
    contentBlocks = entry.message?.content || entry.content;
  } else {
    return null;
  }

  if (!contentBlocks) return null;
  if (typeof contentBlocks === 'string') {
    contentBlocks = [{ type: 'text', text: contentBlocks }];
  }
  if (!Array.isArray(contentBlocks)) return null;

  contentBlocks = mergeLocalCommandBlocks(contentBlocks);

  const isToolResultOnly = role === 'user' && Array.isArray(contentBlocks) &&
    contentBlocks.every(b => b.type === 'tool_result');
  const visualRole = isToolResultOnly ? 'assistant' : role;

  const div = document.createElement('div');
  div.className = 'jsonl-entry ' + (visualRole === 'user' ? 'jsonl-user' : 'jsonl-assistant');

  for (const block of contentBlocks) {
    if (block.type === 'thinking' && block.thinking) {
      div.appendChild(makeCollapsible('jsonl-thinking', 'Thinking', block.thinking, false));
    } else if (block.type === 'text' && block.text && block.text.trim()) {
      if (block._localCmd) {
        div.appendChild(renderLocalCommand(block._localCmd));
        continue;
      }
      const imgMatch = block.text.trim().match(/^\[Image:\s*source:\s*([^\]]+)\]$/);
      if (imgMatch) {
        const imgEl = document.createElement('img');
        imgEl.className = 'jsonl-tool-screenshot jsonl-clickable-img';
        imgEl.src = 'file://' + imgMatch[1].trim();
        div.appendChild(imgEl);
        continue;
      }
      const textEl = document.createElement('div');
      textEl.className = 'jsonl-text';
      textEl.innerHTML = renderJsonlText(block.text.trim());
      div.appendChild(textEl);
    } else if (block.type === 'tool_use') {
      const toolEl = renderToolUse(block);
      if (block.id && toolResultMap && toolResultMap.has(block.id)) {
        const resultData = toolResultMap.get(block.id);
        toolResultMap.delete(block.id);
        let contentEl = toolEl.querySelector('.jsonl-tool-content');
        if (!contentEl) {
          contentEl = document.createElement('div');
          contentEl.className = 'jsonl-tool-content';
          toolEl.appendChild(contentEl);
        }
        renderToolResult(resultData, contentEl);
      }
      div.appendChild(opts?.foldTools ? collapseToolBlock(toolEl) : toolEl);
    } else if (block.type === 'tool_result') {
      if (block.tool_use_id && toolResultMap && !toolResultMap.has(block.tool_use_id)) continue;
      const resultContent = block.content || block.output || '';
      div.appendChild(makeCollapsible('jsonl-tool-result', 'Tool Result', resultContent, false));
    }
  }

  if (!div.children.length) return null;
  return div;
}


export { renderJsonlEntry };

export { renderViewItems, renderUnknown, renderNotice };
