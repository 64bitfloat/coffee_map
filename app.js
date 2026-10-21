/**
 * Coffee Flavor Atlas - 珈琲味覚マッピング＆記録帳
 * ・毎日同じ淹れ方で淹れる珈琲の主観スコアを記録し、回数分の平均と「日々の評価ブレ」を多軸四象限マップ＆レーダーで可視化
 * ・同じ銘柄で異なる焙煎プロファイル（バッチ）がある場合は1つの銘柄にまとめ、基本は「最高評価（★ベスト）プロファイル」を表示
 * ・銘柄詳細画面内でプロファイル切替や重ね合わせ比較が可能
 * ・「全プロファイル展開＆比較表」をONにした時のみ、マップ上で全プロファイルを展開し、全銘柄×全プロファイルの対照表を表示
 */

const STORAGE_KEY = 'coffee_flavor_atlas_logs_v1';
const SAMPLE_FLAG_KEY = 'coffee_flavor_atlas_is_sample_v1';

// セキュリティ上限設定（リソース枯渇・DoS対策）
const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024; // ファイルサイズ上限: 5MB
const MAX_IMPORT_RECORDS = 5000; // 最大ログ件数
const MAX_CURVE_POINTS = 600; // 焙煎カーブ保持ポイント上限
const MAX_RAW_ALOG_SAMPLES = 20000; // .alog 生配列の最大サンプル数

function clampNumber(val, min, max, fallback = 0) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeString(val, maxLen = 300, fallback = '') {
  if (val === null || val === undefined) return fallback;
  return String(val).trim().slice(0, maxLen);
}

// 合成焙煎カーブ生成ヘルパー（滑らかなArtisan特有の減衰RoR曲線とBT/ET曲線）
function buildSyntheticRoastCurve({
  chargeTemp = 195,
  tpTimeSec = 80,
  tpTemp = 102,
  dryEndSec = 270,
  dryEndTemp = 152,
  fcsSec = 470,
  fcsTemp = 196,
  dropSec = 565,
  dropTemp = 207,
} = {}) {
  // 異常値・無限ループ（DoS）防止のためすべてのパラメータを現実的な範囲へクランプ
  const safeDropSec = clampNumber(dropSec, 60, 3600, 565);
  const safeTpTimeSec = clampNumber(tpTimeSec, 10, Math.max(20, safeDropSec - 30), 80);
  const safeFcsSec = clampNumber(fcsSec, safeTpTimeSec + 10, safeDropSec, 470);
  const safeChargeTemp = clampNumber(chargeTemp, 50, 320, 195);
  const safeTpTemp = clampNumber(tpTemp, 40, 220, 102);
  const safeFcsTemp = clampNumber(fcsTemp, 100, 250, 196);
  const safeDropTemp = clampNumber(dropTemp, 120, 270, 207);

  const step = Math.max(5, Math.ceil(safeDropSec / 180));
  const timex = [];
  const bt = [];
  const et = [];
  const ror = [];

  const totalRiseTime = Math.max(60, safeDropSec - safeTpTimeSec);
  const totalRiseTemp = Math.max(40, safeDropTemp - safeTpTemp);

  const tRatioFcs = Math.max(0.1, Math.min(0.95, (safeFcsSec - safeTpTimeSec) / totalRiseTime));
  const tempRatioFcs = Math.max(0.1, Math.min(0.98, (safeFcsTemp - safeTpTemp) / totalRiseTemp));
  const gamma = Math.max(0.55, Math.min(0.92, Math.log(tempRatioFcs) / Math.log(tRatioFcs)));

  for (let t = 0; t <= safeDropSec; t += step) {
    timex.push(t);
    let curBt;
    if (t <= safeTpTimeSec) {
      const u = t / Math.max(1, safeTpTimeSec);
      curBt = safeTpTemp + (safeChargeTemp - safeTpTemp) * Math.pow(1 - u, 2.1);
    } else {
      const u = (t - safeTpTimeSec) / totalRiseTime;
      curBt = safeTpTemp + totalRiseTemp * Math.pow(u, gamma);
    }
    bt.push(Number(curBt.toFixed(2)));
    const curEt = curBt + 34 * Math.exp(-t / (safeDropSec * 0.85)) + 12;
    et.push(Number(curEt.toFixed(1)));
  }

  for (let i = 0; i < timex.length; i++) {
    const t = timex[i];
    if (t < safeTpTimeSec) {
      ror.push(null);
    } else {
      const dtMin = (timex[i] - timex[Math.max(0, i - 1)]) / 60;
      const rawRor = dtMin > 0 ? (bt[i] - bt[Math.max(0, i - 1)]) / dtMin : 0;
      const ramp = Math.min(1, (t - safeTpTimeSec) / 38);
      const smoothRor = rawRor * Math.pow(ramp, 0.8);
      ror.push(Number(Math.max(1.5, Math.min(22, smoothRor)).toFixed(2)));
    }
  }

  return { timex, bt, et, ror, smoothV3: true };
}

// 軸の定義
const AXES_META = {
  acidity: {
    label: '酸味・フルーティ',
    short: 'フルーティ',
    lowPole: '穏やか・低酸味',
    highPole: '鮮やか・フルーティ',
    min: 1,
    max: 10,
    unit: '',
    isRoastAxis: false,
    getValue: (s) => s.acidity,
  },
  bitterness: {
    label: '苦味・ビター',
    short: 'ビター',
    lowPole: '控えめ・マイルド',
    highPole: '力強い・ビター',
    min: 1,
    max: 10,
    unit: '',
    isRoastAxis: false,
    getValue: (s) => s.bitterness,
  },
  sweetness: {
    label: '甘み',
    short: '甘み',
    lowPole: 'ドライ・すっきり',
    highPole: 'リッチな甘み',
    min: 1,
    max: 10,
    unit: '',
    isRoastAxis: false,
    getValue: (s) => s.sweetness,
  },
  body: {
    label: 'コク・ボディ',
    short: 'コク',
    lowPole: '軽やか・ティーライク',
    highPole: '重厚・濃厚ボディ',
    min: 1,
    max: 10,
    unit: '',
    isRoastAxis: false,
    getValue: (s) => s.body,
  },
  aroma: {
    label: '香り・華やかさ',
    short: '華やかさ',
    lowPole: '落ち着き・ナッツ感',
    highPole: '華やか・アロマティック',
    min: 1,
    max: 10,
    unit: '',
    isRoastAxis: false,
    getValue: (s) => s.aroma,
  },
  aftertaste: {
    label: '余韻・後味',
    short: '余韻',
    lowPole: 'キレが良い・爽快',
    highPole: '長い余韻・持続',
    min: 1,
    max: 10,
    unit: '',
    isRoastAxis: false,
    getValue: (s) => s.aftertaste,
  },
  balance_ab: {
    label: '酸味(1) ⇔ 苦味(10)',
    short: '酸⇔苦バランス',
    lowPole: '酸味・果実味寄り',
    highPole: '苦味・ロースト寄り',
    min: 1,
    max: 10,
    unit: '',
    isRoastAxis: false,
    getValue: (s) => Math.max(1, Math.min(10, 5.5 + (s.bitterness - s.acidity) * 0.45)),
  },
  roast_dropTemp: {
    label: '🔥 排出温度 Drop Temp (℃)',
    short: '排出温度',
    lowPole: '低温・浅め (192℃)',
    highPole: '高温・深め (224℃)',
    min: 192,
    max: 224,
    unit: '℃',
    isRoastAxis: true,
    getValue: (_s, roast) => (roast ? Number(roast.dropTemp) : null),
  },
  roast_dtr: {
    label: '🔥 DTR 発達時間比率 (%)',
    short: 'DTR(%)',
    lowPole: '短め・クリーン (11%)',
    highPole: '長め・発達重視 (25%)',
    min: 11,
    max: 25,
    unit: '%',
    isRoastAxis: true,
    getValue: (_s, roast) => (roast ? Number(roast.dtr) : null),
  },
  roast_time: {
    label: '🔥 総焙煎時間 (分)',
    short: '焙煎時間',
    lowPole: '短時間・ファスト (7分)',
    highPole: '長時間・スロー (14分)',
    min: 7,
    max: 14,
    unit: '分',
    isRoastAxis: true,
    getValue: (_s, roast) => (roast && roast.dropSec ? Number((roast.dropSec / 60).toFixed(2)) : null),
  },
  roast_loss: {
    label: '🔥 重量減少率 (%)',
    short: '減少率(%)',
    lowPole: '軽減少 (11%)',
    highPole: '高減少 (19%)',
    min: 11,
    max: 19,
    unit: '%',
    isRoastAxis: true,
    getValue: (_s, roast) => (roast ? Number(roast.weightLoss) : null),
  },
};

const QUADRANT_TITLES = {
  'acidity__bitterness': {
    tr: { title: '芳醇・複雑 (Fruity & Bitter)', sub: 'オランジェット・赤ワイン・ダークベリー系' },
    tl: { title: '王道ビター・重厚', sub: 'ダークチョコ・クラシック深煎り系' },
    br: { title: 'ジューシー・爽快果実', sub: 'シトラス・ベリー・クリーン浅煎り系' },
    bl: { title: 'マイルド・柔和バランス', sub: 'ナッツ・穏やかな日常珈琲' },
  },
  'balance_ab__body': {
    tr: { title: '重厚ビター・フルボディ', sub: '濃厚エスプレッソ・深煎りの王道' },
    tl: { title: '芳醇ジューシー・リッチ', sub: '果実味ととろみが同居する個性派' },
    br: { title: 'すっきりビター・キレ', sub: '香ばしく軽快なロースト感' },
    bl: { title: 'クリーン＆ブライト', sub: '紅茶のように澄んだ果実味' },
  },
  'aftertaste__body': {
    tr: { title: '濃厚・ロングアフター', sub: '余韻に浸る重厚な一杯' },
    tl: { title: '重厚・クリーンフィニッシュ', sub: '飲みごたえがありつつ後味すっきり' },
    br: { title: '繊細・長い余韻', sub: '軽やかなのに香りが長く残る' },
    bl: { title: '軽快・クリスプ', sub: 'ゴクゴク飲める爽快なキレ' },
  },
  'aroma__sweetness': {
    tr: { title: '華やか・蜜のような甘み', sub: 'フローラル＆ハニー・デザート感' },
    tl: { title: 'ほっこり甘やか・ナッツ系', sub: 'キャラメルやミルクチョコの優しさ' },
    br: { title: '高貴・ドライアロマ', sub: 'スパイスやハーブ、爽やかな芳香' },
    bl: { title: '素朴・クラシック', sub: '飾らない落ち着いた味わい' },
  },
};

const ROAST_COLORS = {
  '浅煎り': '#d99b38',
  '中浅煎り': '#c4742f',
  '中煎り': '#8f4e27',
  '中深煎り': '#5c3118',
  '深煎り': '#241209',
};

const PROCESS_COLORS = {
  'ウォッシュト': '#3a7ca5',
  'ナチュラル': '#b84a39',
  'ハニー': '#d98a2b',
  'アナエロビック': '#7b4b94',
  'その他': '#6e655f',
};

const ORIGIN_PALETTE = [
  '#b84a39', '#3a7ca5', '#3b6e52', '#c88a4b',
  '#7b4b94', '#8f4e27', '#2b7a78', '#a63a50',
];

const PROFILE_COMPARE_COLORS = ['#ff8c42', '#38b6ff', '#d9534f', '#9b5de5'];

const DEFAULT_ORIGINS = [
  'エチオピア', 'ケニア', 'コロンビア', 'ブラジル',
  'グアテマラ', 'コスタリカ', 'インドネシア', 'パナマ',
  'ルワンダ', 'エルサルバドル', 'ペルー', 'タンザニア',
];

// サンプル用の自家焙煎プロファイル（同じ「エチオピア イルガチェフェ コンガ G1」内の2つのプロファイル）
const SAMPLE_ROAST_BATCH_1 = {
  isHomeRoasted: true,
  batchLabel: 'Batch #1 中浅煎り (204.5℃)',
  roastDate: '2026-10-07',
  chargeTemp: 194,
  tpTimeSec: 78,
  tpTemp: 101,
  dryEndSec: 265,
  dryEndTemp: 151,
  fcsSec: 468,
  fcsTemp: 195.5,
  dropSec: 556,
  dropTemp: 204.5,
  dtr: 15.8,
  weightLoss: 13.8,
  sourceFile: 'ethiopia_konga_batch1.alog',
  curve: buildSyntheticRoastCurve({
    chargeTemp: 194,
    tpTimeSec: 78,
    tpTemp: 101,
    dryEndSec: 265,
    dryEndTemp: 151,
    fcsSec: 468,
    fcsTemp: 195.5,
    dropSec: 556,
    dropTemp: 204.5,
  }),
};

const SAMPLE_ROAST_BATCH_2 = {
  isHomeRoasted: true,
  batchLabel: 'Batch #2 中深煎り (213.0℃)',
  roastDate: '2026-10-14',
  chargeTemp: 198,
  tpTimeSec: 82,
  tpTemp: 104,
  dryEndSec: 275,
  dryEndTemp: 153,
  fcsSec: 472,
  fcsTemp: 196.0,
  dropSec: 595,
  dropTemp: 213.0,
  dtr: 20.6,
  weightLoss: 16.2,
  sourceFile: 'ethiopia_konga_batch2.alog',
  curve: buildSyntheticRoastCurve({
    chargeTemp: 198,
    tpTimeSec: 82,
    tpTemp: 104,
    dryEndSec: 275,
    dryEndTemp: 153,
    fcsSec: 472,
    fcsTemp: 196.0,
    dropSec: 595,
    dropTemp: 213.0,
  }),
};

// 初期サンプルデータ：同じ豆「エチオピア イルガチェフェ コンガ G1」の中に
// Batch #1 (★平均5.0 -> ベストプロファイルとして代表表示) と Batch #2 (★平均4.5) が格納されています
const INITIAL_SAMPLE_LOGS = [
  // 1. エチオピア イルガチェフェ コンガ G1 - Batch #1 中浅煎り (★平均 5.0 = 最高評価プロファイル)
  {
    id: 'samp-101',
    beanName: 'エチオピア イルガチェフェ コンガ G1',
    origin: 'エチオピア',
    roast: '中浅煎り',
    process: 'ナチュラル',
    date: '2026-10-08',
    scores: { acidity: 9, bitterness: 3, sweetness: 8, body: 5, aroma: 9, aftertaste: 8 },
    rating: 5,
    tempNote: '冷めると甘み・果実味UP',
    memo: '【Batch#1 中浅煎り】ストロベリージャムのような華やかな香りと明るい酸味。',
    roastProfile: SAMPLE_ROAST_BATCH_1,
  },
  {
    id: 'samp-102',
    beanName: 'エチオピア イルガチェフェ コンガ G1',
    origin: 'エチオピア',
    roast: '中浅煎り',
    process: 'ナチュラル',
    date: '2026-10-12',
    scores: { acidity: 8, bitterness: 3, sweetness: 9, body: 6, aroma: 10, aftertaste: 8 },
    rating: 5,
    tempNote: '冷めると甘み・果実味UP',
    memo: '【Batch#1】少し落ち着いて桃やベリーの甘みが前に出てきた。',
    roastProfile: SAMPLE_ROAST_BATCH_1,
  },
  {
    id: 'samp-103',
    beanName: 'エチオピア イルガチェフェ コンガ G1',
    origin: 'エチオピア',
    roast: '中浅煎り',
    process: 'ナチュラル',
    date: '2026-10-16',
    scores: { acidity: 9, bitterness: 2, sweetness: 8, body: 5, aroma: 9, aftertaste: 7 },
    rating: 5,
    tempNote: '変化なし・安定',
    memo: '【Batch#1】紅茶のような質感。DTR15.8%で狙い通りのクリーンな果実味。',
    roastProfile: SAMPLE_ROAST_BATCH_1,
  },

  // 1-B. 同じ「エチオピア イルガチェフェ コンガ G1」の別焙煎プロファイル - Batch #2 中深煎り (★平均 4.5)
  {
    id: 'samp-105',
    beanName: 'エチオピア イルガチェフェ コンガ G1',
    origin: 'エチオピア',
    roast: '中深煎り',
    process: 'ナチュラル',
    date: '2026-10-15',
    scores: { acidity: 6, bitterness: 7, sweetness: 8, body: 8, aroma: 8, aftertaste: 9 },
    rating: 5,
    tempNote: '冷めると甘み・果実味UP',
    memo: '【Batch#2 中深煎り】213℃・DTR20.6%まで伸ばしたロット。ベリーチョコ感が出て芳醇！',
    roastProfile: SAMPLE_ROAST_BATCH_2,
  },
  {
    id: 'samp-106',
    beanName: 'エチオピア イルガチェフェ コンガ G1',
    origin: 'エチオピア',
    roast: '中深煎り',
    process: 'ナチュラル',
    date: '2026-10-18',
    scores: { acidity: 7, bitterness: 6, sweetness: 8, body: 7, aroma: 7, aftertaste: 8 },
    rating: 4,
    tempNote: '冷めるとまろやかに',
    memo: '【Batch#2】赤ワインとダークチョコの余韻。個人的には浅煎りのBatch#1の方がさらに好み。',
    roastProfile: SAMPLE_ROAST_BATCH_2,
  },

  // 2. ケニア マサイ AA（通常の購入豆）: 3回記録
  {
    id: 'samp-201',
    beanName: 'ケニア マサイ AA',
    origin: 'ケニア',
    roast: '中深煎り',
    process: 'ウォッシュト',
    date: '2026-10-05',
    scores: { acidity: 8, bitterness: 7, sweetness: 7, body: 8, aroma: 8, aftertaste: 9 },
    rating: 5,
    tempNote: '冷めると甘み・果実味UP',
    memo: 'カシスとダークチョコが同居！フルーティなのにしっかりビターで濃厚。',
  },
  {
    id: 'samp-202',
    beanName: 'ケニア マサイ AA',
    origin: 'ケニア',
    roast: '中深煎り',
    process: 'ウォッシュト',
    date: '2026-10-10',
    scores: { acidity: 7, bitterness: 8, sweetness: 7, body: 9, aroma: 7, aftertaste: 9 },
    rating: 5,
    tempNote: '冷めるとまろやかに',
    memo: '今日はビター感が強めに感じられた。オランジェットのような余韻。',
  },
  {
    id: 'samp-203',
    beanName: 'ケニア マサイ AA',
    origin: 'ケニア',
    roast: '中深煎り',
    process: 'ウォッシュト',
    date: '2026-10-15',
    scores: { acidity: 8, bitterness: 7, sweetness: 8, body: 8, aroma: 8, aftertaste: 8 },
    rating: 5,
    tempNote: '冷めると甘み・果実味UP',
    memo: 'ブラッドオレンジのようなジューシーさとどっしりしたコク。',
  },

  // 3. ブラジル ショコラ サントアントニオ（通常の購入豆）: 3回記録
  {
    id: 'samp-301',
    beanName: 'ブラジル ショコラ サントアントニオ',
    origin: 'ブラジル',
    roast: '中煎り',
    process: 'ナチュラル',
    date: '2026-10-06',
    scores: { acidity: 3, bitterness: 5, sweetness: 7, body: 6, aroma: 5, aftertaste: 4 },
    rating: 4,
    tempNote: '変化なし・安定',
    memo: 'ローストナッツとミルクチョコ。酸味も苦味も穏やかで毎日飲める味。',
  },
  {
    id: 'samp-302',
    beanName: 'ブラジル ショコラ サントアントニオ',
    origin: 'ブラジル',
    roast: '中煎り',
    process: 'ナチュラル',
    date: '2026-10-11',
    scores: { acidity: 2, bitterness: 5, sweetness: 8, body: 6, aroma: 5, aftertaste: 5 },
    rating: 4,
    tempNote: '冷めるとまろやかに',
    memo: 'ピーナッツバターのような香ばしさと甘み。後味はすっきり。',
  },
  {
    id: 'samp-303',
    beanName: 'ブラジル ショコラ サントアントニオ',
    origin: 'ブラジル',
    roast: '中煎り',
    process: 'ナチュラル',
    date: '2026-10-18',
    scores: { acidity: 3, bitterness: 4, sweetness: 7, body: 5, aroma: 6, aftertaste: 4 },
    rating: 4,
    tempNote: '変化なし・安定',
    memo: 'ブレが少なくいつも安心するバランス感。',
  },

  // 4. インドネシア マンデリン ビンタンリマ（通常の購入豆）: 3回記録
  {
    id: 'samp-401',
    beanName: 'インドネシア マンデリン ビンタンリマ',
    origin: 'インドネシア',
    roast: '深煎り',
    process: 'その他',
    date: '2026-10-07',
    scores: { acidity: 2, bitterness: 9, sweetness: 6, body: 9, aroma: 7, aftertaste: 9 },
    rating: 4,
    tempNote: '冷めるとまろやかに',
    memo: 'ハーブやスパイスの香りと、とろりとした重厚な苦味。',
  },
  {
    id: 'samp-402',
    beanName: 'インドネシア マンデリン ビンタンリマ',
    origin: 'インドネシア',
    roast: '深煎り',
    process: 'その他',
    date: '2026-10-14',
    scores: { acidity: 2, bitterness: 10, sweetness: 5, body: 10, aroma: 6, aftertaste: 8 },
    rating: 4,
    tempNote: '変化なし・安定',
    memo: 'ガツンとくるダークロースト感。甘いお菓子と最高に合う。',
  },
  {
    id: 'samp-403',
    beanName: 'インドネシア マンデリン ビンタンリマ',
    origin: 'インドネシア',
    roast: '深煎り',
    process: 'その他',
    date: '2026-10-19',
    scores: { acidity: 3, bitterness: 9, sweetness: 6, body: 9, aroma: 7, aftertaste: 9 },
    rating: 5,
    tempNote: '冷めるとまろやかに',
    memo: '奥に黒糖のような甘みとアーシーな余韻が長く残る。',
  },

  // 5. グアテマラ アンティグア アゾテア（通常の購入豆・中央の基準アンカー）: 3回記録
  {
    id: 'samp-501',
    beanName: 'グアテマラ アンティグア アゾテア',
    origin: 'グアテマラ',
    roast: '中煎り',
    process: 'ウォッシュト',
    date: '2026-10-09',
    scores: { acidity: 5, bitterness: 5, sweetness: 6, body: 5, aroma: 6, aftertaste: 5 },
    rating: 4,
    tempNote: '変化なし・安定',
    memo: '生豆本舗のシティロースト。酸味と苦味がちょうど真ん中で基準になる一杯。',
  },
  {
    id: 'samp-502',
    beanName: 'グアテマラ アンティグア アゾテア',
    origin: 'グアテマラ',
    roast: '中煎り',
    process: 'ウォッシュト',
    date: '2026-10-13',
    scores: { acidity: 5, bitterness: 6, sweetness: 5, body: 6, aroma: 5, aftertaste: 5 },
    rating: 4,
    tempNote: '変化なし・安定',
    memo: 'ミルクチョコと柑橘のバランス。ど真ん中の物差しとして最適。',
  },
  {
    id: 'samp-503',
    beanName: 'グアテマラ アンティグア アゾテア',
    origin: 'グアテマラ',
    roast: '中煎り',
    process: 'ウォッシュト',
    date: '2026-10-17',
    scores: { acidity: 6, bitterness: 5, sweetness: 6, body: 5, aroma: 6, aftertaste: 5 },
    rating: 4,
    tempNote: '冷めると甘み・果実味UP',
    memo: '今日も安定したオール5〜6の味わい。',
  },
];

// アプリの状態
const state = {
  logs: [],
  isSampleMode: false,
  selectedBeanName: null,
  selectedProfileKey: null, // null = ベストプロファイル, '__ALL__' = 全プロファイル比較, または特定プロファイルkey
  hoveredMapNodeId: null,
  xAxis: 'acidity',
  yAxis: 'bitterness',
  colorMode: 'roast',
  showVariance: true,
  showSweetSpot: true,
  showAllProfiles: false, // false(初期) = 各銘柄の最高評価プロファイルのみ表示 / true = 全プロファイル展開＆比較表
  filters: {
    search: '',
    origin: '',
    roast: '',
    process: '',
  },
  sortBy: 'recent',
  renderedBeanPositions: [],
  currentModalCurve: null,
  currentModalSourceFile: '',
};

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  loadInitialData();
  bindEvents();
  refreshAll();
});

function cacheElements() {
  els.sampleModeBadge = document.getElementById('sampleModeBadge');
  els.clearSampleBtn = document.getElementById('clearSampleBtn');
  els.loadSampleBtn = document.getElementById('loadSampleBtn');
  els.exportJsonBtn = document.getElementById('exportJsonBtn');
  els.importJsonInput = document.getElementById('importJsonInput');
  els.openLogModalBtn = document.getElementById('openLogModalBtn');

  els.axisPresets = document.getElementById('axisPresets');
  els.xAxisSelect = document.getElementById('xAxisSelect');
  els.yAxisSelect = document.getElementById('yAxisSelect');
  els.xAxisRoastGroup = document.getElementById('xAxisRoastGroup');
  els.yAxisRoastGroup = document.getElementById('yAxisRoastGroup');
  els.swapAxesBtn = document.getElementById('swapAxesBtn');
  els.colorModeSelect = document.getElementById('colorModeSelect');
  els.showVarianceToggle = document.getElementById('showVarianceToggle');
  els.showSweetSpotToggle = document.getElementById('showSweetSpotToggle');
  els.batchTrajectoryToggleWrap = document.getElementById('batchTrajectoryToggleWrap');
  els.showBatchLinksToggle = document.getElementById('showBatchLinksToggle');

  els.searchBeanInput = document.getElementById('searchBeanInput');
  els.filterOriginSelect = document.getElementById('filterOriginSelect');
  els.filterRoastSelect = document.getElementById('filterRoastSelect');
  els.filterProcessSelect = document.getElementById('filterProcessSelect');
  els.mapLegend = document.getElementById('mapLegend');

  els.mapWrapper = document.getElementById('mapWrapper');
  els.canvas = document.getElementById('flavorMapCanvas');
  els.mapTooltip = document.getElementById('mapTooltip');

  // 全プロファイル比較一覧表カード
  els.allProfilesTableCard = document.getElementById('allProfilesTableCard');
  els.allProfilesTableBody = document.getElementById('allProfilesTableBody');

  els.inspectorEmptyState = document.getElementById('inspectorEmptyState');
  els.inspectorContent = document.getElementById('inspectorContent');
  els.inspectorBadges = document.getElementById('inspectorBadges');
  els.inspectorBeanName = document.getElementById('inspectorBeanName');
  els.inspectorMeta = document.getElementById('inspectorMeta');
  els.inspectorProfileSwitcher = document.getElementById('inspectorProfileSwitcher');
  els.inspectorProfileTabs = document.getElementById('inspectorProfileTabs');
  els.inspectorProfileCompareWrap = document.getElementById('inspectorProfileCompareWrap');
  els.inspectorProfileCompareBody = document.getElementById('inspectorProfileCompareBody');

  els.logAgainBtn = document.getElementById('logAgainBtn');
  els.stabilityBadge = document.getElementById('stabilityBadge');
  els.radarCanvas = document.getElementById('radarCanvas');
  els.inspectorScoreGrid = document.getElementById('inspectorScoreGrid');

  els.inspectorRoastSection = document.getElementById('inspectorRoastSection');
  els.roastBatchBadge = document.getElementById('roastBatchBadge');
  els.roastCurveCanvas = document.getElementById('roastCurveCanvas');
  els.inspectorRoastSpecs = document.getElementById('inspectorRoastSpecs');

  els.historyCountTitle = document.getElementById('historyCountTitle');
  els.inspectorHistoryList = document.getElementById('inspectorHistoryList');

  els.beanCountBadge = document.getElementById('beanCountBadge');
  els.sortBeansSelect = document.getElementById('sortBeansSelect');
  els.beanListContainer = document.getElementById('beanListContainer');

  // Modal
  els.logModalBackdrop = document.getElementById('logModalBackdrop');
  els.modalTitle = document.getElementById('modalTitle');
  els.modalEyebrow = document.getElementById('modalEyebrow');
  els.closeModalBtn = document.getElementById('closeModalBtn');
  els.cancelModalBtn = document.getElementById('cancelModalBtn');
  els.tastingLogForm = document.getElementById('tastingLogForm');
  els.editLogId = document.getElementById('editLogId');
  els.existingBeanSelect = document.getElementById('existingBeanSelect');
  els.beanNameInput = document.getElementById('beanNameInput');
  els.beanNameDatalist = document.getElementById('beanNameDatalist');
  els.logDateInput = document.getElementById('logDateInput');
  els.originInput = document.getElementById('originInput');
  els.originDatalist = document.getElementById('originDatalist');
  els.originQuickChips = document.getElementById('originQuickChips');
  els.roastSelect = document.getElementById('roastSelect');
  els.processSelect = document.getElementById('processSelect');
  els.sliderAutoFillNotice = document.getElementById('sliderAutoFillNotice');

  // Home Roast Modal Fields
  els.isHomeRoastedCheckbox = document.getElementById('isHomeRoastedCheckbox');
  els.homeRoastFormPanel = document.getElementById('homeRoastFormPanel');
  els.alogDropzone = document.getElementById('alogDropzone');
  els.alogStatusText = document.getElementById('alogStatusText');
  els.alogFileInput = document.getElementById('alogFileInput');
  els.fillDemoAlogBtn = document.getElementById('fillDemoAlogBtn');
  els.existingProfileSelect = document.getElementById('existingProfileSelect');
  els.batchLabelInput = document.getElementById('batchLabelInput');
  els.roastChargeTemp = document.getElementById('roastChargeTemp');
  els.roastFcsTime = document.getElementById('roastFcsTime');
  els.roastFcsTemp = document.getElementById('roastFcsTemp');
  els.roastDropTime = document.getElementById('roastDropTime');
  els.roastDropTemp = document.getElementById('roastDropTemp');
  els.roastDtr = document.getElementById('roastDtr');
  els.roastWeightLoss = document.getElementById('roastWeightLoss');

  els.sliders = {
    acidity: document.getElementById('scoreAcidity'),
    bitterness: document.getElementById('scoreBitterness'),
    sweetness: document.getElementById('scoreSweetness'),
    body: document.getElementById('scoreBody'),
    aroma: document.getElementById('scoreAroma'),
    aftertaste: document.getElementById('scoreAftertaste'),
  };
  els.sliderOutputs = {
    acidity: document.getElementById('valAcidity'),
    bitterness: document.getElementById('valBitterness'),
    sweetness: document.getElementById('valSweetness'),
    body: document.getElementById('valBody'),
    aroma: document.getElementById('valAroma'),
    aftertaste: document.getElementById('valAftertaste'),
  };
  els.prevAvgTags = {
    acidity: document.getElementById('prevAvgAcidity'),
    bitterness: document.getElementById('prevAvgBitterness'),
    sweetness: document.getElementById('prevAvgSweetness'),
    body: document.getElementById('prevAvgBody'),
    aroma: document.getElementById('prevAvgAroma'),
    aftertaste: document.getElementById('prevAvgAftertaste'),
  };

  els.starRatingGroup = document.getElementById('starRatingGroup');
  els.ratingTextLabel = document.getElementById('ratingTextLabel');
  els.ratingInput = document.getElementById('ratingInput');
  els.tempChangeInput = document.getElementById('tempChangeInput');
  els.tempQuickChips = document.getElementById('tempQuickChips');
  els.memoInput = document.getElementById('memoInput');
}

function sanitizeRoastCurve(rawCurve) {
  if (!rawCurve || typeof rawCurve !== 'object' || !Array.isArray(rawCurve.timex)) return null;
  const len = Math.min(rawCurve.timex.length, MAX_CURVE_POINTS);
  if (len < 2) return null;
  const timex = [];
  const bt = [];
  const et = [];
  const ror = [];
  for (let i = 0; i < len; i++) {
    timex.push(clampNumber(rawCurve.timex[i], 0, 7200, i * 10));
    bt.push(Number(clampNumber(rawCurve.bt?.[i], 0, 350, 150).toFixed(2)));
    et.push(Number(clampNumber(rawCurve.et?.[i], 0, 450, 180).toFixed(1)));
    const rVal = rawCurve.ror?.[i];
    ror.push(
      rVal === null || rVal === undefined || !Number.isFinite(Number(rVal))
        ? null
        : Number(clampNumber(rVal, -10, 60, 0).toFixed(2))
    );
  }
  return { timex, bt, et, ror, smoothV3: Boolean(rawCurve.smoothV3) };
}

function sanitizeRoastProfile(rawRp) {
  if (!rawRp || typeof rawRp !== 'object' || !rawRp.isHomeRoasted) return null;
  const dropTemp = Number(clampNumber(rawRp.dropTemp, 120, 270, 206).toFixed(1));
  const dtr = Number(clampNumber(rawRp.dtr, 1, 50, 16.0).toFixed(1));
  const weightLoss = Number(clampNumber(rawRp.weightLoss, 1, 40, 14.5).toFixed(1));
  const chargeTemp = Number(clampNumber(rawRp.chargeTemp, 50, 320, 195).toFixed(1));
  const tpTimeSec = Math.round(clampNumber(rawRp.tpTimeSec, 10, 600, 78));
  const tpTemp = Number(clampNumber(rawRp.tpTemp, 40, 220, 102).toFixed(1));
  const dryEndSec = Math.round(clampNumber(rawRp.dryEndSec, 30, 1800, 270));
  const dryEndTemp = Number(clampNumber(rawRp.dryEndTemp, 80, 230, 152).toFixed(1));
  const dropSec = Math.round(clampNumber(rawRp.dropSec, 60, 3600, 560));
  const fcsSec = Math.round(clampNumber(rawRp.fcsSec, 30, dropSec, 470));
  const fcsTemp = Number(clampNumber(rawRp.fcsTemp, 100, 250, 196).toFixed(1));
  const batchLabel = sanitizeString(
    rawRp.batchLabel,
    120,
    `排出 ${dropTemp}℃ / DTR ${dtr}%`
  );
  const roastDate = sanitizeString(rawRp.roastDate, 32, '');
  const sourceFile = sanitizeString(rawRp.sourceFile, 120, '');

  const sanitizedCurve = sanitizeRoastCurve(rawRp.curve);
  const curve =
    sanitizedCurve ||
    buildSyntheticRoastCurve({
      chargeTemp,
      tpTimeSec,
      tpTemp,
      dryEndSec,
      dryEndTemp,
      fcsSec,
      fcsTemp,
      dropSec,
      dropTemp,
    });

  return {
    isHomeRoasted: true,
    batchLabel,
    roastDate,
    chargeTemp,
    tpTimeSec,
    tpTemp,
    dryEndSec,
    dryEndTemp,
    fcsSec,
    fcsTemp,
    dropSec,
    dropTemp,
    dtr,
    weightLoss,
    sourceFile,
    curve,
  };
}

function sanitizeLogRecord(raw, idx = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const beanName = sanitizeString(raw.beanName, 120, '');
  if (!beanName) return null;

  const allowedRoasts = ['浅煎り', '中浅煎り', '中煎り', '中深煎り', '深煎り'];
  const roastCandidate = sanitizeString(raw.roast, 30, '中煎り');
  const roast = allowedRoasts.includes(roastCandidate) ? roastCandidate : '中煎り';

  const rawScores = raw.scores && typeof raw.scores === 'object' ? raw.scores : {};
  const scores = {
    acidity: Number(clampNumber(rawScores.acidity, 1, 10, 5).toFixed(1)),
    bitterness: Number(clampNumber(rawScores.bitterness, 1, 10, 5).toFixed(1)),
    sweetness: Number(clampNumber(rawScores.sweetness, 1, 10, 5).toFixed(1)),
    body: Number(clampNumber(rawScores.body, 1, 10, 5).toFixed(1)),
    aroma: Number(clampNumber(rawScores.aroma, 1, 10, 5).toFixed(1)),
    aftertaste: Number(clampNumber(rawScores.aftertaste, 1, 10, 5).toFixed(1)),
  };

  return {
    id: sanitizeString(raw.id, 80, `log-${Date.now()}-${idx}`),
    beanName,
    origin: sanitizeString(raw.origin, 80, '不明'),
    roast,
    process: sanitizeString(raw.process, 60, 'ウォッシュド'),
    date: sanitizeString(raw.date, 20, new Date().toLocaleDateString('sv-SE')),
    rating: Math.round(clampNumber(raw.rating, 1, 5, 4)),
    tempNote: sanitizeString(raw.tempNote, 160, ''),
    memo: sanitizeString(raw.memo, 500, ''),
    scores,
    roastProfile: sanitizeRoastProfile(raw.roastProfile),
  };
}

function sanitizeLogsArray(rawList) {
  if (!Array.isArray(rawList)) return [];
  const result = [];
  const limit = Math.min(rawList.length, MAX_IMPORT_RECORDS);
  for (let i = 0; i < limit; i++) {
    const clean = sanitizeLogRecord(rawList[i], i);
    if (clean) result.push(clean);
  }
  return result;
}

function loadInitialData() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const isSample = localStorage.getItem(SAMPLE_FLAG_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      const isSampleFlag = isSample === 'true';
      // 旧サンプルデータ（[Batch #1]が別銘柄名に分かれていた版など）が残っていたら最新サンプルに自動更新
      const isOldSample =
        isSampleFlag &&
        Array.isArray(parsed) &&
        parsed.some((l) => String(l?.id).startsWith('samp-')) &&
        (!parsed.some((l) => l?.roastProfile?.curve?.smoothV3) ||
          parsed.some((l) => String(l?.beanName || '').includes('[Batch')));

      const cleanLogs = sanitizeLogsArray(parsed);
      if (isOldSample || cleanLogs.length === 0) {
        state.logs = JSON.parse(JSON.stringify(INITIAL_SAMPLE_LOGS));
        state.isSampleMode = true;
        saveToStorage();
      } else {
        state.logs = cleanLogs;
        state.isSampleMode = isSampleFlag;
      }
    } catch (e) {
      state.logs = JSON.parse(JSON.stringify(INITIAL_SAMPLE_LOGS));
      state.isSampleMode = true;
    }
  } else {
    state.logs = JSON.parse(JSON.stringify(INITIAL_SAMPLE_LOGS));
    state.isSampleMode = true;
    saveToStorage();
  }

  const beans = getAggregatedBeans();
  if (beans.length > 0) {
    state.selectedBeanName = beans[0].beanName;
    state.selectedProfileKey = null; // 初期は最高評価プロファイル
  }
}

function saveToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.logs));
  localStorage.setItem(SAMPLE_FLAG_KEY, String(state.isSampleMode));
}

// スコア配列群から平均・標準偏差・評価を計算するヘルパー
function computeProfileStats(logs, profileKey, label) {
  const scoreKeys = ['acidity', 'bitterness', 'sweetness', 'body', 'aroma', 'aftertaste'];
  const sortedLogs = [...logs].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const count = sortedLogs.length;

  const avgScores = {};
  const sdScores = {};
  for (const k of scoreKeys) {
    const vals = sortedLogs.map((l) => Number(l.scores?.[k] ?? 5));
    const mean = vals.reduce((a, b) => a + b, 0) / count;
    const variance = vals.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / count;
    avgScores[k] = Number(mean.toFixed(2));
    sdScores[k] = Number(Math.sqrt(variance).toFixed(2));
  }

  const avgRating =
    sortedLogs.reduce((acc, l) => acc + Number(l.rating || 4), 0) / count;
  const meanSd =
    Object.values(sdScores).reduce((a, b) => a + b, 0) / scoreKeys.length;

  const latest = sortedLogs[0] || {};
  const roastProfile = sortedLogs.find((l) => l.roastProfile?.isHomeRoasted)?.roastProfile || null;

  return {
    key: profileKey,
    label,
    roast: latest.roast || '中煎り',
    process: latest.process || 'ウォッシュト',
    roastProfile,
    logs: sortedLogs,
    count,
    avgScores,
    sdScores,
    avgRating: Number(avgRating.toFixed(2)),
    displayRating: Number(avgRating.toFixed(1)),
    meanSd: Number(meanSd.toFixed(2)),
    latestDate: latest.date || '',
  };
}

/**
 * 同じ銘柄名(beanName)を1つの銘柄として集約し、
 * その内部に焙煎プロファイル単位の配列 (profiles) を持たせる。
 * 基本の代表値には「最も評価（★お気に入り度）が高いプロファイル (bestProfile)」を採用する。
 */
function getAggregatedBeans() {
  const beanMap = new Map();

  for (const log of state.logs) {
    const name = log.beanName.trim();
    if (!name) continue;
    if (!beanMap.has(name)) {
      beanMap.set(name, {
        beanName: name,
        origin: log.origin || '不明',
        allLogs: [],
      });
    }
    const entry = beanMap.get(name);
    entry.allLogs.push(log);
    if (log.origin) entry.origin = log.origin;
  }

  const result = [];

  for (const b of beanMap.values()) {
    // 銘柄内のログを焙煎プロファイル名ごとにグループ化
    const profMap = new Map();
    for (const log of b.allLogs) {
      const isHome = Boolean(log.roastProfile && log.roastProfile.isHomeRoasted);
      const pKey = isHome
        ? (log.roastProfile.batchLabel || `排出${log.roastProfile.dropTemp}℃`).trim()
        : '__STANDARD__';
      const pLabel = isHome ? pKey : '通常（購入豆）';
      if (!profMap.has(pKey)) {
        profMap.set(pKey, { key: pKey, label: pLabel, logs: [] });
      }
      profMap.get(pKey).logs.push(log);
    }

    const profiles = Array.from(profMap.values()).map((pg) =>
      computeProfileStats(pg.logs, pg.key, pg.label)
    );

    // 評価（avgRating）が高い順にソート（同率なら記録回数が多い順 -> 日付が新しい順）
    profiles.sort((p1, p2) => {
      if (p2.avgRating !== p1.avgRating) return p2.avgRating - p1.avgRating;
      if (p2.count !== p1.count) return p2.count - p1.count;
      return (p2.latestDate || '').localeCompare(p1.latestDate || '');
    });

    const bestProfile = profiles[0];
    const totalCount = b.allLogs.length;
    const latestDate = b.allLogs
      .map((l) => l.date || '')
      .sort((d1, d2) => d2.localeCompare(d1))[0] || '';

    result.push({
      beanName: b.beanName,
      origin: b.origin,
      profiles,
      bestProfile,
      hasMultipleProfiles: profiles.length > 1,
      // 基本表示用（最高評価プロファイルの値を代表として持つ）
      roast: bestProfile.roast,
      process: bestProfile.process,
      roastProfile: bestProfile.roastProfile,
      logs: bestProfile.logs,
      allLogs: b.allLogs,
      count: totalCount,
      bestProfileCount: bestProfile.count,
      avgScores: bestProfile.avgScores,
      sdScores: bestProfile.sdScores,
      avgRating: bestProfile.displayRating,
      meanSd: bestProfile.meanSd,
      latestDate,
    });
  }

  return result;
}

// 現在選択されている銘柄において、表示対象となるプロファイルを取得する
function getActiveProfileForBean(bean) {
  if (!bean) return null;
  if (!state.selectedProfileKey || state.selectedProfileKey === '__ALL__') {
    return bean.bestProfile;
  }
  return bean.profiles.find((p) => p.key === state.selectedProfileKey) || bean.bestProfile;
}

function getFilteredBeans(beans) {
  return beans.filter((b) => {
    if (state.filters.origin && b.origin !== state.filters.origin) return false;
    if (state.filters.roast && !b.profiles.some((p) => p.roast === state.filters.roast)) {
      return false;
    }
    if (state.filters.process && !b.profiles.some((p) => p.process === state.filters.process)) {
      return false;
    }
    if (state.filters.search) {
      const q = state.filters.search.toLowerCase();
      const matchName = b.beanName.toLowerCase().includes(q);
      const matchOrigin = b.origin.toLowerCase().includes(q);
      const matchMemo = b.allLogs.some((l) => (l.memo || '').toLowerCase().includes(q));
      if (!matchName && !matchOrigin && !matchMemo) return false;
    }
    return true;
  });
}

function bindEvents() {
  els.axisPresets.addEventListener('click', (e) => {
    const btn = e.target.closest('.preset-pill');
    if (!btn) return;
    state.xAxis = btn.dataset.x;
    state.yAxis = btn.dataset.y;
    els.xAxisSelect.value = state.xAxis;
    els.yAxisSelect.value = state.yAxis;
    syncPresetActiveState();
    drawFlavorMap();
  });

  els.xAxisSelect.addEventListener('change', () => {
    state.xAxis = els.xAxisSelect.value;
    syncPresetActiveState();
    drawFlavorMap();
  });

  els.yAxisSelect.addEventListener('change', () => {
    state.yAxis = els.yAxisSelect.value;
    syncPresetActiveState();
    drawFlavorMap();
  });

  els.swapAxesBtn.addEventListener('click', () => {
    const tmp = state.xAxis;
    state.xAxis = state.yAxis;
    state.yAxis = tmp;
    els.xAxisSelect.value = state.xAxis;
    els.yAxisSelect.value = state.yAxis;
    syncPresetActiveState();
    drawFlavorMap();
  });

  els.colorModeSelect.addEventListener('change', () => {
    state.colorMode = els.colorModeSelect.value;
    renderLegend();
    drawFlavorMap();
  });

  els.showVarianceToggle.addEventListener('change', () => {
    state.showVariance = els.showVarianceToggle.checked;
    drawFlavorMap();
  });

  els.showSweetSpotToggle.addEventListener('change', () => {
    state.showSweetSpot = els.showSweetSpotToggle.checked;
    drawFlavorMap();
  });

  // 🔥 全プロファイル展開＆比較表トグル
  els.showBatchLinksToggle.addEventListener('change', () => {
    state.showAllProfiles = els.showBatchLinksToggle.checked;
    if (state.showAllProfiles) {
      state.selectedProfileKey = '__ALL__';
    } else if (state.selectedProfileKey === '__ALL__') {
      state.selectedProfileKey = null;
    }
    refreshAll();
  });

  // フィルター
  els.searchBeanInput.addEventListener('input', () => {
    state.filters.search = els.searchBeanInput.value.trim();
    refreshAll();
  });
  els.filterOriginSelect.addEventListener('change', () => {
    state.filters.origin = els.filterOriginSelect.value;
    refreshAll();
  });
  els.filterRoastSelect.addEventListener('change', () => {
    state.filters.roast = els.filterRoastSelect.value;
    refreshAll();
  });
  els.filterProcessSelect.addEventListener('change', () => {
    state.filters.process = els.filterProcessSelect.value;
    refreshAll();
  });

  els.sortBeansSelect.addEventListener('change', () => {
    state.sortBy = els.sortBeansSelect.value;
    renderBeanCatalog();
  });

  // キャンバスマウス操作
  els.canvas.addEventListener('mousemove', handleCanvasMouseMove);
  els.canvas.addEventListener('mouseleave', () => {
    state.hoveredMapNodeId = null;
    els.mapTooltip.hidden = true;
    drawFlavorMap();
  });
  els.canvas.addEventListener('click', handleCanvasClick);

  window.addEventListener('resize', () => {
    drawFlavorMap();
    renderInspector();
  });

  // サンプル・JSON操作
  els.clearSampleBtn.addEventListener('click', () => {
    if (confirm('サンプルデータを消去して、空の状態からあなたの記録を始めますか？')) {
      state.logs = [];
      state.isSampleMode = false;
      state.selectedBeanName = null;
      state.selectedProfileKey = null;
      state.showAllProfiles = false;
      els.showBatchLinksToggle.checked = false;
      saveToStorage();
      refreshAll();
      openLogModal();
    }
  });

  els.loadSampleBtn.addEventListener('click', () => {
    if (
      state.logs.length === 0 ||
      confirm('現在のデータを初期サンプルデータに置き換えますか？')
    ) {
      state.logs = JSON.parse(JSON.stringify(INITIAL_SAMPLE_LOGS));
      state.isSampleMode = true;
      state.selectedBeanName = state.logs[0].beanName;
      state.selectedProfileKey = null;
      saveToStorage();
      refreshAll();
    }
  });

  els.exportJsonBtn.addEventListener('click', exportJsonData);
  els.importJsonInput.addEventListener('change', importJsonData);

  // モーダル操作
  els.openLogModalBtn.addEventListener('click', () => openLogModal());
  els.logAgainBtn.addEventListener('click', () => {
    if (state.selectedBeanName) {
      openLogModal({
        prefillBeanName: state.selectedBeanName,
        prefillProfileKey:
          state.selectedProfileKey && state.selectedProfileKey !== '__ALL__'
            ? state.selectedProfileKey
            : null,
      });
    }
  });
  els.closeModalBtn.addEventListener('click', closeLogModal);
  els.cancelModalBtn.addEventListener('click', closeLogModal);
  els.logModalBackdrop.addEventListener('click', (e) => {
    if (e.target === els.logModalBackdrop) closeLogModal();
  });

  // 自家焙煎チェックボックス開閉
  els.isHomeRoastedCheckbox.addEventListener('change', () => {
    els.homeRoastFormPanel.hidden = !els.isHomeRoastedCheckbox.checked;
  });

  // 既存プロファイル選択プルダウン変更時
  els.existingProfileSelect.addEventListener('change', () => {
    const pKey = els.existingProfileSelect.value;
    const bName = els.beanNameInput.value.trim();
    const beans = getAggregatedBeans();
    const foundBean = beans.find((b) => b.beanName === bName);
    if (!foundBean || !pKey) {
      els.batchLabelInput.value = '';
      hidePrevAvgTags();
      return;
    }
    const prof = foundBean.profiles.find((p) => p.key === pKey);
    if (prof) {
      els.roastSelect.value = prof.roast;
      showPrevAvgTags(prof.avgScores);
      const rounded = {};
      for (const [k, v] of Object.entries(prof.avgScores)) rounded[k] = Math.round(v);
      setSlidersValues(rounded);
      els.sliderAutoFillNotice.innerHTML = `<strong style="color:#6f4225">✓ 「${escapeHtml(prof.label)}」の${prof.count + 1}回目の記録として追加します</strong>（過去の記録は上書きされません。下書きとして過去${prof.count}回の平均値をセットしています）`;
      if (prof.roastProfile) applyRoastProfileToModal(prof.roastProfile);
    }
  });

  // 冷めてからの味の変化クイックチップ
  if (els.tempQuickChips) {
    els.tempQuickChips.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-temp]');
      if (!chip) return;
      els.tempChangeInput.value = chip.dataset.temp;
    });
  }

  // 1ハゼ時間・排出時間からDTR(%)を自動計算
  const recalcDtr = () => {
    const fcsSec = parseMmSsToSec(els.roastFcsTime.value);
    const dropSec = parseMmSsToSec(els.roastDropTime.value);
    if (fcsSec > 0 && dropSec > fcsSec) {
      const dtr = ((dropSec - fcsSec) / dropSec) * 100;
      els.roastDtr.value = dtr.toFixed(1);
    }
  };
  els.roastFcsTime.addEventListener('change', recalcDtr);
  els.roastDropTime.addEventListener('change', recalcDtr);

  // .alog ドラッグ＆ドロップとファイル選択
  els.alogDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.alogDropzone.classList.add('dragover');
  });
  els.alogDropzone.addEventListener('dragleave', () => {
    els.alogDropzone.classList.remove('dragover');
  });
  els.alogDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.alogDropzone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleAlogFile(file);
  });
  els.alogFileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleAlogFile(file);
  });
  els.fillDemoAlogBtn.addEventListener('click', () => {
    applyRoastProfileToModal(SAMPLE_ROAST_BATCH_1);
    els.alogStatusText.innerHTML = `<strong style="color:#9e3d1a">✓ デモ用Artisanプロファイル波形をセットしました！</strong>`;
  });

  // 既存銘柄セレクトで自動補完
  els.existingBeanSelect.addEventListener('change', () => {
    const val = els.existingBeanSelect.value;
    if (val) applyBeanAutoFill(val);
  });

  els.beanNameInput.addEventListener('change', () => {
    const val = els.beanNameInput.value.trim();
    const beans = getAggregatedBeans();
    const found = beans.find((b) => b.beanName === val);
    if (found && !els.editLogId.value) {
      applyBeanAutoFill(val);
    }
  });

  for (const [key, inputEl] of Object.entries(els.sliders)) {
    inputEl.addEventListener('input', () => {
      els.sliderOutputs[key].textContent = inputEl.value;
    });
  }

  els.starRatingGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.star-btn');
    if (!btn) return;
    setStarRating(Number(btn.dataset.rating));
  });

  els.tastingLogForm.addEventListener('submit', handleFormSubmit);
}

// ============================================================================
// Artisan (.alog) パーサー
// ============================================================================
function handleAlogFile(file) {
  if (!file) return;
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    alert('ファイルサイズが大きすぎます（上限 5MB）。');
    els.alogFileInput.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const profile = parseArtisanAlogContent(reader.result, file.name);
      applyRoastProfileToModal(profile);
      els.alogStatusText.innerHTML = `<strong style="color:#2d5a3f">✓ ${escapeHtml(file.name)} を解析しました（排出 ${escapeHtml(profile.dropTemp)}℃ / DTR ${escapeHtml(profile.dtr)}%）</strong>`;
    } catch (err) {
      alert('Artisan (.alog) ファイルの解析に失敗しました。手動で数値を入力することも可能です。');
    }
    els.alogFileInput.value = '';
  };
  reader.readAsText(file);
}

function parseArtisanAlogContent(rawText, fileName) {
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch (_) {
    try {
      const jsonLike = rawText
        .replace(/\bTrue\b/g, 'true')
        .replace(/\bFalse\b/g, 'false')
        .replace(/\bNone\b/g, 'null')
        .replace(/'/g, '"');
      data = JSON.parse(jsonLike);
    } catch (_e2) {
      data = extractAlogArraysRegex(rawText);
    }
  }

  if (!data || !Array.isArray(data.timex) || data.timex.length === 0) {
    throw new Error('Invalid alog structure');
  }

  const timex = data.timex.slice(0, MAX_RAW_ALOG_SAMPLES).map(Number);
  const etArr = (data.temp1 || []).slice(0, MAX_RAW_ALOG_SAMPLES).map(Number);
  const btArr = (data.temp2 || data.temp1 || []).slice(0, MAX_RAW_ALOG_SAMPLES).map(Number);
  const tidx = Array.isArray(data.timeindex) ? data.timeindex : [-1, 0, 0, 0, 0, 0, 0, 0];

  const maxIdx = timex.length - 1;
  const chargeIdx = tidx[0] >= 0 ? Math.min(maxIdx, tidx[0]) : 0;
  const dryIdx = tidx[1] > 0 ? Math.min(maxIdx, tidx[1]) : Math.floor(timex.length * 0.45);
  const fcsIdx = tidx[2] > 0 ? Math.min(maxIdx, tidx[2]) : Math.floor(timex.length * 0.78);
  const dropIdx = tidx[6] > 0 ? Math.min(maxIdx, tidx[6]) : maxIdx;

  const tCharge = timex[chargeIdx] || 0;
  const chargeTemp = Number((btArr[chargeIdx] || 195).toFixed(1));
  const dryEndSec = Math.max(0, Math.round((timex[dryIdx] || 270) - tCharge));
  const dryEndTemp = Number((btArr[dryIdx] || 150).toFixed(1));
  const fcsSec = Math.max(0, Math.round((timex[fcsIdx] || 460) - tCharge));
  const fcsTemp = Number((btArr[fcsIdx] || 196).toFixed(1));
  const dropSec = Math.max(1, Math.round((timex[dropIdx] || 560) - tCharge));
  const dropTemp = Number((btArr[dropIdx] || 206).toFixed(1));

  let tpIdx = chargeIdx;
  for (let i = chargeIdx; i <= Math.min(dryIdx, btArr.length - 1); i++) {
    if (btArr[i] > 0 && btArr[i] < btArr[tpIdx]) tpIdx = i;
  }
  const tpTimeSec = Math.max(0, Math.round((timex[tpIdx] || 75) - tCharge));
  const tpTemp = Number((btArr[tpIdx] || 100).toFixed(1));

  const dtr = dropSec > fcsSec ? Number((((dropSec - fcsSec) / dropSec) * 100).toFixed(1)) : 16.0;

  let weightLoss = 14.5;
  if (Array.isArray(data.weight) && Number(data.weight[0]) > 0 && Number(data.weight[1]) > 0) {
    weightLoss = Number((((data.weight[0] - data.weight[1]) / data.weight[0]) * 100).toFixed(1));
  }

  const span = Math.max(1, dropIdx - chargeIdx);
  const step = Math.max(1, Math.floor(span / 55));
  const cTime = [];
  const cBt = [];
  const cEt = [];
  const cRor = [];

  for (let i = chargeIdx; i <= dropIdx; i += step) {
    const relSec = Math.round(timex[i] - tCharge);
    cTime.push(relSec);
    cBt.push(Number((btArr[i] || 0).toFixed(1)));
    cEt.push(Number((etArr[i] || 0).toFixed(1)));
  }

  for (let i = 0; i < cTime.length; i++) {
    if (i === 0 || cTime[i] < tpTimeSec) {
      cRor.push(null);
    } else {
      const dtMin = (cTime[i] - cTime[i - 1]) / 60;
      cRor.push(dtMin > 0 ? Number(((cBt[i] - cBt[i - 1]) / dtMin).toFixed(1)) : null);
    }
  }

  return sanitizeRoastProfile({
    isHomeRoasted: true,
    batchLabel: data.title ? `${data.title} (${dropTemp}℃)` : `排出 ${dropTemp}℃ / DTR ${dtr}%`,
    roastDate: data.roastisodate || '',
    chargeTemp,
    tpTimeSec,
    tpTemp,
    dryEndSec,
    dryEndTemp,
    fcsSec,
    fcsTemp,
    dropSec,
    dropTemp,
    dtr,
    weightLoss,
    sourceFile: fileName,
    curve: { timex: cTime, bt: cBt, et: cEt, ror: cRor, smoothV3: true },
  });
}

function extractAlogArraysRegex(raw) {
  const grabNumArray = (key) => {
    const m = raw.match(new RegExp(`['"]${key}['"]\\s*:\\s*\\[([^\\]]+)\\]`));
    if (!m) return null;
    return m[1].split(',').map((s) => Number(s.trim()));
  };
  const grabStr = (key) => {
    const m = raw.match(new RegExp(`['"]${key}['"]\\s*:\\s*['"]([^'"]*)['"]`));
    return m ? m[1] : '';
  };
  return {
    timex: grabNumArray('timex'),
    temp1: grabNumArray('temp1'),
    temp2: grabNumArray('temp2'),
    timeindex: grabNumArray('timeindex'),
    weight: grabNumArray('weight'),
    title: grabStr('title'),
    beans: grabStr('beans'),
    roastisodate: grabStr('roastisodate'),
  };
}

function applyRoastProfileToModal(prof) {
  if (!prof) return;
  els.isHomeRoastedCheckbox.checked = true;
  els.homeRoastFormPanel.hidden = false;
  els.batchLabelInput.value = prof.batchLabel || '';
  els.roastChargeTemp.value = prof.chargeTemp ?? 195;
  els.roastFcsTime.value = formatSecToMmSs(prof.fcsSec ?? 470);
  els.roastFcsTemp.value = prof.fcsTemp ?? 196;
  els.roastDropTime.value = formatSecToMmSs(prof.dropSec ?? 560);
  els.roastDropTemp.value = prof.dropTemp ?? 206;
  els.roastDtr.value = prof.dtr ?? 16.0;
  els.roastWeightLoss.value = prof.weightLoss ?? 14.5;
  state.currentModalCurve = prof.curve || null;
  state.currentModalSourceFile = prof.sourceFile || '';
}

function syncPresetActiveState() {
  const buttons = els.axisPresets.querySelectorAll('.preset-pill');
  buttons.forEach((btn) => {
    const isMatch = btn.dataset.x === state.xAxis && btn.dataset.y === state.yAxis;
    btn.classList.toggle('active', isMatch);
  });
}

function syncHomeRoastVisibility(beans) {
  const hasAnyHomeRoasted = beans.some((b) =>
    b.profiles.some((p) => p.roastProfile && p.roastProfile.isHomeRoasted)
  );

  els.axisPresets.querySelectorAll('.preset-roast-only').forEach((el) => {
    el.hidden = !hasAnyHomeRoasted;
  });
  els.xAxisRoastGroup.hidden = !hasAnyHomeRoasted;
  els.yAxisRoastGroup.hidden = !hasAnyHomeRoasted;
  els.batchTrajectoryToggleWrap.hidden = !hasAnyHomeRoasted;

  if (!hasAnyHomeRoasted) {
    state.showAllProfiles = false;
    els.showBatchLinksToggle.checked = false;
    if (AXES_META[state.xAxis]?.isRoastAxis) {
      state.xAxis = 'acidity';
      els.xAxisSelect.value = 'acidity';
    }
    if (AXES_META[state.yAxis]?.isRoastAxis) {
      state.yAxis = 'bitterness';
      els.yAxisSelect.value = 'bitterness';
    }
    syncPresetActiveState();
  }
}

function refreshAll() {
  els.sampleModeBadge.hidden = !state.isSampleMode;
  const allBeans = getAggregatedBeans();
  syncHomeRoastVisibility(allBeans);
  updateOriginFilterOptions(allBeans);
  renderLegend();
  drawFlavorMap();
  renderAllProfilesComparisonTable(allBeans);
  renderBeanCatalog();
  renderInspector();
}

function updateOriginFilterOptions(beans) {
  const origins = Array.from(new Set(beans.map((b) => b.origin))).sort();
  const current = state.filters.origin;
  els.filterOriginSelect.innerHTML =
    '<option value="">すべての産地</option>' +
    origins.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
  els.filterOriginSelect.value = origins.includes(current) ? current : '';
}

function getBeanColor(bean, roastOverride) {
  const roastVal = roastOverride || bean.roast;
  if (state.colorMode === 'roast') {
    return ROAST_COLORS[roastVal] || '#6f4225';
  }
  if (state.colorMode === 'process') {
    return PROCESS_COLORS[bean.process] || '#6e655f';
  }
  if (state.colorMode === 'rating') {
    if (bean.avgRating >= 4.5) return '#c87d20';
    if (bean.avgRating >= 4.0) return '#8f4e27';
    return '#7d7068';
  }
  if (state.colorMode === 'origin') {
    const beans = getAggregatedBeans();
    const origins = Array.from(new Set(beans.map((b) => b.origin))).sort();
    const idx = Math.max(0, origins.indexOf(bean.origin));
    return ORIGIN_PALETTE[idx % ORIGIN_PALETTE.length];
  }
  return '#6f4225';
}

function renderLegend() {
  let items = [];
  if (state.colorMode === 'roast') {
    items = Object.entries(ROAST_COLORS).map(([label, color]) => ({ label, color }));
  } else if (state.colorMode === 'process') {
    items = Object.entries(PROCESS_COLORS).map(([label, color]) => ({ label, color }));
  } else if (state.colorMode === 'rating') {
    items = [
      { label: '★4.5〜 (特にお気に入り)', color: '#c87d20' },
      { label: '★4.0〜4.4', color: '#8f4e27' },
      { label: '〜★3.9', color: '#7d7068' },
    ];
  } else if (state.colorMode === 'origin') {
    const beans = getAggregatedBeans();
    const origins = Array.from(new Set(beans.map((b) => b.origin))).sort();
    items = origins.map((o, idx) => ({
      label: o,
      color: ORIGIN_PALETTE[idx % ORIGIN_PALETTE.length],
    }));
  }

  els.mapLegend.innerHTML = items
    .map(
      (it) => `
      <span class="legend-item">
        <span class="legend-swatch" style="background:${it.color}"></span>
        <span>${escapeHtml(it.label)}</span>
      </span>`
    )
    .join('');
}

function getQuadrantDescriptions(xKey, yKey) {
  const directKey = `${xKey}__${yKey}`;
  if (QUADRANT_TITLES[directKey]) {
    return QUADRANT_TITLES[directKey];
  }
  const xMeta = AXES_META[xKey];
  const yMeta = AXES_META[yKey];
  return {
    tr: {
      title: `高${xMeta.short} × 高${yMeta.short}`,
      sub: `${xMeta.highPole} / ${yMeta.highPole}`,
    },
    tl: {
      title: `低${xMeta.short} × 高${yMeta.short}`,
      sub: `${xMeta.lowPole} / ${yMeta.highPole}`,
    },
    br: {
      title: `高${xMeta.short} × 低${yMeta.short}`,
      sub: `${xMeta.highPole} / ${yMeta.lowPole}`,
    },
    bl: {
      title: `低${xMeta.short} × 低${yMeta.short}`,
      sub: `${xMeta.lowPole} / ${yMeta.lowPole}`,
    },
  };
}

// ============================================================================
// 2軸4象限マップの描画 (Canvas)
// 基本は「各銘柄の最高評価プロファイル1点」のみを描画し、
// 全プロファイル表示モード(showAllProfiles)または全比較タブ選択時のみ別プロファイルを展開する
// ============================================================================
function drawFlavorMap() {
  const canvas = els.canvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(window.devicePixelRatio || 1, 2);
  const width = Math.max(320, rect.width);
  const height = Math.max(460, rect.height);

  canvas.width = width * dpr;
  canvas.height = height * dpr;

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);

  const pad = { top: 52, right: 54, bottom: 52, left: 58 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const centerX = pad.left + plotW / 2;
  const centerY = pad.top + plotH / 2;

  const xMeta = AXES_META[state.xAxis];
  const yMeta = AXES_META[state.yAxis];

  const toX = (val) => {
    const clamped = Math.max(xMeta.min, Math.min(xMeta.max, val));
    return pad.left + ((clamped - xMeta.min) / (xMeta.max - xMeta.min)) * plotW;
  };
  const toY = (val) => {
    const clamped = Math.max(yMeta.min, Math.min(yMeta.max, val));
    return pad.top + plotH - ((clamped - yMeta.min) / (yMeta.max - yMeta.min)) * plotH;
  };

  ctx.fillStyle = '#fdfbf7';
  ctx.fillRect(0, 0, width, height);

  const bgGrad = ctx.createRadialGradient(
    centerX,
    centerY,
    20,
    centerX,
    centerY,
    Math.max(plotW, plotH) * 0.7
  );
  bgGrad.addColorStop(0, '#fcf8f0');
  bgGrad.addColorStop(1, '#f4ecde');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(pad.left, pad.top, plotW, plotH);

  // グリッド目盛り描画
  ctx.lineWidth = 1;
  for (let i = 0; i <= 9; i++) {
    const xVal = xMeta.min + ((xMeta.max - xMeta.min) * i) / 9;
    const yVal = yMeta.min + ((yMeta.max - yMeta.min) * i) / 9;
    const x = pad.left + (plotW * i) / 9;
    const y = pad.top + plotH - (plotH * i) / 9;

    ctx.strokeStyle = i === 4 || i === 5 ? 'rgba(138, 115, 99, 0.16)' : 'rgba(138, 115, 99, 0.09)';
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();

    ctx.fillStyle = 'rgba(138, 115, 99, 0.65)';
    ctx.font = '500 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    const xLabelStr = xMeta.isRoastAxis ? xVal.toFixed(0) + xMeta.unit : String(Math.round(xVal));
    ctx.fillText(xLabelStr, x, pad.top + plotH + 15);

    ctx.textAlign = 'right';
    const yLabelStr = yMeta.isRoastAxis ? yVal.toFixed(0) + yMeta.unit : String(Math.round(yVal));
    ctx.fillText(yLabelStr, pad.left - 8, y + 3);
  }

  const quads = getQuadrantDescriptions(state.xAxis, state.yAxis);
  drawQuadrantWatermark(ctx, pad.left + 14, pad.top + 22, quads.tl, 'left');
  drawQuadrantWatermark(ctx, pad.left + plotW - 14, pad.top + 22, quads.tr, 'right');
  drawQuadrantWatermark(ctx, pad.left + 14, pad.top + plotH - 28, quads.bl, 'left');
  drawQuadrantWatermark(ctx, pad.left + plotW - 14, pad.top + plotH - 28, quads.br, 'right');

  // 中央の十字線
  ctx.save();
  ctx.strokeStyle = '#9c7e65';
  ctx.lineWidth = 1.6;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(centerX, pad.top);
  ctx.lineTo(centerX, pad.top + plotH);
  ctx.moveTo(pad.left, centerY);
  ctx.lineTo(pad.left + plotW, centerY);
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = '#c8b499';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(pad.left, pad.top, plotW, plotH);

  // X軸・Y軸ラベル
  ctx.font = '700 12px "Noto Sans JP", sans-serif';
  ctx.fillStyle = '#4a372b';
  ctx.textAlign = 'center';
  ctx.fillText(`横軸: ${xMeta.label}`, centerX, height - 12);

  ctx.font = '600 11px "Noto Sans JP", sans-serif';
  ctx.fillStyle = '#8a7363';
  ctx.textAlign = 'left';
  ctx.fillText(`◀ ${xMeta.lowPole}`, pad.left, height - 12);
  ctx.textAlign = 'right';
  ctx.fillText(`${xMeta.highPole} ▶`, pad.left + plotW, height - 12);

  ctx.textAlign = 'center';
  ctx.font = '700 12px "Noto Sans JP", sans-serif';
  ctx.fillStyle = '#4a372b';
  ctx.fillText(`▲ ${yMeta.highPole} （縦軸: ${yMeta.label}）`, centerX, 20);

  ctx.font = '600 11px "Noto Sans JP", sans-serif';
  ctx.fillStyle = '#8a7363';
  ctx.fillText(`▼ ${yMeta.lowPole}`, centerX, 37);

  // マップに表示するプロットリストを構築
  // ・通常時: 各銘柄につき1点（選択中の銘柄で別プロファイルを選んでいる場合はそのプロファイル、それ以外は最高評価の bestProfile）
  // ・全プロファイル展開時 (state.showAllProfiles または 選択銘柄が '__ALL__'): 該当銘柄の全プロファイルを展開
  const allBeans = getAggregatedBeans();
  const filteredBeans = getFilteredBeans(allBeans);

  const plotNodes = [];
  const trajectoryGroups = [];

  for (const bean of filteredBeans) {
    const expandThisBean =
      state.showAllProfiles ||
      (bean.beanName === state.selectedBeanName && state.selectedProfileKey === '__ALL__');

    if (expandThisBean && bean.hasMultipleProfiles) {
      const beanNodes = [];
      for (const prof of bean.profiles) {
        const xv = xMeta.getValue(prof.avgScores, prof.roastProfile);
        const yv = yMeta.getValue(prof.avgScores, prof.roastProfile);
        if (xv === null || Number.isNaN(xv) || yv === null || Number.isNaN(yv)) continue;
        const node = {
          nodeId: `${bean.beanName}__${prof.key}`,
          beanName: bean.beanName,
          profileKey: prof.key,
          bean,
          prof,
          isBest: prof.key === bean.bestProfile.key,
          isExpandedSub: true,
          rawX: xv,
          rawY: yv,
        };
        plotNodes.push(node);
        beanNodes.push(node);
      }
      if (beanNodes.length >= 2) {
        trajectoryGroups.push(beanNodes);
      }
    } else {
      const prof =
        bean.beanName === state.selectedBeanName
          ? getActiveProfileForBean(bean)
          : bean.bestProfile;
      const xv = xMeta.getValue(prof.avgScores, prof.roastProfile);
      const yv = yMeta.getValue(prof.avgScores, prof.roastProfile);
      if (xv === null || Number.isNaN(xv) || yv === null || Number.isNaN(yv)) continue;
      plotNodes.push({
        nodeId: `${bean.beanName}__${prof.key}`,
        beanName: bean.beanName,
        profileKey: prof.key,
        bean,
        prof,
        isBest: prof.key === bean.bestProfile.key,
        isExpandedSub: false,
        rawX: xv,
        rawY: yv,
      });
    }
  }

  // 1. 「好みゾーン（スイートスポット）」描画
  if (state.showSweetSpot) {
    for (const item of plotNodes) {
      if (item.prof.displayRating >= 4.4) {
        const bx = toX(item.rawX);
        const by = toY(item.rawY);
        const radius = item.prof.displayRating >= 4.8 ? 85 : 62;
        const glow = ctx.createRadialGradient(bx, by, 4, bx, by, radius);
        glow.addColorStop(0, 'rgba(217, 155, 56, 0.22)');
        glow.addColorStop(0.6, 'rgba(217, 155, 56, 0.08)');
        glow.addColorStop(1, 'rgba(217, 155, 56, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(bx, by, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // 2. 「日々の評価ブレ」の透過描画（表示中のプロファイル内の各回記録の散らばり）
  if (state.showVariance) {
    for (const item of plotNodes) {
      if (item.prof.logs.length < 2) continue;
      const isFocused =
        item.beanName === state.selectedBeanName || item.nodeId === state.hoveredMapNodeId;
      const baseColor = getBeanColor(item.bean, item.prof.roast);

      const avgX = toX(item.rawX);
      const avgY = toY(item.rawY);

      const pts = item.prof.logs.map((l) => ({
        x: toX(xMeta.getValue(l.scores, l.roastProfile || item.prof.roastProfile)),
        y: toY(yMeta.getValue(l.scores, l.roastProfile || item.prof.roastProfile)),
      }));

      const maxDx = Math.max(12, ...pts.map((p) => Math.abs(p.x - avgX))) + 8;
      const maxDy = Math.max(12, ...pts.map((p) => Math.abs(p.y - avgY))) + 8;

      ctx.save();
      ctx.beginPath();
      ctx.ellipse(avgX, avgY, maxDx, maxDy, 0, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(baseColor, isFocused ? 0.16 : 0.08);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(baseColor, isFocused ? 0.45 : 0.22);
      ctx.lineWidth = isFocused ? 1.4 : 1;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.restore();

      for (const pt of pts) {
        ctx.save();
        ctx.strokeStyle = hexToRgba(baseColor, isFocused ? 0.55 : 0.25);
        ctx.lineWidth = isFocused ? 1.2 : 0.9;
        ctx.beginPath();
        ctx.moveTo(avgX, avgY);
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();

        ctx.fillStyle = hexToRgba(baseColor, isFocused ? 0.75 : 0.38);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, isFocused ? 4 : 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  // 2.5 全プロファイル展開時の同一銘柄プロファイル間矢印
  for (const groupNodes of trajectoryGroups) {
    const sorted = [...groupNodes].sort(
      (a, b) => (a.prof.roastProfile?.dropTemp || 0) - (b.prof.roastProfile?.dropTemp || 0)
    );
    for (let i = 0; i < sorted.length - 1; i++) {
      const n1 = sorted[i];
      const n2 = sorted[i + 1];
      drawBatchTrajectoryArrow(
        ctx,
        toX(n1.rawX),
        toY(n1.rawY),
        toX(n2.rawX),
        toY(n2.rawY),
        n1.prof,
        n2.prof
      );
    }
  }

  // 3. メインプロット描画
  state.renderedBeanPositions = [];

  for (const item of plotNodes) {
    const cx = toX(item.rawX);
    const cy = toY(item.rawY);
    const color = getBeanColor(item.bean, item.prof.roast);
    const isSelected = item.beanName === state.selectedBeanName;
    const isHovered = item.nodeId === state.hoveredMapNodeId;
    const isHomeRoasted = Boolean(item.prof.roastProfile?.isHomeRoasted);
    const radius = 9 + Math.min(5, item.prof.count * 1.1);

    state.renderedBeanPositions.push({
      nodeId: item.nodeId,
      beanName: item.beanName,
      profileKey: item.profileKey,
      bean: item.bean,
      prof: item.prof,
      isExpandedSub: item.isExpandedSub,
      x: cx,
      y: cy,
      rawX: item.rawX,
      rawY: item.rawY,
      radius: radius + 4,
    });

    if (isSelected || isHovered) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius + 6, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(color, 0.18);
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#231914' : color;
      ctx.lineWidth = isSelected ? 2.2 : 1.5;
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.shadowColor = 'rgba(35, 25, 20, 0.22)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fill();
    ctx.lineWidth = isHomeRoasted ? 2.4 : 2;
    ctx.strokeStyle = isHomeRoasted ? '#f3b37a' : '#fdfbf7';
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 9.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${item.prof.count}`, cx, cy + 0.5);

    // ラベル文字列：通常時は銘柄名のみ。展開モード時はプロファイル名を添える
    const prefix = isHomeRoasted ? '🔥 ' : '';
    let baseTitle = item.bean.beanName;
    if (baseTitle.length > 14) baseTitle = baseTitle.slice(0, 13) + '…';
    const subTag = item.isExpandedSub
      ? ` (${item.isBest ? '★' : ''}${item.prof.roast})`
      : item.bean.hasMultipleProfiles
      ? ` [★ベスト:${item.prof.roast}]`
      : '';
    const label = prefix + baseTitle + subTag;

    ctx.font = isSelected
      ? '700 11px "Noto Sans JP", sans-serif'
      : '600 10.5px "Noto Sans JP", sans-serif';
    const textW = ctx.measureText(label).width;
    const labelY = cy - radius - 10;

    ctx.fillStyle = isSelected ? 'rgba(35, 25, 20, 0.92)' : 'rgba(253, 251, 247, 0.88)';
    ctx.beginPath();
    ctx.roundRect(cx - textW / 2 - 6, labelY - 9, textW + 12, 18, 5);
    ctx.fill();
    ctx.strokeStyle = isSelected ? '#231914' : 'rgba(200, 180, 153, 0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = isSelected ? '#fdfbf7' : '#231914';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, labelY);
  }

  ctx.restore();
}

function drawBatchTrajectoryArrow(ctx, x1, y1, x2, y2, p1, p2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  if (dist < 24) return;

  const ux = dx / dist;
  const uy = dy / dist;
  const startX = x1 + ux * 15;
  const startY = y1 + uy * 15;
  const endX = x2 - ux * 16;
  const endY = y2 - uy * 16;

  ctx.save();
  ctx.strokeStyle = 'rgba(158, 61, 26, 0.78)';
  ctx.lineWidth = 2.2;
  ctx.setLineDash([5, 3]);
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(endX, endY);
  ctx.stroke();

  ctx.setLineDash([]);
  const headLen = 8;
  const angle = Math.atan2(dy, dx);
  ctx.fillStyle = 'rgba(158, 61, 26, 0.9)';
  ctx.beginPath();
  ctx.moveTo(endX, endY);
  ctx.lineTo(
    endX - headLen * Math.cos(angle - Math.PI / 6),
    endY - headLen * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    endX - headLen * Math.cos(angle + Math.PI / 6),
    endY - headLen * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fill();

  if (p1.roastProfile && p2.roastProfile) {
    const midX = (startX + endX) / 2;
    const midY = (startY + endY) / 2;
    const dTemp = (p2.roastProfile.dropTemp - p1.roastProfile.dropTemp).toFixed(1);
    const sign = Number(dTemp) >= 0 ? '+' : '';
    const tag = `焙煎差 ${sign}${dTemp}℃`;

    ctx.font = '600 9.5px "JetBrains Mono", monospace';
    const tw = ctx.measureText(tag).width;
    ctx.fillStyle = 'rgba(253, 237, 228, 0.94)';
    ctx.beginPath();
    ctx.roundRect(midX - tw / 2 - 5, midY - 8, tw + 10, 16, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(158, 61, 26, 0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#9e3d1a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tag, midX, midY);
  }
  ctx.restore();
}

function drawQuadrantWatermark(ctx, x, y, info, align) {
  ctx.save();
  ctx.textAlign = align;
  ctx.font = '700 13px "Shippori Mincho", serif';
  ctx.fillStyle = 'rgba(92, 73, 61, 0.42)';
  ctx.fillText(info.title, x, y);

  ctx.font = '500 10.5px "Noto Sans JP", sans-serif';
  ctx.fillStyle = 'rgba(138, 115, 99, 0.45)';
  ctx.fillText(info.sub, x, y + 16);
  ctx.restore();
}

function handleCanvasMouseMove(e) {
  const rect = els.canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  let hit = null;
  for (let i = state.renderedBeanPositions.length - 1; i >= 0; i--) {
    const item = state.renderedBeanPositions[i];
    const dist = Math.hypot(mx - item.x, my - item.y);
    if (dist <= item.radius + 4) {
      hit = item;
      break;
    }
  }

  if (hit) {
    els.canvas.style.cursor = 'pointer';
    if (state.hoveredMapNodeId !== hit.nodeId) {
      state.hoveredMapNodeId = hit.nodeId;
      drawFlavorMap();
    }
    const xMeta = AXES_META[state.xAxis];
    const yMeta = AXES_META[state.yAxis];
    const rp = hit.prof.roastProfile;
    const roastExtra = rp
      ? `<div style="font-size:0.7rem;color:#f5b895;margin-top:2px;">🔥 ${escapeHtml(hit.prof.label)}｜排出 ${escapeHtml(rp.dropTemp)}℃ / DTR ${escapeHtml(rp.dtr)}%</div>`
      : '';

    els.mapTooltip.hidden = false;
    els.mapTooltip.style.left = `${hit.x}px`;
    els.mapTooltip.style.top = `${hit.y - 10}px`;
    els.mapTooltip.innerHTML = `
      <div class="tooltip-title">${escapeHtml(hit.bean.beanName)}</div>
      <div class="tooltip-sub">${escapeHtml(hit.bean.origin)} / ${escapeHtml(hit.prof.roast)} / ${escapeHtml(hit.prof.process)} (${hit.prof.count}回平均)</div>
      <div class="tooltip-coords">
        ${escapeHtml(xMeta.short)}: ${hit.rawX.toFixed(1)}${xMeta.unit} ｜ ${escapeHtml(yMeta.short)}: ${hit.rawY.toFixed(1)}${yMeta.unit} ｜ ★${hit.prof.displayRating}
      </div>
      ${roastExtra}
    `;
  } else {
    els.canvas.style.cursor = 'grab';
    if (state.hoveredMapNodeId !== null) {
      state.hoveredMapNodeId = null;
      drawFlavorMap();
    }
    els.mapTooltip.hidden = true;
  }
}

function handleCanvasClick() {
  if (!state.hoveredMapNodeId) return;
  const hit = state.renderedBeanPositions.find((p) => p.nodeId === state.hoveredMapNodeId);
  if (!hit) return;

  state.selectedBeanName = hit.beanName;
  if (hit.isExpandedSub) {
    state.selectedProfileKey = hit.profileKey;
  } else {
    state.selectedProfileKey = null; // デフォルト（最高評価プロファイル）
  }
  drawFlavorMap();
  renderAllProfilesComparisonTable(getAggregatedBeans());
  renderBeanCatalog();
  renderInspector();
}

// ============================================================================
// 全プロファイル表示モード時の「全銘柄×全プロファイル比較一覧表」
// ============================================================================
function renderAllProfilesComparisonTable(allBeans) {
  if (!state.showAllProfiles) {
    els.allProfilesTableCard.hidden = true;
    return;
  }

  els.allProfilesTableCard.hidden = false;
  const beans = getFilteredBeans(allBeans);
  const rowsHtml = [];

  for (const bean of beans) {
    bean.profiles.forEach((prof, idx) => {
      const rp = prof.roastProfile;
      const isBest = idx === 0 && bean.hasMultipleProfiles;
      const isSelected =
        bean.beanName === state.selectedBeanName &&
        (state.selectedProfileKey === prof.key ||
          (!state.selectedProfileKey && idx === 0));

      rowsHtml.push(`
        <tr class="${isSelected ? 'active-row' : ''}" data-bean-name="${escapeHtml(bean.beanName)}" data-prof-key="${escapeHtml(prof.key)}">
          <td><strong>${escapeHtml(bean.beanName)}</strong></td>
          <td>${escapeHtml(bean.origin)}</td>
          <td>
            ${isBest ? '<span class="best-crown">👑ベスト</span> ' : ''}
            ${escapeHtml(prof.label)}
          </td>
          <td>${escapeHtml(prof.roast)}</td>
          <td class="num-cell">${rp ? `${escapeHtml(rp.dropTemp)}℃` : '—'}</td>
          <td class="num-cell">${rp ? `${escapeHtml(rp.dtr)}%` : '—'}</td>
          <td class="num-cell">${rp ? `${escapeHtml(rp.weightLoss)}%` : '—'}</td>
          <td class="num-cell">${prof.count}回</td>
          <td class="num-cell" style="color:#c87d20;font-weight:700;">★${prof.displayRating}</td>
          <td class="num-cell">${prof.avgScores.acidity.toFixed(1)}</td>
          <td class="num-cell">${prof.avgScores.bitterness.toFixed(1)}</td>
          <td class="num-cell">${prof.avgScores.sweetness.toFixed(1)}</td>
          <td class="num-cell">${prof.avgScores.body.toFixed(1)}</td>
          <td class="num-cell">${prof.avgScores.aroma.toFixed(1)}</td>
          <td class="num-cell">${prof.avgScores.aftertaste.toFixed(1)}</td>
        </tr>
      `);
    });
  }

  els.allProfilesTableBody.innerHTML = rowsHtml.join('');

  els.allProfilesTableBody.querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', () => {
      state.selectedBeanName = tr.dataset.beanName;
      state.selectedProfileKey = tr.dataset.profKey;
      drawFlavorMap();
      renderAllProfilesComparisonTable(allBeans);
      renderBeanCatalog();
      renderInspector();
    });
  });
}

// ============================================================================
// 右サイドバー：選択銘柄インスペクター（同一銘柄内のプロファイル切替・比較表）
// ============================================================================
function renderInspector() {
  const beans = getAggregatedBeans();
  const bean = beans.find((b) => b.beanName === state.selectedBeanName);

  if (!bean) {
    els.inspectorEmptyState.hidden = false;
    els.inspectorContent.hidden = true;
    return;
  }

  els.inspectorEmptyState.hidden = true;
  els.inspectorContent.hidden = false;

  const isCompareAllMode = state.selectedProfileKey === '__ALL__';
  const activeProf = getActiveProfileForBean(bean);

  const roastColor = ROAST_COLORS[activeProf.roast] || '#6f4225';
  const homeRoastBadge = activeProf.roastProfile?.isHomeRoasted
    ? `<span class="badge badge-home-roast">🔥 自家焙煎</span>`
    : '';

  els.inspectorBadges.innerHTML = `
    <span class="badge badge-origin">🌍 ${escapeHtml(bean.origin)}</span>
    <span class="badge badge-roast" style="background:${roastColor}">${escapeHtml(activeProf.roast)}</span>
    <span class="badge badge-process">${escapeHtml(activeProf.process)}</span>
    ${homeRoastBadge}
  `;

  els.inspectorBeanName.textContent = bean.beanName;
  els.inspectorMeta.innerHTML = bean.hasMultipleProfiles
    ? `<span>🔥 <strong>${bean.profiles.length}</strong> 種類の焙煎プロファイル（計${bean.count}回記録）</span><span>★ 最高評価 <strong>${bean.bestProfile.displayRating}</strong></span>`
    : `<span>☕ 記録 <strong>${activeProf.count}</strong> 回（平均化済）</span><span>★ 平均お気に入り <strong>${activeProf.displayRating}</strong></span>`;

  // 同一銘柄に複数の焙煎プロファイルがある場合のみプロファイル切替バーを表示
  if (bean.hasMultipleProfiles) {
    els.inspectorProfileSwitcher.hidden = false;
    const currentKey = state.selectedProfileKey || bean.bestProfile.key;

    const tabsHtml = bean.profiles
      .map((p, idx) => {
        const isBest = idx === 0;
        const isActive = currentKey === p.key;
        return `
          <button type="button" class="profile-tab-btn ${isActive ? 'active' : ''}" data-prof-key="${escapeHtml(p.key)}">
            ${isBest ? '<span class="best-crown">👑ベスト</span>' : ''}
            <span>${escapeHtml(p.label)}</span>
            <span style="opacity:0.85;">(★${p.displayRating})</span>
          </button>
        `;
      })
      .join('');

    const compareAllBtnHtml = `
      <button type="button" class="profile-tab-btn compare-all-btn ${isCompareAllMode ? 'active' : ''}" data-prof-key="__ALL__">
        📊 全プロファイル比較表
      </button>
    `;

    els.inspectorProfileTabs.innerHTML = tabsHtml + compareAllBtnHtml;

    els.inspectorProfileTabs.querySelectorAll('.profile-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedProfileKey = btn.dataset.profKey;
        drawFlavorMap();
        renderAllProfilesComparisonTable(beans);
        renderInspector();
      });
    });
  } else {
    els.inspectorProfileSwitcher.hidden = true;
  }

  // 「📊 全プロファイル比較表」が選ばれている時のみ、銘柄内のプロファイル比較表を表示
  if (bean.hasMultipleProfiles && isCompareAllMode) {
    els.inspectorProfileCompareWrap.hidden = false;
    els.inspectorProfileCompareBody.innerHTML = bean.profiles
      .map((p, idx) => {
        const rp = p.roastProfile;
        const colorDot = PROFILE_COMPARE_COLORS[idx % PROFILE_COMPARE_COLORS.length];
        return `
          <tr data-prof-key="${escapeHtml(p.key)}">
            <td>
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${colorDot};margin-right:3px;"></span>
              ${idx === 0 ? '👑 ' : ''}${escapeHtml(p.label)}
            </td>
            <td>${escapeHtml(p.roast)}</td>
            <td class="num-cell">${rp ? `${escapeHtml(rp.dropTemp)}℃ / ${escapeHtml(rp.dtr)}%` : '—'}</td>
            <td class="num-cell" style="color:#c87d20;font-weight:700;">★${p.displayRating}</td>
            <td class="num-cell">${p.avgScores.acidity.toFixed(1)}</td>
            <td class="num-cell">${p.avgScores.bitterness.toFixed(1)}</td>
            <td class="num-cell">${p.avgScores.sweetness.toFixed(1)}</td>
            <td class="num-cell">${p.avgScores.body.toFixed(1)}</td>
            <td class="num-cell">${p.avgScores.aroma.toFixed(1)}</td>
            <td class="num-cell">${p.avgScores.aftertaste.toFixed(1)}</td>
          </tr>
        `;
      })
      .join('');

    els.inspectorProfileCompareBody.querySelectorAll('tr').forEach((tr) => {
      tr.addEventListener('click', () => {
        state.selectedProfileKey = tr.dataset.profKey;
        drawFlavorMap();
        renderInspector();
      });
    });
  } else {
    els.inspectorProfileCompareWrap.hidden = true;
  }

  // 安定度バッジ
  if (isCompareAllMode && bean.hasMultipleProfiles) {
    els.stabilityBadge.textContent = `${bean.profiles.length}プロファイル重ね合わせ比較中`;
  } else if (activeProf.count === 1) {
    els.stabilityBadge.textContent = '記録1回（2回目以降でブレ表示）';
  } else if (activeProf.meanSd <= 0.55) {
    els.stabilityBadge.textContent = `評価の安定度：高（ブレ ±${activeProf.meanSd}）`;
  } else if (activeProf.meanSd <= 0.95) {
    els.stabilityBadge.textContent = `評価の安定度：中（ブレ ±${activeProf.meanSd}）`;
  } else {
    els.stabilityBadge.textContent = `日による変化：大（ブレ ±${activeProf.meanSd}）`;
  }

  // 6軸レーダーチャート描画（単一プロファイル or 全プロファイル重ね合わせ）
  drawRadarChart(bean, activeProf, isCompareAllMode);

  // スコアグリッド
  const scoreKeys = ['acidity', 'bitterness', 'sweetness', 'body', 'aroma', 'aftertaste'];
  els.inspectorScoreGrid.innerHTML = scoreKeys
    .map((k) => {
      const meta = AXES_META[k];
      const avg = activeProf.avgScores[k].toFixed(1);
      const sd = activeProf.count > 1 ? `±${activeProf.sdScores[k].toFixed(1)}` : '—';
      return `
        <div class="score-stat-box">
          <span class="score-stat-label">${escapeHtml(meta.short)}</span>
          <span class="score-stat-val">${avg} <span class="score-stat-sd">(${sd})</span></span>
        </div>
      `;
    })
    .join('');

  // 🔥 自家焙煎プロファイルセクション（自家焙煎データがある時のみ表示！）
  const hasRoast = Boolean(activeProf.roastProfile && activeProf.roastProfile.isHomeRoasted);
  if (hasRoast) {
    els.inspectorRoastSection.hidden = false;
    const rp = activeProf.roastProfile;
    els.roastBatchBadge.textContent = isCompareAllMode
      ? `全${bean.profiles.length}プロファイル波形比較`
      : rp.batchLabel || rp.sourceFile || 'Artisan Profile';

    drawRoastCurveCanvas(bean, activeProf, isCompareAllMode);

    els.inspectorRoastSpecs.innerHTML = `
      <div class="roast-spec-pill">
        <span class="roast-spec-label">排出温度</span>
        <span class="roast-spec-val">${escapeHtml(rp.dropTemp ?? '—')}℃</span>
      </div>
      <div class="roast-spec-pill">
        <span class="roast-spec-label">DTR (発達率)</span>
        <span class="roast-spec-val">${escapeHtml(rp.dtr ?? '—')}%</span>
      </div>
      <div class="roast-spec-pill">
        <span class="roast-spec-label">1ハゼ / 総時間</span>
        <span class="roast-spec-val">${escapeHtml(formatSecToMmSs(rp.fcsSec))} / ${escapeHtml(formatSecToMmSs(rp.dropSec))}</span>
      </div>
      <div class="roast-spec-pill">
        <span class="roast-spec-label">重量減少率</span>
        <span class="roast-spec-val">${escapeHtml(rp.weightLoss ?? '—')}%</span>
      </div>
    `;
  } else {
    els.inspectorRoastSection.hidden = true;
  }

  // 履歴リスト（全比較時は全ログ、単一プロファイル時はそのプロファイルのログ）
  const targetLogs = isCompareAllMode ? bean.allLogs : activeProf.logs;
  els.historyCountTitle.textContent = isCompareAllMode
    ? `全プロファイルの記録履歴 (${targetLogs.length}件)`
    : `このプロファイルの記録履歴 (${targetLogs.length}件)`;

  els.inspectorHistoryList.innerHTML = targetLogs
    .map((log) => {
      const safeRating = Math.round(clampNumber(log.rating, 1, 5, 4));
      const stars = '★'.repeat(safeRating) + '☆'.repeat(5 - safeRating);
      const batchTag = log.roastProfile?.batchLabel
        ? `<span style="font-size:0.68rem;background:#fdede4;color:#9e3d1a;padding:1px 5px;border-radius:4px;">🔥 ${escapeHtml(log.roastProfile.batchLabel)}</span>`
        : '';
      return `
        <div class="history-item">
          <div class="history-item-top">
            <span class="history-date">${escapeHtml(log.date)} ${batchTag}</span>
            <span class="history-stars">${stars}</span>
            <div class="history-actions">
              <button class="btn-mini" data-edit-id="${escapeHtml(log.id)}">編集</button>
              <button class="btn-mini delete" data-del-id="${escapeHtml(log.id)}">削除</button>
            </div>
          </div>
          ${log.tempNote ? `<div style="font-size:0.7rem;color:#6f4225;font-weight:600;">🌡️ ${escapeHtml(log.tempNote)}</div>` : ''}
          ${log.memo ? `<div class="history-memo">${escapeHtml(log.memo)}</div>` : ''}
          <div class="history-mini-scores">
            <span>酸:${escapeHtml(log.scores.acidity)}</span>
            <span>苦:${escapeHtml(log.scores.bitterness)}</span>
            <span>甘:${escapeHtml(log.scores.sweetness)}</span>
            <span>コク:${escapeHtml(log.scores.body)}</span>
            <span>香:${escapeHtml(log.scores.aroma)}</span>
            <span>余韻:${escapeHtml(log.scores.aftertaste)}</span>
          </div>
        </div>
      `;
    })
    .join('');

  els.inspectorHistoryList.querySelectorAll('[data-edit-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.editId;
      const log = state.logs.find((l) => l.id === id);
      if (log) openLogModal({ editLog: log });
    });
  });

  els.inspectorHistoryList.querySelectorAll('[data-del-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.delId;
      if (confirm('この日の記録を削除しますか？')) {
        state.logs = state.logs.filter((l) => l.id !== id);
        saveToStorage();
        refreshAll();
      }
    });
  });
}

// Artisan 焙煎曲線キャンバス描画 (単一プロファイル表示 ＆ 全プロファイル重ね合わせ比較対応)
function drawRoastCurveCanvas(bean, activeProf, isCompareAllMode) {
  const rp = activeProf.roastProfile;
  const canvas = els.roastCurveCanvas;
  const parentBox = canvas.parentElement;
  const cssW = Math.max(320, (parentBox ? parentBox.clientWidth : 360) - 14);
  const cssH = 230;

  const scale = Math.max(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.round(cssW * scale);
  canvas.height = Math.round(cssH * scale);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(scale, scale);

  const w = cssW;
  const h = cssH;

  const pad = { top: 30, right: 34, bottom: 26, left: 40 };
  const pw = w - pad.left - pad.right;
  const ph = h - pad.top - pad.bottom;

  const curve =
    rp.curve && Array.isArray(rp.curve.timex) && rp.curve.timex.length > 2 && rp.curve.smoothV3
      ? rp.curve
      : buildSyntheticRoastCurve(rp);

  const maxCurveSec = (curve.timex || []).reduce(
    (acc, v) => (Number.isFinite(v) && v > acc ? v : acc),
    600
  );
  const maxTime = Math.min(7200, maxCurveSec) * 1.04;
  const minTemp = 80;
  const maxTemp = 235;
  const maxRor = 24;

  const toX = (sec) => pad.left + (sec / maxTime) * pw;
  const toYTemp = (temp) => pad.top + ph - ((temp - minTemp) / (maxTemp - minTemp)) * ph;
  const toYRor = (rorVal) => pad.top + ph - (Math.max(0, Math.min(maxRor, rorVal)) / maxRor) * ph;

  ctx.fillStyle = '#1e1510';
  ctx.fillRect(0, 0, w, h);

  // 横グリッド線と温度・RoR目盛り
  for (const temp of [100, 150, 200]) {
    const y = toYTemp(temp);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.11)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + pw, y);
    ctx.stroke();

    ctx.fillStyle = '#d8c8b8';
    ctx.font = '600 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${temp}℃`, pad.left - 6, y);
  }

  for (const rStep of [5, 10, 15, 20]) {
    const y = toYRor(rStep);
    ctx.fillStyle = 'rgba(76, 212, 149, 0.75)';
    ctx.font = '500 9.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${rStep}`, pad.left + pw + 5, y);
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.left, pad.top, pw, ph);

  for (let m = 0; m <= Math.floor(maxTime / 60); m += 2) {
    const sec = m * 60;
    const x = toX(sec);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + ph);
    ctx.stroke();

    ctx.fillStyle = '#d8c8b8';
    ctx.font = '600 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${m}:00`, x, h - 11);
  }

  // 全プロファイル比較モード時は複数プロファイルのBT/RoR曲線を色分けして重ね描き！
  if (isCompareAllMode && bean.hasMultipleProfiles) {
    ctx.font = '600 10px "Noto Sans JP", sans-serif';
    ctx.textAlign = 'left';
    let lx = pad.left;
    bean.profiles.forEach((p, idx) => {
      if (!p.roastProfile) return;
      const col = PROFILE_COMPARE_COLORS[idx % PROFILE_COMPARE_COLORS.length];
      ctx.fillStyle = col;
      const shortLbl = p.label.length > 16 ? p.label.slice(0, 15) + '…' : p.label;
      ctx.fillText(`● ${shortLbl}`, lx, 14);
      lx += ctx.measureText(`● ${shortLbl}`).width + 14;
    });

    bean.profiles.forEach((p, idx) => {
      const prp = p.roastProfile;
      if (!prp) return;
      const pCurve =
        prp.curve && prp.curve.smoothV3 ? prp.curve : buildSyntheticRoastCurve(prp);
      const col = PROFILE_COMPARE_COLORS[idx % PROFILE_COMPARE_COLORS.length];

      // RoR (破線)
      ctx.save();
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      let started = false;
      pCurve.timex.forEach((t, i) => {
        const rv = pCurve.ror[i];
        if (rv === null || rv === undefined || rv < 0) return;
        const x = toX(t);
        const y = toYRor(rv);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();

      // BT (実線)
      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      pCurve.timex.forEach((t, i) => {
        const x = toX(t);
        const y = toYTemp(pCurve.bt[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // 排出点ドット
      const dx = toX(prp.dropSec);
      const dy = toYTemp(prp.dropTemp);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(dx, dy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });

    ctx.restore();
    return;
  }

  // 単一プロファイル描画
  ctx.font = '600 10.5px "Noto Sans JP", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ff8c42';
  ctx.fillText('● BT (豆温度)', pad.left, 14);
  ctx.fillStyle = '#4cd495';
  ctx.fillText('● RoR (上昇率 ℃/分)', pad.left + 88, 14);
  ctx.fillStyle = '#8ecae6';
  ctx.fillText('┄ ET (排気)', pad.left + 206, 14);

  if (rp.fcsSec && rp.dropSec && rp.dropSec > rp.fcsSec) {
    const xFcs = toX(rp.fcsSec);
    const xDrop = toX(rp.dropSec);
    ctx.fillStyle = 'rgba(235, 168, 52, 0.16)';
    ctx.fillRect(xFcs, pad.top, xDrop - xFcs, ph);

    ctx.strokeStyle = 'rgba(235, 168, 52, 0.45)';
    ctx.lineWidth = 1;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(xFcs, pad.top);
    ctx.lineTo(xFcs, pad.top + ph);
    ctx.moveTo(xDrop, pad.top);
    ctx.lineTo(xDrop, pad.top + ph);
    ctx.stroke();
    ctx.restore();

    const dtrCenter = (xFcs + xDrop) / 2;
    const dtrText = `DTR ${rp.dtr}%`;
    ctx.font = '700 10px "JetBrains Mono", monospace';
    const dtw = ctx.measureText(dtrText).width;
    ctx.fillStyle = 'rgba(30, 21, 16, 0.88)';
    ctx.beginPath();
    ctx.roundRect(dtrCenter - dtw / 2 - 5, pad.top + ph - 20, dtw + 10, 16, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(235, 168, 52, 0.6)';
    ctx.stroke();

    ctx.fillStyle = '#ffd166';
    ctx.textAlign = 'center';
    ctx.fillText(dtrText, dtrCenter, pad.top + ph - 12);
  }

  if (Array.isArray(curve.et) && curve.et.length === curve.timex.length) {
    ctx.save();
    ctx.strokeStyle = 'rgba(142, 202, 230, 0.65)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    curve.timex.forEach((t, i) => {
      const x = toX(t);
      const y = toYTemp(curve.et[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  if (Array.isArray(curve.ror)) {
    ctx.save();
    ctx.strokeStyle = '#4cd495';
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    let started = false;
    curve.timex.forEach((t, i) => {
      const rVal = curve.ror[i];
      if (rVal === null || rVal === undefined || rVal < 0) return;
      const x = toX(t);
      const y = toYRor(rVal);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.strokeStyle = '#ff8c42';
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  curve.timex.forEach((t, i) => {
    const x = toX(t);
    const y = toYTemp(curve.bt[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();

  const drawCalloutBadge = (sec, temp, label, color, offsetX, offsetY) => {
    if (!sec || !temp) return;
    const x = toX(sec);
    const y = toYTemp(temp);

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1e1510';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = '700 10px "Noto Sans JP", sans-serif';
    const tw = ctx.measureText(label).width;
    const bx = Math.max(pad.left + tw / 2 + 4, Math.min(pad.left + pw - tw / 2 - 4, x + offsetX));
    const by = y + offsetY;

    ctx.fillStyle = 'rgba(30, 21, 16, 0.9)';
    ctx.beginPath();
    ctx.roundRect(bx - tw / 2 - 5, by - 8, tw + 10, 16, 4);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx, by);
  };

  if (rp.tpTimeSec && rp.tpTemp) {
    drawCalloutBadge(rp.tpTimeSec, rp.tpTemp, `TP ${rp.tpTemp}℃`, '#a8dadc', 12, 14);
  }
  drawCalloutBadge(rp.fcsSec, rp.fcsTemp, `1ハゼ ${rp.fcsTemp}℃`, '#ffd166', -22, -15);
  drawCalloutBadge(rp.dropSec, rp.dropTemp, `排出 ${rp.dropTemp}℃`, '#ff7b54', -18, 16);

  ctx.restore();
}

function drawRadarChart(bean, activeProf, isCompareAllMode) {
  const canvas = els.radarCanvas;
  const scale = Math.max(window.devicePixelRatio || 1, 2.5);
  const w = 280;
  const h = 230;
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(scale, scale);

  const cx = w / 2;
  const cy = h / 2 + 4;
  const maxR = 76;
  const keys = ['acidity', 'bitterness', 'body', 'aftertaste', 'sweetness', 'aroma'];

  const getAngle = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / keys.length;
  const getPt = (i, val) => {
    const r = (val / 10) * maxR;
    const ang = getAngle(i);
    return { x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) };
  };

  ctx.clearRect(0, 0, w, h);

  for (const step of [2, 4, 6, 8, 10]) {
    ctx.beginPath();
    keys.forEach((_, i) => {
      const pt = getPt(i, step);
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    });
    ctx.closePath();
    ctx.strokeStyle = step === 6 ? 'rgba(138, 115, 99, 0.35)' : 'rgba(138, 115, 99, 0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  keys.forEach((k, i) => {
    const outer = getPt(i, 10);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(outer.x, outer.y);
    ctx.strokeStyle = 'rgba(138, 115, 99, 0.25)';
    ctx.stroke();

    const labelPt = getPt(i, 12.3);
    ctx.font = '700 10.5px "Noto Sans JP", sans-serif';
    ctx.fillStyle = '#4a372b';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(AXES_META[k].short, labelPt.x, labelPt.y);
  });

  // 全プロファイル比較モード時は各プロファイルの平均ポリゴンを色分けして重ね描き
  if (isCompareAllMode && bean.hasMultipleProfiles) {
    bean.profiles.forEach((prof, idx) => {
      const col = PROFILE_COMPARE_COLORS[idx % PROFILE_COMPARE_COLORS.length];
      ctx.beginPath();
      keys.forEach((k, i) => {
        const pt = getPt(i, prof.avgScores[k]);
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      });
      ctx.closePath();
      ctx.fillStyle = hexToRgba(col, 0.15);
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.1;
      ctx.stroke();
    });
    ctx.restore();
    return;
  }

  // 単一プロファイル表示（各回のブレ＋プロファイル平均）
  if (activeProf.logs.length > 1) {
    for (const log of activeProf.logs) {
      ctx.beginPath();
      keys.forEach((k, i) => {
        const pt = getPt(i, log.scores[k] || 5);
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(200, 138, 75, 0.08)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(200, 138, 75, 0.38)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  ctx.beginPath();
  keys.forEach((k, i) => {
    const pt = getPt(i, activeProf.avgScores[k]);
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(111, 66, 37, 0.24)';
  ctx.fill();
  ctx.strokeStyle = '#6f4225';
  ctx.lineWidth = 2.2;
  ctx.stroke();

  keys.forEach((k, i) => {
    const pt = getPt(i, activeProf.avgScores[k]);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = '#6f4225';
    ctx.fill();
  });

  ctx.restore();
}

function renderBeanCatalog() {
  const allBeans = getAggregatedBeans();
  const beans = getFilteredBeans(allBeans);

  els.beanCountBadge.textContent = String(beans.length);

  beans.sort((a, b) => {
    if (state.sortBy === 'count') return b.count - a.count;
    if (state.sortBy === 'rating') return b.avgRating - a.avgRating;
    if (state.sortBy === 'name') return a.beanName.localeCompare(b.beanName, 'ja');
    return (b.latestDate || '').localeCompare(a.latestDate || '');
  });

  if (beans.length === 0) {
    els.beanListContainer.innerHTML = `<div style="text-align:center;padding:1.2rem;color:#8a7363;font-size:0.8rem;">該当する銘柄がありません</div>`;
    return;
  }

  els.beanListContainer.innerHTML = beans
    .map((b) => {
      const isSelected = b.beanName === state.selectedBeanName;
      const color = ROAST_COLORS[b.roast] || '#6f4225';
      const fireIcon = b.roastProfile?.isHomeRoasted ? '🔥 ' : '';
      const profBadge = b.hasMultipleProfiles
        ? `<span style="font-size:0.66rem;background:#fdede4;color:#9e3d1a;padding:1px 5px;border-radius:4px;font-weight:700;">${b.profiles.length}プロファイル</span>`
        : '';
      return `
        <div class="bean-row ${isSelected ? 'selected' : ''}" data-bean-name="${escapeHtml(b.beanName)}">
          <div class="bean-row-main">
            <div class="bean-row-title">${fireIcon}${escapeHtml(b.beanName)}</div>
            <div class="bean-row-sub">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}"></span>
              <span>${escapeHtml(b.origin)} / ★ベスト:${escapeHtml(b.roast)} (${b.avgRating})</span>
              ${profBadge}
            </div>
          </div>
          <div class="bean-row-right">
            <span class="cup-count-tag">計${b.count}回</span>
          </div>
        </div>
      `;
    })
    .join('');

  els.beanListContainer.querySelectorAll('.bean-row').forEach((row) => {
    row.addEventListener('click', () => {
      state.selectedBeanName = row.dataset.beanName;
      state.selectedProfileKey = state.showAllProfiles ? '__ALL__' : null;
      drawFlavorMap();
      renderAllProfilesComparisonTable(allBeans);
      renderBeanCatalog();
      renderInspector();
    });
  });
}

// ============================================================================
// モーダル（記録追加・2回目以降の自動補完・同一銘柄内プロファイル選択）
// ============================================================================
function openLogModal(options = {}) {
  const { prefillBeanName, prefillProfileKey, editLog } = options;
  const beans = getAggregatedBeans();

  els.existingBeanSelect.innerHTML =
    '<option value="">＋ 新しい銘柄として入力する / 直接入力</option>' +
    beans
      .map(
        (b) =>
          `<option value="${escapeHtml(b.beanName)}">${escapeHtml(b.beanName)} （${escapeHtml(b.origin)} / 過去${b.count}回・${b.profiles.length}プロファイル）</option>`
      )
      .join('');

  els.beanNameDatalist.innerHTML = beans
    .map((b) => `<option value="${escapeHtml(b.beanName)}"></option>`)
    .join('');

  const usedOrigins = Array.from(new Set(beans.map((b) => b.origin)));
  const allOrigins = Array.from(new Set([...usedOrigins, ...DEFAULT_ORIGINS]));
  els.originDatalist.innerHTML = allOrigins
    .map((o) => `<option value="${escapeHtml(o)}"></option>`)
    .join('');

  els.originQuickChips.innerHTML = allOrigins
    .slice(0, 8)
    .map((o) => `<button type="button" class="origin-chip" data-origin="${escapeHtml(o)}">${escapeHtml(o)}</button>`)
    .join('');

  els.originQuickChips.querySelectorAll('.origin-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      els.originInput.value = chip.dataset.origin;
    });
  });

  const todayStr = new Date().toLocaleDateString('sv-SE');
  resetHomeRoastModalFields();
  hidePrevAvgTags();

  if (editLog) {
    els.modalEyebrow.textContent = 'EDIT TASTING LOG';
    els.modalTitle.textContent = '記録を編集';
    els.editLogId.value = editLog.id;
    els.existingBeanSelect.value = '';
    els.beanNameInput.value = editLog.beanName;
    els.logDateInput.value = editLog.date || todayStr;
    els.originInput.value = editLog.origin || '';
    els.roastSelect.value = editLog.roast || '中煎り';
    els.processSelect.value = editLog.process || 'ウォッシュト';
    setSlidersValues(editLog.scores);
    setStarRating(editLog.rating || 4);
    els.tempChangeInput.value = editLog.tempNote || '';
    els.memoInput.value = editLog.memo || '';
    els.sliderAutoFillNotice.textContent = 'この日の1回分の記録内容を編集しています';

    populateExistingProfilesDropdown(editLog.beanName);
    if (editLog.roastProfile && editLog.roastProfile.isHomeRoasted) {
      applyRoastProfileToModal(editLog.roastProfile);
    }
  } else {
    els.modalEyebrow.textContent = 'DAILY CUP LOGGING';
    els.modalTitle.textContent = '今日の一杯を記録';
    els.editLogId.value = '';
    els.logDateInput.value = todayStr;
    els.memoInput.value = '';
    els.tempChangeInput.value = ''; // 初期状態は未記入（空欄）
    setStarRating(4);

    if (prefillBeanName) {
      els.existingBeanSelect.value = prefillBeanName;
      applyBeanAutoFill(prefillBeanName, prefillProfileKey);
    } else {
      els.existingBeanSelect.value = '';
      els.beanNameInput.value = '';
      els.originInput.value = '';
      els.roastSelect.value = '中煎り';
      els.processSelect.value = 'ウォッシュト';
      setSlidersValues({
        acidity: 5,
        bitterness: 5,
        sweetness: 5,
        body: 5,
        aroma: 5,
        aftertaste: 5,
      });
      els.sliderAutoFillNotice.textContent =
        '今回の1杯のスコアを直感で入力してください（同じ銘柄は回数分の平均位置にマッピングされます）';
    }
  }

  els.logModalBackdrop.hidden = false;
}

function showPrevAvgTags(avgScores) {
  if (!els.prevAvgTags) return;
  for (const [k, el] of Object.entries(els.prevAvgTags)) {
    if (!el) continue;
    const val = avgScores?.[k];
    if (val !== undefined) {
      el.textContent = `前回平均 ${ Number(val).toFixed(1) }`;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }
}

function hidePrevAvgTags() {
  if (!els.prevAvgTags) return;
  for (const el of Object.values(els.prevAvgTags)) {
    if (el) el.hidden = true;
  }
}

function populateExistingProfilesDropdown(beanName) {
  const beans = getAggregatedBeans();
  const found = beans.find((b) => b.beanName === beanName);
  const homeProfiles = found
    ? found.profiles.filter((p) => p.roastProfile && p.roastProfile.isHomeRoasted)
    : [];

  els.existingProfileSelect.innerHTML =
    '<option value="">＋ 新しい焙煎プロファイル（別バッチ）として記録</option>' +
    homeProfiles
      .map(
        (p) =>
          `<option value="${escapeHtml(p.key)}">${escapeHtml(p.label)} (${escapeHtml(p.roast)} / 過去${p.count}回・★${p.displayRating})</option>`
      )
      .join('');
}

function resetHomeRoastModalFields() {
  els.isHomeRoastedCheckbox.checked = false;
  els.homeRoastFormPanel.hidden = true;
  els.existingProfileSelect.innerHTML =
    '<option value="">＋ 新しい焙煎プロファイル（別バッチ）として記録</option>';
  els.batchLabelInput.value = '';
  els.roastChargeTemp.value = '';
  els.roastFcsTime.value = '';
  els.roastFcsTemp.value = '';
  els.roastDropTime.value = '';
  els.roastDropTemp.value = '';
  els.roastDtr.value = '';
  els.roastWeightLoss.value = '';
  state.currentModalCurve = null;
  state.currentModalSourceFile = '';
  els.alogStatusText.textContent =
    '温度曲線（BT/ET/RoR）・1ハゼ・排出温度・DTR(%)・重量減少率を自動抽出します';
}

function applyBeanAutoFill(beanName, preferredProfileKey = null) {
  const beans = getAggregatedBeans();
  const found = beans.find((b) => b.beanName === beanName);
  if (!found) return;

  const targetProf =
    (preferredProfileKey && found.profiles.find((p) => p.key === preferredProfileKey)) ||
    found.bestProfile;

  els.beanNameInput.value = found.beanName;
  els.originInput.value = found.origin;
  els.roastSelect.value = targetProf.roast;
  els.processSelect.value = targetProf.process;

  const rounded = {};
  for (const [k, v] of Object.entries(targetProf.avgScores)) {
    rounded[k] = Math.round(v);
  }
  setSlidersValues(rounded);
  showPrevAvgTags(targetProf.avgScores);
  setStarRating(Math.round(targetProf.displayRating));
  els.sliderAutoFillNotice.innerHTML = `<strong style="color:#6f4225">✓ 「${escapeHtml(targetProf.label)}」の ${targetProf.count + 1} 回目の記録として追加します</strong>（過去の記録は上書きされません。入力ガイドとして過去${targetProf.count}回の平均値を初期セットしています）`;

  populateExistingProfilesDropdown(found.beanName);
  if (targetProf.roastProfile && targetProf.roastProfile.isHomeRoasted) {
    els.existingProfileSelect.value = targetProf.key;
    applyRoastProfileToModal(targetProf.roastProfile);
  } else {
    resetHomeRoastModalFields();
  }
}

function setSlidersValues(scores) {
  for (const [k, inputEl] of Object.entries(els.sliders)) {
    const val = Math.round(Number(scores?.[k] ?? 5));
    inputEl.value = val;
    els.sliderOutputs[k].textContent = val;
  }
}

function setStarRating(rating) {
  els.ratingInput.value = rating;
  els.ratingTextLabel.textContent = `${rating} / 5`;
  els.starRatingGroup.querySelectorAll('.star-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.rating) <= rating);
  });
}

function closeLogModal() {
  els.logModalBackdrop.hidden = true;
}

function handleFormSubmit(e) {
  e.preventDefault();
  const beanName = els.beanNameInput.value.trim();
  const origin = els.originInput.value.trim() || '不明';
  if (!beanName) return;

  let roastProfile = null;
  if (els.isHomeRoastedCheckbox.checked) {
    const chargeTemp = Number(els.roastChargeTemp.value || 195);
    const fcsSec = parseMmSsToSec(els.roastFcsTime.value || '07:50');
    const fcsTemp = Number(els.roastFcsTemp.value || 196);
    const dropSec = parseMmSsToSec(els.roastDropTime.value || '09:30');
    const dropTemp = Number(els.roastDropTemp.value || 206);
    const dtr = Number(
      els.roastDtr.value ||
        (dropSec > fcsSec ? (((dropSec - fcsSec) / dropSec) * 100).toFixed(1) : 16.0)
    );
    const weightLoss = Number(els.roastWeightLoss.value || 14.5);
    const batchLabel =
      els.batchLabelInput.value.trim() || `Batch (${els.roastSelect.value} ${dropTemp}℃)`;

    roastProfile = {
      isHomeRoasted: true,
      batchLabel,
      roastDate: els.logDateInput.value,
      chargeTemp,
      tpTimeSec: 80,
      tpTemp: 102,
      dryEndSec: Math.round(fcsSec * 0.57),
      dryEndTemp: 152,
      fcsSec,
      fcsTemp,
      dropSec,
      dropTemp,
      dtr,
      weightLoss,
      sourceFile: state.currentModalSourceFile || '',
      curve:
        state.currentModalCurve ||
        buildSyntheticRoastCurve({
          chargeTemp,
          fcsSec,
          fcsTemp,
          dropSec,
          dropTemp,
        }),
    };
  }

  const newLog = {
    id: els.editLogId.value || `log-${Date.now()}`,
    beanName,
    origin,
    roast: els.roastSelect.value,
    process: els.processSelect.value,
    date: els.logDateInput.value,
    scores: {
      acidity: Number(els.sliders.acidity.value),
      bitterness: Number(els.sliders.bitterness.value),
      sweetness: Number(els.sliders.sweetness.value),
      body: Number(els.sliders.body.value),
      aroma: Number(els.sliders.aroma.value),
      aftertaste: Number(els.sliders.aftertaste.value),
    },
    rating: Number(els.ratingInput.value || 4),
    tempNote: els.tempChangeInput.value.trim(),
    memo: els.memoInput.value.trim(),
    roastProfile,
  };

  if (els.editLogId.value) {
    const idx = state.logs.findIndex((l) => l.id === els.editLogId.value);
    if (idx !== -1) state.logs[idx] = newLog;
  } else {
    state.logs.push(newLog);
  }

  state.selectedBeanName = beanName;
  state.selectedProfileKey = roastProfile ? roastProfile.batchLabel : null;
  saveToStorage();
  closeLogModal();
  refreshAll();
}

// ============================================================================
// JSON エクスポート・インポート ＆ ユーティリティ
// ============================================================================
function exportJsonData() {
  const dataStr = JSON.stringify(state.logs, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toLocaleDateString('sv-SE');
  a.href = url;
  a.download = `coffee-flavor-atlas-${dateStr}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importJsonData(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    alert('JSONファイルのサイズが大きすぎます（上限 5MB）。');
    els.importJsonInput.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!Array.isArray(parsed)) throw new Error('Invalid format');
      const cleanLogs = sanitizeLogsArray(parsed);
      if (cleanLogs.length === 0) throw new Error('No valid records');
      state.logs = cleanLogs;
      state.isSampleMode = false;
      state.selectedBeanName = cleanLogs[0]?.beanName || null;
      state.selectedProfileKey = null;
      saveToStorage();
      refreshAll();
      alert(`${cleanLogs.length}件の記録データを安全に検証・読み込みました。`);
    } catch (err) {
      alert('JSONファイルの形式が正しくありません。');
    }
    els.importJsonInput.value = '';
  };
  reader.readAsText(file);
}

function formatSecToMmSs(sec) {
  if (!sec || Number.isNaN(Number(sec))) return '—';
  const total = Math.max(0, Math.round(Number(sec)));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function parseMmSsToSec(str) {
  if (!str) return 0;
  const parts = String(str).trim().split(':');
  if (parts.length === 2) {
    return Number(parts[0]) * 60 + Number(parts[1]);
  }
  return Number(str) || 0;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hexToRgba(hex, alpha) {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
