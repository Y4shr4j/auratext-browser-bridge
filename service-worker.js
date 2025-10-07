let ws = null;
let backoff = 500;

async function ensureContentInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
      await new Promise(r => setTimeout(r, 50));
      return true;
    } catch (e) {
      console.warn('[AuraText] Injection failed:', e?.message);
      return false;
    }
  }
}

function connect() {
  if (ws?.readyState === WebSocket.OPEN) return;
  
  try {
    ws = new WebSocket('ws://127.0.0.1:8765');
    
    ws.onopen = () => {
      console.log('[AuraText] Connected');
      backoff = 500;
    };
    
    ws.onmessage = async (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg?.type !== 'replace-range') return;

      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) {
        ws.send(JSON.stringify({ requestId: msg.requestId, success: false, error: 'no-tab' }));
        return;
      }

      try {
        const ok = await ensureContentInjected(tab.id);
        if (!ok) {
          ws.send(JSON.stringify({ requestId: msg.requestId, success: false, error: 'inject-failed' }));
          return;
        }

        const resp = await chrome.tabs.sendMessage(tab.id, msg);
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(resp || { requestId: msg.requestId, success: false, error: 'no-response' }));
        }
      } catch (error) {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            requestId: msg.requestId, 
            success: false, 
            error: error.message || 'send-failed' 
          }));
        }
      }
    };
    
    ws.onclose = ws.onerror = () => {
      ws = null;
      setTimeout(connect, Math.min(backoff *= 2, 8000));
    };
  } catch {
    setTimeout(connect, backoff);
  }
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onMessage.addListener((msg) => msg?.type === 'noop');
connect();