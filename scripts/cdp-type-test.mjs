// Simulates typing into the running Prosa WebView2 via CDP and checks
// that the dirty indicator appears. PM reacts to beforeinput insertText.
const res = await fetch('http://127.0.0.1:9222/json');
const targets = await res.json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target found');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6);
    const onMessage = (ev) => {
      const m = JSON.parse(ev.data.toString());
      if (m.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const evaluate = (expression) =>
  send('Runtime.evaluate', { expression, returnByValue: true }).then((r) => r.result.value);

await evaluate(`(() => {
  const pm = document.querySelector('.ProseMirror');
  pm.focus();
  pm.dispatchEvent(new InputEvent('beforeinput', {
    inputType: 'insertText', data: 'привет', bubbles: true, cancelable: true,
  }));
  return 'dispatched';
})()`);

await new Promise((r) => setTimeout(r, 700));

const result = await evaluate(`JSON.stringify({
  title: document.title,
  docText: (document.querySelector('.ProseMirror') || { textContent: '' }).textContent.slice(0, 40),
  stCount: document.getElementById('st-count').textContent,
})`);
ws.close();
console.log(result);
