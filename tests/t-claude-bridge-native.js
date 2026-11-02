// claude-bridge.js が、インストール式の口（ネイティブメッセージング）と、
// これまでの中継（start.bat の HTTP）をどう使い分けるか (v0.24.21)。
//
// chrome.runtime.sendNativeMessage と fetch を差し替えて、実物の claude-bridge.js を動かす。
// 依存なし。本物の Chrome / Edge がホストを起動するところは見ていない。
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.resolve(process.env.SRC || __dirname + '/../');

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

/**
 * @param native  undefined = 拡張でない（ブラウザ版）
 *                { lastError } = ブラウザがエラーを返す / { reply } = ホストの返事
 * @param http    'down' = 繋がらない / { ...json } = 中継の返事
 */
function load({ native, http }) {
  const calls = { native: [], http: 0 };
  const chrome = native === undefined ? undefined : {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      lastError: undefined,
      sendNativeMessage(name, msg, cb) {
        calls.native.push({ name, type: msg.type });
        this.lastError = native.lastError ? { message: native.lastError } : undefined;
        cb(native.reply);
        this.lastError = undefined;
      },
    },
  };
  const ctx = {
    console, JSON, Promise, String, RegExp, Error, Object, Array,
    chrome,
    fetch: async () => {
      calls.http++;
      if (http === 'down') throw new TypeError('Failed to fetch');
      return { ok: !!http.ok, status: http.ok ? 200 : 502, json: async () => http };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'claude-bridge.js'), 'utf8'), ctx);
  return { ctx, calls };
}

(async () => {
  console.log('■ 拡張でインストール済み');
  {
    const { ctx, calls } = load({ native: { reply: { ok: true, text: '```markdown\n要約\n```', seconds: 3 } }, http: 'down' });
    const r = await ctx.claudeBridgeRun('まとめて');
    eq('インストール式の口で処理する', [r.ok, r.text, r.via], [true, '要約', 'native']);
    eq('登録名は com.dictation.helper', calls.native[0], { name: 'com.dictation.helper', type: 'run' });
    eq('start.bat の中継には行かない', calls.http, 0);
  }
  {
    const { ctx } = load({ native: { reply: { ok: false, error: 'Failed to authenticate: OAuth session expired' } }, http: { ok: true, text: 'x' } });
    const r = await ctx.claudeBridgeRun('まとめて');
    eq('claude の失敗はそのまま返す（中継に回し直さない）', [r.ok, /OAuth/.test(r.error)], [false, true]);
    eq('画面の文言はログイン切れ', ctx.claudeBridgeFallbackMessage(r.error), 'Claude のログインが切れているので Gemini で処理');
  }

  console.log('\n■ 拡張で未インストール');
  {
    const { ctx, calls } = load({ native: { lastError: 'Specified native messaging host not found.' }, http: 'down' });
    const r = await ctx.claudeBridgeRun('まとめて');
    eq('中継も無ければ「インストールされていません」', r.error, vm.runInContext('CLAUDE_NOT_INSTALLED', ctx));
    eq('start.bat を起動しろとは言わない', /start\.bat/.test(ctx.claudeBridgeFallbackMessage(r.error)), false);
    eq('画面の文言', ctx.claudeBridgeFallbackMessage(r.error), 'Claude 連携が未インストールなので Gemini で処理');
    eq('一度は中継も試している（start.bat で使っていた人のため）', calls.http, 1);
  }
  {
    const { ctx } = load({ native: { lastError: 'Specified native messaging host not found.' }, http: { ok: true, text: '中継の答え', seconds: 2 } });
    const r = await ctx.claudeBridgeRun('まとめて');
    eq('start.bat の中継が動いていればそれで処理する（インストールまでの間も使える）', [r.ok, r.text, r.via], [true, '中継の答え', 'http']);
  }

  console.log('\n■ 拡張で、入ってはいるが使えない');
  {
    const { ctx, calls } = load({ native: { lastError: 'Access to the specified native messaging host is forbidden.' }, http: { ok: true, text: 'x' } });
    const r = await ctx.claudeBridgeRun('まとめて');
    eq('別の場所の拡張用に入っている → 入れ直してと言う', /入れ直して/.test(r.error), true);
    eq('中継には回さない', calls.http, 0);
    eq('画面の文言', ctx.claudeBridgeFallbackMessage(r.error), 'Claude 連携を入れ直す必要があるので Gemini で処理');
  }
  {
    const { ctx } = load({ native: { lastError: 'Native host has exited.' }, http: 'down' });
    const r = await ctx.claudeBridgeRun('まとめて');
    eq('補助プログラムが落ちた → そう言う', ctx.claudeBridgeFallbackMessage(r.error), 'Claude 連携の補助プログラムが動かないので Gemini で処理');
  }

  console.log('\n■ ブラウザ版（拡張でない）');
  {
    const { ctx, calls } = load({ native: undefined, http: 'down' });
    const r = await ctx.claudeBridgeRun('まとめて');
    eq('これまでどおり中継だけを使い、start.bat を案内する', ctx.claudeBridgeFallbackMessage(r.error), '中継に繋がらないので Gemini で処理（start.bat を起動）');
    eq('インストール式の口は呼ばない', calls.native.length, 0);
  }

  console.log('\n■ 「接続を確認」');
  {
    const { ctx } = load({ native: { reply: { ok: true, version: '0.24.23', invocation: 'wsl', via: 'native', features: ['effort', 'timeout'], auth: { ok: true, loggedIn: true } } }, http: 'down' });
    const h = await ctx.claudeBridgeHealth();
    eq('インストール式で使える', ctx.claudeBridgeHealthMessage(h).text, '使えます（ログイン済み / wsl / 連携 0.24.23）');
  }
  {
    // v0.24.21〜22 で入れた補助プログラムは調整（effort / timeout）を知らない
    const { ctx } = load({ native: { reply: { ok: true, version: '0.24.21', invocation: 'wsl', via: 'native', auth: { ok: true, loggedIn: true } } }, http: 'down' });
    const m = ctx.claudeBridgeHealthMessage(await ctx.claudeBridgeHealth());
    eq('古い補助プログラム → 使えるが、インストーラーで入れ直してと言う', [m.ok, m.stale, /インストーラーを保存して入れ直して/.test(m.text)], [true, true, true]);
  }

  console.log('\n■ リアルタイム要約の調整（effort / timeout）が届く');
  {
    const { ctx, calls } = load({ native: { reply: { ok: true, text: 'x' } }, http: 'down' });
    let sent = null;
    ctx.chrome.runtime.sendNativeMessage = (name, msg, cb) => { sent = msg; cb({ ok: true, text: 'x' }); };
    await ctx.claudeBridgeRun('まとめて', { effort: 'low', timeoutMs: 600000 });
    eq('インストール式には effort と timeoutMs を一緒に送る', [sent.effort, sent.timeoutMs], ['low', 600000]);
    sent = null;
    await ctx.claudeBridgeRun('まとめて');
    eq('調整なしの呼び出し（要約・質問）には付けない', ['effort' in sent, 'timeoutMs' in sent], [false, false]);
    void calls;
  }
  {
    const { ctx } = load({ native: { reply: { ok: true, version: '0.24.21', invocation: 'claude', via: 'native', auth: { ok: true, loggedIn: false } } }, http: 'down' });
    const m = ctx.claudeBridgeHealthMessage(await ctx.claudeBridgeHealth());
    eq('ログインしていない → インストーラーからサインインできると言う（login.bat ではなく）',
       [m.needsLogin, /インストーラー/.test(m.text), /login\.bat/.test(m.text)], [true, true, false]);
  }
  {
    const { ctx } = load({ native: { lastError: 'Specified native messaging host not found.' }, http: 'down' });
    const m = ctx.claudeBridgeHealthMessage(await ctx.claudeBridgeHealth());
    eq('未インストール → インストールを案内', m.text, vm.runInContext('CLAUDE_NOT_INSTALLED', ctx));
  }

  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
