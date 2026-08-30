/**
 * dictation — Notion API クライアント
 * v0.14.1 セッション（タブバーの1タブ）を Notion のノートとして保存する
 *
 * ■ API バージョン
 * 2025-09-03 を使う。この版から Notion のデータモデルが
 *   データベース → データソース → ページ
 * の3階層になり、ページ作成の親は database_id ではなく data_source_id を渡す。
 * 公式 SDK @notionhq/client v5.26.0 の既定値 (Client.defaultNotionVersion) に合わせている。
 *
 * ■ CORS の制約（重要）
 * api.notion.com はブラウザからの直接アクセスに CORS ヘッダを返さない。
 * Chrome 拡張のページは manifest.json の host_permissions に載っているホストに対しては
 * CORS の対象外になるため、**拡張版でのみ動作する**。
 * HTML 版（serve.js の localhost:8765）では fetch がブラウザに弾かれる。
 * 呼び出し側は notionIsAvailable() で分岐すること。
 *
 * ■ API 側の上限（chunk 処理の根拠）
 * - children 配列は 1 リクエストにつき 100 ブロックまで
 * - rich_text 1 要素の content は 2000 文字まで
 */

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2025-09-03';
const NOTION_MAX_CHILDREN = 100;
const NOTION_MAX_TEXT = 2000;

/** この実行環境で Notion 連携が使えるか（拡張版のみ true） */
function notionIsAvailable() {
  return location.protocol === 'chrome-extension:';
}

/* ───────── HTTP ───────── */

/**
 * Notion API の薄い呼び出し。失敗時はやっさんが読んで分かる日本語にして throw する。
 */
async function notionRequest(path, { token, method = 'GET', body } = {}) {
  if (!token) throw new Error('Notion インテグレーショントークンが設定されていません（設定 → Notion 連携）');

  let res;
  try {
    res = await fetch(NOTION_API_BASE + path, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // 拡張版以外だと CORS でここに落ちる
    if (!notionIsAvailable()) {
      throw new Error('Notion 連携は Chrome 拡張版でのみ使えます（HTML 版はブラウザの CORS 制限で通信できません）');
    }
    throw new Error('Notion に接続できませんでした: ' + e.message);
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* JSON でない応答はそのまま握る */ }

  if (!res.ok) {
    const err = new Error(notionErrorMessage(res.status, data));
    err.status = res.status;
    err.code = data?.code || null;
    throw err;
  }
  return data;
}

function notionErrorMessage(status, data) {
  const raw = data?.message || `HTTP ${status}`;
  if (status === 401) return 'Notion トークンが無効です。設定のトークンを確認してください';
  if (status === 403) return 'Notion がこの操作を許可しませんでした（インテグレーションの権限を確認してください）';
  if (status === 404) return '保存先が見つかりません。Notion 側でデータベースをインテグレーションに接続（コネクト）してください';
  if (status === 429) return 'Notion のレート制限にかかりました。少し待ってからやり直してください';
  if (status >= 500) return `Notion 側で一時的なエラーが発生しました（${status}）`;
  return raw;
}

/* ───────── 保存先（データソース）の取得 ───────── */

/** rich_text 配列 → プレーンテキスト */
function notionPlainText(rich) {
  if (!Array.isArray(rich)) return '';
  return rich.map(r => r?.plain_text ?? r?.text?.content ?? '').join('');
}

/**
 * インテグレーションに接続されているデータソースを一覧する。
 * Notion 側で「コネクト」していないデータベースはここに出てこない（API の仕様）。
 * @returns {Promise<Array<{id:string, title:string}>>}
 */
async function notionListDataSources(token) {
  const out = [];
  let cursor = null;
  do {
    const data = await notionRequest('/search', {
      token,
      method: 'POST',
      body: {
        filter: { property: 'object', value: 'data_source' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      },
    });
    for (const r of data?.results || []) {
      if (r?.in_trash || r?.archived) continue;
      out.push({ id: r.id, title: notionPlainText(r.title) || '(無題のデータベース)' });
    }
    cursor = data?.has_more ? data.next_cursor : null;
  } while (cursor);
  return out;
}

/**
 * データソースの「タイトル列」の名前を得る。
 * ページ作成時の properties のキーに使う。DB ごとに「名前」「Name」など違うため毎回引く。
 */
async function notionGetTitlePropName(token, dataSourceId) {
  const ds = await notionRequest(`/data_sources/${dataSourceId}`, { token });
  const props = ds?.properties || {};
  for (const [name, conf] of Object.entries(props)) {
    if (conf?.type === 'title') return name;
  }
  throw new Error('保存先にタイトル列が見つかりませんでした');
}

/* ───────── リッチテキスト / ブロック生成 ───────── */

/**
 * 文字列を rich_text 配列にする。2000 文字上限があるので分割する。
 * @param {string} text
 * @param {object} ann - { bold, italic, code } などの annotations
 */
function notionRichText(text, ann) {
  const s = String(text ?? '');
  if (!s) return [];
  const items = [];
  for (let i = 0; i < s.length; i += NOTION_MAX_TEXT) {
    const item = { type: 'text', text: { content: s.slice(i, i + NOTION_MAX_TEXT) } };
    if (ann) item.annotations = ann;
    items.push(item);
  }
  return items;
}

/** 1つの DOM 要素の中身を、装飾を保ったまま rich_text 配列にする */
function notionRichTextFromNode(node) {
  const items = [];
  const walk = (n, ann) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n.nodeValue;
      if (t) items.push(...notionRichText(t, ann));
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const tag = n.tagName.toLowerCase();
    if (tag === 'br') { items.push(...notionRichText('\n', ann)); return; }
    // チェックボックス自身は本文に出さない
    if (tag === 'input') return;
    const next = { ...(ann || {}) };
    if (tag === 'strong' || tag === 'b') next.bold = true;
    if (tag === 'em' || tag === 'i') next.italic = true;
    if (tag === 'code') next.code = true;
    if (tag === 's' || tag === 'del') next.strikethrough = true;
    if (tag === 'u') next.underline = true;
    const annOut = Object.keys(next).length ? next : null;
    for (const child of n.childNodes) walk(child, annOut);
  };
  for (const child of node.childNodes) walk(child, null);

  // rich_text 配列は 100 要素まで。溢れる分は落とさずに連結して詰め直す
  if (items.length > 100) {
    const merged = items.map(i => i.text.content).join('');
    return notionRichText(merged).slice(0, 100);
  }
  return items;
}

const notionBlock = {
  paragraph: rich => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rich } }),
  heading: (level, rich) => {
    const key = `heading_${Math.min(3, Math.max(1, level))}`;
    return { object: 'block', type: key, [key]: { rich_text: rich, is_toggleable: false } };
  },
  bulleted: rich => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rich } }),
  numbered: rich => ({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: rich } }),
  todo: (rich, checked) => ({ object: 'block', type: 'to_do', to_do: { rich_text: rich, checked: !!checked } }),
  quote: rich => ({ object: 'block', type: 'quote', quote: { rich_text: rich } }),
  code: (rich, lang) => ({ object: 'block', type: 'code', code: { rich_text: rich, language: lang || 'plain text' } }),
  divider: () => ({ object: 'block', type: 'divider', divider: {} }),
  toggle: (rich, children) => ({ object: 'block', type: 'toggle', toggle: { rich_text: rich, ...(children?.length ? { children } : {}) } }),
};

/**
 * このアプリのペインが持つ HTML を Notion ブロック配列に変換する。
 *
 * 対応する構造（app.js のメモエディタ / renderMarkdown が実際に吐くもの）:
 *   h1〜h3, p, div, ul>li, ol>li, div.task-item(チェックボックス), blockquote, hr, pre/code
 * それ以外のタグは段落として扱う。
 */
function notionBlocksFromHtml(html) {
  if (!html || !html.trim()) return [];
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = doc.getElementById('root');
  const blocks = [];

  const pushText = (node, make) => {
    const rich = notionRichTextFromNode(node);
    if (rich.length === 0) return;          // 空行は落とす
    blocks.push(make(rich));
  };

  const visit = (el) => {
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'h1': pushText(el, r => notionBlock.heading(1, r)); return;
      case 'h2': pushText(el, r => notionBlock.heading(2, r)); return;
      case 'h3': case 'h4': case 'h5': case 'h6':
        pushText(el, r => notionBlock.heading(3, r)); return;
      case 'hr': blocks.push(notionBlock.divider()); return;
      case 'blockquote': pushText(el, notionBlock.quote); return;
      case 'pre': {
        const rich = notionRichText(el.textContent || '');
        if (rich.length) blocks.push(notionBlock.code(rich));
        return;
      }
      case 'ul':
        for (const li of el.children) pushText(li, notionBlock.bulleted);
        return;
      case 'ol':
        for (const li of el.children) pushText(li, notionBlock.numbered);
        return;
      case 'li':  // 親なしで裸の li が来た場合
        pushText(el, notionBlock.bulleted); return;
      default: {
        if (el.classList && el.classList.contains('task-item')) {
          const cb = el.querySelector('input[type="checkbox"]');
          pushText(el, r => notionBlock.todo(r, cb?.checked));
          return;
        }
        // 中にブロック要素を含む入れ物（.paragraph や chat-block など）は掘り下げる
        const hasBlockChild = Array.from(el.children).some(c =>
          ['h1','h2','h3','h4','h5','h6','p','div','ul','ol','hr','blockquote','pre'].includes(c.tagName.toLowerCase()));
        if (hasBlockChild) {
          for (const child of Array.from(el.children)) visit(child);
          return;
        }
        pushText(el, notionBlock.paragraph);
      }
    }
  };

  for (const child of Array.from(root.children)) visit(child);

  // 子要素が無くテキストだけ（<div>無しの生テキスト）だった場合の保険
  if (blocks.length === 0) {
    const t = (root.textContent || '').trim();
    if (t) for (const line of t.split('\n')) {
      const rich = notionRichText(line.trim());
      if (rich.length) blocks.push(notionBlock.paragraph(rich));
    }
  }
  return blocks;
}

/** プレーンテキスト → 段落ブロック配列（空行は捨てる） */
function notionBlocksFromText(text) {
  if (!text) return [];
  return String(text).split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => notionBlock.paragraph(notionRichText(l)));
}

/* ───────── ノート作成 ───────── */

function notionChunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * データソースに 1 ノートを作る。
 * ペインごとに 1 つのトグルを作り、その中に本文ブロックをぶら下げる。
 *
 * children は 1 リクエスト 100 ブロックまでなので、
 *   1) タイトルだけのページを作る
 *   2) トグルを 1 個ずつ append（最初の 100 ブロックは同時に入れる）
 *   3) 溢れた分をそのトグルの子として追加 append
 * の順で分割送信する。
 *
 * @param {object} args
 * @param {string} args.token
 * @param {string} args.dataSourceId
 * @param {string} args.title            ノートのタイトル（= セッションのタイトル）
 * @param {Array<{label:string, blocks:Array}>} args.toggles
 * @param {function} [args.onProgress]   (done, total) で進捗を返す
 * @returns {Promise<{id:string, url:string}>}
 */
async function notionCreateNote({ token, dataSourceId, title, toggles, onProgress }) {
  const titleProp = await notionGetTitlePropName(token, dataSourceId);

  const page = await notionRequest('/pages', {
    token,
    method: 'POST',
    body: {
      parent: { type: 'data_source_id', data_source_id: dataSourceId },
      properties: {
        [titleProp]: { title: notionRichText(title || '無題', null).slice(0, 100) },
      },
    },
  });

  const pageId = page?.id;
  if (!pageId) throw new Error('Notion がページIDを返しませんでした');

  const total = toggles.length;
  let done = 0;
  for (const t of toggles) {
    const chunks = notionChunk(t.blocks, NOTION_MAX_CHILDREN);
    const first = chunks.shift() || [];
    const res = await notionRequest(`/blocks/${pageId}/children`, {
      token,
      method: 'PATCH',
      body: { children: [notionBlock.toggle(notionRichText(t.label), first)] },
    });
    const toggleId = res?.results?.[0]?.id;
    if (toggleId) {
      for (const chunk of chunks) {
        await notionRequest(`/blocks/${toggleId}/children`, {
          token, method: 'PATCH', body: { children: chunk },
        });
      }
    }
    done += 1;
    if (onProgress) onProgress(done, total);
  }

  return { id: pageId, url: page?.url || '' };
}

/** 設定画面の「接続テスト」用。成功したらワークスペース上の表示名を返す */
async function notionTestConnection(token) {
  const me = await notionRequest('/users/me', { token });
  return me?.name || me?.bot?.workspace_name || 'Notion';
}
