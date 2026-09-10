#!/usr/bin/env node
// Screenshot the running app through the DevTools protocol.
//
// Needs the app started with --remote-debugging-port=<port>. Unlike
// `screencapture` this does not require macOS screen-recording permission,
// which is why it exists: it is the only way to eyeball the renderer from a
// headless shell.
//
//   node scripts/devtools-shot.js <out.png> [port] [waitMs]
const fs = require('fs');
const WebSocket = require('ws');

const out = process.argv[2] || '/tmp/wootonpad.png';
const port = Number(process.argv[3] || 9222);
const waitMs = Number(process.argv[4] || 0);

(async () => {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error(`no debuggable page on port ${port}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  let id = 0;
  const pending = new Map();

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

  if (waitMs) await new Promise(r => setTimeout(r, waitMs));

  const { result } = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({ url: location.href, theme: document.documentElement.dataset.theme, errors: (window.__shotErrors || []) })',
    returnByValue: true,
  });
  console.error('page:', result.value);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.error(`wrote ${out}`);
  ws.close();
})().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
