/**
 * term-dicts.js — 語彙辞書（プリセット＋自作） (v0.20.0)
 *
 * v0.16 の「よく出る語」は、タブごとに手で書くものだった。実素材のテストで
 * 「教科」が全部「強化」になり、**分野が決まっているなら毎回書くのは無駄**
 * だと分かったので、辞書として持ち回せるようにする。
 *
 * ■ 語彙ヒントは効くぶん、効きすぎる
 *
 * 先に語を渡すと音声認識はその語を選びやすくなる。それが狙いだが、
 * **言っていない語まで選ばれる**ようになる。医療の辞書を入れると
 * 「しょけん」が常に「所見」になり、「初見」と言っても直されうる。
 *
 * 避けようがないトレードオフなので、プリセットには
 * **一般語と同音でぶつかりやすい語をなるべく入れない**方針で選んである。
 * （例: 「対応」「機能」のような、どの分野でも出るうえ誤変換もされない語は
 *   入れる価値が無いだけでなく、上限を圧迫するので害になる）
 *
 * 入れる価値があるのは次のどちらか:
 *   1. 同音異義語で、その分野では特定の表記になるもの（決裁／決済、教科／強化）
 *   2. 一般の辞書に無い、または音から想像しにくい専門語（褥瘡、稟議、冪等）
 */

/**
 * 組み込みプリセット。
 * ここは**利用者が編集できない**。自分用に変えたいときは「複製して自作辞書にする」。
 */
const TERM_PRESETS = [
  {
    id: 'preset:education',
    name: '教育・学校',
    hint: '授業・校務・指導要領まわり',
    terms: [
      '教科', '教育課程', '学習指導要領', '指導要録', '通級指導', '特別支援',
      '校務分掌', '学級経営', '単元', '履修', '生徒指導', '不登校',
      '就学支援', '学年会', '教務主任', '研究授業', '授業時数', '学習評価',
      '個別最適な学び', '協働的な学び', '教育支援センター', '特別活動',
    ],
  },
  {
    id: 'preset:business',
    name: 'ビジネス・会議',
    hint: '稟議・決裁・数字まわり',
    terms: [
      '稟議', '決裁', '与信', '与件', '商流', '粗利', '販管費', '原価率',
      '内示', '起案', '締結', '所管', '四半期', '上期', '下期',
      '中期経営計画', '取締役会', '見積', '発注', '検収', '与信枠', '棚卸',
    ],
  },
  {
    id: 'preset:medical',
    name: '医療・介護',
    hint: '所見・処方・ケアまわり',
    terms: [
      '既往歴', '主訴', '所見', '転帰', '予後', '罹患', '嚥下', '誤嚥',
      '褥瘡', '服薬', '処方', '疾患', '病棟', '検体', 'バイタル',
      '要介護', 'ケアプラン', '訪問看護', '認知症', '転院', '退院支援', '禁忌',
    ],
  },
  {
    id: 'preset:it',
    name: 'IT・開発',
    hint: '設計・運用・障害対応まわり',
    terms: [
      'リポジトリ', 'プルリクエスト', 'マージ', 'ブランチ', 'デプロイ',
      'ロールバック', 'コンテナ', 'オンプレ', '冗長化', '疎結合',
      '認証', '認可', '脆弱性', '可用性', '冪等', 'リファクタリング',
      'スプリント', 'バックログ', 'レイテンシ', 'スループット', '本番環境', '結合試験',
    ],
  },
  {
    id: 'preset:government',
    name: '行政・自治体',
    hint: '条例・予算・審議会まわり',
    terms: [
      '条例', '要綱', '要領', '答申', '諮問', '議案', '所管', '起案',
      '決裁', '告示', '公示', '補正予算', '交付金', '委託料', '審議会',
      '協議会', 'パブリックコメント', '住民説明会', '施行', '施策', '陳情', '専決',
    ],
  },
  {
    id: 'preset:research',
    name: '研究・学術',
    hint: '調査・分析・発表まわり',
    terms: [
      '先行研究', '有意差', '母集団', '標本', '仮説', '検証', '査読',
      '抄録', '考察', '定量', '定性', 'エビデンス', 'バイアス', '再現性',
      '倫理審査', '学会発表', '交絡', '尺度', '質的研究', '量的研究', '横断研究', '縦断研究',
    ],
  },
];

/** 合成後の語数の上限。多すぎると効き目が薄まり、トークンも無駄になる */
const TERM_MERGE_CAP = 50;

/**
 * 語彙を1本にまとめる (v0.20.0)
 *
 * 純関数。ここが優先順位の唯一の置き場所になる。
 *
 * ■ 優先順位: 手入力 → 辞書（プリセット・自作） → 自動
 *
 * 手入力が最優先なのは v0.16.1 から変わらない。やっさんが書いた語が最終権限。
 *
 * **辞書を自動より前に置くのが v0.20.0 の判断。**
 * 録音中にプリセットへ切り替えるのは「教科と書いてくれ」という
 * 明示的な訂正なので、上限で削られては意味がない。
 * 自動抽出は放っておいても育つので、削られる側になってもらう。
 *
 * ■ 重複は先勝ち
 *
 * 同じ語が複数の出どころにあれば、優先順位が高いほうの位置に残す。
 *
 * @param {object} args
 * @param {string[]} [args.manual]  手入力
 * @param {string[]} [args.dict]    辞書（プリセット・自作をつないだもの）
 * @param {string[]} [args.auto]    自動抽出
 * @param {number}   [args.cap]
 * @returns {{terms: string[], dropped: number}} dropped = 上限で落ちた語数
 */
function mergeTermSources({ manual, dict, auto, cap } = {}) {
  const limit = Number.isFinite(cap) && cap > 0 ? cap : TERM_MERGE_CAP;
  const seen = new Set();
  const out = [];
  let considered = 0;

  for (const list of [manual || [], dict || [], auto || []]) {
    for (const raw of list) {
      const t = String(raw || '').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      considered++;
      if (out.length < limit) out.push(t);
    }
  }
  return { terms: out, dropped: Math.max(0, considered - out.length) };
}

/** id から辞書を引く（プリセットと自作の両方を見る） */
function findTermDict(id, userDicts) {
  return TERM_PRESETS.find(d => d.id === id)
    || (userDicts || []).find(d => d.id === id)
    || null;
}

/**
 * 適用中の辞書たちの語を1本につなぐ。
 * 見つからない id は黙って飛ばす（辞書を消したあとも壊れないように）
 */
function collectDictTerms(ids, userDicts) {
  const out = [];
  for (const id of ids || []) {
    const d = findTermDict(id, userDicts);
    if (d) out.push(...(d.terms || []));
  }
  return out;
}

/**
 * フッターに出す短い表示を作る (v0.20.0)
 *
 * 「何が効いているか」が一目で分かることが目的。**間違いを減らすための表示**なので、
 * 何も効いていないときにそう言うことも同じくらい大事。
 */
function describeTermState({ dictNames, manualCount, autoCount }) {
  const names = (dictNames || []).filter(Boolean);
  const parts = [];
  if (names.length === 1) parts.push(names[0]);
  else if (names.length > 1) parts.push(`${names[0]} ほか${names.length - 1}件`);
  if (manualCount) parts.push(`手入力${manualCount}`);
  if (autoCount) parts.push(`自動${autoCount}`);
  return parts.length ? parts.join(' / ') : '辞書なし';
}
