/**
 * タブを開いて、ひとつのタブグループにまとめる。
 * タブグループを触れるのは拡張機能だけなので、この役はここにしか置けない。
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  const fn = msg.type === 'open-group' ? openGroup
           : msg.type === 'close-group' ? closeGroup
           : msg.type === 'close-groups' ? closeGroups
           : msg.type === 'sync-groups' ? syncGroups
           : msg.type === 'list-groups' ? listGroups
           : msg.type === 'focus-group' ? focusGroup
           : null;
  if (!fn) return;
  const job = serial(() => fn(msg, sender));
  job.then(r => sendResponse(r))
     .catch(e => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
  return true;   // 非同期で返すので true
});

/** 依頼を1つずつ順に処理する。記録（chrome.storage）の読み直しと書き込みが重なると、後の書き込みが先の分を消すため */
let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

async function openGroup(msg, sender) {
  const windowId = sender.tab ? sender.tab.windowId : undefined;
  const title = msg.title || 'タスク';
  const acct = String(msg.acct || '');

  // 同じ名前のグループが既にあれば、そこに足す（押すたびに増えないように）。
  // ただし別のアカウントの画面が開いたグループには足さない（片方の完了で、もう片方のタブまで閉じないように）
  const recs = await loadRecs();
  const seen = await loadObj(SEEN_KEY);
  const now = Date.now();
  const found = await chrome.tabGroups.query(
    windowId ? { windowId, title } : { title });
  const join = (found || []).find(g => {
    const ra = recAcct(recs[g.id], seen, now);
    return !ra || ra === acct;
  });

  // 同じページが既に開いていれば、開き直さずにそのタブを使う（1.7.3〜）。
  //   どのグループにも入っていない同じ窓のタブ → このグループに入れる
  //   このグループに入っているタブ → そのまま
  //   ほかのグループ・ほかの窓のタブ → 動かさない（前面に出すだけ）
  const openTabs = await chrome.tabs.query({});
  const selfId = sender.tab ? sender.tab.id : -1;
  const used = new Set();
  const order = [];     // 開く順のタブ id（最初の1枚を前面に出す）
  const tabIds = [];    // このグループに入れるタブ
  let opened = 0, reused = 0;
  for (const url of msg.urls) {
    const key = urlKey(url);
    const hit = openTabs.find(t => t.id !== selfId && !used.has(t.id) && urlKey(t.url || t.pendingUrl) === key);
    if (hit) {
      used.add(hit.id);
      order.push(hit.id);
      reused++;
      const free = hit.groupId === -1 || hit.groupId === undefined;
      const sameWin = !windowId || hit.windowId === windowId;
      if (free && sameWin) tabIds.push(hit.id);
      continue;
    }
    // 裏で開く。1枚ずつ前面に出すと、開いている間ちらつくため
    const t = await chrome.tabs.create(
      windowId ? { url, active: false, windowId } : { url, active: false });
    order.push(t.id);
    tabIds.push(t.id);
    opened++;
  }

  let groupId = join ? join.id : null;
  if (tabIds.length) {
    groupId = join
      ? await chrome.tabs.group({ groupId: join.id, tabIds })
      : await chrome.tabs.group(windowId ? { tabIds, createProperties: { windowId } } : { tabIds });
  }
  if (groupId === null) {
    // 全部が既に開いていて、どれもほかのグループに入っていた。前面に出すだけ
    await bringToFront(order[0]);
    return { ok: true, opened: 0, reused: reused };
  }

  await chrome.tabGroups.update(groupId, { title, color: msg.color || 'blue', collapsed: false });
  await rememberTitle(title);   // この拡張が作ったグループとして覚える（放置の片付けに使う）
  // どのアカウントの・どのタスクの・いつ開いたグループかも覚える（1.7.0〜）
  const prev = recs[groupId];
  recs[groupId] = {
    n: norm(title), a: (prev && prev.a) || acct, t: String(msg.taskId || (prev && prev.t) || ''), at: now
  };
  await saveObj(REC_KEY, recs);
  if (acct) { seen[acct] = now; await saveObj(SEEN_KEY, seen); }

  // まとめ終わってから、最初のタブを前面に出す。
  // グループ化でタブが動くことがあるので、並べ替えが済んだ後に切り替える
  await bringToFront(order[0]);
  return { ok: true, opened: opened, reused: reused };
}

/** タブとその窓を前面に出す。閉じられていた等で失敗しても、開くこと自体は済んでいるので失敗扱いにしない */
async function bringToFront(tabId) {
  if (typeof tabId !== 'number') return;
  try {
    const t = await chrome.tabs.update(tabId, { active: true });
    if (t && t.windowId !== undefined) await chrome.windows.update(t.windowId, { focused: true });
  } catch (e) {
    console.debug('[タブまとめ] 前面に出せませんでした:', e && e.message);
  }
}

/**
 * 同じページかを比べるための形。末尾の「/」の有無だけは同じとみなす。
 * # 以降は残す（Gmail は # 以降でどのメールかが変わる）
 */
function urlKey(u) {
  if (!u) return '';
  try {
    const x = new URL(u);
    // 大文字小文字は区別する（パスや id は区別されるため）。ホスト名は URL が小文字にそろえる
    return x.origin + x.pathname.replace(/\/+$/, '') + x.search + x.hash;
  } catch (e) {
    return String(u);
  }
}

/**
 * 名前の合うタブグループを閉じる。タスクを完了したときに呼ばれる。
 * タブグループ自体を消す命令は無いので、中のタブを閉じる（空になるとグループも消える）。
 * 無ければ何もしない（閉じた枚数 0 を返す）。
 */
async function closeGroup(msg, sender) {
  const title = String(msg.title || '');
  if (!title) return { ok: true, closed: 0, titles: [] };
  await touchAcct(msg.acct);

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

  const ctx = await closeContext(msg, false);
  let closed = 0;
  for (const g of hit) {
    if (!mayClose(ctx.recs[g.id], ctx)) continue;
    closed += await removeGroup(g.id);
  }
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
/* ------------------------------------------------- どの画面が開いたグループか（1.7.0〜）
   仕事用と個人用のレポートを同じ Chrome で使うと、片方の画面の片付けが、もう片方で対応中の
   グループを「放置」とみなして閉じていた。そこで、グループごとに
   { n: 名前, a: 開いた画面のアカウントの印, t: タスク id, at: 最後に開いた・足した時刻 } を覚え、
   自動の片付けでは「同じ印の画面が開いた」「開いてから2分を過ぎた」グループだけを閉じる。
   印はレポートのサーバーが作るでたらめな文字列で、メールアドレス等は含まない。 */
const REC_KEY = 'groupRecs';                 // グループ id → 上の記録
const SEEN_KEY = 'acctSeen';                 // アカウントの印 → 最後にその印の依頼が来た時刻
const RECENT_MS = 2 * 60000;                 // 開いてからこの間は、自動の片付けでは閉じない
const STALE_ACCT_MS = 30 * 86400000;         // この間どこからも依頼が来ない印は、印の無い記録とみなす

async function loadObj(key) {
  try {
    const o = await chrome.storage.local.get(key);
    const v = o && o[key];
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) {
    return {};
  }
}
async function saveObj(key, obj) {
  try { await chrome.storage.local.set({ [key]: obj }); } catch (e) { /* 覚えられなくても動作は止めない */ }
}

/**
 * 記録を今あるグループに合わせる。Chrome を再起動するとグループの id が変わるので、
 * 名前が1つだけ一致するグループに付け替える。2つ以上あって決められないときは、
 * どちらにも「決められない」印（amb）を付け、自動では閉じない。
 */
function reconcile(recs, all) {
  const alive = new Map(all.map(g => [g.id, g]));
  const out = {};
  const orphans = [];
  Object.keys(recs).forEach(k => {
    const r = recs[k];
    if (!r || typeof r !== 'object') return;
    const g = alive.get(Number(k));
    if (g && norm(g.title) === r.n) out[g.id] = r;
    else orphans.push(r);
  });
  orphans.forEach(r => {
    const same = all.filter(g => norm(g.title) === r.n && !(g.id in out));
    if (same.length === 1) out[same[0].id] = r;
    else same.forEach(g => { out[g.id] = Object.assign({}, r, { amb: true }); });
  });
  return out;
}

/** 今あるグループに合わせた記録（合わせた結果は保存する。消えたグループの記録はここで消える） */
async function loadRecs(all) {
  const groups = all || await chrome.tabGroups.query({});
  const recs = reconcile(await loadObj(REC_KEY), groups);
  await saveObj(REC_KEY, recs);
  return recs;
}

/** 記録の印。30日どこからも依頼の来ていない印は、印の無い記録とみなす（印が変わった後に迷子にしない） */
function recAcct(r, seen, now) {
  if (!r || !r.a) return '';
  return now - (seen[r.a] || 0) > STALE_ACCT_MS ? '' : r.a;
}

async function touchAcct(acct) {
  if (!acct) return;
  const seen = await loadObj(SEEN_KEY);
  seen[String(acct)] = Date.now();
  await saveObj(SEEN_KEY, seen);
}

/**
 * 閉じてよいかを決める材料。auto は自動の片付けか。
 * 印を付けてこない依頼（1.7.0 より前のレポート）は自動とみなす（安全な側に倒す）
 */
async function closeContext(msg, autoDefault, all) {
  await touchAcct(msg.acct);
  return {
    recs: await loadRecs(all),
    seen: await loadObj(SEEN_KEY),
    now: Date.now(),
    acct: String(msg.acct || ''),
    auto: msg.auto === undefined ? autoDefault : msg.auto !== false,
    others: msg.others === true
  };
}

/** 記録 r のグループを閉じてよいか（名前の照合は呼び出し側で済ませておく） */
function mayClose(r, ctx) {
  if (ctx.auto && r && r.amb) return false;                          // どれの記録か決められない
  if (ctx.auto && r && ctx.now - (r.at || 0) < RECENT_MS) return false; // 開いて2分以内
  const ra = recAcct(r, ctx.seen, ctx.now);
  if (!ra) return true;                                              // 印の無い記録・記録なし
  if (!ctx.acct) return false;                                       // 古いレポートは印の付いた記録に触らない
  if (ra === ctx.acct) return true;
  return !ctx.auto && ctx.others;                                    // 別のアカウントのもの: ボタンで「含めて閉じる」ときだけ
}

/**
 * タブグループの一覧（「タブ片付け」ボタン用）。
 * mine: 同じ印の画面が開いたもの true / 別の印 false / 印なし・記録なし null。own: レポート自身が入っているもの。
 * 名前の無いグループも返す（id で閉じられるように）。保存済みのグループを開き直したものや、
 * ほかのツールが作ったものは名前が無いことが多く、名前では指定できないため
 */
async function listGroups(msg, sender) {
  await touchAcct(msg.acct);
  const all = await chrome.tabGroups.query({});
  const recs = await loadRecs(all);
  const seen = await loadObj(SEEN_KEY);
  const now = Date.now();
  const acct = String(msg.acct || '');
  const own = ownGroupId(sender);
  const groups = [];
  for (const g of all) {
    const tabs = await chrome.tabs.query({ groupId: g.id });
    const ra = recAcct(recs[g.id], seen, now);
    groups.push({
      id: g.id, title: g.title || '', tabs: tabs.length, own: g.id === own,
      mine: !ra || !acct ? null : ra === acct
    });
  }
  return { ok: true, groups: groups };
}

/**
 * 既にあるグループを前面に出す（1.7.2〜）。ランダムで選んだタスクが既に対応中だったときに使う。
 * そのタスクの記録が付いたグループを先に探し、無ければ名前で探す。
 * 別のアカウントの画面が開いたグループと、レポート自身が入っているグループは選ばない。
 * 折りたたまれていれば開き、先頭のタブを前面に出す。見つからなければ found: false を返す
 * （レポートはそのとき開き直す）
 */
async function focusGroup(msg, sender) {
  const title = norm(msg.title);
  const taskId = String(msg.taskId || '');
  const acct = String(msg.acct || '');
  await touchAcct(acct);
  const all = await chrome.tabGroups.query({});
  const recs = await loadRecs(all);
  const seen = await loadObj(SEEN_KEY);
  const now = Date.now();
  const own = ownGroupId(sender);
  const ok = g => {
    if (g.id === own) return false;
    const ra = recAcct(recs[g.id], seen, now);
    return !ra || ra === acct;
  };
  const cand = all.filter(ok);
  const g = (taskId && cand.find(x => recs[x.id] && recs[x.id].t === taskId && norm(x.title) === title))
         || (title && cand.find(x => norm(x.title) === title));
  if (!g) return { ok: true, found: false };

  const tabs = (await chrome.tabs.query({ groupId: g.id })).sort((a, b) => a.index - b.index);
  if (!tabs.length) return { ok: true, found: false };
  if (g.collapsed) await chrome.tabGroups.update(g.id, { collapsed: false });
  await chrome.tabs.update(tabs[0].id, { active: true });
  await chrome.windows.update(tabs[0].windowId, { focused: true });
  return { ok: true, found: true, tabs: tabs.length };
}

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

/** レポート自身が入っているグループ。閉じるとレポートも消えるので、片付けの対象から外す */
function ownGroupId(sender) {
  return sender && sender.tab && typeof sender.tab.groupId === 'number' ? sender.tab.groupId : -1;
}

async function syncGroups(msg, sender) {
  const keep = new Set((Array.isArray(msg.keep) ? msg.keep : []).map(norm).filter(Boolean));
  const known = new Set((Array.isArray(msg.known) ? msg.known : []).map(norm).filter(Boolean));
  const made = await loadMade();
  const all = await chrome.tabGroups.query({});
  const own = ownGroupId(sender);
  const ctx = await closeContext(msg, true, all);
  let closed = 0;
  const groups = [];
  for (const g of all) {
    const name = norm(g.title);
    if (!name || keep.has(name) || g.id === own) continue;
    const r = ctx.recs[g.id];
    const ra = recAcct(r, ctx.seen, ctx.now);
    // 自分で作ったグループには触らない。この拡張が作ったと分かるのは、同じ印の記録があるもの。
    // 印の無いもの（1.7.0 より前に開いたもの）は、印付きの依頼ならタスクの名前と一致するときだけ。
    // 印の無い依頼（古いレポート）は、これまでどおり覚えている名前でもよい
    const ours = ra ? ra === ctx.acct : (ctx.acct ? known.has(name) : (made.has(name) || known.has(name)));
    if (!ours || !mayClose(r, ctx)) continue;
    const n = await removeGroup(g.id);
    if (n) { closed += n; groups.push(g.title || ''); }
  }
  // もう存在しない名前は忘れる（覚える量が増え続けないように）
  const alive = new Set((await chrome.tabGroups.query({})).map(g => norm(g.title)));
  [...made].forEach(n => { if (!alive.has(n) && !keep.has(n)) made.delete(n); });
  await saveMade(made);
  return { ok: true, closed: closed, groups: groups };
}

async function closeGroups(msg, sender) {
  const want = new Set((Array.isArray(msg.titles) ? msg.titles : [])
    .map(x => String(x || '').trim().toLowerCase()).filter(Boolean));
  // id での指定は「タブ片付け」ボタン（手動）だけ受ける。名前の無いグループはこれでしか指定できない
  const ids = new Set(msg.auto === false && Array.isArray(msg.ids) ? msg.ids.filter(Number.isInteger) : []);
  if (!want.size && !ids.size) return { ok: true, closed: 0, groups: [], closedIds: [] };
  const all = await chrome.tabGroups.query({});
  const own = ownGroupId(sender);
  const ctx = await closeContext(msg, true, all);
  let closed = 0;
  const groups = [];
  const closedIds = [];
  for (const g of all) {
    const name = String(g.title || '').trim().toLowerCase();
    if (!(want.has(name) || ids.has(g.id)) || g.id === own) continue;
    if (!mayClose(ctx.recs[g.id], ctx)) continue;
    const n = await removeGroup(g.id);
    if (n) { closed += n; groups.push(g.title || ''); closedIds.push(g.id); }
  }
  return { ok: true, closed: closed, groups: groups, closedIds: closedIds };
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
