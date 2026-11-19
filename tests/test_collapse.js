// 選択を外れたグループを折りたたむ（background.js の collapseOthers, 1.7.4〜）を、偽の chrome API で確かめる
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function setup(activeTab, groups, recs, made, onQuery) {
  const store = { groupRecs: recs || {}, madeTitles: made || [] };
  const collapsed = [];
  const chrome = {
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    storage: { local: { get: async k => ({ [k]: store[k] }), set: async o => { Object.assign(store, o); } } },
    tabGroups: {
      query: async q => groups.filter(g => g.windowId === q.windowId && g.collapsed === q.collapsed),
      update: async (id, p) => { if (p.collapsed) collapsed.push(id); }
    },
    tabs: {
      onUpdated: { addListener() {} }, onActivated: { addListener() {} },
      query: (q, cb) => { if (cb) return cb([]); if (onQuery) onQuery(activeTab); return Promise.resolve(q.active ? [Object.assign({}, activeTab)] : []); }
    }
  };
  const api = new Function('chrome', src + '\nreturn { collapseOthers, holdGroup };')(chrome);
  return { api, collapsed };
}

(async () => {
  const groups = [
    { id: 1, title: '見積書を', windowId: 1, collapsed: false },   // 記録あり → たたむ
    { id: 2, title: '請求書の', windowId: 1, collapsed: false },   // 前面のタブが居る → たたまない
    { id: 3, title: '自分用', windowId: 1, collapsed: false },     // 自分で作った → 触らない
    { id: 4, title: '日報', windowId: 1, collapsed: false },       // 記録は無いが作った名前 → たたむ
    { id: 5, title: '見積書を', windowId: 2, collapsed: false },   // 別の窓 → 触らない
    { id: 6, title: '旧', windowId: 1, collapsed: true }           // もうたたんである
  ];
  {
    const t = setup({ id: 20, groupId: 2 }, groups, { 1: { n: '見積書を' }, 2: { n: '請求書の' }, 6: { n: '旧' } }, ['日報']);
    await t.api.collapseOthers(1);
    assert.deepStrictEqual(t.collapsed.sort(), [1, 4]);
    console.log('[OK] 前面のタブのグループ以外で、この拡張が作ったものだけたたむ');
  }
  {
    const t = setup({ id: 9, groupId: -1 }, groups, { 1: { n: '見積書を' }, 2: { n: '請求書の' } }, []);
    await t.api.collapseOthers(1);
    assert.deepStrictEqual(t.collapsed.sort(), [1, 2]);
    console.log('[OK] グループの外のタブに切り替えたら、開いていたグループをたたむ');
  }
  {
    // 判断している間に、たたもうとしたグループへ切り替わったら、そのグループはたたまない
    let n = 0;
    const t = setup({ id: 9, groupId: -1 }, groups, { 1: { n: '見積書を' } }, ['日報'], tab => { if (++n === 2) tab.groupId = 1; });
    await t.api.collapseOthers(1);
    assert.deepStrictEqual(t.collapsed, [4]);
    console.log('[OK] たたむ直前に前面のタブを確かめ直す（選択中のグループはたたまない）');
  }
  {
    // いま開いた・前面に出したグループは、数秒たたまない
    const t = setup({ id: 9, groupId: -1 }, groups, { 1: { n: '見積書を' } }, ['日報']);
    t.api.holdGroup(1);
    await t.api.collapseOthers(1);
    assert.deepStrictEqual(t.collapsed, [4]);
    console.log('[OK] 開いた直後のグループはたたまない');
  }
  console.log('すべて通過');
})().catch(e => { console.error(e); process.exit(1); });
