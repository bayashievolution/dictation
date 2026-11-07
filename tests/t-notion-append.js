// 既存ノートへの追記を、実物の関数のまま検査する。
// fetch を差し替えて、送られるリクエストを捕まえるだけ。
const fs = require('fs'), vm = require('vm');
const R = process.env.SRC || __dirname + '/../';
const src = fs.readFileSync(R + 'notion.js', 'utf8');
let calls = [];
let responder = null;
const ctx = {
  console: { warn() {}, log() {} },
  location: { protocol: 'chrome-extension:' },
  setTimeout: (fn) => fn(),            // 待たない
  fetch: async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts.method || 'GET', body });
    const r = responder ? responder(url, opts, body) : { ok: true, json: {} };
    return {
      ok: r.status ? r.status < 400 : true,
      status: r.status || 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(r.json || {}),
    };
  },
  Array, Set, Map, JSON, Math, Number, String, Object, Promise, Date, Error,
};
vm.createContext(ctx);
vm.runInContext(src, ctx);

let fail = 0;
const check = (label, ok, note) => {
  console.log(`${ok ? '✓' : '✕'} ${label}${ok || !note ? '' : ` — ${note}`}`);
  if (!ok) fail++;
};
const reset = (fn) => { calls = []; responder = fn || null; };

(async () => {
  console.log('■ 既存ノートに追記する');
  reset((url) => url.includes('/children')
    ? { json: { results: [{ id: 'tog1' }] } } : { json: {} });
  await ctx.notionAppendToNote({
    token: 't', pageId: 'PAGE1', pageUrl: 'https://notion.so/x',
    title: '講義3回目', dateTs: new Date('2026-10-22T13:05:00').getTime(),
    toggles: [{ label: '文字起こし', blocks: [{ x: 1 }] }],
  });
  // 新しいページを作ってはいけない。追記しに来ただけ
  check('ページを新規作成しない', !calls.some(c => c.url.endsWith('/pages')),
    JSON.stringify(calls.map(c => c.url)));
  check('指定したページに書く', calls.every(c => c.url.includes('PAGE1')));
  const head = calls[0].body.children;
  check('区切り線を先に置く', head[0].type === 'divider');
  check('見出しを置く', head[1].type === 'heading_2');
  const headText = head[1].heading_2.rich_text.map(r => r.text.content).join('');
  check('見出しにタイトルが入る', headText.includes('講義3回目'), headText);
  check('見出しに録音日時が入る', /2026-10-22 13:05/.test(headText), headText);
  check('そのあとトグルを足す', calls[1].body.children[0].type === 'toggle');
  // 既存ページのタイトルや日付列を書き換えたら事故
  check('プロパティを触らない', !calls.some(c => c.body && c.body.properties));

  console.log('\n■ 追記先が無いときは止める');
  reset();
  let msg = '';
  try { await ctx.notionAppendToNote({ token: 't', pageId: '', toggles: [] }); }
  catch (e) { msg = e.message; }
  check('ページIDが無ければ投げる', /追記先のノートが指定されていません/.test(msg), msg);
  check('何も送っていない', calls.length === 0);

  console.log('\n■ 既存ノートの一覧');
  // 本命の経路が使えるとき
  reset((url) => url.includes('/data_sources/DS1/query')
    ? { json: { results: [
        { object: 'page', id: 'p1', url: 'u1', last_edited_time: 't1',
          properties: { 名前: { type: 'title', title: [{ plain_text: '講義1' }] } } },
        { object: 'page', id: 'p2', in_trash: true,
          properties: { 名前: { type: 'title', title: [{ plain_text: 'ゴミ箱' }] } } },
      ] } }
    : { json: {} });
  let notes = await ctx.notionListNotesInDataSource('t', 'DS1');
  check('データソースを直接引く', calls[0].url.includes('/data_sources/DS1/query'));
  check('ノートが取れる', notes.length === 1 && notes[0].title === '講義1', JSON.stringify(notes));
  check('ゴミ箱のものは出さない', !notes.some(n => n.id === 'p2'));

  // 本命が使えないとき（この形は実測できていないので、落ちたら /search に逃がす）
  reset((url) => {
    if (url.includes('/data_sources/')) return { status: 404, json: { code: 'not_found' } };
    return { json: { results: [
      { object: 'page', id: 'p9', parent: { data_source_id: 'DS1' },
        properties: { 名前: { type: 'title', title: [{ plain_text: '別経路' }] } } },
      { object: 'page', id: 'p8', parent: { data_source_id: 'OTHER' },
        properties: { 名前: { type: 'title', title: [{ plain_text: 'よそのDB' }] } } },
    ], has_more: false } };
  });
  notes = await ctx.notionListNotesInDataSource('t', 'DS1');
  check('404 なら /search に切り替える', calls.some(c => c.url.endsWith('/search')));
  check('切り替えてもノートが取れる', notes.length === 1 && notes[0].title === '別経路',
    JSON.stringify(notes));
  // ここを間違えると、よそのデータベースのノートに追記してしまう
  check('よそのDBのノートは混ぜない', !notes.some(n => n.id === 'p8'));

  // 通信エラーなど、形の問題でないものは黙って握らない
  reset(() => ({ status: 401, json: { code: 'unauthorized' } }));
  msg = '';
  try { await ctx.notionListNotesInDataSource('t', 'DS1'); } catch (e) { msg = e.message; }
  check('401 は投げる（/search に逃がさない）', !!msg, msg);

  console.log('\n■ 親の取り違え');
  check('data_source_id を見る',
    ctx.notionNotesFromResults([{ object: 'page', id: 'a', parent: { data_source_id: 'X' },
      properties: {} }], 'X').length === 1);
  check('database_id でも拾う',
    ctx.notionNotesFromResults([{ object: 'page', id: 'a', parent: { database_id: 'X' },
      properties: {} }], 'X').length === 1);
  check('親が違えば落とす',
    ctx.notionNotesFromResults([{ object: 'page', id: 'a', parent: { data_source_id: 'Y' },
      properties: {} }], 'X').length === 0);
  check('空でも落ちない', ctx.notionNotesFromResults(undefined, 'X').length === 0);

  console.log(fail ? `\n${fail}件 失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
