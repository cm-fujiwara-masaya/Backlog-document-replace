// Backlog Document Find & Replace - Background Service Worker

let cancelRequested = false;


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fetchDocumentTree') {
    fetchDocumentTree(message.spaceUrl, message.apiKey, message.projectKey)
      .then(data => sendResponse({ success: true, data }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.action === 'runDryRun') {
    runDryRun(message)
      .then(result => sendResponse({ success: true, result }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.action === 'startBulkReplace') {
    cancelRequested = false;
    startBulkReplace(message).catch(console.error);
    sendResponse({ started: true });
    return false;
  }

  if (message.action === 'cancelBulkReplace') {
    cancelRequested = true;
    sendResponse({ ok: true });
    return false;
  }
});

function normalizeUrl(url) {
  const u = url.trim().replace(/\/$/, '');
  return u.startsWith('http') ? u : `https://${u}`;
}

async function fetchDocumentTree(spaceUrl, apiKey, projectKey) {
  const base = normalizeUrl(spaceUrl);
  const url = `${base}/api/v2/documents/tree?projectIdOrKey=${encodeURIComponent(projectKey)}&apiKey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function runDryRun({ spaceUrl, apiKey, documents, searchText, caseSensitive }) {
  const base = normalizeUrl(spaceUrl);
  const results = [];
  for (const doc of documents) {
    try {
      const url = `${base}/api/v2/documents/${encodeURIComponent(doc.id)}?apiKey=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data = await res.json();
      const text = extractPlainText(data);
      const count = countMatches(text, searchText, caseSensitive);
      results.push({ id: doc.id, name: doc.name, count });
    } catch (e) {
      results.push({ id: doc.id, name: doc.name, count: 0, error: e.message });
    }
  }
  return results;
}

async function startBulkReplace({ spaceUrl, projectKey, documents, searchText, replaceText, caseSensitive }) {
  const base = normalizeUrl(spaceUrl);
  const results = [];

  await setBulkState({ status: 'running', current: 0, total: documents.length, currentDoc: '', results });

  for (let i = 0; i < documents.length; i++) {
    if (cancelRequested) {
      await setBulkState({ status: 'cancelled', current: i, total: documents.length, currentDoc: '', results });
      return;
    }

    const doc = documents[i];
    await setBulkState({ status: 'running', current: i, total: documents.length, currentDoc: doc.name, results });

    let tabId = null;
    try {
      const docUrl = `${base}/document/${projectKey}/e/${doc.id}`;
      const tab = await chrome.tabs.create({ url: docUrl, active: false });
      tabId = tab.id;

      await waitForTabLoad(tab.id);
      await waitForContentScript(tab.id);

      const result = await chrome.tabs.sendMessage(tab.id, {
        action: 'autoReplace',
        searchText,
        replaceText,
        caseSensitive,
      }).catch(e => ({ success: false, error: e.message }));

      results.push({ id: doc.id, name: doc.name, ...result });
    } catch (e) {
      results.push({ id: doc.id, name: doc.name, success: false, error: e.message });
    } finally {
      if (tabId != null) {
        await chrome.tabs.remove(tabId).catch(() => {});
        await sleep(400);
      }
    }
  }

  await setBulkState({ status: 'completed', current: documents.length, total: documents.length, currentDoc: '', results });
}

async function setBulkState(state) {
  await chrome.storage.local.set({ bulkReplaceState: state });
  chrome.runtime.sendMessage({ action: 'bulkStateUpdate', state }).catch(() => {});
}

// content scriptが応答可能になるまで待つ。タイムアウトしたら programmatic injection でフォールバック
async function waitForContentScript(tabId, maxAttempts = 30, intervalMs = 500) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      if (res && res.ready) return true;
    } catch (_) { /* not ready yet */ }
    await sleep(intervalMs);
  }
  // 最後の手段: content.js を直接注入してから再度ping
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await sleep(800);
    const res = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    if (res && res.ready) return true;
  } catch (_) { /* injection failed */ }
  throw new Error('content_script_not_ready');
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(resolve, 20000);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function extractPlainText(docData) {
  if (typeof docData.plain === 'string' && docData.plain.length > 0) {
    return docData.plain;
  }
  const raw = docData.json ?? docData.content ?? docData.plainContent ?? docData.text ?? '';
  if (typeof raw === 'string') {
    try {
      return extractFromPmNode(JSON.parse(raw));
    } catch {
      return raw;
    }
  }
  if (typeof raw === 'object' && raw !== null) return extractFromPmNode(raw);
  return '';
}

function extractFromPmNode(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node.content)) return node.content.map(extractFromPmNode).join('');
  if (Array.isArray(node)) return node.map(extractFromPmNode).join('');
  return '';
}

function countMatches(text, searchText, caseSensitive) {
  if (!text || !searchText) return 0;
  const h = caseSensitive ? text : text.toLowerCase();
  const n = caseSensitive ? searchText : searchText.toLowerCase();
  let count = 0, pos = 0;
  while ((pos = h.indexOf(n, pos)) !== -1) { count++; pos += n.length; }
  return count;
}
