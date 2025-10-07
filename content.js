// content.js - Fixed for atomic browser text replacement
function respond(requestId, body) {
  chrome.runtime.sendMessage({ type:'noop' }); // keep SW alive
  return { requestId, ...body };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'replace-range') return true;
  
  const { start, end, newText, expectedOriginal } = msg.payload || {};
  const requestId = msg.requestId;

  const active = document.activeElement;
  if (!active) {
    sendResponse(respond(requestId, { 
      success: false, 
      error: 'no-active-editable' 
    }));
    return true;
  }

  try {
    // Handle standard input/textarea elements
    if (active instanceof HTMLTextAreaElement || 
        (active instanceof HTMLInputElement && !active.readOnly)) {
      
      let s = start, e = end;
      const currentValue = active.value || '';
      
      // Validate the range matches expected original text
      if (expectedOriginal) {
        const actualText = currentValue.slice(s, e);
        if (actualText !== expectedOriginal) {
          // Try to find the text in the document
          const idx = currentValue.indexOf(expectedOriginal);
          if (idx < 0) {
            sendResponse(respond(requestId, { 
              success: false, 
              error: 'range-mismatch',
              details: `Expected "${expectedOriginal}" but found "${actualText}"`
            }));
            return true;
          }
          s = idx;
          e = idx + expectedOriginal.length;
        }
      }
      
      // Perform atomic replacement
      active.setSelectionRange(s, e);
      active.setRangeText(newText, s, e, 'end');
      
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
      return true;
    }

    // Handle contenteditable elements
    let root = active.closest('[contenteditable="true"]');
    if (!root) {
      sendResponse(respond(requestId, { 
        success: false, 
        error: 'no-contenteditable' 
      }));
      return true;
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
      const actualText = text.slice(s0, e0);
      if (actualText !== expectedOriginal) {
        const idx = text.indexOf(expectedOriginal);
        if (idx < 0) {
          sendResponse(respond(requestId, { 
            success: false, 
            error: 'range-mismatch',
            details: `Expected "${expectedOriginal}" at ${s0}-${e0}`
          }));
          return true;
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
      return true;
    }

    // Create range and replace
    const r = document.createRange();
    r.setStart(A.n, s0 - A.start);
    r.setEnd(B.n, e0 - B.start);

    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    
    // Try execCommand first (better for preserving formatting)
    const ok = document.execCommand('insertText', false, newText);
    
    if (!ok) {
      // Fallback: manual DOM manipulation
      r.deleteContents();
      r.insertNode(document.createTextNode(newText));
    }

    // Trigger input event for framework compatibility
    root.dispatchEvent(new InputEvent('input', { 
      bubbles: true, 
      inputType: 'insertReplacementText', 
      data: newText 
    }));
    
    sendResponse(respond(requestId, { 
      success: true, 
      method: ok ? 'execCommand' : 'range-insert',
      replacedLength: e0 - s0,
      newLength: newText.length
    }));
    return true;
    
  } catch (e) {
    sendResponse(respond(requestId, { 
      success: false, 
      error: e.message || 'exception',
      stack: e.stack
    }));
    return true;
  }
});