// Backlog Document Find & Replace - Popup Script

// ===== ツリーユーティリティ =====

function flattenTree(nodes, prefix, result) {
  prefix = prefix || '';
  result = result || [];
  for (const node of nodes) {
    const path = prefix ? `${prefix} / ${node.name}` : node.name;
    result.push({ ...node, path });
    if (node.children && node.children.length > 0) {
      flattenTree(node.children, path, result);
    }
  }
  return result;
}

// Backlogではフォルダ自身もドキュメントなので、選択ノード自身+全子孫を収集する
function collectDocuments(nodes) {
  const docs = [];
  function traverse(nodeList) {
    for (const node of nodeList) {
      if (node.id) docs.push(node);
      if (node.children && node.children.length > 0) {
        traverse(node.children);
      }
    }
  }
  traverse(nodes);
  return docs;
}

function findNodeById(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findNodeById(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

// APIレスポンスを正規化してトップレベルのノード配列を返す
// /api/v2/projects/:projectIdOrKey/documents/tree のレスポンス形式に対応
function normalizeTree(apiResponse) {
  // ツリーAPI: { activeTree: { children: [...] }, trashTree: {...} }
  if (apiResponse && apiResponse.activeTree) {
    const at = apiResponse.activeTree;
    return Array.isArray(at.children) ? at.children : [];
  }
  // フラットリスト（parentId 付き）→ ツリー化
  if (Array.isArray(apiResponse)) {
    const hasParentId = apiResponse.some(n => n.parentId !== undefined);
    if (hasParentId) {
      const map = {};
      for (const item of apiResponse) map[item.id] = { ...item, children: item.children || [] };
      const roots = [];
      for (const item of apiResponse) {
        if (item.parentId && map[item.parentId]) {
          map[item.parentId].children.push(map[item.id]);
        } else {
          roots.push(map[item.id]);
        }
      }
      return roots;
    }
    return apiResponse;
  }
  if (apiResponse && apiResponse.tree) return normalizeTree(apiResponse.tree);
  if (apiResponse && apiResponse.children) return apiResponse.children;
  return [];
}

document.addEventListener("DOMContentLoaded", () => {
  const searchInput = document.getElementById("searchText");
  const replaceInput = document.getElementById("replaceText");
  const caseSensitive = document.getElementById("caseSensitive");
  const btnPrev = document.getElementById("btnPrev");
  const btnNext = document.getElementById("btnNext");
  const btnReplace = document.getElementById("btnReplace");
  const btnReplaceAll = document.getElementById("btnReplaceAll");
  const status = document.getElementById("status");

  let matchCount = 0;
  let searchTimer = null;

  // Content Scriptから前回の入力値を復元し、検索文字列があれば自動検索
  sendToContentScript({ action: "getState" }).then((state) => {
    if (state.searchText) searchInput.value = state.searchText;
    if (state.replaceText) replaceInput.value = state.replaceText;
    if (state.caseSensitive) caseSensitive.checked = state.caseSensitive;
    if (state.searchText) performSearch();
  }).catch(() => {});

  // フォーカスを検索欄に
  searchInput.focus();

  function showStatus(message, type) {
    status.textContent = message;
    status.className = type;
  }

  function setNavEnabled(enabled) {
    btnPrev.disabled = !enabled;
    btnNext.disabled = !enabled;
  }

  async function sendToContentScript(message) {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return chrome.tabs.sendMessage(tab.id, message);
  }

  // エラーメッセージを原因に応じて出し分ける
  function showConnectionError(e) {
    if (e?.message?.includes("Receiving end does not exist")) {
      showStatus("Backlogドキュメントページをリロードしてください（Cmd+R / Ctrl+R）", "error");
    } else {
      showStatus("接続エラー: ページをリロードしてお試しください", "error");
    }
  }

  // 検索実行
  async function performSearch() {
    const searchText = searchInput.value;
    if (!searchText) {
      matchCount = 0;
      setNavEnabled(false);
      status.className = "";
      try {
        await sendToContentScript({ action: "clearHighlights" });
      } catch (_) { /* ignore */ }
      return;
    }
    try {
      const response = await sendToContentScript({
        action: "find",
        searchText,
        caseSensitive: caseSensitive.checked,
      });
      matchCount = response.count;
      if (response.count > 0) {
        const idx = response.activeIndex ?? 0;
        showStatus(`${idx + 1} / ${response.count} 件`, "info");
        setNavEnabled(true);
      } else {
        showStatus("見つかりませんでした", "warning");
        setNavEnabled(false);
      }
    } catch (e) {
      showConnectionError(e);
    }
  }

  // リアルタイム検索（150msデバウンス）
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(performSearch, 150);
  });

  // 大文字小文字の切り替えでも再検索
  caseSensitive.addEventListener("change", () => {
    performSearch();
  });

  // 前へ
  btnPrev.addEventListener("click", async () => {
    try {
      const response = await sendToContentScript({ action: "findPrev" });
      matchCount = response.count;
      showStatus(`${response.activeIndex + 1} / ${response.count} 件`, "info");
    } catch (e) {
      showConnectionError(e);
    }
  });

  // 次へ
  btnNext.addEventListener("click", async () => {
    try {
      const response = await sendToContentScript({ action: "findNext" });
      matchCount = response.count;
      showStatus(`${response.activeIndex + 1} / ${response.count} 件`, "info");
    } catch (e) {
      showConnectionError(e);
    }
  });

  // 置換（1件）
  btnReplace.addEventListener("click", async () => {
    const searchText = searchInput.value;
    const replaceText = replaceInput.value;
    if (!searchText) {
      showStatus("検索文字列を入力してください", "warning");
      return;
    }
    try {
      const response = await sendToContentScript({
        action: "replace",
        searchText,
        replaceText,
        caseSensitive: caseSensitive.checked,
      });
      if (response.error === "not_editable") {
        showStatus(
          "編集モードにしてください（鉛筆アイコンをクリック）",
          "error"
        );
      } else if (response.success) {
        if (response.remaining > 0) {
          showStatus(
            `置換しました（残り ${response.remaining} 件）`,
            "success"
          );
        } else {
          showStatus("全て置換しました", "success");
          setNavEnabled(false);
        }
        matchCount = response.remaining;
      } else {
        showStatus("見つかりませんでした", "warning");
      }
    } catch (e) {
      showConnectionError(e);
    }
  });

  // 全置換
  btnReplaceAll.addEventListener("click", async () => {
    const searchText = searchInput.value;
    const replaceText = replaceInput.value;
    if (!searchText) {
      showStatus("検索文字列を入力してください", "warning");
      return;
    }
    try {
      const response = await sendToContentScript({
        action: "replaceAll",
        searchText,
        replaceText,
        caseSensitive: caseSensitive.checked,
      });
      if (response.error === "not_editable") {
        showStatus(
          "編集モードにしてください（鉛筆アイコンをクリック）",
          "error"
        );
      } else if (response.success) {
        showStatus(`${response.count} 件を置換しました`, "success");
        matchCount = 0;
        setNavEnabled(false);
      } else {
        showStatus("見つかりませんでした", "warning");
      }
    } catch (e) {
      showConnectionError(e);
    }
  });

  // Enterで次へ、Shift+Enterで前へ
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.shiftKey) {
      if (matchCount > 0) btnPrev.click();
    } else if (e.key === "Enter") {
      if (matchCount > 0) btnNext.click();
    }
  });

  // ポップアップを閉じた時にハイライトをクリア（content scriptが居なくてもエラーを握り潰す）
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      const port = chrome.tabs.connect(tab.id, { name: "blg-fr-popup" });
      port.onDisconnect.addListener(() => {
        // lastError を読み出して "Unchecked runtime.lastError" を抑制
        void chrome.runtime.lastError;
      });
    } catch (_) { /* ignore */ }
  })();

  // ===== タブ切替 =====
  const panelSingle = document.getElementById('panel-single');
  const panelBulk   = document.getElementById('panel-bulk');

  document.querySelectorAll('.tab-bar button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-bar button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      panelSingle.style.display = tab === 'single' ? '' : 'none';
      panelBulk.style.display   = tab === 'bulk'   ? '' : 'none';
    });
  });

  // ===== 一括置換モード =====

  const bSpaceUrl      = document.getElementById('b-spaceUrl');
  const bApiKey        = document.getElementById('b-apiKey');
  const bProjectKey    = document.getElementById('b-projectKey');
  const bLoadDocs      = document.getElementById('b-loadDocs');
  const bFolderSection = document.getElementById('b-folderSection');
  const bFolderSelect  = document.getElementById('b-folderSelect');
  const bDocCount      = document.getElementById('b-docCount');
  const bSearchText    = document.getElementById('b-searchText');
  const bReplaceText   = document.getElementById('b-replaceText');
  const bCaseSensitive = document.getElementById('b-caseSensitive');
  const bDryRun        = document.getElementById('b-dryRun');
  const bExecute       = document.getElementById('b-execute');
  const bCancel        = document.getElementById('b-cancel');
  const bProgressSec   = document.getElementById('b-progressSection');
  const bProgressFill  = document.getElementById('b-progressFill');
  const bProgressLabel = document.getElementById('b-progressLabel');
  const bResultList    = document.getElementById('b-resultList');
  const bStatus        = document.getElementById('b-status');

  let treeData = [];          // 正規化済みツリー
  let dryRunResults = null;   // ドライラン結果

  function bShowStatus(msg, type) {
    bStatus.textContent = msg;
    bStatus.className = type;
  }

  // 設定をストレージから復元
  chrome.storage.local.get(['b_spaceUrl', 'b_apiKey', 'b_projectKey'], vals => {
    if (vals.b_spaceUrl)   bSpaceUrl.value   = vals.b_spaceUrl;
    if (vals.b_apiKey)     bApiKey.value     = vals.b_apiKey;
    if (vals.b_projectKey) bProjectKey.value = vals.b_projectKey;
  });

  // 設定を変更したらストレージに保存
  [bSpaceUrl, bApiKey, bProjectKey].forEach(el => {
    el.addEventListener('input', () => {
      chrome.storage.local.set({
        b_spaceUrl:   bSpaceUrl.value,
        b_apiKey:     bApiKey.value,
        b_projectKey: bProjectKey.value,
      });
    });
  });

  // ドキュメントを読み込む
  bLoadDocs.addEventListener('click', async () => {
    const spaceUrl   = bSpaceUrl.value.trim();
    const apiKey     = bApiKey.value.trim();
    const projectKey = bProjectKey.value.trim();
    if (!spaceUrl || !apiKey || !projectKey) {
      bShowStatus('スペースURL・APIキー・プロジェクトキーを入力してください', 'warning');
      return;
    }

    bLoadDocs.disabled = true;
    bLoadDocs.textContent = '読み込み中…';
    bShowStatus('', '');

    try {
      const res = await chrome.runtime.sendMessage({
        action: 'fetchDocumentTree',
        spaceUrl, apiKey, projectKey,
      });

      if (!res.success) throw new Error(res.error);

      treeData = normalizeTree(res.data);
      buildFolderSelect(treeData);
      bFolderSection.style.display = '';
      updateDocCount();
      bShowStatus('', '');
    } catch (e) {
      bShowStatus(`読み込みエラー: ${e.message}`, 'error');
    } finally {
      bLoadDocs.disabled = false;
      bLoadDocs.textContent = 'ドキュメントを読み込む';
    }
  });

  function buildFolderSelect(nodes) {
    const flat = flattenTree(nodes);
    bFolderSelect.innerHTML = '<option value="">すべてのドキュメント</option>';
    for (const node of flat) {
      // フォルダノード（子あり）のみ選択肢に追加
      if (node.children && node.children.length > 0) {
        const opt = document.createElement('option');
        opt.value = node.id;
        opt.textContent = node.path;
        bFolderSelect.appendChild(opt);
      }
    }
  }

  function getTargetDocuments() {
    const selectedId = bFolderSelect.value;
    if (!selectedId) return collectDocuments(treeData);
    const node = findNodeById(treeData, selectedId);
    return node ? collectDocuments([node]) : [];
  }

  function updateDocCount() {
    const docs = getTargetDocuments();
    bDocCount.textContent = `対象: ${docs.length} 件のドキュメント`;
    dryRunResults = null;
    bExecute.disabled = true;
    bResultList.style.display = 'none';
    bResultList.innerHTML = '';
  }

  bFolderSelect.addEventListener('change', updateDocCount);

  // ドライラン
  bDryRun.addEventListener('click', async () => {
    const searchText = bSearchText.value;
    if (!searchText) { bShowStatus('検索文字列を入力してください', 'warning'); return; }

    const docs = getTargetDocuments();
    if (docs.length === 0) { bShowStatus('対象ドキュメントがありません', 'warning'); return; }

    bDryRun.disabled = true;
    bExecute.disabled = true;
    bShowStatus(`${docs.length} 件を確認中…`, 'info');
    bResultList.style.display = 'none';

    try {
      const res = await chrome.runtime.sendMessage({
        action: 'runDryRun',
        spaceUrl:      bSpaceUrl.value.trim(),
        apiKey:        bApiKey.value.trim(),
        documents:     docs,
        searchText,
        caseSensitive: bCaseSensitive.checked,
      });

      if (!res.success) throw new Error(res.error);
      dryRunResults = res.result;

      const matched = dryRunResults.filter(r => r.count > 0);
      renderResultList(dryRunResults, false);
      bShowStatus(
        matched.length > 0
          ? `${matched.length} 件に一致あり（合計 ${dryRunResults.reduce((s,r)=>s+r.count,0)} 箇所）`
          : '一致するドキュメントはありません',
        matched.length > 0 ? 'info' : 'warning'
      );
      bExecute.disabled = matched.length === 0;
    } catch (e) {
      bShowStatus(`エラー: ${e.message}`, 'error');
    } finally {
      bDryRun.disabled = false;
    }
  });

  // 一括置換を実行
  bExecute.addEventListener('click', async () => {
    const searchText  = bSearchText.value;
    const replaceText = bReplaceText.value;
    if (!searchText) { bShowStatus('検索文字列を入力してください', 'warning'); return; }

    const docs = dryRunResults
      ? dryRunResults.filter(r => r.count > 0)
      : getTargetDocuments();

    if (docs.length === 0) { bShowStatus('対象ドキュメントがありません', 'warning'); return; }

    if (!confirm(`${docs.length} 件のドキュメントを一括置換します。よろしいですか？`)) return;

    bDryRun.disabled  = true;
    bExecute.disabled = true;
    bCancel.style.display = '';
    bProgressSec.style.display = '';
    setProgress(0, docs.length, '準備中…');
    bResultList.style.display = 'none';
    bResultList.innerHTML = '';
    bShowStatus('', '');

    chrome.runtime.sendMessage({
      action:        'startBulkReplace',
      spaceUrl:      bSpaceUrl.value.trim(),
      projectKey:    bProjectKey.value.trim(),
      documents:     docs,
      searchText,
      replaceText,
      caseSensitive: bCaseSensitive.checked,
    }).catch(() => { /* ignore */ });
  });

  // キャンセル
  bCancel.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'cancelBulkReplace' }).catch(() => {});
    bShowStatus('キャンセル中…', 'warning');
  });

  // バックグラウンドからの進捗受信
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action !== 'bulkStateUpdate') return;
    const s = message.state;

    if (s.status === 'running') {
      setProgress(s.current, s.total, s.currentDoc ? `処理中: ${s.currentDoc}` : '準備中…');
    } else if (s.status === 'completed') {
      setProgress(s.total, s.total, '完了');
      const ok    = s.results.filter(r => r.success && r.count > 0).length;
      const skip  = s.results.filter(r => r.success && r.count === 0).length;
      const err   = s.results.filter(r => !r.success).length;
      bShowStatus(`完了: ${ok} 件置換 / ${skip} 件スキップ / ${err} 件エラー`, 'success');
      renderResultList(s.results, true);
      bDryRun.disabled  = false;
      bExecute.disabled = false;
      bCancel.style.display = 'none';
    } else if (s.status === 'cancelled') {
      bShowStatus('キャンセルしました', 'warning');
      bDryRun.disabled  = false;
      bExecute.disabled = false;
      bCancel.style.display = 'none';
    }
  });

  // ポップアップ再表示時に進行中の状態を復元
  chrome.storage.local.get('bulkReplaceState', vals => {
    const s = vals.bulkReplaceState;
    if (!s || s.status === 'completed' || s.status === 'cancelled') return;
    if (s.status === 'running') {
      bProgressSec.style.display = '';
      setProgress(s.current, s.total, s.currentDoc ? `処理中: ${s.currentDoc}` : '');
      bCancel.style.display = '';
    }
  });

  function setProgress(current, total, label) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    bProgressFill.style.width = `${pct}%`;
    bProgressLabel.textContent = `${current} / ${total}  ${label}`;
  }

  function renderResultList(results, isExecResult) {
    bResultList.innerHTML = '';
    for (const r of results) {
      const item = document.createElement('div');
      item.className = 'result-item';

      const name = document.createElement('span');
      name.className = 'doc-name';
      name.title = r.name;
      name.textContent = r.name;

      const badge = document.createElement('span');
      badge.className = 'badge';
      if (r.error) {
        badge.className += ' badge-err';
        badge.textContent = 'エラー';
      } else if (r.count === 0) {
        badge.className += ' badge-zero';
        badge.textContent = isExecResult ? 'スキップ' : '一致なし';
      } else {
        badge.className += ' badge-ok';
        badge.textContent = isExecResult ? `${r.count}箇所` : `${r.count}件`;
      }

      item.appendChild(name);
      item.appendChild(badge);
      bResultList.appendChild(item);
    }
    bResultList.style.display = results.length > 0 ? '' : 'none';
  }
});
