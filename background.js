/**
 * タブを開いて、ひとつのタブグループにまとめる。
 * タブグループを触れるのは拡張機能だけなので、この役はここにしか置けない。
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  const job = msg.type === 'open-group' ? openGroup(msg, sender)
            : msg.type === 'close-group' ? closeGroup(msg, sender)
            : msg.type === 'close-groups' ? closeGroups(msg)
            : msg.type === 'sync-groups' ? syncGroups(msg)
            : null;
  if (!job) return;
  job.then(r => sendResponse(r))
     .catch(e => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
  return true;   // 非同期で返すので true
});

async function openGroup(msg, sender) {
  const windowId = sender.tab ? sender.tab.windowId : undefined;
  const title = msg.title || 'タスク';

  // まず全部を裏で開く。1枚ずつ前面に出すと、開いている間ちらつくため
  const tabIds = [];
  for (const url of msg.urls) {
    const t = await chrome.tabs.create(
      windowId ? { url, active: false, windowId } : { url, active: false });
    tabIds.push(t.id);
  }

  // 同じ名前のグループが既にあれば、そこに足す（押すたびに増えないように）
  let groupId;
  const found = await chrome.tabGroups.query(
    windowId ? { windowId, title } : { title });
  if (found && found.length) {
    groupId = await chrome.tabs.group({ groupId: found[0].id, tabIds });
  } else {
    groupId = await chrome.tabs.group(
      windowId ? { tabIds, createProperties: { windowId } } : { tabIds });
  }

  await chrome.tabGroups.update(groupId, { title, color: msg.color || 'blue' });
  await rememberTitle(title);   // この拡張が作ったグループとして覚える（放置の片付けに使う）

  // まとめ終わってから、最初に開いたタブを前面に出す。
  // グループ化でタブが動くことがあるので、並べ替えが済んだ後に切り替える
  try {
    await chrome.tabs.update(tabIds[0], { active: true });
    if (windowId) await chrome.windows.update(windowId, { focused: true });
  } catch (e) {
    // 閉じられていた等。開くこと自体は済んでいるので、ここで失敗扱いにはしない
    console.debug('[タブまとめ] 前面に出せませんでした:', e && e.message);
  }

  return { ok: true, opened: tabIds.length };
}

/**
 * 名前の合うタブグループを閉じる。タスクを完了したときに呼ばれる。
 * タブグループ自体を消す命令は無いので、中のタブを閉じる（空になるとグループも消える）。
 * 無ければ何もしない（閉じた枚数 0 を返す）。
 */
async function closeGroup(msg, sender) {
  const title = String(msg.title || '');
  if (!title) return { ok: true, closed: 0, titles: [] };

  // 名前で検索する query は当てにしない（パターン扱いのため、記号入りの名前で外れる）。
  // 全部のグループを取って、こちらで突き合わせる。
  // 窓は絞らない。押した窓と、タブを開いた窓が違っていることがあるため
  const all = await chrome.tabGroups.query({});
  const titles = all.map(g => g.title || '');
  const norm = x => String(x || '').trim().toLowerCase();
  const hit = all.filter(g => norm(g.title) === norm(title));

  if (!hit.length) {
    // どれと一致しなかったのかが分かるよう、いまあるグループ名を返す
    return { ok: true, closed: 0, titles: titles };
  }

  let closed = 0;
  for (const g of hit) closed += await removeGroup(g.id);
  return { ok: true, closed: closed, titles: titles };
}

/**
 * グループを跡形なく消す。
 * タブをいきなり閉じると、Chrome は「グループを閉じた」とみなして
 * 保存済みのタブグループ（ブックマークバー等）に残してしまう。
 * 先にグループから外してから閉じれば、グループそのものが消える。
 */
async function removeGroup(groupId) {
  const tabs = await chrome.tabs.query({ groupId: groupId });
  const ids = tabs.map(t => t.id).filter(id => typeof id === 'number');
  if (!ids.length) return 0;
  try {
    await chrome.tabs.ungroup(ids);
  } catch (e) {
    // 外せなくても閉じることはできる（保存済みに残る可能性はある）
    console.debug('[タブまとめ] グループから外せませんでした:', e && e.message);
  }
  await chrome.tabs.remove(ids);
  return ids.length;
}

/**
 * 終わったタスクのグループをまとめて片付ける。レポートが開いた時と更新のたびに呼ぶ。
 * Google Tasks のアプリやスマホで完了にした場合は、レポートの「完了」ボタンを
 * 通らないので、こちらで後から気づいて閉じる。
 * 渡されるのは「完了済みで、未完のタスクとは名前が重ならない」グループ名だけ。
 */
/* ------------------------------------------------- 放置グループの片付け
   この拡張が作ったグループの名前を覚えておき、レポートから「いま残しておくべき名前」
   （対応中・あとで対応のタスク）を受け取ったら、それ以外を閉じる。
   完了した・消えた・先送りした・名前を変えた・Chrome を再起動して残った、などで
   取り残されたグループが対象。自分で作ったグループ（覚えていない名前）には触らない。
   覚える前に作られたグループは、レポートが送ってくる「タスクの名前の一覧」と
   一致するものだけを、この拡張が作ったものとみなす。 */
const MADE_KEY = 'madeTitles';
const norm = x => String(x || '').trim().toLowerCase();

async function loadMade() {
  try {
    const o = await chrome.storage.local.get(MADE_KEY);
    return new Set(Array.isArray(o[MADE_KEY]) ? o[MADE_KEY] : []);
  } catch (e) {
    return new Set();
  }
}
async function saveMade(set) {
  try { await chrome.storage.local.set({ [MADE_KEY]: [...set].slice(-300) }); } catch (e) { /* 覚えられなくても動作は止めない */ }
}
async function rememberTitle(title) {
  const made = await loadMade();
  made.add(norm(title));
  await saveMade(made);
}

async function syncGroups(msg) {
  const keep = new Set((Array.isArray(msg.keep) ? msg.keep : []).map(norm).filter(Boolean));
  const known = new Set((Array.isArray(msg.known) ? msg.known : []).map(norm).filter(Boolean));
  const made = await loadMade();
  const all = await chrome.tabGroups.query({});
  let closed = 0;
  const groups = [];
  for (const g of all) {
    const name = norm(g.title);
    if (!name || keep.has(name)) continue;
    if (!made.has(name) && !known.has(name)) continue;   // 自分で作ったグループには触らない
    const n = await removeGroup(g.id);
    if (n) { closed += n; groups.push(g.title || ''); }
  }
  // もう存在しない名前は忘れる（覚える量が増え続けないように）
  const alive = new Set((await chrome.tabGroups.query({})).map(g => norm(g.title)));
  [...made].forEach(n => { if (!alive.has(n) && !keep.has(n)) made.delete(n); });
  await saveMade(made);
  return { ok: true, closed: closed, groups: groups };
}

async function closeGroups(msg) {
  const want = new Set((Array.isArray(msg.titles) ? msg.titles : [])
    .map(x => String(x || '').trim().toLowerCase()).filter(Boolean));
  if (!want.size) return { ok: true, closed: 0, groups: [] };
  const all = await chrome.tabGroups.query({});
  let closed = 0;
  const groups = [];
  for (const g of all) {
    const name = String(g.title || '').trim().toLowerCase();
    if (!want.has(name)) continue;
    const n = await removeGroup(g.id);
    if (n) { closed += n; groups.push(g.title || ''); }
  }
  return { ok: true, closed: closed, groups: groups };
}

/* ------------------------------------------------- 中身が書かれた後の差し込み
   レポートの中身は、親ページが後から document.write でレポートの枠に流し込む。
   その書き込みで文書が作り直されるため、最初に差し込んだぶんは道連れに消えてしまう
   （コンソールには出ているのに、ページから拡張が見えないのはこれが理由）。
   そこで、ページが落ち着いた頃に何度か差し込み直す。
   inject.js は「1回だけ効く」作りなので、何度呼んでも二重にはならない。 */

const REPORT_HOST = 'script.google.com';
const RETRY_MS = [0, 1200, 3000, 6000, 10000];

/* Google Workspace のアカウントで公開したレポートは
   https://script.google.com/a/macros/<ドメイン>/s/.../exec になる。
   /macros/ だけで決め打ちすると、差し込み直しが一度も走らない */
const REPORT_PATTERNS = [
  'https://' + REPORT_HOST + '/macros/*',
  'https://' + REPORT_HOST + '/a/macros/*'
];

function isReportUrl(u) {
  return /^https:\/\/script\.google\.com\/(a\/)?macros\//.test(u);
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (!tab || !tab.url) return;
  if (!isReportUrl(tab.url)) return;
  RETRY_MS.forEach(ms => setTimeout(() => injectAll(tabId), ms));
});

function injectAll(tabId) {
  chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['inject.js']
  }).catch(e => {
    // 枠がまだ無い・閉じられた等。次の回で入るので黙って流す
    console.debug('[タブまとめ] 差し込み見送り:', e && e.message);
  });
}

/* 拡張機能を読み込み直した直後は、開きっぱなしのレポートに古いぶんが残っている。
   古い側は chrome.runtime を失っていて、押しても sendMessage で止まる。
   起動時にいま開いているレポートへ入れ直し、受け口を新しいものに替える。 */
chrome.runtime.onInstalled.addListener(() => injectOpenReports());
chrome.runtime.onStartup.addListener(() => injectOpenReports());
injectOpenReports();   // サービスワーカーが起きたときにも一度

function injectOpenReports() {
  chrome.tabs.query({ url: REPORT_PATTERNS }, tabs => {
    if (chrome.runtime.lastError || !tabs) return;
    tabs.forEach(t => injectAll(t.id));
  });
}
