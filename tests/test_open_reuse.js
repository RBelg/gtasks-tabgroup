// 同じページが既に開いていれば開き直さない（background.js の openGroup, 1.7.3〜）を、偽の chrome API で確かめる
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function setup(openTabs, groups) {
  const store = { groupRecs: {}, acctSeen: {} };
  const log = { created: [], grouped: [], active: [] };
  let nextId = 1000;
  const chrome = {
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    storage: { local: {
      get: async k => ({ [k]: store[k] }),
      set: async o => { Object.assign(store, o); }
    } },
    tabGroups: {
      query: async q => (groups || []).filter(g => !q.title || g.title === q.title),
      update: async () => {}
    },
    tabs: {
      onUpdated: { addListener() {} },
      query: (q, cb) => { if (cb) return cb([]); return Promise.resolve(openTabs.slice()); },
      create: async p => { const t = { id: nextId++, url: p.url, windowId: p.windowId }; log.created.push(p.url); return t; },
      group: async p => { log.grouped.push({ into: p.groupId || 'new', ids: p.tabIds.slice() }); return p.groupId || 77; },
      update: async (id, p) => { if (p.active) log.active.push(id); return { id, windowId: 1 }; }
    },
    windows: { update: async () => {} }
  };
  const api = new Function('chrome', src + '\nreturn { openGroup };')(chrome);
  return { api, log };
}

const sender = { tab: { id: 1, windowId: 1 } };   // レポートのタブ
const msg = urls => ({ title: '見積書を', color: 'red', urls, acct: 'A', taskId: 'T1' });

(async () => {
  // 1) どこにも入っていない同じ窓のタブは開き直さず、グループに入れて前面に出す（末尾の / の差は同じとみなす）
  {
    const t = setup([
      { id: 1, url: 'https://script.google.com/report', windowId: 1, groupId: -1 },
      { id: 5, url: 'https://example.com/a/', windowId: 1, groupId: -1 }
    ]);
    const r = await t.api.openGroup(msg(['https://example.com/a', 'https://example.com/b']), sender);
    assert.deepStrictEqual(t.log.created, ['https://example.com/b']);
    assert.deepStrictEqual(t.log.grouped, [{ into: 'new', ids: [5, 1000] }]);
    assert.deepStrictEqual([t.log.active, r.opened, r.reused], [[5], 1, 1]);
    console.log('[OK] 開いていたタブを使い、残りだけ開く。最初の行き先のタブを前面に');
  }
  // 2) ほかのグループのタブは動かさず、前面に出すだけ（全部開いていれば新しいグループも作らない）
  {
    const t = setup([{ id: 6, url: 'https://example.com/a', windowId: 1, groupId: 40 }]);
    const r = await t.api.openGroup(msg(['https://example.com/a']), sender);
    assert.deepStrictEqual([t.log.created, t.log.grouped, t.log.active, r.reused], [[], [], [6], 1]);
    console.log('[OK] ほかのグループのタブは動かさない');
  }
  // 3) Gmail の # 以降が違えば別のページ。レポート自身のタブも使わない
  {
    const t = setup([
      { id: 7, url: 'https://mail.google.com/mail/u/0/#inbox/AAA', windowId: 1, groupId: -1 },
      { id: 1, url: 'https://example.com/self', windowId: 1, groupId: -1 }
    ]);
    await t.api.openGroup(msg(['https://mail.google.com/mail/u/0/#inbox/BBB', 'https://example.com/self']), sender);
    assert.deepStrictEqual(t.log.created, ['https://mail.google.com/mail/u/0/#inbox/BBB', 'https://example.com/self']);
    console.log('[OK] # 以降が違うメールは別扱い。レポートのタブは使わない');
  }
  // 4) 同じ名前のグループに既に入っているタブはそのまま（入れ直さない）
  {
    const t = setup([{ id: 8, url: 'https://example.com/a', windowId: 1, groupId: 50 }], [{ id: 50, title: '見積書を' }]);
    const r = await t.api.openGroup(msg(['https://example.com/a']), sender);
    assert.deepStrictEqual([t.log.created, t.log.grouped, t.log.active, r.opened], [[], [], [8], 0]);
    console.log('[OK] 既にそのグループにあるタブは前面に出すだけ');
  }
  // 5) ほかの窓の、どこにも入っていないタブは動かさない
  {
    const t = setup([{ id: 9, url: 'https://example.com/a', windowId: 2, groupId: -1 }]);
    await t.api.openGroup(msg(['https://example.com/a']), sender);
    assert.deepStrictEqual([t.log.created, t.log.grouped, t.log.active], [[], [], [9]]);
    console.log('[OK] ほかの窓のタブは動かさず前面に出す');
  }
  console.log('すべて通過');
})().catch(e => { console.error(e); process.exit(1); });
