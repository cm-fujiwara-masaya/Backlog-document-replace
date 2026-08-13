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

async function startBulkReplace({ tabId, documents, searchText, replaceText, caseSensitive }) {
  const results = [];

  await setBulkState({ status: 'running', current: 0, total: documents.length, currentDoc: '', results });

  // 対象タブが Backlog かつ有効か事前チェック
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !/backlog\.(com|jp)/.test(tab.url || '')) {
      const msg = 'target_tab_not_backlog';
      console.error(`[bulkReplace] ${msg}: url=${tab?.url}`);
      await setBulkState({ status: 'completed', current: 0, total: documents.length, currentDoc: '', results: [{ id: '-', name: '-', success: false, error: msg }] });
      return;
    }
  } catch (e) {
    await setBulkState({ status: 'completed', current: 0, total: documents.length, currentDoc: '', results: [{ id: '-', name: '-', success: false, error: `target_tab_not_found: ${e.message}` }] });
    return;
  }

  // content script が常駐している事、エディタが使える事を確認（未応答なら直接注入でフォールバック）
  try {
    await waitForContentScript(tabId, '[bulkReplace init]');
  } catch (e) {
    await setBulkState({ status: 'completed', current: 0, total: documents.length, currentDoc: '', results: [{ id: '-', name: '-', success: false, error: e.message }] });
    return;
  }

  for (let i = 0; i < documents.length; i++) {
    if (cancelRequested) {
      await setBulkState({ status: 'cancelled', current: i, total: documents.length, currentDoc: '', results });
      return;
    }

    const doc = documents[i];
    const ctx = `[bulkReplace ${i + 1}/${documents.length}] "${doc.name}" (${doc.id})`;
    await setBulkState({ status: 'running', current: i, total: documents.length, currentDoc: doc.name, results });

    try {
      console.log(`${ctx} navigateAndAutoReplace`);
      const result = await chrome.tabs.sendMessage(tabId, {
        action: 'navigateAndAutoReplace',
        documentId: doc.id,
        searchText,
        replaceText,
        caseSensitive,
      }).catch(e => {
        console.error(`${ctx} sendMessage failed:`, e);
        return { success: false, error: `sendMessage failed: ${e.message}` };
      });

      if (!result.success) {
        console.error(`${ctx} returned error:`, result.error);
      } else {
        console.log(`${ctx} replaced ${result.count} occurrences`);
      }

      results.push({ id: doc.id, name: doc.name, ...result });
    } catch (e) {
      console.error(`${ctx} threw:`, e);
      results.push({ id: doc.id, name: doc.name, success: false, error: e.message });
    }

    // 次のドキュメント遷移までの安定化（SPA レンダリングのため）
    await sleep(600);
  }

  if (cancelRequested) {
    await setBulkState({ status: 'cancelled', current: documents.length, total: documents.length, currentDoc: '', results });
    return;
  }
  await setBulkState({ status: 'completed', current: documents.length, total: documents.length, currentDoc: '', results });
}

async function setBulkState(state) {
  await chrome.storage.local.set({ bulkReplaceState: state });
  chrome.runtime.sendMessage({ action: 'bulkStateUpdate', state }).catch(() => {});
}

// content scriptが応答可能になるまで待つ。タイムアウトしたら programmatic injection でフォールバック
async function waitForContentScript(tabId, ctx = '', maxAttempts = 60, intervalMs = 500) {
  let lastErr = null;
  let lastRes = null;
  let firstConnectAt = -1;
  for (let i = 0; i < maxAttempts; i++) {
    if (cancelRequested) throw new Error('cancelled');
    try {
      const res = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      lastRes = res;
      if (firstConnectAt < 0) firstConnectAt = i;
      if (res && res.ready) return true;
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  if (cancelRequested) throw new Error('cancelled');
  const elapsedMs = maxAttempts * intervalMs;
  // 接続はできていたがエディタが現れなかった = ページは開いたがTiptapエディタなし
  if (firstConnectAt >= 0 && lastRes) {
    console.error(`${ctx} editor never appeared in ${elapsedMs}ms. last ping response:`, lastRes);
    const labels = (lastRes.buttonLabels || []).slice(0, 10).join(' | ');
    throw new Error(`editor_not_found url=${lastRes.url} title="${lastRes.title}" PM=${lastRes.proseMirrorCount} CE=${lastRes.contenteditableCount} editBtn=${lastRes.hasEditButton} buttons=[${labels}] bodyHead="${(lastRes.bodyTextPreview || '').slice(0, 80)}"`);
  }
  // 接続自体ができなかった → content scriptが未注入の可能性 → 直接注入を試す
  console.warn(`${ctx} ping never connected (lastErr=${lastErr?.message}). Trying programmatic injection.`);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await sleep(800);
    const res = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    if (res && res.ready) {
      console.log(`${ctx} content script injected via scripting API`);
      return true;
    }
    console.error(`${ctx} ping after injection still not ready:`, res);
    throw new Error(`editor_not_found_after_injection (url=${res?.url}, title=${res?.title}, proseMirrorCount=${res?.proseMirrorCount})`);
  } catch (e) {
    if (e.message?.startsWith('editor_not_found')) throw e;
    console.error(`${ctx} programmatic injection failed:`, e);
    throw new Error(`injection_failed: ${e.message}`);
  }
}

function waitForTabLoad(tabId, timeoutMs = 20000) {
  return new Promise(resolve => {
    let timeoutId;
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timeoutId);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
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
