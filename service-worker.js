let ws = null;
let backoff = 500;
let heartbeatInterval = null;

async function ensureContentInjected(tabId, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'ping' });
      return true;
    } catch {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js']
        });
        const delayMs = 100 * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delayMs));
        await chrome.tabs.sendMessage(tabId, { type: 'ping' });
        return true;
      } catch (e) {
        if (attempt === maxRetries - 1) {
          console.warn('[AuraText] Injection failed after retries:', e?.message);
          return false;
        }
      }
    }
  }
  return false;
}

function startHeartbeat() {
  clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(async () => {
    try {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'heartbeat', ts: Date.now() }));
      }
    } catch {}
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab?.id) continue;
        try { await chrome.tabs.sendMessage(tab.id, { type: 'ping' }); } catch {}
      }
    } catch {}
  }, 20000);
}

function stopHeartbeat() {
  clearInterval(heartbeatInterval);
  heartbeatInterval = null;
}

function connect() {
  if (ws?.readyState === WebSocket.OPEN) return;
  
  try {
    ws = new WebSocket('ws://127.0.0.1:8765');
    
    ws.onopen = () => {
      console.log('[AuraText] Connected');
      backoff = 500;
      startHeartbeat();
      chrome.tabs.query({}).then((tabs) => {
        for (const tab of tabs) {
          if (!tab?.id) continue;
          chrome.tabs.sendMessage(tab.id, { type: 'extension-ready' }).catch(() => {});
        }
      }).catch(() => {});
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
        const ok = await ensureContentInjected(tab.id, 3);
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
      stopHeartbeat();
      ws = null;
      setTimeout(connect, Math.min(backoff *= 1.5, 5000));
    };
  } catch {
    setTimeout(connect, backoff);
  }
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'noop') return true;
  if (msg?.type === 'check-connection') {
    sendResponse({ connected: ws?.readyState === WebSocket.OPEN, backoff });
    return true;
  }
  return false;
});
connect();