#!/usr/bin/env node
// Run a JS snippet in the running app's renderer and optionally screenshot an
// element, over the DevTools protocol. Companion to devtools-shot.js — see
// that file for why CDP rather than `screencapture`.
//
//   node scripts/devtools-eval.js <file.js> [--shot <selector> <out.png>] [--port 9222]
const fs = require('fs');
const WebSocket = require('ws');

const args = process.argv.slice(2);
const scriptFile = args[0];
const shotIdx = args.indexOf('--shot');
const portIdx = args.indexOf('--port');
const port = portIdx > -1 ? Number(args[portIdx + 1]) : 9222;
const shotSelector = shotIdx > -1 ? args[shotIdx + 1] : null;
const shotOut = shotIdx > -1 ? args[shotIdx + 2] : null;

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

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  };

  const out = await evaluate(`(async () => { ${fs.readFileSync(scriptFile, 'utf8')} })()`);
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));

  if (shotSelector) {
    await evaluate(`document.querySelector(${JSON.stringify(shotSelector)})?.scrollIntoView({ block: 'center' })`);
    await new Promise(r => setTimeout(r, 400));
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(shotSelector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    })()`);
    if (!box) throw new Error(`selector not found: ${shotSelector}`);
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: {
        x: Math.max(0, box[0] - 10), y: Math.max(0, box[1] - 10),
        width: box[2] + 20, height: box[3] + 20, scale: 2,
      },
    });
    fs.writeFileSync(shotOut, Buffer.from(shot.data, 'base64'));
    console.log(`wrote ${shotOut}`);
  }
  ws.close();
})().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
