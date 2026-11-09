// リアルタイム要約（目次付き・Claude 連携のみ）を、本物の Chromium で動かして検査する (v0.24.22)。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-live-summary-browser.js
//
// Claude（/api/claude）と Gemini は page.route で差し替え、Web Speech は偽物。
// 実物の Claude がどんな目次を返すかは見ていない（返事は決め打ち）。
//
// ■ なぜ実機が要るのか
//
// 「いつ回るか」（録音中の定期更新・止めたときの最終版・要約ボタン）と、
// 「Gemini に回らないか」は、ページを動かさないと分からない（CLAUDE.md）。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

const MD1 = '## 目次\n1. 評価の観点\n2. ルーブリック（進行中）\n\n## 1. 評価の観点\n- 観点は3つ\n\n## 2. ルーブリック（進行中）\n- 段階で示す';
const MD2 = '## 目次\n1. 評価の観点\n2. ルーブリック\n\n## 1. 評価の観点\n- 観点は3つ\n\n## 2. ルーブリック\n- 段階で示す\n- 4段階';

async function open(browser, { settings = {}, claude = 'ok' } = {}) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  const seen = { claude: [], gemini: 0 };
  let replies = [MD1, MD2, MD2];
  await page.addInitScript(() => {
    class FakeRec extends EventTarget { start() {} stop() {} abort() {} }
    window.SpeechRecognition = FakeRec;
    window.webkitSpeechRecognition = FakeRec;
  });
  await page.route('**/generativelanguage.googleapis.com/**', r => {
    seen.gemini++;
    r.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini の要約' }] }, finishReason: 'STOP' }] }) });
  });
  await page.route('**/api/claude/health', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ ok: true, invocation: 'claude', version: 'x', auth: { ok: true, loggedIn: true } }) }));
  await page.route('**/api/claude', async r => {
    const body = JSON.parse(r.request().postData() || '{}');
    seen.claude.push(body.prompt || '');
    seen.bodies = seen.bodies || [];
    seen.bodies.push(body);
    if (claude === 'fail') {
      return r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '一時的な失敗' }) });
    }
    // タイトル生成など、目次付き要約以外の依頼には短く返す
    const isLive = (body.prompt || '').includes('目次付きの要約');
    r.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ ok: true, text: isLive ? replies.shift() : '講義のタイトル', seconds: 1 }) });
  });
  await page.goto(URL);
  await page.evaluate((s) => localStorage.setItem('dictation:settings', JSON.stringify(s)), {
    apiKey: 'AIza-test', inputMode: 'web-speech', aiEnabled: false, autoSummarize: true,
    useClaudeBridge: true, liveSummary: true, liveSummaryMin: 1, ...settings,
  });
  await page.reload();
  await page.waitForTimeout(800);
  return { ctx, page, seen };
}

/** 文字起こしペインに 300字ほど入れる */
const fillTranscript = (page, text) => page.evaluate((t) => {
  const p = document.createElement('div');
  p.className = 'paragraph';
  p.textContent = t;
  document.getElementById('confirmed').appendChild(p);
  snapshotActiveToSession();
}, text);

const summary = (page) => page.evaluate(() => ({
  toc: Array.from(document.querySelectorAll('#live-summary .live-summary-toc li')).map(li => [li.textContent, li.dataset.lsJump]),
  secs: Array.from(document.querySelectorAll('#live-summary h2[data-ls-section]')).map(h => h.textContent),
}));

(async () => {
  // 録音を本当に始めるので、偽のマイクを渡す
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const T = '今日は評価論です。評価の観点は三つあります。'.repeat(15);

  console.log('■ 録音中、間隔が来たら Claude で目次付き要約を作る');
  {
    const { ctx, page, seen } = await open(browser);
    await page.evaluate(() => startRecording());
    await page.waitForTimeout(300);
    await fillTranscript(page, T);
    // 1分待つ代わりに、前回の更新を昔にしてから見回りを1回走らせる
    await page.evaluate(() => { state.liveSummaryLastAt = 0; liveSummaryTick(); });
    await page.waitForTimeout(800);
    const s = await summary(page);
    eq('目次が上にでき、項目が本文の節に結びつく', s.toc, [['評価の観点', '1'], ['ルーブリック（進行中）', '2']]);
    eq('本文の節', s.secs, ['1. 評価の観点', '2. ルーブリック（進行中）']);
    eq('Claude に1回だけ頼んだ', seen.claude.filter(p => p.includes('目次付きの要約')).length, 1);
    eq('Gemini には頼んでいない', seen.gemini, 0);
    // v0.24.23: やっさんの手元で 144.8秒→次は 180秒で時間切れ。考える量を減らし、長く待つ
    const lb = seen.bodies.find(b => (b.prompt || '').includes('目次付きの要約'));
    eq('考える量を減らし（effort: low）、600秒まで待つ', [lb.effort, lb.timeoutMs], ['low', 600000]);

    console.log('■ 目次を押すとその節へ飛ぶ');
    const jumped = await page.evaluate(() => {
      let hit = '';
      const orig = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function () { hit = this.textContent; };
      document.querySelector('#live-summary [data-ls-jump="2"]').click();
      Element.prototype.scrollIntoView = orig;
      return hit;
    });
    eq('2番目を押すと 2番目の節', jumped, '2. ルーブリック（進行中）');

    console.log('■ 増えていなければ回さない');
    await page.evaluate(() => { state.liveSummaryLastAt = 0; liveSummaryTick(); });
    await page.waitForTimeout(500);
    eq('同じ中身で作り直さない', seen.claude.filter(p => p.includes('目次付きの要約')).length, 1);

    console.log('■ 録音を止めたら最終版に更新する（普通の要約は aiEnabled:false なのでここでは作られない）');
    await fillTranscript(page, '次にルーブリックの話です。四段階で示します。'.repeat(12));
    await page.evaluate(() => stopRecording());
    await page.waitForTimeout(2500);
    const lives = seen.claude.filter(p => p.includes('目次付きの要約'));
    eq('最終版を頼んだ', lives.length, 2);
    eq('最終版には前回の要約を渡す', lives[1].includes('【前回の要約】') && lives[1].includes('評価の観点'), true);
    eq('最終版では（進行中）を付けさせない', lives[1].includes('「（進行中）」は付けない'), true);
    eq('（進行中）が消えた', (await summary(page)).secs, ['1. 評価の観点', '2. ルーブリック']);
    eq('Gemini は使っていない', seen.gemini, 0);
    // v0.24.39: 「要約・タイトル生成」はライブ整形（aiEnabled）と独立したので、普通の要約は作られる。
    // 見るのは、目次付きのライブ要約が要約タブに入っていないこと
    eq('ライブ要約は要約タブに書いていない（別のタブ）', await page.evaluate(() => !document.querySelector('#summary .live-summary-toc')), true);

    console.log('■ リアルタイム要約タブの「最初から要約し直す」');
    await page.evaluate(() => { switchInnerPane('pane-live'); });
    await page.click('#btn-live-redo');
    await page.waitForTimeout(1500);
    const last = seen.claude.filter(p => p.includes('目次付きの要約')).pop();
    eq('前回に縛られず全体から組み立てる', [last.includes('いまある文字起こし全体を見て'), last.includes('【前回の要約】')], [true, false]);
    eq('ここでも Gemini は使わない', seen.gemini, 0);
    await ctx.close();
  }

  console.log('■ Claude に回せなかったら、Gemini には切り替えず見送る');
  {
    const { ctx, page, seen } = await open(browser, { claude: 'fail' });
    await fillTranscript(page, T);
    const before = await page.innerHTML('#live-summary');
    const ok = await page.evaluate(() => runLiveSummary({ sessionId: state.activeId }));
    eq('更新しない', [ok, await page.innerHTML('#live-summary')], [false, before]);
    eq('Gemini には頼んでいない', seen.gemini, 0);
    eq('画面に理由を出す', (await page.textContent('#status-indicator')).includes('ライブ要約を更新できませんでした'), true);
    await ctx.close();
  }

  // v0.24.93: ライブ要約は Gemini でも作れるようにした。選べないのは Gemini も Claude も使えないとき
  console.log('■ 設定: Gemini も Claude も使えないときは選べない');
  {
    const { ctx, page } = await open(browser, { settings: { useClaudeBridge: false, liveSummary: false, geminiEnabled: false } });
    await page.evaluate(() => document.getElementById('btn-settings').click());
    await page.waitForTimeout(200);
    const st = () => page.evaluate(() => ({
      disabled: document.getElementById('input-live-summary').disabled,
      note: !document.getElementById('live-summary-note').hidden,
    }));
    eq('押せない・理由が出る', await st(), { disabled: true, note: true });
    // v0.24.39: ライブ要約の前提は「Claude Code」（連携を使う）のトグル
    await page.evaluate(() => { const b = document.getElementById('input-claude-code'); b.checked = true; b.dispatchEvent(new Event('change')); });
    await page.waitForTimeout(800);   // v0.24.77: 断り書きは高さと濃さをばねでしまうので、しまい終わってから見る
    eq('Claude 連携をオンにすると押せる', await st(), { disabled: false, note: false });
    await page.evaluate(() => { const b = document.getElementById('input-claude-code'); b.checked = false; b.dispatchEvent(new Event('change')); });
    await page.waitForTimeout(800);
    eq('Claude を切るとまた押せない', await st(), { disabled: true, note: true });
    await page.evaluate(() => { const b = document.getElementById('input-gemini-enabled'); b.checked = true; b.dispatchEvent(new Event('change')); });
    await page.waitForTimeout(800);
    eq('Gemini API（キーあり）をオンにしても押せる（v0.24.93）', await st(), { disabled: false, note: false });
    await ctx.close();
  }

  console.log('■ 設定を開いて保存しても、オンのまま（v0.24.22 で踏んだ順番の穴）');
  {
    const { ctx, page } = await open(browser);
    await page.evaluate(() => document.getElementById('btn-settings').click());
    await page.waitForTimeout(200);
    eq('開いたときチェックが入ったまま・押せる', await page.evaluate(() => {
      const b = document.getElementById('input-live-summary'); return [b.checked, b.disabled];
    }), [true, false]);
    await page.evaluate(() => { document.getElementById('input-live-summary-min').value = '7'; saveSettingsFromForm(); });
    await page.waitForTimeout(200);
    eq('保存してもオンのまま、分数は変えた値', await page.evaluate(() => [state.settings.liveSummary, state.settings.liveSummaryMin]), [true, 7]);
    await ctx.close();
  }

  // ───── v0.24.25: 要約とは別のタブ ─────
  // やっさん「リアルタイム要約と要約それぞれの良さがあると思うから、オンにしたらタブを表示して、
  // オフにしたら非表示にして、それぞれ分けてほしい」
  const tabs = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.inner-tab')).map(t => t.dataset.pane));

  console.log('■ タブはオンのときだけ出て、オフにすると隠れる');
  {
    const { ctx, page } = await open(browser);
    eq('オン: 要約の左に ライブ要約のタブ（v0.24.26）', await tabs(page), ['pane-transcript', 'pane-memo', 'pane-live', 'pane-summary', 'pane-chat']);
    eq('タブの名前は「ライブ要約」（v0.24.28。RT要約はリツイートに見えるので変えた）', await page.evaluate(() => document.querySelector('.inner-tab[data-pane="pane-live"]').textContent.trim()), 'ライブ要約');
    await page.evaluate(() => switchInnerPane('pane-live'));
    await page.evaluate(() => document.getElementById('btn-settings').click());
    await page.waitForTimeout(200);
    await page.evaluate(() => { document.getElementById('input-live-summary').checked = false; saveSettingsFromForm(); });
    await page.waitForTimeout(400);
    eq('オフ: タブが隠れる', (await tabs(page)).includes('pane-live'), false);
    eq('開いていたなら要約タブへ移る', await page.evaluate(() => state.activePane), 'pane-summary');
    await ctx.close();
  }

  console.log('■ 前の版の並び順（ライブ要約が無い）でも、要約の左に入る');
  {
    const { ctx, page } = await open(browser, { settings: { paneOrder: ['pane-memo', 'pane-transcript', 'pane-summary', 'pane-chat'] } });
    eq('自分で並べ替えた順は保ったまま、要約の左に足す', await tabs(page), ['pane-memo', 'pane-transcript', 'pane-live', 'pane-summary', 'pane-chat']);
    await ctx.close();
  }

  console.log('■ 止めたら、リアルタイム要約の最終版と普通の要約の両方ができる');
  {
    const { ctx, page, seen } = await open(browser, { settings: { aiEnabled: true } });
    await page.evaluate(() => startRecording());
    await page.waitForTimeout(300);
    await fillTranscript(page, T);
    await page.evaluate(() => stopRecording());
    await page.waitForTimeout(3000);
    eq('リアルタイム要約タブに目次', (await summary(page)).toc.length > 0, true);
    eq('要約タブには普通の要約（Claude 連携オンなので Claude）', (await page.textContent('#summary')).includes('講義のタイトル'), true);
    eq('目次付きの要約を最終版として頼んだ', seen.claude.some(p => p.includes('目次付きの要約') && p.includes('「（進行中）」は付けない')), true);
    await ctx.close();
  }

  console.log('■ 前の版で要約タブに書かれた目次付き要約は、リアルタイム要約タブへ移す');
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
    // アプリが起動する前に仕込む（起動後に書くと、読み込み直す瞬間にアプリが上書きする）
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('dictation:settings', JSON.stringify({ useClaudeBridge: true, liveSummary: true }));
      localStorage.setItem('dictation:sessions', JSON.stringify([
        { id: 's1', title: 'a', transcript: '', memo: '', chat: [],
          // v0.24.22〜24 が実際に保存していた形（renderLiveSummaryHtml の出力そのまま）
          summary: '<h2 class="live-summary-toc-head">目次</h2>\n<ol class="live-summary-toc">\n<li data-ls-jump="1">a</li>\n</ol>\n<h2 data-ls-section="1">1. a</h2>\n<ul>\n<li>x</li>\n</ul>' },
        { id: 's2', title: 'b', transcript: '', memo: '', chat: [], summary: '<h2>概要</h2><p>普通の要約</p>' },
      ]));
      localStorage.setItem('dictation:activeTab', 's1');
    });
    await page.goto(URL);
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => state.sessions.map(x => [x.id, !!x.summary, !!x.liveSummary]));
    eq('印の付いたものだけ移し、普通の要約は触らない', r, [['s1', false, true], ['s2', true, false]]);
    eq('移したものがタブに出る', await page.evaluate(() => document.querySelector('#live-summary .live-summary-toc') !== null), true);
    await ctx.close();
  }

  console.log('■ 隠れているタブは、コピーにも載らない');
  {
    const { ctx, page } = await open(browser, { settings: { liveSummary: false } });
    await page.evaluate(() => { els.liveSummary.innerHTML = '<p>隠れている中身</p>'; els.summary.innerHTML = '<p>要約</p>'; });
    eq('コピーの文面に入らない', await page.evaluate(() => buildCombinedPlain().includes('隠れている中身')), false);
    eq('要約は入る', await page.evaluate(() => buildCombinedPlain().includes('要約')), true);
    await ctx.close();
  }

  console.log('■ リアルタイム要約がオフなら、これまでどおり');
  {
    const { ctx, page, seen } = await open(browser, { settings: { liveSummary: false, aiEnabled: true } });
    await page.evaluate(() => startRecording());
    await fillTranscript(page, T);
    await page.evaluate(() => { state.liveSummaryLastAt = 0; liveSummaryTick(); });
    await page.waitForTimeout(500);
    eq('録音中に目次付き要約は作らない', seen.claude.filter(p => p.includes('目次付きの要約')).length, 0);
    await page.evaluate(() => stopRecording());
    await page.waitForTimeout(2500);
    eq('止めたら普通の要約（Claude 連携オンなので Claude）', seen.claude.some(p => !p.includes('目次付きの要約') && p.includes('要約')), true);
    await ctx.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
