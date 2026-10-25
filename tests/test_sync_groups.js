// 放置グループの片付け（background.js の syncGroups）を、偽の chrome API で確かめる
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function setup(groups, tabs, made) {
  const removed = [], ungrouped = [];
  const store = { madeTitles: made || [] };
  let live = groups.slice();
  const chrome = {
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    storage: { local: {
      get: async k => ({ [k]: store[k] }),
      set: async o => { Object.assign(store, o); }
    } },
    tabGroups: { query: async () => live.slice(), update: async () => {} },
    tabs: {
      onUpdated: { addListener() {} },
      query: (q, cb) => {
        if (cb) return cb([]);   // 起動時の差し込み直し用（ここでは使わない）
        return Promise.resolve((tabs[q.groupId] || []).map(id => ({ id })));
      },
      ungroup: async ids => { ungrouped.push(...ids); },
      remove: async ids => {
        removed.push(...ids);
        live = live.filter(g => !(tabs[g.id] || []).some(id => ids.includes(id)));
      }
    }
  };
  const api = new Function('chrome', src + '\nreturn { syncGroups, rememberTitle };')(chrome);
  return { api, removed, ungrouped, store };
}

(async () => {
  // 対応中（残す）・完了済み（拡張が作った）・自分で作ったグループ・覚える前に作られた古いグループ
  const groups = [
    { id: 1, title: '見積書を' },     // 対応中 → 残す
    { id: 2, title: '請求書の' },     // 拡張が作った・もう対応中ではない → 閉じる
    { id: 3, title: '自分用' },       // 自分で作った → 触らない
    { id: 4, title: '旧タスク' }      // 覚えていないが、タスクの名前と一致 → 閉じる
  ];
  const tabs = { 1: [11], 2: [21, 22], 3: [31], 4: [41] };
  const t = setup(groups, tabs, ['見積書を', '請求書の']);
  const r = await t.api.syncGroups({ keep: ['見積書を'], known: ['見積書を', '請求書の', '旧タスク'] });
  assert.deepStrictEqual(r.groups.sort(), ['旧タスク', '請求書の'].sort());
  assert.deepStrictEqual(t.removed.sort(), [21, 22, 41].sort());
  assert.deepStrictEqual(t.ungrouped.sort(), [21, 22, 41].sort(), 'グループから外してから閉じる');
  console.log('[OK] 対応中は残し、放置されたものだけ閉じる。自分のグループには触らない');

  // 閉じた名前は忘れる。残した名前は覚えたまま
  assert.deepStrictEqual(t.store.madeTitles.sort(), ['見積書を']);
  console.log('[OK] 閉じた名前は忘れる');

  // 開いたときに覚える
  const t2 = setup([], {}, []);
  await t2.api.rememberTitle('新しい件');
  assert.deepStrictEqual(t2.store.madeTitles, ['新しい件']);
  console.log('[OK] 作ったグループの名前を覚える');
  console.log('すべて通過');
})().catch(e => { console.error(e); process.exit(1); });
