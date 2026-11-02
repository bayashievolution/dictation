// リアルタイム要約（目次付き・Claude 連携のみ）の純関数と、Notion の目次リンクを、
// 実物の関数のまま検査する (v0.24.22)。依存なし。
//
// 目次のリンクを Notion に張るところは fetch を差し替えて「何を送るか」まで見る。
// **実物の Notion がそのリンクで見出しへ飛ぶかは確かめていない**（api.notion.com に届かない）。
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.resolve(process.env.SRC || __dirname + '/../');

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

const ls = { module: { exports: {} } };
vm.createContext(ls);
vm.runInContext(fs.readFileSync(path.join(SRC, 'live-summary.js'), 'utf8'), ls);
const { buildLiveSummaryPrompt, normalizeLiveSummary, clampLiveSummaryMinutes, LIVE_SUMMARY_MAX_PROMPT } = ls.module.exports;

const T = '今日は評価論の話をします。'.repeat(30);

console.log('■ 初回（前回の要約が無い）');
{
  const p = buildLiveSummaryPrompt({ transcript: T, title: '評価論' });
  eq('目次の形を示す', p.includes('## 目次\n1. 見出し'), true);
  eq('目次と本文の番号を一致させる', p.includes('番号・文言を必ず一致させる'), true);
  eq('前回の目次を保つ指示は出さない（前回が無い）', p.includes('前回の目次の見出しと順番は変えない'), false);
  eq('録音中なので最後の話題に（進行中）', p.includes('「（進行中）」と付ける'), true);
  eq('文字起こしとタイトルが入る', p.includes('【文字起こし】\n' + T) && p.includes('【タイトル】\n評価論'), true);
  eq('メモが無ければメモの決まりも入れない', p.includes('【メモ】'), false);
}

console.log('\n■ 2回目以降（前回の要約がある）');
{
  const prev = '## 目次\n1. 評価の観点\n\n## 1. 評価の観点\n- 3つある';
  const p = buildLiveSummaryPrompt({ transcript: T, previous: prev });
  eq('前回の要約を渡す', p.includes('【前回の要約】\n' + prev), true);
  eq('目次の見出しと順番は変えない（読み手が頼りにしている）', p.includes('前回の目次の見出しと順番は変えない'), true);
  eq('最後の項目だけは直してよい', p.includes('前回の**最後の項目**は話の途中だった'), true);
  eq('新しい話題は末尾に足す', p.includes('目次の末尾に足す'), true);
}

console.log('\n■ 最初から作り直す（要約ボタン）');
{
  const p = buildLiveSummaryPrompt({ transcript: T, previous: '## 目次\n1. 古い', fresh: true, final: true });
  eq('前回の要約は渡さない', p.includes('【前回の要約】'), false);
  eq('全体を見て組み立てる', p.includes('いまある文字起こし全体を見て'), true);
  eq('止めたあとなので（進行中）は付けない', [p.includes('「（進行中）」は付けない'), p.includes('と付ける')], [true, false]);
}

console.log('\n■ メモ');
{
  const p = buildLiveSummaryPrompt({ transcript: T, memo: 'ルーブリック要確認' });
  eq('メモを渡し、断片を膨らませない決まりを足す', [p.includes('【メモ】\nルーブリック要確認'), p.includes('断片を想像で膨らませない')], [true, true]);
}

console.log('\n■ 長すぎる文字起こし');
{
  const long = 'あ'.repeat(LIVE_SUMMARY_MAX_PROMPT) + '最後の発言';
  const p = buildLiveSummaryPrompt({ transcript: long, previous: '## 目次\n1. x' });
  eq('上限に収まる', p.length <= LIVE_SUMMARY_MAX_PROMPT, true);
  eq('落とすのは冒頭（最後の発言は残る）', p.endsWith('最後の発言'), true);
  eq('省略したと書く', p.includes('冒頭を省略'), true);
}

console.log('\n■ 返ってきたものを整える');
eq('前置きを落とす', normalizeLiveSummary('更新しました。\n\n## 目次\n1. a\n\n## 1. a\n- x'),
   { ok: true, md: '## 目次\n1. a\n\n## 1. a\n- x' });
eq('コードブロックを外す', normalizeLiveSummary('```markdown\n## 目次\n1. a\n```'), { ok: true, md: '## 目次\n1. a' });
eq('目次が無ければ ok:false（中身はそのまま）', normalizeLiveSummary('ただの文'), { ok: false, md: 'ただの文' });

console.log('\n■ 分数');
eq('ふつう', clampLiveSummaryMinutes('15'), 15);
eq('0 は 1 に', clampLiveSummaryMinutes(0), 1);
eq('大きすぎは 60 に', clampLiveSummaryMinutes(999), 60);
eq('数でなければ既定の 10', clampLiveSummaryMinutes('abc'), 10);

// ───── Notion の目次リンク ─────
const calls = [];
const nctx = {
  console: { warn() {}, log() {} },
  location: { protocol: 'chrome-extension:' },
  setTimeout: (fn) => fn(),
  fetch: async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts.method || 'GET', body });
    let json = {};
    if (/\/blocks\/TOG\/children/.test(url) && (opts.method || 'GET') === 'GET') json = { results: CHILDREN, has_more: false };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(json) };
  },
  Array, Set, Map, JSON, Math, Number, String, Object, Promise, Date, Error, encodeURIComponent,
};
const rt = (t) => [{ type: 'text', plain_text: t, text: { content: t } }];
const CHILDREN = [
  { id: 'h-toc', type: 'heading_2', heading_2: { rich_text: rt('目次') } },
  { id: 'li-1', type: 'numbered_list_item', numbered_list_item: { rich_text: rt('評価の観点') } },
  { id: 'li-2', type: 'numbered_list_item', numbered_list_item: { rich_text: rt('ルーブリック') } },
  { id: 'aaaa-1111', type: 'heading_2', heading_2: { rich_text: rt('1. 評価の観点') } },
  { id: 'b1', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt('3つある') } },
  { id: 'bbbb-2222', type: 'heading_2', heading_2: { rich_text: rt('2. ルーブリック') } },
];
vm.createContext(nctx);
vm.runInContext(fs.readFileSync(path.join(SRC, 'notion.js'), 'utf8'), nctx);

console.log('\n■ Notion: 目次から見出しへのリンク');
{
  const plan = nctx.notionTocLinkPlan(CHILDREN, 'page-0001');
  eq('目次の項目ごとに1つ', plan.map((p) => p.blockId), ['li-1', 'li-2']);
  eq('リンク先は ページID#見出しのID（ハイフン無し）',
     plan.map((p) => p.rich_text[0].text.link.url),
     ['https://www.notion.so/page0001#aaaa1111', 'https://www.notion.so/page0001#bbbb2222']);
  eq('文字は元のまま', plan.map((p) => p.rich_text[0].text.content), ['評価の観点', 'ルーブリック']);
  eq('目次が無ければ何もしない', nctx.notionTocLinkPlan(CHILDREN.slice(1), 'p').length, 0);
}

(async () => {
  console.log('\n■ Notion: 送ったあとにリンクを張る（失敗しても保存は失敗にしない）');
  const logs = [];
  // トグルを作ったときに id（TOG）を返すようにして送る
  calls.length = 0;
  nctx.fetch = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts.method || 'GET', body });
    let json = {};
    if (/\/blocks\/page-0001\/children/.test(url)) json = { results: [{ id: 'TOG' }] };
    if (/\/blocks\/TOG\/children/.test(url) && (opts.method || 'GET') === 'GET') json = { results: CHILDREN, has_more: false };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(json) };
  };
  logs.length = 0;
  await nctx.notionAppendToggles({
    token: 't', pageId: 'page-0001',
    toggles: [{ label: '要約', blocks: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }], liveToc: true }],
    onLog: (m) => logs.push(m),
  });
  const patches = calls.filter((c) => c.method === 'PATCH' && /\/blocks\/li-/.test(c.url));
  eq('目次の項目を PATCH する', patches.map((c) => c.url.replace(/^.*\/blocks\//, '')), ['li-1', 'li-2']);
  eq('PATCH の中身は numbered_list_item の rich_text（リンク付き）',
     patches[0].body.numbered_list_item.rich_text[0].text.link.url, 'https://www.notion.so/page0001#aaaa1111');
  eq('ログに件数を残す', logs, ['Notion: 目次に2件のリンクを付けました']);

  // リンク処理が失敗しても、notionAppendToggles 自体は成功する
  nctx.fetch = async (url, opts) => {
    if (/\/blocks\/page-0001\/children/.test(url)) {
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ results: [{ id: 'TOG' }] }) };
    }
    return { ok: false, status: 400, headers: { get: () => null }, text: async () => JSON.stringify({ message: 'bad' }) };
  };
  logs.length = 0;
  let threw = false;
  try {
    await nctx.notionAppendToggles({
      token: 't', pageId: 'page-0001',
      toggles: [{ label: '要約', blocks: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }], liveToc: true }],
      onLog: (m) => logs.push(m),
    });
  } catch { threw = true; }
  eq('リンクが付けられなくても保存は失敗にしない', threw, false);
  eq('付けられなかったことはログに残す', /目次のリンクを付けられませんでした/.test(logs[0] || ''), true);

  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
