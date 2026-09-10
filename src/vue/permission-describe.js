// permission-describe.js — a tool-permission request, in a sentence.
//
// The SDK hands over a tool name and an arbitrary input object. Printing that
// object is honest but useless: the question "may Claude write this file" is
// buried in JSON braces, and the one thing worth reading — which file, what
// command — is the part hardest to find.
//
// So each tool the CLI actually asks about gets a question naming its subject,
// and a body showing only as much of the payload as is worth glancing at.
// Anything unrecognised still renders, as JSON — a tool this build has never
// heard of must not become an unanswerable dialog.

/** Body limits. Enough to recognise what is being done, not to read it. */
export const MAX_LINES = 3;
export const MAX_CHARS = 1000;

/** Last path segment — the part of a path anyone actually reads. */
function base(filePath) {
  if (typeof filePath !== 'string' || !filePath) return '';
  return filePath.split('/').filter(Boolean).pop() || filePath;
}

/**
 * Three lines at most, a thousand characters at most, and say so when there
 * was more. Truncating silently would make a 400-line file look like 3.
 */
export function clip(text) {
  if (typeof text !== 'string') {
    try { text = JSON.stringify(text, null, 2); } catch { text = String(text); }
  }
  if (!text) return '';
  const lines = text.split('\n');
  let body = lines.slice(0, MAX_LINES).join('\n');
  let trimmed = lines.length > MAX_LINES;

  if (body.length > MAX_CHARS) {
    body = body.slice(0, MAX_CHARS);
    trimmed = true;
  }
  return trimmed ? `${body}\n…` : body;
}

/**
 * @param {string} toolName
 * @param {unknown} input
 * @param {{ title?: string, displayName?: string, description?: string }} [bridge]
 *   What the CLI itself rendered for this prompt, when it sent any. The SDK
 *   docs are explicit that `title` should be preferred over reconstructing a
 *   sentence from the tool name and input — it is the same wording the
 *   official client shows, and it knows about tools this build does not.
 * @returns {{ question: string, detail: string, subject: string }}
 */
export function describePermission(toolName, input, bridge) {
  const it = (input && typeof input === 'object') ? input : {};
  const name = String(toolName || 'a tool');
  const own = describeLocally(name, it, input);

  const title = String(bridge?.title || '').trim();
  if (!title) return own;
  // The bridge writes the sentence; the local branch still knows which part of
  // the payload is worth looking at, so the two are combined rather than one
  // replacing the other.
  return {
    question: /[?.!]$/.test(title) ? title : `${title}?`,
    subject: own.subject || String(bridge?.description || '').trim(),
    detail: own.detail,
  };
}

function describeLocally(name, it, input) {
  switch (name) {
    case 'Write': {
      const file = base(it.file_path);
      return {
        question: file ? `Write to ${file}?` : 'Write a file?',
        subject: it.file_path || '',
        detail: clip(it.content),
      };
    }

    case 'Edit':
    case 'MultiEdit': {
      const file = base(it.file_path);
      // The replacement is what will exist afterwards, so that is the half
      // worth showing when there is only room for one.
      const edits = Array.isArray(it.edits) ? it.edits : null;
      const replacement = edits?.length
        ? edits.map(e => e?.new_string).filter(Boolean).join('\n')
        : it.new_string;
      return {
        question: file ? `Edit ${file}?` : 'Edit a file?',
        subject: it.file_path || '',
        detail: clip(replacement),
      };
    }

    case 'Bash':
    case 'BashOutput': {
      return {
        question: it.description ? `Run: ${it.description}?` : 'Run a shell command?',
        subject: '',
        detail: clip(it.command),
      };
    }

    case 'Read':
    case 'NotebookEdit': {
      const file = base(it.file_path || it.notebook_path);
      return {
        question: file ? `${name === 'Read' ? 'Read' : 'Edit'} ${file}?` : `Allow ${name}?`,
        subject: it.file_path || it.notebook_path || '',
        detail: clip(it.new_source || ''),
      };
    }

    case 'Glob':
    case 'Grep': {
      return {
        question: `Search the project with ${name}?`,
        subject: it.path || '',
        detail: clip(it.pattern),
      };
    }

    case 'WebFetch': {
      let host = '';
      try { host = new URL(String(it.url)).host; } catch { host = String(it.url || ''); }
      return {
        question: host ? `Fetch ${host}?` : 'Fetch a page?',
        subject: it.url || '',
        detail: clip(it.prompt || it.url),
      };
    }

    case 'WebSearch': {
      return { question: 'Search the web?', subject: '', detail: clip(it.query) };
    }

    case 'Task': {
      return {
        question: it.subagent_type ? `Run the ${it.subagent_type} agent?` : 'Run a subagent?',
        subject: '',
        detail: clip(it.description || it.prompt),
      };
    }

    default: {
      // Unknown tool, including every MCP one. The name is still the question
      // and the payload is still readable, just without a tailored shape.
      return { question: `Allow ${name}?`, subject: '', detail: clip(input) };
    }
  }
}

/**
 * The answers to a permission prompt, as a numbered list.
 *
 * The official client asks this question as a list you answer with a digit,
 * and so does this one — which is also why "always" sits between yes and no
 * rather than off to one side: the order is the order you read.
 *
 * @param {{ suggestions?: unknown[] }} [request]
 * @returns {Array<{ id: string, label: string, description: string, tone?: string }>}
 */
export function permissionChoices(request) {
  const choices = [{ id: 'allow', label: 'Yes', description: '', tone: 'primary' }];
  if (request?.suggestions?.length) {
    choices.push({
      id: 'always',
      label: "Yes, and don't ask again",
      // The CLI wrote these rules itself; accepting them is what makes the
      // next session behave the same way without being asked.
      description: 'Adds this to your permission rules',
    });
  }
  choices.push({
    id: 'deny', label: 'No', description: 'Tell Claude what to do instead', tone: 'danger',
  });
  return choices;
}
