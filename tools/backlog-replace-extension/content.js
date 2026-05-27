// Backlog Document Find & Replace - Content Script
// Tiptap (ProseMirror) エディタ上でテキスト置換を行う

(function () {
  "use strict";

  // --- ハイライト用スタイル (CSS Custom Highlight API) ---
  const style = document.createElement("style");
  style.textContent = `
    ::highlight(blg-fr-all) {
      background-color: #fff176;
      color: #333;
    }
    ::highlight(blg-fr-active) {
      background-color: #ff9800;
      color: #fff;
    }
  `;
  document.head.appendChild(style);

  // 現在のマッチ情報（ハイライト用）
  let lastMatches = [];
  let activeIndex = 0;

  // ポップアップの入力値を保持（ページリロードまで有効）
  let lastSearchText = "";
  let lastReplaceText = "";
  let lastCaseSensitive = false;

  // ポップアップが閉じられた時にハイライトをクリア
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "blg-fr-popup") {
      port.onDisconnect.addListener(() => {
        lastMatches = [];
        activeIndex = 0;
        clearHighlights();
      });
    }
  });

  // ポップアップからのメッセージを受信
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getState") {
      sendResponse({ searchText: lastSearchText, replaceText: lastReplaceText, caseSensitive: lastCaseSensitive });
    } else if (request.action === "find") {
      lastSearchText = request.searchText;
      lastCaseSensitive = request.caseSensitive;
      const results = findText(request.searchText, request.caseSensitive);
      lastMatches = results;
      activeIndex = 0;
      applyHighlights();
      sendResponse({ count: results.length, activeIndex: results.length > 0 ? 0 : -1 });
    } else if (request.action === "findNext") {
      if (lastMatches.length > 0) {
        activeIndex = (activeIndex + 1) % lastMatches.length;
        applyHighlights();
      }
      sendResponse({ count: lastMatches.length, activeIndex });
    } else if (request.action === "findPrev") {
      if (lastMatches.length > 0) {
        activeIndex = (activeIndex - 1 + lastMatches.length) % lastMatches.length;
        applyHighlights();
      }
      sendResponse({ count: lastMatches.length, activeIndex });
    } else if (request.action === "replace") {
      lastSearchText = request.searchText;
      lastReplaceText = request.replaceText;
      lastCaseSensitive = request.caseSensitive;
      const result = replaceText(
        request.searchText,
        request.replaceText,
        request.caseSensitive
      );
      // 置換後に再検索してハイライト更新
      lastMatches = findText(request.searchText, request.caseSensitive);
      if (activeIndex >= lastMatches.length) activeIndex = 0;
      applyHighlights();
      sendResponse(result);
    } else if (request.action === "replaceAll") {
      lastSearchText = request.searchText;
      lastReplaceText = request.replaceText;
      lastCaseSensitive = request.caseSensitive;
      const result = replaceAllText(
        request.searchText,
        request.replaceText,
        request.caseSensitive
      );
      lastMatches = [];
      activeIndex = 0;
      clearHighlights();
      sendResponse(result);
    } else if (request.action === "clearHighlights") {
      lastMatches = [];
      activeIndex = 0;
      clearHighlights();
      sendResponse({ success: true });
    } else if (request.action === "ping") {
      const editor = getEditorElement();
      sendResponse({ ready: !!editor, editable: isEditorEditable() });
    } else if (request.action === "autoReplace") {
      autoReplace(request.searchText, request.replaceText, request.caseSensitive)
        .then(sendResponse);
      return true;
    }
    return true; // 非同期レスポンスを許可
  });

  /**
   * CSS Custom Highlight API でハイライトを適用
   */
  function applyHighlights() {
    if (!CSS.highlights) return;

    const allRanges = [];
    for (let i = 0; i < lastMatches.length; i++) {
      if (i === activeIndex) continue;
      const m = lastMatches[i];
      try {
        const range = new Range();
        range.setStart(m.node, m.index);
        range.setEnd(m.node, m.index + m.length);
        allRanges.push(range);
      } catch (e) { /* ノードが無効な場合はスキップ */ }
    }
    CSS.highlights.set("blg-fr-all", new Highlight(...allRanges));

    // アクティブマッチ
    if (activeIndex >= 0 && activeIndex < lastMatches.length) {
      const m = lastMatches[activeIndex];
      try {
        const range = new Range();
        range.setStart(m.node, m.index);
        range.setEnd(m.node, m.index + m.length);
        CSS.highlights.set("blg-fr-active", new Highlight(range));
        // スクロール
        const el = m.node.parentElement;
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (e) {
        CSS.highlights.delete("blg-fr-active");
      }
    } else {
      CSS.highlights.delete("blg-fr-active");
    }
  }

  /**
   * ハイライトをクリア
   */
  function clearHighlights() {
    if (!CSS.highlights) return;
    CSS.highlights.delete("blg-fr-all");
    CSS.highlights.delete("blg-fr-active");
  }

  /**
   * _assistive-text のテキストでボタンを検索
   */
  function findButtonByText(text) {
    for (const btn of document.querySelectorAll('button')) {
      const span = btn.querySelector('._assistive-text');
      if (span && span.textContent.trim() === text) return btn;
    }
    return null;
  }

  /**
   * 条件が真になるまで待機（タイムアウト付き）
   */
  function waitForCondition(condition, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (condition()) { resolve(); return; }
      const start = Date.now();
      const timer = setInterval(() => {
        if (condition()) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error('timeout'));
        }
      }, 200);
    });
  }

  /**
   * Tiptapエディタ要素を取得
   */
  function getEditorElement() {
    return document.querySelector(".tiptap.ProseMirror");
  }

  /**
   * エディタが編集可能かチェック
   */
  function isEditorEditable() {
    const editor = getEditorElement();
    return editor && editor.getAttribute("contenteditable") === "true";
  }

  /**
   * エディタ内の全テキストノードを取得（テーブルセル内も含む）
   */
  function getTextNodes(root) {
    const textNodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        // 空白のみのノードはスキップ
        if (!node.textContent.trim()) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }
    return textNodes;
  }

  /**
   * テキスト検索
   */
  function findText(searchText, caseSensitive) {
    const editor = getEditorElement();
    if (!editor || !searchText) return [];

    const textNodes = getTextNodes(editor);
    const matches = [];

    for (const node of textNodes) {
      const text = caseSensitive
        ? node.textContent
        : node.textContent.toLowerCase();
      const search = caseSensitive ? searchText : searchText.toLowerCase();
      let startIndex = 0;

      while (true) {
        const index = text.indexOf(search, startIndex);
        if (index === -1) break;
        matches.push({ node, index, length: searchText.length });
        startIndex = index + 1;
      }
    }

    return matches;
  }

  /**
   * execCommand を使ってテキストを安全に置換する
   * ProseMirrorの内部状態と同期するため、Selection API + execCommand を使用
   */
  function selectAndReplace(node, index, length, replaceText) {
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + length);

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    // execCommand は ProseMirror の input handler を通るため安全
    document.execCommand("insertText", false, replaceText);
  }

  /**
   * 最初のマッチを置換
   */
  function replaceText(searchText, replaceText, caseSensitive) {
    const editor = getEditorElement();
    if (!editor || !searchText) return { success: false, remaining: 0 };
    if (!isEditorEditable())
      return { success: false, remaining: 0, error: "not_editable" };

    const matches = findText(searchText, caseSensitive);
    if (matches.length === 0) return { success: false, remaining: 0 };

    const match = matches[activeIndex];
    selectAndReplace(match.node, match.index, match.length, replaceText);

    // 置換後の残り件数を返す
    const remaining = findText(searchText, caseSensitive).length;
    return { success: true, remaining };
  }

  /**
   * 一括置換モード用: 編集モード突入 → 全置換 → 保存
   */
  async function autoReplace(searchText, replaceText, caseSensitive) {
    try {
      await waitForCondition(() => !!getEditorElement(), 8000);
    } catch {
      return { success: false, error: 'editor_not_found' };
    }

    if (!isEditorEditable()) {
      const editBtn = findButtonByText('編集');
      if (!editBtn) return { success: false, error: 'edit_button_not_found' };
      editBtn.click();
      try {
        await waitForCondition(() => isEditorEditable(), 5000);
      } catch {
        return { success: false, error: 'editor_not_editable' };
      }
    }

    const result = replaceAllText(searchText, replaceText, caseSensitive);

    const saveBtn = findButtonByText('編集を終了');
    if (saveBtn) saveBtn.click();
    await waitForCondition(() => !isEditorEditable(), 8000).catch(() => {});

    return result;
  }

  /**
   * 全てのマッチを置換（後ろから順に処理してインデックスのずれを防ぐ）
   */
  function replaceAllText(searchText, replaceText, caseSensitive) {
    const editor = getEditorElement();
    if (!editor || !searchText) return { success: false, count: 0 };
    if (!isEditorEditable())
      return { success: false, count: 0, error: "not_editable" };

    let totalReplaced = 0;

    // 各テキストノードに対して後ろから置換（同一ノード内のインデックスずれ対策）
    const matches = findText(searchText, caseSensitive);
    if (matches.length === 0) return { success: false, count: 0 };

    // 後ろのマッチから処理する（DOMの位置的に後ろから）
    const reversedMatches = [...matches].reverse();

    for (const match of reversedMatches) {
      selectAndReplace(match.node, match.index, match.length, replaceText);
      totalReplaced++;
    }

    return { success: true, count: totalReplaced };
  }
})();
