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
      const editBtn = findButtonByText('編集');
      // デバッグ用: DOM上のボタンっぽい要素のラベルを最大20件収集
      const buttonLabels = [];
      const labelElems = document.querySelectorAll('button, [role="button"], a[href]');
      for (let i = 0; i < labelElems.length && buttonLabels.length < 20; i++) {
        const el = labelElems[i];
        const label = el.getAttribute('aria-label')?.trim()
          || el.querySelector('._assistive-text')?.textContent?.trim()
          || el.getAttribute('title')?.trim()
          || (el.textContent?.trim()?.slice(0, 20));
        if (label) buttonLabels.push(label);
      }
      sendResponse({
        // エディタが居る、または編集ボタンが居れば autoReplace に進める
        ready: !!editor || !!editBtn,
        editable: isEditorEditable(),
        editorPresent: !!editor,
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        hasEditButton: !!editBtn,
        proseMirrorCount: document.querySelectorAll('.ProseMirror').length,
        tiptapCount: document.querySelectorAll('.tiptap').length,
        contenteditableCount: document.querySelectorAll('[contenteditable="true"]').length,
        bodyTextPreview: document.body?.innerText?.trim()?.slice(0, 200),
        buttonLabels,
      });
    } else if (request.action === "autoReplace") {
      autoReplace(request.searchText, request.replaceText, request.caseSensitive)
        .then(sendResponse);
      return true;
    } else if (request.action === "navigateAndAutoReplace") {
      navigateAndAutoReplace(
        request.documentId,
        request.searchText,
        request.replaceText,
        request.caseSensitive
      ).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
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
   * テキスト/aria-label/title でボタン要素を検索（複数パターン対応）
   */
  function findButtonByText(text) {
    const targets = document.querySelectorAll('button, [role="button"], a');
    for (const el of targets) {
      // _assistive-text パターン
      const span = el.querySelector?.('._assistive-text');
      if (span && span.textContent.trim() === text) return el;
      // aria-label パターン
      if (el.getAttribute?.('aria-label')?.trim() === text) return el;
      // title 属性パターン
      if (el.getAttribute?.('title')?.trim() === text) return el;
      // 短い textContent（アイコンボタンが含まれる場合があるので 20 文字までに制限）
      const txt = el.textContent?.trim() ?? '';
      if (txt && txt.length <= 20 && txt === text) return el;
    }
    return null;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
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
   * Tiptapエディタ要素を取得（複数のセレクタにフォールバック）
   */
  function getEditorElement() {
    return document.querySelector(".tiptap.ProseMirror") ||
           document.querySelector(".ProseMirror") ||
           document.querySelector("[contenteditable='true']");
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
   * サイドバーリンクから対象ドキュメントを見つける
   * href の末尾IDまたは data-node-id で判定
   */
  function findSidebarLink(documentId) {
    // href ベース: <a class="tree-item-link" href="/document/{key}/{id}">
    let link = document.querySelector(`a.tree-item-link[href$="/${documentId}"]`);
    if (link) return link;
    // data-node-id ベース: <button data-node-id="{id}"> → 親 <a>
    const btn = document.querySelector(`button[data-node-id="${documentId}"]`);
    if (btn) {
      const parent = btn.closest('a.tree-item-link');
      if (parent) return parent;
    }
    return null;
  }

  /**
   * サイドバーの折りたたまれているフォルダをすべて展開する
   * 折りたたまれていると子ドキュメントの <a> がDOMに無い場合があるため
   */
  async function expandAllSidebarFolders() {
    for (let i = 0; i < 10; i++) {
      const closed = document.querySelectorAll('button.tree-icon-button[data-is-open="false"]');
      if (closed.length === 0) return;
      for (const btn of closed) {
        try { btn.click(); } catch (_) {}
      }
      await sleep(300);
    }
  }

  /**
   * 一括置換モード用（SPA navigation 方式）:
   * サイドバーから指定IDのドキュメントリンクを探してクリック → 編集→置換→保存
   */
  async function navigateAndAutoReplace(documentId, searchText, replaceText, caseSensitive) {
    // 既にそのドキュメントを表示中なら遷移をスキップ
    const alreadyOnDoc = location.pathname.endsWith(`/${documentId}`);

    if (!alreadyOnDoc) {
      // ユーザーが編集中だと遷移確認ダイアログが出るので回避
      if (isEditorEditable()) {
        return { success: false, error: 'user_currently_editing' };
      }

      // 1回だけサイドバーを展開する（高コストなので毎回はしない）
      let link = findSidebarLink(documentId);
      if (!link) {
        await expandAllSidebarFolders();
        link = findSidebarLink(documentId);
      }
      if (!link) {
        return { success: false, error: 'sidebar_link_not_found' };
      }

      link.click();

      // SPA遷移完了を待つ: URLが切り替わって、コンテンツ付きエディタor編集ボタンが出るまで
      try {
        await waitForCondition(() => {
          if (!location.pathname.endsWith(`/${documentId}`)) return false;
          // 編集ボタンがあれば表示モードでコンテンツ描画済みとみなす
          if (findButtonByText('編集')) return true;
          // エディタが既にある場合は、テキストが入っている事を確認
          const editor = getEditorElement();
          return !!editor && (editor.textContent || '').trim().length > 0;
        }, 15000);
      } catch {
        return { success: false, error: 'navigation_timeout' };
      }

      // SPAの安定化（タイトル/DOM更新待ち）
      await sleep(500);
    }

    return await autoReplace(searchText, replaceText, caseSensitive);
  }

  /**
   * 一括置換モード用: 編集モード突入 → 全置換 → 保存
   * 表示モードではTiptap DOMが描画されないので、先に編集ボタンをクリックする
   */
  async function autoReplace(searchText, replaceText, caseSensitive) {
    // 既に編集モードならスキップ。そうでなければ編集ボタンを探してクリック
    if (!isEditorEditable()) {
      let editBtn = null;
      try {
        await waitForCondition(() => {
          editBtn = findButtonByText('編集');
          return !!editBtn;
        }, 10000);
      } catch {
        return { success: false, error: 'edit_button_not_found' };
      }
      editBtn.click();
      try {
        await waitForCondition(() => isEditorEditable(), 10000);
      } catch {
        return { success: false, error: 'editor_not_editable_after_click' };
      }
    }

    // 念のためエディタDOMがある事も確認
    if (!getEditorElement()) {
      try {
        await waitForCondition(() => !!getEditorElement(), 5000);
      } catch {
        return { success: false, error: 'editor_element_not_found' };
      }
    }

    // 編集モードに切り替わった直後はProseMirrorのコンテンツ反映が遅延する事があるため、
    // テキストが描画されるまで待機（コンテンツが入ったら安定化待ちも入れる）
    try {
      await waitForCondition(() => {
        const editor = getEditorElement();
        if (!editor) return false;
        return (editor.textContent || '').trim().length > 0;
      }, 10000);
    } catch {
      return { success: false, error: 'editor_content_not_loaded' };
    }
    await sleep(400);

    const result = replaceAllText(searchText, replaceText, caseSensitive);
    if (!result.success) return result;

    if (result.count > 0) {
      // 置換あり: 「編集を終了」をクリックして保存。失敗を error として返す
      const saveBtn = findButtonByText('編集を終了');
      if (!saveBtn) return { success: false, count: result.count, error: 'save_button_not_found' };
      saveBtn.click();
      try {
        await waitForCondition(() => !isEditorEditable(), 10000);
      } catch {
        return { success: false, count: result.count, error: 'save_did_not_complete' };
      }
    } else {
      // 置換0件: 変更がないので「キャンセル」優先で編集モードを抜ける
      const cancelBtn = findButtonByText('キャンセル') || findButtonByText('破棄');
      if (cancelBtn) {
        cancelBtn.click();
      } else {
        // フォールバック: 「編集を終了」（Backlog側で「変更なし」と判断されるはず）
        const saveBtn = findButtonByText('編集を終了');
        if (saveBtn) saveBtn.click();
      }
      // タブを閉じる前提なので検証は緩く
      await waitForCondition(() => !isEditorEditable(), 3000).catch(() => {});
    }

    return result;
  }

  /**
   * ブロック内の連続するテキストノードをまたいで検索する
   * 例: <p>Foo<strong>Bar</strong>Baz</p> で「FooBarBaz」を検索可能にする
   */
  function findTextAcrossNodes(searchText, caseSensitive) {
    const editor = getEditorElement();
    if (!editor || !searchText) return [];

    // ブロック要素ごとにテキストノードをグループ化
    const blockSelector = 'p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, pre, dt, dd';
    const allTextNodes = getTextNodes(editor);
    const groupMap = new Map();
    const groupOrder = [];
    for (const node of allTextNodes) {
      const block = node.parentElement?.closest(blockSelector) || editor;
      if (!groupMap.has(block)) {
        groupMap.set(block, []);
        groupOrder.push(block);
      }
      groupMap.get(block).push(node);
    }

    const needle = caseSensitive ? searchText : searchText.toLowerCase();
    const matches = [];

    for (const block of groupOrder) {
      const nodes = groupMap.get(block);
      let combined = '';
      const boundaries = [];
      for (const node of nodes) {
        const start = combined.length;
        combined += node.textContent;
        boundaries.push({ node, start, end: combined.length });
      }
      const haystack = caseSensitive ? combined : combined.toLowerCase();
      let pos = 0;
      while ((pos = haystack.indexOf(needle, pos)) !== -1) {
        const endPos = pos + needle.length;
        const startB = boundaries.find(b => b.start <= pos && pos < b.end);
        const endB = boundaries.find(b => b.start < endPos && endPos <= b.end);
        if (startB && endB) {
          matches.push({
            startNode: startB.node,
            startOffset: pos - startB.start,
            endNode: endB.node,
            endOffset: endPos - endB.start,
          });
        }
        pos = endPos;
      }
    }
    return matches;
  }

  /**
   * Range を選択して execCommand("insertText") で置換
   */
  function selectAndReplaceRange(match, replaceText) {
    const range = document.createRange();
    range.setStart(match.startNode, match.startOffset);
    range.setEnd(match.endNode, match.endOffset);

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    document.execCommand("insertText", false, replaceText);
  }

  /**
   * 全てのマッチを置換（後ろから順に処理してインデックスのずれを防ぐ）
   * ノードまたぎの検索に対応
   */
  function replaceAllText(searchText, replaceText, caseSensitive) {
    const editor = getEditorElement();
    if (!editor || !searchText) return { success: false, count: 0, error: 'editor_not_found' };
    if (!isEditorEditable())
      return { success: false, count: 0, error: "not_editable" };

    const matches = findTextAcrossNodes(searchText, caseSensitive);
    // マッチ0件は「成功した上でスキップ」扱い（エラーではない）
    if (matches.length === 0) return { success: true, count: 0 };

    // 後ろのマッチから処理する（DOMの位置的に後ろから）
    const reversedMatches = [...matches].reverse();
    let totalReplaced = 0;
    for (const match of reversedMatches) {
      try {
        selectAndReplaceRange(match, replaceText);
        totalReplaced++;
      } catch (e) {
        /* 個別失敗はスキップ */
      }
    }

    return { success: true, count: totalReplaced };
  }
})();
