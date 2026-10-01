// Inspects the running Prosa WebView2 via CDP (launched with
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222).
const res = await fetch('http://127.0.0.1:9222/json');
const targets = await res.json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target found');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6);
    const onMessage = (ev) => {
      const m = JSON.parse(ev.data.toString());
      if (m.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result.result.value);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
}

const state = await evaluate(`JSON.stringify({
  openBtn: document.getElementById('btn-open').textContent,
  visualMounted: !!document.querySelector('.ProseMirror'),
  docText: (document.querySelector('.ProseMirror') || { textContent: '' }).textContent.slice(0, 80),
  stCount: document.getElementById('st-count').textContent,
  theme: document.documentElement.dataset.theme,
  title: document.title,
})`);
ws.close();
console.log(state);
