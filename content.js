// content.js - Fixed for atomic browser text replacement
function respond(requestId, body) {
  chrome.runtime.sendMessage({ type:'noop' }); // keep SW alive
  return { requestId, ...body };
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash >>> 0;
}

function getActiveEditableText() {
  const active = document.activeElement;
  if (!active) return { element: null, text: '' };
  if (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && !active.readOnly)) {
    return { element: active, text: active.value || '' };
  }
  const root = active.closest('[contenteditable="true"]');
  if (root) {
    return { element: root, text: root.textContent || '' };
  }
  return { element: null, text: '' };
}

function getDocumentFingerprint() {
  const { text } = getActiveEditableText();
  return {
    length: text.length,
    hash: simpleHash(text),
    ts: Date.now()
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'ping') {
    sendResponse({ pong: true });
    return false;
  }
  if (msg?.type !== 'replace-range') return false;
  
  const { start, end, newText, expectedOriginal, documentHash } = msg.payload || {};
  const requestId = msg.requestId;

  const active = document.activeElement;
  if (!active) {
    sendResponse(respond(requestId, { 
      success: false, 
      error: 'no-active-editable' 
    }));
    return false; // Synchronous response
  }

  // Verify document fingerprint if provided
  const fp = getDocumentFingerprint();
  if (documentHash != null && fp.hash !== documentHash) {
    sendResponse(respond(requestId, {
      success: false,
      error: 'document-modified'
    }));
    return false;
  }

  try {
    // Handle standard input/textarea elements
    if (active instanceof HTMLTextAreaElement || 
        (active instanceof HTMLInputElement && !active.readOnly)) {
      
      let s = start, e = end;
      const currentValue = active.value || '';
      
      // Validate the range matches expected original text
      if (expectedOriginal) {
        const normalize = (t) => t.replace(/\s+/g, ' ').trim();
        const actualText = currentValue.slice(s, e);
        if (normalize(actualText) !== normalize(expectedOriginal)) {
          // Try to find the text in the document (tolerant)
          const idx = currentValue.indexOf(expectedOriginal);
          if (idx < 0) {
            sendResponse(respond(requestId, { 
              success: false, 
              error: 'range-mismatch',
              details: `Expected "${expectedOriginal}" but found "${actualText}"`
            }));
            return false; // Synchronous response
          }
          s = idx;
          e = idx + expectedOriginal.length;
        }
      }
      
      // Perform atomic replacement at exact position
      active.setRangeText(newText, s, e, 'select');
      active.setSelectionRange(s + newText.length, s + newText.length);
      
      // Trigger input event for framework compatibility (React, Vue, etc.)
      active.dispatchEvent(new InputEvent('input', { 
        bubbles: true, 
        inputType: 'insertReplacementText', 
        data: newText 
      }));
      
      // Trigger change event for some frameworks
      active.dispatchEvent(new Event('change', { bubbles: true }));
      
      sendResponse(respond(requestId, { 
        success: true, 
        method: 'setRangeText',
        replacedLength: e - s,
        newLength: newText.length
      }));
      return false; // Synchronous response
    }

    // Handle contenteditable elements
    let root = active.closest('[contenteditable="true"]');
    if (!root) {
      sendResponse(respond(requestId, { 
        success: false, 
        error: 'no-contenteditable' 
      }));
      return false; // Synchronous response
    }

    // Build linear text map for contenteditable
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const spans = [];
    let text = '';
    
    while (walker.nextNode()) {
      const n = walker.currentNode;
      spans.push({ n, start: text.length });
      text += n.nodeValue || '';
      spans[spans.length - 1].end = text.length;
    }

    const findPoint = (off) => spans.find(s => off >= s.start && off <= s.end);
    
    let s0 = start, e0 = end;
    
    // Validate range for contenteditable
    if (expectedOriginal) {
      const normalize = (t) => t.replace(/\s+/g, ' ').trim();
      const actualText = text.slice(s0, e0);
      if (normalize(actualText) !== normalize(expectedOriginal)) {
        const idx = text.indexOf(expectedOriginal);
        if (idx < 0) {
          sendResponse(respond(requestId, { 
            success: false, 
            error: 'range-mismatch',
            details: `Expected "${expectedOriginal}" at ${s0}-${e0}`
          }));
          return false; // Synchronous response
        }
        s0 = idx;
        e0 = idx + expectedOriginal.length;
      }
    }
    
    const A = findPoint(s0);
    const B = findPoint(e0);
    
    if (!A || !B) {
      sendResponse(respond(requestId, { 
        success: false, 
        error: 'dom-map-failed' 
      }));
      return false; // Synchronous response
    }

    // Create range and replace
    const r = document.createRange();
    r.setStart(A.n, s0 - A.start);
    r.setEnd(B.n, e0 - B.start);

    // Delete old content and insert new text at exact position
    r.deleteContents();
    const textNode = document.createTextNode(newText);
    r.insertNode(textNode);
    
    // Set cursor to end of inserted text
    r.setStartAfter(textNode);
    r.collapse(true);
    
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);

    // Trigger input event for framework compatibility
    root.dispatchEvent(new InputEvent('input', { 
      bubbles: true, 
      inputType: 'insertReplacementText', 
      data: newText 
    }));
    
    sendResponse(respond(requestId, { 
      success: true, 
      method: 'range-insert',
      replacedLength: e0 - s0,
      newLength: newText.length
    }));
    return false; // Synchronous response
    
  } catch (e) {
    sendResponse(respond(requestId, { 
      success: false, 
      error: e.message || 'exception',
      stack: e.stack
    }));
    return false; // Synchronous response
  }
});