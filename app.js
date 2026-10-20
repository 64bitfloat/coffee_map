/**
 * Coffee Flavor Atlas - 珈琲味覚マッピング＆記録帳
 * 毎日同じ淹れ方で淹れる珈琲の主観スコアを記録し、
 * 銘柄ごとの複数回平均と「日々の評価ブレ」を多軸四象限マップ＆レーダーで可視化するアプリ
 */

const STORAGE_KEY = 'coffee_flavor_atlas_logs_v1';
const SAMPLE_FLAG_KEY = 'coffee_flavor_atlas_is_sample_v1';

// 軸の定義
const AXES_META = {
  acidity: {
    label: '酸味・フルーティ',
    short: 'フルーティ',
    lowPole: '穏やか・低酸味',
    highPole: '鮮やか・フルーティ',
    getValue: (s) => s.acidity,
  },
  bitterness: {
    label: '苦味・ビター',
    short: 'ビター',
    lowPole: '控えめ・マイルド',
    highPole: '力強い・ビター',
    getValue: (s) => s.bitterness,
  },
  sweetness: {
    label: '甘み',
    short: '甘み',
    lowPole: 'ドライ・すっきり',
    highPole: 'リッチな甘み',
    getValue: (s) => s.sweetness,
  },
  body: {
    label: 'コク・ボディ',
    short: 'コク',
    lowPole: '軽やか・ティーライク',
    highPole: '重厚・濃厚ボディ',
    getValue: (s) => s.body,
  },
  aroma: {
    label: '香り・華やかさ',
    short: '華やかさ',
    lowPole: '落ち着き・ナッツ感',
    highPole: '華やか・アロマティック',
    getValue: (s) => s.aroma,
  },
  aftertaste: {
    label: '余韻・後味',
    short: '余韻',
    lowPole: 'キレが良い・爽快',
    highPole: '長い余韻・持続',
    getValue: (s) => s.aftertaste,
  },
  balance_ab: {
    label: '酸味(1) ⇔ 苦味(10)',
    short: '酸⇔苦バランス',
    lowPole: '酸味・果実味寄り',
    highPole: '苦味・ロースト寄り',
    // 1〜10に正規化: (bitterness - acidity + 10) / 2 -> 0.5〜9.5 を 1〜10へ
    getValue: (s) => Math.max(1, Math.min(10, 5.5 + (s.bitterness - s.acidity) * 0.45)),
  },
};

// 四象限のコーナーラベル辞書（特定ペア用の特別名称＋汎用自動生成）
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

const DEFAULT_ORIGINS = [
  'エチオピア', 'ケニア', 'コロンビア', 'ブラジル',
  'グアテマラ', 'コスタリカ', 'インドネシア', 'パナマ',
  'ルワンダ', 'エルサルバドル', 'ペルー', 'タンザニア',
];

// 初期サンプルデータ（複数回記録の平均化・ブレの可視化がすぐ体験できるデータ）
const INITIAL_SAMPLE_LOGS = [
  // 1. エチオピア イルガチェフェ コンガ（ナチュラル・中浅煎り）: 4回記録
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
    memo: '開封初日。ストロベリージャムのような華やかな香りと明るい酸味。',
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
    memo: '少し落ち着いて桃やベリーの甘みが前に出てきた。',
  },
  {
    id: 'samp-103',
    beanName: 'エチオピア イルガチェフェ コンガ G1',
    origin: 'エチオピア',
    roast: '中浅煎り',
    process: 'ナチュラル',
    date: '2026-10-16',
    scores: { acidity: 8, bitterness: 4, sweetness: 8, body: 5, aroma: 9, aftertaste: 7 },
    rating: 5,
    tempNote: '変化なし・安定',
    memo: '紅茶のような質感。いつも通り安定して華やか。',
  },
  {
    id: 'samp-104',
    beanName: 'エチオピア イルガチェフェ コンガ G1',
    origin: 'エチオピア',
    roast: '中浅煎り',
    process: 'ナチュラル',
    date: '2026-10-19',
    scores: { acidity: 9, bitterness: 2, sweetness: 8, body: 5, aroma: 9, aftertaste: 8 },
    rating: 4,
    tempNote: '冷めると甘み・果実味UP',
    memo: '少し酸味を強く感じたが、冷めるとシロップのように甘い。',
  },

  // 2. ケニア マサイ AA（ウォッシュト・中深煎り）: フルーティ×ビター両立の例（4回記録）
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

  // 3. ブラジル ショコラ サントアントニオ（ナチュラル・中煎り）: マイルド・バランス系（3回記録）
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

  // 4. インドネシア マンデリン ビンタンリマ（スマトラ・深煎り）: 王道ビター重厚系（3回記録）
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

  // 5. グアテマラ アンティグア アゾテア（ウォッシュト・中煎り）: 3回記録（少し日によるブレがある例）
  {
    id: 'samp-501',
    beanName: 'グアテマラ アンティグア アゾテア',
    origin: 'グアテマラ',
    roast: '中煎り',
    process: 'ウォッシュト',
    date: '2026-10-09',
    scores: { acidity: 6, bitterness: 5, sweetness: 7, body: 6, aroma: 7, aftertaste: 5 },
    rating: 4,
    tempNote: '変化なし・安定',
    memo: '青リンゴのような爽やかさとチョコレートのバランス。',
  },
  {
    id: 'samp-502',
    beanName: 'グアテマラ アンティグア アゾテア',
    origin: 'グアテマラ',
    roast: '中煎り',
    process: 'ウォッシュト',
    date: '2026-10-13',
    scores: { acidity: 5, bitterness: 7, sweetness: 6, body: 7, aroma: 6, aftertaste: 6 },
    rating: 3,
    tempNote: '冷めると酸味が立つ',
    memo: '今日は少しビター寄りに感じた。体調による感覚差かも。',
  },
  {
    id: 'samp-503',
    beanName: 'グアテマラ アンティグア アゾテア',
    origin: 'グアテマラ',
    roast: '中煎り',
    process: 'ウォッシュト',
    date: '2026-10-17',
    scores: { acidity: 7, bitterness: 4, sweetness: 8, body: 6, aroma: 7, aftertaste: 5 },
    rating: 4,
    tempNote: '冷めると甘み・果実味UP',
    memo: '柑橘の明るい酸とキャラメルの甘みが綺麗にまとまった。',
  },

  // 6. コロンビア ピンクブルボン（ハニー・浅煎り）: 2回記録
  {
    id: 'samp-601',
    beanName: 'コロンビア ウィラ ピンクブルボン',
    origin: 'コロンビア',
    roast: '浅煎り',
    process: 'ハニー',
    date: '2026-10-15',
    scores: { acidity: 9, bitterness: 2, sweetness: 7, body: 3, aroma: 8, aftertaste: 4 },
    rating: 4,
    tempNote: '冷めると甘み・果実味UP',
    memo: 'ピンクグレープフルーツのような弾ける酸味と驚きのキレの良さ。',
  },
  {
    id: 'samp-602',
    beanName: 'コロンビア ウィラ ピンクブルボン',
    origin: 'コロンビア',
    roast: '浅煎り',
    process: 'ハニー',
    date: '2026-10-20',
    scores: { acidity: 8, bitterness: 2, sweetness: 8, body: 4, aroma: 9, aftertaste: 5 },
    rating: 5,
    tempNote: '冷めると甘み・果実味UP',
    memo: 'ハチミツレモンティーのよう。軽やかで朝にぴったり。',
  },
];

// アプリの状態
const state = {
  logs: [],
  isSampleMode: false,
  selectedBeanName: null,
  hoveredBeanName: null,
  xAxis: 'acidity',
  yAxis: 'bitterness',
  colorMode: 'roast',
  showVariance: true,
  showSweetSpot: true,
  filters: {
    search: '',
    origin: '',
    roast: '',
    process: '',
  },
  sortBy: 'recent',
  renderedBeanPositions: [], // キャンバス上のヒットテスト用
};

// DOM参照
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
  els.swapAxesBtn = document.getElementById('swapAxesBtn');
  els.colorModeSelect = document.getElementById('colorModeSelect');
  els.showVarianceToggle = document.getElementById('showVarianceToggle');
  els.showSweetSpotToggle = document.getElementById('showSweetSpotToggle');

  els.searchBeanInput = document.getElementById('searchBeanInput');
  els.filterOriginSelect = document.getElementById('filterOriginSelect');
  els.filterRoastSelect = document.getElementById('filterRoastSelect');
  els.filterProcessSelect = document.getElementById('filterProcessSelect');
  els.mapLegend = document.getElementById('mapLegend');

  els.mapWrapper = document.getElementById('mapWrapper');
  els.canvas = document.getElementById('flavorMapCanvas');
  els.mapTooltip = document.getElementById('mapTooltip');

  els.inspectorEmptyState = document.getElementById('inspectorEmptyState');
  els.inspectorContent = document.getElementById('inspectorContent');
  els.inspectorBadges = document.getElementById('inspectorBadges');
  els.inspectorBeanName = document.getElementById('inspectorBeanName');
  els.inspectorMeta = document.getElementById('inspectorMeta');
  els.logAgainBtn = document.getElementById('logAgainBtn');
  els.stabilityBadge = document.getElementById('stabilityBadge');
  els.radarCanvas = document.getElementById('radarCanvas');
  els.inspectorScoreGrid = document.getElementById('inspectorScoreGrid');
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

  els.starRatingGroup = document.getElementById('starRatingGroup');
  els.ratingTextLabel = document.getElementById('ratingTextLabel');
  els.ratingInput = document.getElementById('ratingInput');
  els.tempChangeSelect = document.getElementById('tempChangeSelect');
  els.memoInput = document.getElementById('memoInput');
}

function loadInitialData() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const isSample = localStorage.getItem(SAMPLE_FLAG_KEY);
  if (saved) {
    try {
      state.logs = JSON.parse(saved);
      state.isSampleMode = isSample === 'true';
    } catch (e) {
      state.logs = [...INITIAL_SAMPLE_LOGS];
      state.isSampleMode = true;
    }
  } else {
    state.logs = JSON.parse(JSON.stringify(INITIAL_SAMPLE_LOGS));
    state.isSampleMode = true;
    saveToStorage();
  }

  // 初回に最初の銘柄を選択状態にする
  const beans = getAggregatedBeans();
  if (beans.length > 0) {
    state.selectedBeanName = beans[0].beanName;
  }
}

function saveToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.logs));
  localStorage.setItem(SAMPLE_FLAG_KEY, String(state.isSampleMode));
}

// 銘柄ごとに記録を集約し、平均値とブレ（標準偏差・個別座標）を計算する
function getAggregatedBeans() {
  const map = new Map();

  for (const log of state.logs) {
    const key = log.beanName.trim();
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, {
        beanName: key,
        origin: log.origin || '不明',
        roast: log.roast || '中煎り',
        process: log.process || 'ウォッシュト',
        logs: [],
      });
    }
    const entry = map.get(key);
    entry.logs.push(log);
    // 最新の記録の属性を優先反映
    entry.origin = log.origin || entry.origin;
    entry.roast = log.roast || entry.roast;
    entry.process = log.process || entry.process;
  }

  const scoreKeys = ['acidity', 'bitterness', 'sweetness', 'body', 'aroma', 'aftertaste'];
  const result = [];

  for (const bean of map.values()) {
    // 日付降順でソート
    bean.logs.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const count = bean.logs.length;

    const avgScores = {};
    const sdScores = {};

    for (const k of scoreKeys) {
      const vals = bean.logs.map((l) => Number(l.scores?.[k] ?? 5));
      const mean = vals.reduce((a, b) => a + b, 0) / count;
      const variance = vals.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / count;
      avgScores[k] = Number(mean.toFixed(2));
      sdScores[k] = Number(Math.sqrt(variance).toFixed(2));
    }

    const avgRating =
      bean.logs.reduce((acc, l) => acc + Number(l.rating || 4), 0) / count;

    // 全体安定度（6軸の標準偏差の平均）
    const meanSd =
      Object.values(sdScores).reduce((a, b) => a + b, 0) / scoreKeys.length;

    result.push({
      ...bean,
      count,
      avgScores,
      sdScores,
      avgRating: Number(avgRating.toFixed(1)),
      meanSd: Number(meanSd.toFixed(2)),
      latestDate: bean.logs[0]?.date || '',
    });
  }

  return result;
}

function getFilteredBeans(beans) {
  return beans.filter((b) => {
    if (state.filters.origin && b.origin !== state.filters.origin) return false;
    if (state.filters.roast && b.roast !== state.filters.roast) return false;
    if (state.filters.process && b.process !== state.filters.process) return false;
    if (state.filters.search) {
      const q = state.filters.search.toLowerCase();
      const matchName = b.beanName.toLowerCase().includes(q);
      const matchOrigin = b.origin.toLowerCase().includes(q);
      const matchMemo = b.logs.some((l) => (l.memo || '').toLowerCase().includes(q));
      if (!matchName && !matchOrigin && !matchMemo) return false;
    }
    return true;
  });
}

function bindEvents() {
  // 軸プリセット切り替え
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
    state.hoveredBeanName = null;
    els.mapTooltip.hidden = true;
    drawFlavorMap();
  });
  els.canvas.addEventListener('click', handleCanvasClick);

  window.addEventListener('resize', () => {
    drawFlavorMap();
  });

  // サンプル・JSON操作
  els.clearSampleBtn.addEventListener('click', () => {
    if (confirm('サンプルデータを消去して、空の状態からあなたの記録を始めますか？')) {
      state.logs = [];
      state.isSampleMode = false;
      state.selectedBeanName = null;
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
      openLogModal({ prefillBeanName: state.selectedBeanName });
    }
  });
  els.closeModalBtn.addEventListener('click', closeLogModal);
  els.cancelModalBtn.addEventListener('click', closeLogModal);
  els.logModalBackdrop.addEventListener('click', (e) => {
    if (e.target === els.logModalBackdrop) closeLogModal();
  });

  // 既存銘柄セレクトで自動補完
  els.existingBeanSelect.addEventListener('change', () => {
    const val = els.existingBeanSelect.value;
    if (val) {
      applyBeanAutoFill(val);
    }
  });

  // 銘柄名の手入力でも既存と一致したら自動補完
  els.beanNameInput.addEventListener('change', () => {
    const val = els.beanNameInput.value.trim();
    const beans = getAggregatedBeans();
    const found = beans.find((b) => b.beanName === val);
    if (found && !els.editLogId.value) {
      applyBeanAutoFill(val);
    }
  });

  // スライダー値表示の連動
  for (const [key, inputEl] of Object.entries(els.sliders)) {
    inputEl.addEventListener('input', () => {
      els.sliderOutputs[key].textContent = inputEl.value;
    });
  }

  // 星評価ボタン
  els.starRatingGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.star-btn');
    if (!btn) return;
    setStarRating(Number(btn.dataset.rating));
  });

  // フォーム送信
  els.tastingLogForm.addEventListener('submit', handleFormSubmit);
}

function syncPresetActiveState() {
  const buttons = els.axisPresets.querySelectorAll('.preset-pill');
  buttons.forEach((btn) => {
    const isMatch = btn.dataset.x === state.xAxis && btn.dataset.y === state.yAxis;
    btn.classList.toggle('active', isMatch);
  });
}

function refreshAll() {
  els.sampleModeBadge.hidden = !state.isSampleMode;
  updateOriginFilterOptions();
  renderLegend();
  drawFlavorMap();
  renderBeanCatalog();
  renderInspector();
}

function updateOriginFilterOptions() {
  const beans = getAggregatedBeans();
  const origins = Array.from(new Set(beans.map((b) => b.origin))).sort();
  const current = state.filters.origin;
  els.filterOriginSelect.innerHTML =
    '<option value="">すべての産地</option>' +
    origins.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
  els.filterOriginSelect.value = origins.includes(current) ? current : '';
}

function getBeanColor(bean) {
  if (state.colorMode === 'roast') {
    return ROAST_COLORS[bean.roast] || '#6f4225';
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

// 四象限タイトル取得
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
// ============================================================================
function drawFlavorMap() {
  const canvas = els.canvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
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

  // スコア(1〜10) -> キャンバス座標への変換
  const toX = (val) => pad.left + ((val - 1) / 9) * plotW;
  const toY = (val) => pad.top + plotH - ((val - 1) / 9) * plotH;

  // 背景
  ctx.fillStyle = '#fdfbf7';
  ctx.fillRect(0, 0, width, height);

  // プロット領域のパーチメント背景
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

  // 1〜10の目盛りグリッド線
  ctx.lineWidth = 1;
  for (let s = 1; s <= 10; s++) {
    const x = toX(s);
    const y = toY(s);

    ctx.strokeStyle = s === 5 || s === 6 ? 'rgba(138, 115, 99, 0.16)' : 'rgba(138, 115, 99, 0.09)';
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();

    // 目盛り数字
    ctx.fillStyle = 'rgba(138, 115, 99, 0.65)';
    ctx.font = '500 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(s), x, pad.top + plotH + 15);

    ctx.textAlign = 'right';
    ctx.fillText(String(s), pad.left - 8, y + 3);
  }

  // 四象限のコーナーラベル描画
  const quads = getQuadrantDescriptions(state.xAxis, state.yAxis);
  drawQuadrantWatermark(ctx, pad.left + 14, pad.top + 22, quads.tl, 'left');
  drawQuadrantWatermark(ctx, pad.left + plotW - 14, pad.top + 22, quads.tr, 'right');
  drawQuadrantWatermark(ctx, pad.left + 14, pad.top + plotH - 28, quads.bl, 'left');
  drawQuadrantWatermark(ctx, pad.left + plotW - 14, pad.top + plotH - 28, quads.br, 'right');

  // 中央の十字線（5.5が1〜10の真ん中）
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

  // 外枠
  ctx.strokeStyle = '#c8b499';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(pad.left, pad.top, plotW, plotH);

  // 軸の両端ラベル
  const xMeta = AXES_META[state.xAxis];
  const yMeta = AXES_META[state.yAxis];

  // X軸ラベル
  ctx.font = '700 12px "Noto Sans JP", sans-serif';
  ctx.fillStyle = '#4a372b';
  ctx.textAlign = 'center';
  ctx.fillText(`横軸: ${xMeta.label}`, centerX, height - 12);

  ctx.font = '600 11px "Noto Sans JP", sans-serif';
  ctx.fillStyle = '#8a7363';
  ctx.textAlign = 'left';
  ctx.fillText(`◀ 1: ${xMeta.lowPole}`, pad.left, height - 12);
  ctx.textAlign = 'right';
  ctx.fillText(`${xMeta.highPole} :10 ▶`, pad.left + plotW, height - 12);

  // Y軸ラベル（上部と下部）
  ctx.textAlign = 'center';
  ctx.font = '700 12px "Noto Sans JP", sans-serif';
  ctx.fillStyle = '#4a372b';
  ctx.fillText(`▲ 10: ${yMeta.highPole} （縦軸: ${yMeta.label}）`, centerX, 20);

  ctx.font = '600 11px "Noto Sans JP", sans-serif';
  ctx.fillStyle = '#8a7363';
  ctx.fillText(`▼ 1: ${yMeta.lowPole}`, centerX, 37);

  // フィルター済み銘柄を取得
  const allBeans = getAggregatedBeans();
  const beans = getFilteredBeans(allBeans);

  // 1. 「好みゾーン（スイートスポット）」の背景グロー描画
  if (state.showSweetSpot) {
    for (const bean of beans) {
      if (bean.avgRating >= 4.4) {
        const bx = toX(xMeta.getValue(bean.avgScores));
        const by = toY(yMeta.getValue(bean.avgScores));
        const radius = bean.avgRating >= 4.8 ? 85 : 62;
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

  // 2. 「日々の評価ブレ（過去各回のプロット点と広がり楕円）」の透過描画
  if (state.showVariance) {
    for (const bean of beans) {
      if (bean.logs.length < 2) continue;
      const isFocused =
        bean.beanName === state.selectedBeanName || bean.beanName === state.hoveredBeanName;
      const baseColor = getBeanColor(bean);

      const avgX = toX(xMeta.getValue(bean.avgScores));
      const avgY = toY(yMeta.getValue(bean.avgScores));

      const pts = bean.logs.map((l) => ({
        x: toX(xMeta.getValue(l.scores)),
        y: toY(yMeta.getValue(l.scores)),
        date: l.date,
      }));

      // X方向・Y方向の広がり（最小14pxの半径を持たせた透過楕円）
      const maxDx = Math.max(12, ...pts.map((p) => Math.abs(p.x - avgX)) ) + 8;
      const maxDy = Math.max(12, ...pts.map((p) => Math.abs(p.y - avgY)) ) + 8;

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

      // 個別ログの点と平均点への細い接続線
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

  // 3. 各銘柄のメインプロット（平均位置）描画
  state.renderedBeanPositions = [];

  for (const bean of beans) {
    const rawX = xMeta.getValue(bean.avgScores);
    const rawY = yMeta.getValue(bean.avgScores);
    const cx = toX(rawX);
    const cy = toY(rawY);
    const color = getBeanColor(bean);
    const isSelected = bean.beanName === state.selectedBeanName;
    const isHovered = bean.beanName === state.hoveredBeanName;
    const radius = 9 + Math.min(5, bean.count * 1.1);

    state.renderedBeanPositions.push({
      beanName: bean.beanName,
      bean,
      x: cx,
      y: cy,
      rawX,
      rawY,
      radius: radius + 4,
    });

    // 選択リング
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

    // 本体ノード
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.shadowColor = 'rgba(35, 25, 20, 0.22)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fdfbf7';
    ctx.stroke();
    ctx.restore();

    // ノード内の記録回数表示（2回以上の場合）
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 9.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${bean.count}`, cx, cy + 0.5);

    // 銘柄名ラベル
    const label = bean.beanName.length > 15 ? bean.beanName.slice(0, 14) + '…' : bean.beanName;
    ctx.font = isSelected
      ? '700 11.5px "Noto Sans JP", sans-serif'
      : '600 11px "Noto Sans JP", sans-serif';
    const textW = ctx.measureText(label).width;
    const labelY = cy - radius - 10;

    // ラベル背景ピル
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
    if (state.hoveredBeanName !== hit.beanName) {
      state.hoveredBeanName = hit.beanName;
      drawFlavorMap();
    }
    const xMeta = AXES_META[state.xAxis];
    const yMeta = AXES_META[state.yAxis];
    els.mapTooltip.hidden = false;
    els.mapTooltip.style.left = `${hit.x}px`;
    els.mapTooltip.style.top = `${hit.y - 10}px`;
    els.mapTooltip.innerHTML = `
      <div class="tooltip-title">${escapeHtml(hit.bean.beanName)}</div>
      <div class="tooltip-sub">${escapeHtml(hit.bean.origin)} / ${escapeHtml(hit.bean.roast)} / ${escapeHtml(hit.bean.process)} (${hit.bean.count}回平均)</div>
      <div class="tooltip-coords">
        ${escapeHtml(xMeta.short)}: ${hit.rawX.toFixed(1)} ｜ ${escapeHtml(yMeta.short)}: ${hit.rawY.toFixed(1)} ｜ ★${hit.bean.avgRating}
      </div>
    `;
  } else {
    els.canvas.style.cursor = 'grab';
    if (state.hoveredBeanName !== null) {
      state.hoveredBeanName = null;
      drawFlavorMap();
    }
    els.mapTooltip.hidden = true;
  }
}

function handleCanvasClick() {
  if (state.hoveredBeanName) {
    state.selectedBeanName = state.hoveredBeanName;
    drawFlavorMap();
    renderBeanCatalog();
    renderInspector();
  }
}

// ============================================================================
// 右サイドバー：選択銘柄インスペクター＆6軸レーダーチャート
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

  const roastColor = ROAST_COLORS[bean.roast] || '#6f4225';
  els.inspectorBadges.innerHTML = `
    <span class="badge badge-origin">🌍 ${escapeHtml(bean.origin)}</span>
    <span class="badge badge-roast" style="background:${roastColor}">${escapeHtml(bean.roast)}</span>
    <span class="badge badge-process">${escapeHtml(bean.process)}</span>
  `;

  els.inspectorBeanName.textContent = bean.beanName;
  els.inspectorMeta.innerHTML = `
    <span>☕ 記録 <strong>${bean.count}</strong> 回（平均化済）</span>
    <span>★ 平均お気に入り <strong>${bean.avgRating}</strong></span>
  `;

  // 安定度バッジ
  if (bean.count === 1) {
    els.stabilityBadge.textContent = '記録1回（2回目以降でブレ表示）';
  } else if (bean.meanSd <= 0.55) {
    els.stabilityBadge.textContent = `評価の安定度：高（ブレ ±${bean.meanSd}）`;
  } else if (bean.meanSd <= 0.95) {
    els.stabilityBadge.textContent = `評価の安定度：中（ブレ ±${bean.meanSd}）`;
  } else {
    els.stabilityBadge.textContent = `日による変化：大（ブレ ±${bean.meanSd}）`;
  }

  // 6軸レーダーチャート描画
  drawRadarChart(bean);

  // スコアグリッド
  const scoreKeys = ['acidity', 'bitterness', 'sweetness', 'body', 'aroma', 'aftertaste'];
  els.inspectorScoreGrid.innerHTML = scoreKeys
    .map((k) => {
      const meta = AXES_META[k];
      const avg = bean.avgScores[k].toFixed(1);
      const sd = bean.count > 1 ? `±${bean.sdScores[k].toFixed(1)}` : '—';
      return `
        <div class="score-stat-box">
          <span class="score-stat-label">${escapeHtml(meta.short)}</span>
          <span class="score-stat-val">${avg} <span class="score-stat-sd">(${sd})</span></span>
        </div>
      `;
    })
    .join('');

  // 履歴リスト
  els.historyCountTitle.textContent = `過去の記録履歴 (${bean.count}件)`;
  els.inspectorHistoryList.innerHTML = bean.logs
    .map((log) => {
      const stars = '★'.repeat(log.rating || 4) + '☆'.repeat(5 - (log.rating || 4));
      return `
        <div class="history-item">
          <div class="history-item-top">
            <span class="history-date">${escapeHtml(log.date)}</span>
            <span class="history-stars">${stars}</span>
            <div class="history-actions">
              <button class="btn-mini" data-edit-id="${escapeHtml(log.id)}">編集</button>
              <button class="btn-mini delete" data-del-id="${escapeHtml(log.id)}">削除</button>
            </div>
          </div>
          ${log.tempNote ? `<div style="font-size:0.7rem;color:#6f4225;font-weight:600;">🌡️ ${escapeHtml(log.tempNote)}</div>` : ''}
          ${log.memo ? `<div class="history-memo">${escapeHtml(log.memo)}</div>` : ''}
          <div class="history-mini-scores">
            <span>酸:${log.scores.acidity}</span>
            <span>苦:${log.scores.bitterness}</span>
            <span>甘:${log.scores.sweetness}</span>
            <span>コク:${log.scores.body}</span>
            <span>香:${log.scores.aroma}</span>
            <span>余韻:${log.scores.aftertaste}</span>
          </div>
        </div>
      `;
    })
    .join('');

  // 編集・削除イベント
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

function drawRadarChart(bean) {
  const canvas = els.radarCanvas;
  const dpr = window.devicePixelRatio || 1;
  const w = 280;
  const h = 230;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);

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

  // 同心六角形グリッド (2, 4, 6, 8, 10)
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

  // 軸線とラベル
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

  // 各回の記録をうっすら透過で重ね描き（ブレの可視化）
  if (bean.logs.length > 1) {
    for (const log of bean.logs) {
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

  // 平均プロファイル（太線）
  ctx.beginPath();
  keys.forEach((k, i) => {
    const pt = getPt(i, bean.avgScores[k]);
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(111, 66, 37, 0.24)';
  ctx.fill();
  ctx.strokeStyle = '#6f4225';
  ctx.lineWidth = 2.2;
  ctx.stroke();

  // 頂点ドット
  keys.forEach((k, i) => {
    const pt = getPt(i, bean.avgScores[k]);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = '#6f4225';
    ctx.fill();
  });

  ctx.restore();
}

// 登録銘柄リストの描画
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
      return `
        <div class="bean-row ${isSelected ? 'selected' : ''}" data-bean-name="${escapeHtml(b.beanName)}">
          <div class="bean-row-main">
            <div class="bean-row-title">${escapeHtml(b.beanName)}</div>
            <div class="bean-row-sub">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}"></span>
              <span>${escapeHtml(b.origin)} / ${escapeHtml(b.roast)}</span>
              <span>★${b.avgRating}</span>
            </div>
          </div>
          <div class="bean-row-right">
            <span class="cup-count-tag">${b.count}回</span>
          </div>
        </div>
      `;
    })
    .join('');

  els.beanListContainer.querySelectorAll('.bean-row').forEach((row) => {
    row.addEventListener('click', () => {
      state.selectedBeanName = row.dataset.beanName;
      drawFlavorMap();
      renderBeanCatalog();
      renderInspector();
    });
  });
}

// ============================================================================
// モーダル（記録追加・2回目以降の自動補完）
// ============================================================================
function openLogModal(options = {}) {
  const { prefillBeanName, editLog } = options;
  const beans = getAggregatedBeans();

  // 過去銘柄のセレクトボックスとDatalist更新
  els.existingBeanSelect.innerHTML =
    '<option value="">＋ 新しい銘柄として入力する / 直接入力</option>' +
    beans
      .map(
        (b) =>
          `<option value="${escapeHtml(b.beanName)}">${escapeHtml(b.beanName)} （${escapeHtml(b.origin)}・${escapeHtml(b.roast)} / 過去${b.count}回）</option>`
      )
      .join('');

  els.beanNameDatalist.innerHTML = beans
    .map((b) => `<option value="${escapeHtml(b.beanName)}"></option>`)
    .join('');

  // 産地Datalist＆クイックチップ更新（過去入力した産地を優先表示）
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

  // 今日の日付（ローカルタイム）
  const todayStr = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD

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
    els.tempChangeSelect.value = editLog.tempNote || '変化なし・安定';
    els.memoInput.value = editLog.memo || '';
    els.sliderAutoFillNotice.textContent = '記録内容を編集しています';
  } else {
    els.modalEyebrow.textContent = 'DAILY CUP LOGGING';
    els.modalTitle.textContent = '今日の一杯を記録';
    els.editLogId.value = '';
    els.logDateInput.value = todayStr;
    els.memoInput.value = '';
    els.tempChangeSelect.value = '変化なし・安定';
    setStarRating(4);

    if (prefillBeanName) {
      els.existingBeanSelect.value = prefillBeanName;
      applyBeanAutoFill(prefillBeanName);
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
        '直感でスライダーを動かしてください（同じ銘柄は回数分の平均位置にマッピングされます）';
    }
  }

  els.logModalBackdrop.hidden = false;
}

function applyBeanAutoFill(beanName) {
  const beans = getAggregatedBeans();
  const found = beans.find((b) => b.beanName === beanName);
  if (!found) return;

  els.beanNameInput.value = found.beanName;
  els.originInput.value = found.origin;
  els.roastSelect.value = found.roast;
  els.processSelect.value = found.process;

  // 前回までの平均スコアを四捨五入して初期値にセット（微調整しやすくする）
  const rounded = {};
  for (const [k, v] of Object.entries(found.avgScores)) {
    rounded[k] = Math.round(v);
  }
  setSlidersValues(rounded);
  setStarRating(Math.round(found.avgRating));
  els.sliderAutoFillNotice.innerHTML = `<strong style="color:#6f4225">✓ 過去${found.count}回の記録から産地・焙煎度・平均スコアを自動セットしました。</strong> 今日の感覚に合わせて微調整してください。`;
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
    tempNote: els.tempChangeSelect.value,
    memo: els.memoInput.value.trim(),
  };

  if (els.editLogId.value) {
    const idx = state.logs.findIndex((l) => l.id === els.editLogId.value);
    if (idx !== -1) state.logs[idx] = newLog;
  } else {
    state.logs.push(newLog);
  }

  state.selectedBeanName = beanName;
  saveToStorage();
  closeLogModal();
  refreshAll();
}

// ============================================================================
// JSON エクスポート・インポート
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
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!Array.isArray(parsed)) throw new Error('Invalid format');
      state.logs = parsed;
      state.isSampleMode = false;
      state.selectedBeanName = parsed[0]?.beanName || null;
      saveToStorage();
      refreshAll();
      alert(`${parsed.length}件の記録データを読み込みました。`);
    } catch (err) {
      alert('JSONファイルの形式が正しくありません。');
    }
    els.importJsonInput.value = '';
  };
  reader.readAsText(file);
}

// ユーティリティ
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hexToRgba(hex, alpha) {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
