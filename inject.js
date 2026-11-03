/**
 * レポート画面と拡張機能のあいだの橋渡し。
 *
 * ページからは chrome.tabs / chrome.tabGroups を呼べない（拡張機能専用）。
 * そこで ページ → postMessage → ここ → background という経路で、
 * タブを開いてまとめる役を拡張機能に渡す。
 *
 * このファイルは3通りで読み込まれる。
 *   1) マニフェストの content_scripts（枠が読み込まれた時点）
 *   2) background からの再差し込み（中身が書き込まれた後）
 *   3) 拡張機能を読み込み直したとき（開きっぱなしのページへ入れ直す）
 * 2 が要るのは、レポートの中身を親ページが後から document.write で流し込むため。
 * 書き込みで文書が作り直されると、1 で用意した印もタイマーも道連れに消える。
 *
 * 3 が要るのは、拡張機能を読み込み直すと、先に入っていたぶんが「孤児」になり
 * chrome.runtime が undefined になるため。古い受け口が残っていると、押したときに
 * そこが掴んでしまい「Cannot read properties of undefined (reading 'sendMessage')」
 * で止まる。受け口は毎回作り直し、古いものは必ず外す。
 */
(() => {
  const SOURCE = 'gtasks-priority';
  const MAX_TABS = 12;        // 押し間違いで大量に開かないための上限
  // 閉じる・片付けで受け取るグループ名の長さの上限。20 にしていた頃は、それより長い名前の
  // グループ（自分で付けた名前など）が一致せず、「タブ片付け」で閉じられなかった
  const NAME_MAX = 100;
  // 開くときのグループ名の長さ。レポート側の GROUP_NAME_MAX と対（レポートは必ずこの長さ以内で送る）
  const GROUP_TITLE_MAX = 20;
  const MARK = 'data-gtasks-ext';
  // 名乗りに付ける版と「出来ること」。レポートはこれが無ければ古い版とみなす（1.7.0〜）
  //   acct: アカウントの印で見分ける / recent: 開いて2分は自動で閉じない / list: グループの一覧を返す
  const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (e) { return ''; } })();
  const CAPS = ['acct', 'recent', 'list'];
  const ACCT_MAX = 64;
  const acctOf = d => String((d && d.acct) || '').slice(0, ACCT_MAX);

  // レポートの枠以外（画像などの googleusercontent）では何もしない
  if (location.pathname.indexOf('/userCodeAppPanel') !== 0) return;

  /** この差し込みがまだ生きているか（拡張機能を入れ直すと false になる） */
  function alive() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  /** 印を付け、ついでに名乗る。ページはどちらで気づいてもよい */
  function announce() {
    if (!alive()) { unmark(); return; }
    try {
      if (document.documentElement.getAttribute(MARK) !== '1') {
        document.documentElement.setAttribute(MARK, '1');
      }
    } catch (e) { /* 書き換えの途中なら次の回で付く */ }
    try {
      window.postMessage({ source: SOURCE, type: 'ext-ready', ver: VERSION, caps: CAPS }, '*');
    } catch (e) { /* 無視 */ }
  }

  /** もう繋がっていないので、ページには「拡張は居ない」と見せる */
  function unmark() {
    try { document.documentElement.removeAttribute(MARK); } catch (e) { /* 無視 */ }
  }

  // 印を付け直すのは毎回行う（文書が作り直されていれば、ここで付き直る）
  announce();
  [300, 800, 1500, 3000, 6000, 10000].forEach(ms => setTimeout(announce, ms));

  // 中身が入れ替わって印が消えたら付け直す
  try {
    const mo = new MutationObserver(() => {
      if (document.documentElement.getAttribute(MARK) !== '1') announce();
    });
    mo.observe(document.documentElement, { attributes: true, childList: true });
    setTimeout(() => mo.disconnect(), 60000);
  } catch (e) { /* 監視できなくてもタイマーの方で付く */ }

  /**
   * 開いてよい行き先か。
   * http(s) のほか chrome:（設定画面など）も通す。chrome: はページからは開けず、
   * 拡張機能の tabs.create でしか開けないため、ここを通す意味がある。
   * javascript: や file: などは弾く。
   */
  function isWebUrl(u) {
    try {
      const x = new URL(u);
      return x.protocol === 'https:' || x.protocol === 'http:' || x.protocol === 'chrome:';
    } catch (e) {
      return false;
    }
  }

  /** 切れていることをページに伝える。黙って何も起きないより分かりやすい */
  function replyDead(type, id) {
    unmark();
    window.postMessage({
      source: SOURCE, type: type, id: id, ok: false, titles: [],
      error: '拡張機能を読み込み直したため、この画面とは繋がっていません。ページを開き直してください'
    }, '*');
  }

  function onMessage(ev) {
    // 自分のフレームから来たものだけ受ける
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== SOURCE) return;
    if (d.type === 'ext-ping') { announce(); return; }
    if (d.type !== 'close-group' && d.type !== 'open-group' && d.type !== 'close-groups' &&
        d.type !== 'sync-groups' && d.type !== 'list-groups') return;

    const done = d.type + '-done';

    // 拡張機能を入れ直した後の「孤児」は chrome.runtime を持たない。
    // ここで止めないと sendMessage で例外になり、画面には何も返らない
    if (!alive()) { replyDead(done, d.id); return; }

    if (d.type === 'list-groups') {
      chrome.runtime.sendMessage({ type: 'list-groups', acct: acctOf(d) }, res => {
        const err = chrome.runtime.lastError;
        window.postMessage({
          source: SOURCE, type: 'list-groups-done', id: d.id,
          ok: !err && res && res.ok, groups: (res && res.groups) || [],
          error: err ? err.message : (res && res.error) || ''
        }, '*');
      });
      return;
    }

    if (d.type === 'sync-groups') {
      const list = v => (Array.isArray(v) ? v : []).map(x => String(x || '').slice(0, NAME_MAX)).slice(0, 500);
      chrome.runtime.sendMessage({
        type: 'sync-groups', keep: list(d.keep), known: list(d.known),
        acct: acctOf(d), auto: d.auto !== false
      }, res => {
        const err = chrome.runtime.lastError;
        window.postMessage({
          source: SOURCE, type: 'close-groups-done', id: d.id,
          ok: !err && res && res.ok, closed: (res && res.closed) || 0,
          groups: (res && res.groups) || [],
          error: err ? err.message : (res && res.error) || ''
        }, '*');
      });
      return;
    }

    if (d.type === 'close-groups') {
      const titles = (Array.isArray(d.titles) ? d.titles : [])
        .map(x => String(x || '').slice(0, NAME_MAX)).slice(0, 200);
      chrome.runtime.sendMessage({
        type: 'close-groups', titles: titles,
        acct: acctOf(d), auto: d.auto !== false, others: d.others === true
      }, res => {
        const err = chrome.runtime.lastError;
        window.postMessage({
          source: SOURCE, type: 'close-groups-done', id: d.id,
          ok: !err && res && res.ok, closed: (res && res.closed) || 0,
          groups: (res && res.groups) || [],
          error: err ? err.message : (res && res.error) || ''
        }, '*');
      });
      return;
    }

    if (d.type === 'close-group') {
      chrome.runtime.sendMessage({
        type: 'close-group', title: String(d.title || '').slice(0, NAME_MAX), acct: acctOf(d)
      }, res => {
        const err = chrome.runtime.lastError;
        window.postMessage({
          source: SOURCE, type: 'close-group-done', id: d.id,
          ok: !err && res && res.ok, closed: res && res.closed,
          titles: (res && res.titles) || [],
          error: err ? err.message : (res && res.error) || ''
        }, '*');
      });
      return;
    }

    const urls = (Array.isArray(d.urls) ? d.urls : []).filter(isWebUrl).slice(0, MAX_TABS);
    if (!urls.length) return;

    chrome.runtime.sendMessage({
      type: 'open-group',
      title: String(d.title || '').slice(0, GROUP_TITLE_MAX),
      color: String(d.color || 'blue'),
      urls: urls,
      acct: acctOf(d),
      taskId: String(d.taskId || '').slice(0, 200)
    }, res => {
      const err = chrome.runtime.lastError;
      window.postMessage({
        source: SOURCE, type: 'open-group-done', id: d.id,
        ok: !err && res && res.ok, opened: res && res.opened,
        error: err ? err.message : (res && res.error) || ''
      }, '*');
    });
  }

  /*
   * 受け口は毎回作り直す。
   * 「1回だけ登録」にしていると、拡張機能を入れ直した後に古い受け口が残り、
   * 新しく差し込んだぶんが登録されないまま、死んだ側が掴み続けてしまう。
   * 同じ隔離された世界なので、前回の関数はここから外せる。
   */
  if (window.__gtasksTabGroupListener) {
    try { window.removeEventListener('message', window.__gtasksTabGroupListener); } catch (e) { /* 無視 */ }
  }
  window.__gtasksTabGroupListener = onMessage;
  window.addEventListener('message', onMessage);

  console.log('[タブまとめ] 用意できました', location.pathname);
})();
