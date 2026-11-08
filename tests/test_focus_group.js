// 既にあるグループを前面に出す（background.js の focusGroup, 1.7.2〜）を、偽の chrome API で確かめる
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function setup(groups, tabs, recs, seen) {
  const now = Date.now();
  const store = { groupRecs: recs || {}, acctSeen: seen || { A: now, B: now } };
  const log = { active: [], focused: [], expanded: [] };
  const chrome = {
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    storage: { local: {
      get: async k => ({ [k]: store[k] }),
      set: async o => { Object.assign(store, o); }
    } },
    tabGroups: {
      query: async () => groups.slice(),
      update: async (id, p) => { if (p.collapsed === false) log.expanded.push(id); }
    },
    tabs: {
      onUpdated: { addListener() {} },
      query: (q, cb) => {
        if (cb) return cb([]);
        return Promise.resolve((tabs[q.groupId] || []).map(t => Object.assign({}, t)));
      },
      update: async (id, p) => { if (p.active) log.active.push(id); }
    },
    windows: { update: async (id, p) => { if (p.focused) log.focused.push(id); } }
  };
  const api = new Function('chrome', src + '\nreturn { focusGroup };')(chrome);
  return { api, log };
}

const rec = (n, a, t) => ({ n, a, t, at: Date.now() - 600000 });
const sender = { tab: { groupId: 99, windowId: 1 } };   // レポート自身はグループ 99 に居る

(async () => {
  // 1) 名前の合うグループの先頭タブ（並び順）を前面に出し、折りたたみを開く
  {
    const t = setup(
      [{ id: 1, title: '見積書を', collapsed: true }, { id: 99, title: 'レポート' }],
      { 1: [{ id: 12, index: 5, windowId: 2 }, { id: 11, index: 4, windowId: 2 }] },
      { 1: rec('見積書を', 'A', 'T1') });
    const r = await t.api.focusGroup({ title: '見積書を', acct: 'A', taskId: 'T1' }, sender);
    assert.deepStrictEqual([r.found, t.log.active, t.log.focused, t.log.expanded], [true, [11], [2], [1]]);
    console.log('[OK] 先頭のタブを前面に出し、折りたたみを開き、窓も前に出す');
  }
  // 2) 同じ名前が2つあれば、そのタスクの記録が付いた方
  {
    const t = setup(
      [{ id: 1, title: '日報', collapsed: false }, { id: 2, title: '日報', collapsed: false }],
      { 1: [{ id: 11, index: 0, windowId: 1 }], 2: [{ id: 21, index: 3, windowId: 1 }] },
      { 1: rec('日報', 'A', 'OTHER'), 2: rec('日報', 'A', 'T2') });
    await t.api.focusGroup({ title: '日報', acct: 'A', taskId: 'T2' }, sender);
    assert.deepStrictEqual(t.log.active, [21]);
    console.log('[OK] 同じ名前なら、そのタスクで開いたグループを選ぶ');
  }
  // 3) 別のアカウントの画面が開いた同じ名前のグループは選ばない
  {
    const t = setup(
      [{ id: 1, title: '日報' }],
      { 1: [{ id: 11, index: 0, windowId: 1 }] },
      { 1: rec('日報', 'B', 'T9') });
    const r = await t.api.focusGroup({ title: '日報', acct: 'A', taskId: 'T2' }, sender);
    assert.deepStrictEqual([r.found, t.log.active], [false, []]);
    console.log('[OK] 別のアカウントのグループは選ばず、見つからないと返す');
  }
  // 4) 無ければ found:false（レポートが開き直す）。レポート自身のグループも選ばない
  {
    const t = setup([{ id: 99, title: '見積書を' }], { 99: [{ id: 991, index: 0, windowId: 1 }] }, {});
    const r = await t.api.focusGroup({ title: '見積書を', acct: 'A', taskId: 'T1' }, sender);
    assert.deepStrictEqual([r.ok, r.found, t.log.active], [true, false, []]);
    console.log('[OK] レポートが入っているグループは選ばない');
  }
  // 5) 記録の無い（古い版で開いた）グループも名前で選ぶ
  {
    const t = setup([{ id: 5, title: 'ＡＢＣ' }], { 5: [{ id: 51, index: 0, windowId: 3 }] }, {});
    const r = await t.api.focusGroup({ title: ' ＡＢＣ ', acct: 'A', taskId: 'T5' }, sender);
    assert.deepStrictEqual([r.found, t.log.active], [true, [51]]);
    console.log('[OK] 記録の無いグループも名前で選ぶ');
  }
  console.log('すべて通過');
})().catch(e => { console.error(e); process.exit(1); });
