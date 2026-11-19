// 選択中のタスクのグループだけ開いておく（background.js の expandGroups, 1.8.0〜）を、偽の chrome API で確かめる
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function setup(groups, recs, seen) {
  const now = Date.now();
  const store = { groupRecs: recs || {}, acctSeen: seen || { A: now, B: now } };
  const log = { expanded: [], collapsed: [] };
  const chrome = {
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    storage: { local: { get: async k => ({ [k]: store[k] }), set: async o => { Object.assign(store, o); } } },
    tabGroups: {
      query: async () => groups.map(g => Object.assign({}, g)),
      update: async (id, p) => { (p.collapsed ? log.collapsed : log.expanded).push(id); }
    },
    tabs: {
      onUpdated: { addListener() {} },
      query: (q, cb) => { if (cb) return cb([]); return Promise.resolve([]); }
    }
  };
  const api = new Function('chrome', src + '\nreturn { expandGroups };')(chrome);
  return { api, log };
}

const rec = (n, a, t) => ({ n, a, t, at: 0 });
const sender = { tab: { groupId: 99, windowId: 1 } };   // レポート自身はグループ 99 に居る

(async () => {
  const groups = [
    { id: 1, title: '見積書を', collapsed: true },    // 選択中 → 開く
    { id: 2, title: '請求書の', collapsed: false },   // ほかのタスク → たたむ
    { id: 3, title: '自分用', collapsed: false },     // レポートが送らない名前 → 触らない
    { id: 4, title: '日報', collapsed: false },       // 別のアカウントのもの → 触らない
    { id: 99, title: '請求書の', collapsed: false }   // レポート自身のグループ → 触らない
  ];
  const recs = { 1: rec('見積書を', 'A', 'T1'), 2: rec('請求書の', 'A', 'T2'), 4: rec('日報', 'B', 'T4') };
  {
    const t = setup(groups, recs);
    const r = await t.api.expandGroups({ expand: '見積書を', taskId: 'T1', collapse: ['請求書の', '日報'], acct: 'A' }, sender);
    assert.deepStrictEqual([t.log.expanded, t.log.collapsed, r.found], [[1], [2], true]);
    console.log('[OK] 選択中のグループを開き、ほかのタスクのグループはたたむ（自分用・別アカウント・レポート自身は触らない）');
  }
  {
    // 選択を外した: 開くものは無く、送られた名前をたたむ
    const t = setup(groups.map(g => g.id === 1 ? Object.assign({}, g, { collapsed: false }) : g), recs);
    await t.api.expandGroups({ expand: '', taskId: '', collapse: ['見積書を', '請求書の'], acct: 'A' }, sender);
    assert.deepStrictEqual([t.log.expanded, t.log.collapsed.sort()], [[], [1, 2]]);
    console.log('[OK] 選択を外したら、そのグループもたたむ');
  }
  {
    // 同じ名前が2つ: そのタスクで開いた方だけ開き、もう片方はたたむ
    const g2 = [{ id: 5, title: '日報', collapsed: true }, { id: 6, title: '日報', collapsed: false }];
    const t = setup(g2, { 5: rec('日報', 'A', 'T5'), 6: rec('日報', 'A', 'T6') });
    await t.api.expandGroups({ expand: '日報', taskId: 'T5', collapse: [], acct: 'A' }, sender);
    assert.deepStrictEqual([t.log.expanded, t.log.collapsed], [[5], [6]]);
    console.log('[OK] 同じ名前なら、そのタスクで開いたグループだけを開く');
  }
  {
    // 既に開いている選択中のグループには何もしない
    const t = setup([{ id: 1, title: '見積書を', collapsed: false }], recs);
    await t.api.expandGroups({ expand: '見積書を', taskId: 'T1', collapse: [], acct: 'A' }, sender);
    assert.deepStrictEqual([t.log.expanded, t.log.collapsed], [[], []]);
    console.log('[OK] 開いているものはそのまま');
  }
  console.log('すべて通過');
})().catch(e => { console.error(e); process.exit(1); });
