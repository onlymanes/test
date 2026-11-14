/* onlymanes-api：onlymanes.ai V1 后端（测试阶段）
 * 经典 service-worker 格式；bindings 以全局变量注入：VISITS、MEMORY、GEMINI_API_KEY（secret）
 *
 * POST /api/visit  访问 beacon：记录访问并做 bot 启发式打分
 * POST /api/chat   聊天：GEMINI_API_KEY 未配置时返回占位
 * GET  /api/stats  按天汇总 views / uniques / 疑似真人
 */
const ALLOWED = ['https://onlymanes.ai', 'https://www.onlymanes.ai'];

function corsHeaders(req) {
  const o = req.headers.get('Origin') || '';
  const allow = ALLOWED.includes(o) ? o : ALLOWED[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
function json(obj, status, req) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(req)),
  });
}

async function hashIP(ip) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('onlymanes-v1|' + ip));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/* bot 启发式：返回 0~1，越高越像机器。只是启发式，不下断言。 */
function botScore(ua, b) {
  let s = 0;
  const u = (ua || '').toLowerCase();
  if (/bot|crawl|spider|slurp|mediapartners|baidu|yandex|sogou|exabot|facebot|ia_archiver|pingdom|headless/i.test(u)) s += 0.6;
  if (b.webdriver) s += 0.25;
  if (!b.lang) s += 0.1;
  if (b.vw === 0 || b.vh === 0) s += 0.15;
  if (s === 0 && /mozilla|chrome|safari|firefox|edg/i.test(u)) s = 0.05;
  return Math.min(1, Math.round(s * 100) / 100);
}

async function handleVisit(req) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const ua = req.headers.get('User-Agent') || '';
  let b = {};
  try { b = await req.json(); } catch (e) { /* 空 body 也记一条 */ }
  const now = new Date();
  const rec = {
    t: now.toISOString(),
    ip_h: await hashIP(ip),
    ua: ua.slice(0, 200),
    path: String(b.path || '').slice(0, 120),
    ref: String(b.ref || '').slice(0, 200),
    lang: String(b.lang || '').slice(0, 20),
    tz: String(b.tz || '').slice(0, 40),
    vw: b.vw | 0, vh: b.vh | 0,
    touch: !!b.touch,
    bot: botScore(ua, b),
  };
  const key = 'visits:' + now.toISOString().slice(0, 10);
  let arr = [];
  try { arr = JSON.parse((await VISITS.get(key)) || '[]'); } catch (e) {}
  arr.push(rec);
  await VISITS.put(key, JSON.stringify(arr));
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

async function handleStats(req) {
  const url = new URL(req.url);
  const days = Math.min(30, Math.max(1, parseInt(url.searchParams.get('days') || '14', 10)));
  const list = await VISITS.list({ prefix: 'visits:' });
  const keys = list.keys.map(k => k.name).sort().slice(-days);
  const out = [];
  for (const k of keys) {
    let arr = [];
    try { arr = JSON.parse((await VISITS.get(k)) || '[]'); } catch (e) {}
    const ips = new Set(arr.map(r => r.ip_h));
    const humans = new Set(arr.filter(r => (r.bot || 0) < 0.5).map(r => r.ip_h));
    out.push({
      date: k.replace('visits:', ''),
      views: arr.length,
      uniques: ips.size,
      likely_human_uniques: humans.size,
    });
  }
  return json({ days: out, note: 'bot 判定为启发式，仅供参考' }, 200, req);
}

/* ---- 真鉴权：每人一个口令，登录后发 session ----
 * 口令存在 Worker secret：AUTH_TOKEN_HELEN / AUTH_TOKEN_ALAN
 * POST /api/login {token} -> {ok, user, session}
 * POST /api/logout (Authorization: Bearer <session>)
 * /api/chat 必须带 Authorization: Bearer <session>，身份取自 session，不信任客户端传的 user
 */
async function handleLogin(req) {
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const token = String(body.token || '');
  let user = null;
  if (typeof AUTH_TOKEN_HELEN !== 'undefined' && token && token === AUTH_TOKEN_HELEN) user = 'helen';
  else if (typeof AUTH_TOKEN_ALAN !== 'undefined' && token && token === AUTH_TOKEN_ALAN) user = 'alan';
  if (!user) return json({ ok: false, error: '口令不对' }, 401, req);
  const sid = crypto.randomUUID();
  await MEMORY.put('session:' + sid, JSON.stringify({ user: user, created: Date.now() }),
    { expirationTtl: 30 * 24 * 3600 });
  return json({ ok: true, user: user, session: sid }, 200, req);
}

async function getSessionUser(req) {
  const auth = req.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer ([0-9a-f-]{36})$/i);
  if (!m) return null;
  let data = null;
  try { data = JSON.parse(await MEMORY.get('session:' + m[1])); } catch (e) {}
  return (data && (data.user === 'helen' || data.user === 'alan')) ? data.user : null;
}

async function handleLogout(req) {
  const auth = req.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer ([0-9a-f-]{36})$/i);
  if (m) await MEMORY.delete('session:' + m[1]);
  return json({ ok: true }, 200, req);
}

const SYSTEM_PROMPTS = {
  helen: '你是 onlymanes，Helen 的私人智能伙伴：哲学思辨伙伴。中文回答，判断先行、逻辑严格；只说你核实过的，区分事实、推断与不知道。硬规则：你没有实时行情，没有接任何价格接口。被问实时数据时必须明说查不到，不编数字、不编日期、不拿旧数据当当前数据。',
  alan: '你是 onlymanes，晓晖的交易助手：简洁、务实，给可执行的结论；不确定的地方明确标出。中文回答。硬规则：1) PT1/PT2 在这里指家里 pt-levels 的短期支撑位/短期压力位（成交量分布算的），不是分析师目标价，不要按分析师目标价回答。2) 你没有实时行情，没有接任何价格接口。被问当前价、当前 PT1/PT2、财报数字等实时数据时，必须明说“我没有实时数据，查不到”，不编数字、不编日期、不拿旧数据当当前数据。3) 不知道就说不知道。',
};

async function handleChat(req) {
  const user = await getSessionUser(req);
  if (!user) {
    return json({ error: 'unauthorized', reply: '请先登录。' }, 401, req);
  }
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const message = String(body.message || '').slice(0, 4000);
  const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
  if (typeof GEMINI_API_KEY === 'undefined' || !GEMINI_API_KEY) {
    return json({ reply: '后端已连通，模型尚未接入，请稍后再试。', configured: false, user: user }, 200, req);
  }
  if (!message.trim()) {
    return json({ reply: '请说点什么。', configured: true, user: user }, 200, req);
  }
  const contents = [];
  for (const h of history) {
    if (h && (h.role === 'user' || h.role === 'model') && typeof h.text === 'string') {
      contents.push({ role: h.role, parts: [{ text: h.text.slice(0, 4000) }] });
    }
  }
  contents.push({ role: 'user', parts: [{ text: message }] });
  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPTS[user] }] },
        contents: contents,
      }),
    }
  );
  if (!r.ok) {
    return json({ reply: '模型调用失败（' + r.status + '），请稍后再试。', configured: true, user: user }, 200, req);
  }
  const data = await r.json();
  const reply =
    (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text) || '（模型没有返回内容）';
  return json({ reply: reply, configured: true, user: user }, 200, req);
}

/* ---- 紫微星娱乐测试（2026-11-14 V1）----
 * POST /api/ziwei  公开接口（不登录），每人每天限 1 次（IP 哈希 + 日期，记 KV）。
 * 机制：两颗候选紫微星（两颗候选），服务端 50% 随机定其一；
 * 提交时刻（精确到秒，取用户本地时钟）+ 梅花易数起卦；命盘由前端 iztro 2.6.1 排好随请求带来。
 * 故事由 Gemini 2.0 Flash 写：只讲故事，不预测、不给人生建议；输出后做断言词复查。
 * POST /api/ziwei-gift  送花自愿确认记录（V1：只记“用户说已送花”，不核对到账）。
 */
const ZIWEI_MODEL = 'gemini-2.5-flash';
const ZIWEI_MODEL_FALLBACK = 'gemini-2.0-flash';
const ZIWEI_STARS = []; // 出生数据已移至 Worker 密钥 ZIWEI_STARS_JSON，不在仓库中
const ZIWEI_MODES = {
  future: '自己的未来与紫微星的缘分 + 自己的运势',
  child: '一位已出生、有名字的子女的紫微缘和运势',
  marriage: '自己与紫微星的姻缘',
  futureChild: '未来子女与紫微星的缘分',
};
const TRIGRAMS = { 1: ['乾', '☰'], 2: ['兑', '☱'], 3: ['离', '☲'], 4: ['震', '☳'], 5: ['巽', '☴'], 6: ['坎', '☵'], 7: ['艮', '☶'], 8: ['坤', '☷'] };
const TRIGRAM_BITS = { 1: [1, 1, 1], 2: [1, 1, 0], 3: [1, 0, 1], 4: [1, 0, 0], 5: [0, 1, 1], 6: [0, 1, 0], 7: [0, 0, 1], 8: [0, 0, 0] };
/* 六十四卦：行=上卦，列=下卦（文王卦序，已按 乾1/坤2/屯3/蒙4/需5/讼6/师7/比8 等核对） */
const HEXAGRAMS = [
  [[1, '乾'], [43, '夬'], [14, '大有'], [34, '大壮'], [9, '小畜'], [5, '需'], [26, '大畜'], [11, '泰']],
  [[10, '履'], [58, '兑'], [38, '睽'], [54, '归妹'], [61, '中孚'], [60, '节'], [41, '损'], [19, '临']],
  [[13, '同人'], [49, '革'], [30, '离'], [55, '丰'], [37, '家人'], [63, '既济'], [22, '贲'], [36, '明夷']],
  [[25, '无妄'], [17, '随'], [21, '噬嗑'], [51, '震'], [42, '益'], [3, '屯'], [27, '颐'], [24, '复']],
  [[44, '姤'], [28, '大过'], [50, '鼎'], [32, '恒'], [57, '巽'], [48, '井'], [18, '蛊'], [46, '升']],
  [[6, '讼'], [47, '困'], [64, '未济'], [40, '解'], [59, '涣'], [29, '坎'], [4, '蒙'], [7, '师']],
  [[33, '遁'], [31, '咸'], [56, '旅'], [62, '小过'], [53, '渐'], [39, '蹇'], [52, '艮'], [15, '谦']],
  [[12, '否'], [45, '萃'], [35, '晋'], [16, '豫'], [20, '观'], [8, '比'], [23, '剥'], [2, '坤']],
];
function trigramFromBits(b) { return 8 - (b[0] * 4 + b[1] * 2 + b[2]); }

function meihua(t) {
  const upRaw = t.y + t.mo + t.d;
  const lowRaw = t.y + t.mo + t.d + t.h + t.mi + t.s;
  const up = upRaw % 8 || 8, low = lowRaw % 8 || 8, line = lowRaw % 6 || 6;
  const upBits = TRIGRAM_BITS[up].slice(), lowBits = TRIGRAM_BITS[low].slice();
  if (line <= 3) lowBits[line - 1] = 1 - lowBits[line - 1];
  else upBits[line - 4] = 1 - upBits[line - 4];
  const up2 = trigramFromBits(upBits), low2 = trigramFromBits(lowBits);
  const h1 = HEXAGRAMS[up - 1][low - 1], h2 = HEXAGRAMS[up2 - 1][low2 - 1];
  return {
    submit: t,
    arithmetic: {
      upper: t.y + '+' + t.mo + '+' + t.d + '=' + upRaw + '，' + upRaw + ' mod 8 = ' + up + '（' + TRIGRAMS[up][0] + TRIGRAMS[up][1] + '）',
      lower: t.y + '+' + t.mo + '+' + t.d + '+' + t.h + '+' + t.mi + '+' + t.s + '=' + lowRaw + '，' + lowRaw + ' mod 8 = ' + low + '（' + TRIGRAMS[low][0] + TRIGRAMS[low][1] + '），' + lowRaw + ' mod 6 = ' + line + '（动爻）',
      note: '传统梅花易数只用年月日时；这里按本测试的设计，把分和秒也加进了下卦与动爻的数里。',
    },
    upper: { num: up, name: TRIGRAMS[up][0], symbol: TRIGRAMS[up][1] },
    lower: { num: low, name: TRIGRAMS[low][0], symbol: TRIGRAMS[low][1] },
    movingLine: line,
    hexagram: { num: h1[0], name: h1[1] },
    changedHexagram: { num: h2[0], name: h2[1] },
  };
}

function ziweiSafeJson(text) {
  if (!text) return null;
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(clean); } catch (e) { return null; }
}
const ZIWEI_FORBIDDEN = /注定|必然|命中|你应该|你必须|你的前世是|前世你是|来世你将/;
function ziweiHasForbidden(story) {
  if (!story) return true;
  const s = (story.title_zh || '') + JSON.stringify(story.story_zh || {}) + JSON.stringify(story.story_en || {});
  return ZIWEI_FORBIDDEN.test(s);
}

async function callZiweiModel(systemText, userText, model) {
  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemText }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 6000, temperature: 0.9 },
      }),
    }
  );
  if (!r.ok) throw new Error('gemini ' + model + ' http ' + r.status);
  const data = await r.json();
  return (data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text) || '';
}

const ZIWEI_SYSTEM = [
  '你是 onlymanes.ai 紫微星娱乐测试的故事讲述者。你只讲故事，不算命，不预测命运。',
  '铁律（违反即失败）：',
  '1. 只用故事语气：多用“在故事里”“假如”“像”“仿佛”“如果把这读成一个故事”。绝不说“你的前世是……”“你命中注定……”“你将来会……”。',
  '2. 不预测、不做命运断言、不给人生建议：绝不出现“注定”“必然”“命中”“你应该”“你必须”这类词。',
  '3. 用户自己写的那句话，要原样引用进故事（加引号），不可改写、不可删改。',
  '4. “运势”只写成故事里的顺境与逆境；“姻缘”只写成故事里的一场相遇；子女只写成故事里的一个孩子。不要把故事里的事说成现实里的事。',
  '5. 先写中文故事，再把它译成英文（英文是中文的翻译，保持故事语气）。',
  '6. 输出必须是 JSON：{"title_zh": "故事标题（中文）", "story_zh": {"who": "我是谁（300-600字）", "from": "我从哪来（300-600字）", "to": "我要去哪（300-600字）"}, "story_en": {"who": "...", "from": "...", "to": "..."}}。详细，但不注水、不重复。',
].join('\n');

async function handleZiwei(req) {
  const ua = req.headers.get('User-Agent') || '';
  if (/bot|crawl|spider|slurp|mediapartners|baidu|yandex|sogou|exabot|facebot|ia_archiver|pingdom|headless/i.test(ua)) {
    return json({ error: 'bot' }, 403, req);
  }
  let body = {};
  try { body = await req.json(); } catch (e) { return json({ error: 'bad_json' }, 400, req); }
  const mode = String(body.mode || '');
  if (!ZIWEI_MODES[mode]) return json({ error: 'bad_mode' }, 400, req);
  const t = body.submitTime || {};
  if (![t.y, t.mo, t.d, t.h, t.mi, t.s].every(function (n) { return Number.isInteger(n); })) {
    return json({ error: 'bad_time' }, 400, req);
  }
  if (typeof GEMINI_API_KEY === 'undefined' || !GEMINI_API_KEY) {
    return json({ error: 'model_not_configured' }, 503, req);
  }
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  const key = 'ziwei:day:' + day + ':' + await hashIP(ip);
  if (await MEMORY.get(key)) {
    return json({ error: 'daily_limit', message: '今天已经测过一次啦，明天再来。' }, 429, req);
  }
  await MEMORY.put(key, '1', { expirationTtl: 48 * 3600 });

  const mh = meihua(t);
  const pick = crypto.getRandomValues(new Uint8Array(1))[0] % 2;
  const star = ZIWEI_STARS[pick];
  const other = ZIWEI_STARS[1 - pick];
  const userChart = body.userChart || null;
  const starChart = (body.starCharts && body.starCharts[star.id]) || null;
  const sentence = String(body.sentence || '').slice(0, 100);
  const imagination = String(body.imagination || '').slice(0, 200);
  const birthplace = String(body.birthplace || '').slice(0, 100);
  const childName = String(body.childName || '').slice(0, 50);

  const modeNote = {
    future: '主题：讲一个关于“你与紫微星的未来缘分”的故事；其中的“运势”，只写成故事里的顺境与逆境。',
    child: '主题：讲一个关于“孩子（' + (childName || '未具名') + '）与紫微星”的故事；孩子的运势只写成故事里的顺境与逆境。',
    marriage: '主题：讲一个关于“你与紫微星的姻缘”的故事；写成故事里的一场相遇，不要写成现实里的婚恋判断。',
    futureChild: '主题：讲一个关于“未来的孩子与紫微星”的故事；孩子尚未出生，故事里可以想象，但要写明这只是想象。',
  }[mode];

  const userText = [
    '模式：' + ZIWEI_MODES[mode] + '。' + modeNote,
    '今晚掷到的紫微星：' + star.place + '的那颗（出生 ' + star.clock + ' ' + star.tzLabel + '；按真太阳时约 ' + star.trueSolar + '，' + star.hourBranch + '）。另一颗候选是' + other.place + '的那颗（出生 ' + other.clock + ' ' + other.tzLabel + '；按真太阳时约 ' + other.trueSolar + '，' + other.hourBranch + '）。',
    '你的命盘（iztro 排盘，仅作故事素材）：' + (userChart ? JSON.stringify(userChart) : '（排盘库未加载，未提供命盘）'),
    '紫微星的命盘（iztro 排盘，仅作故事素材）：' + (starChart ? JSON.stringify(starChart) : '（排盘库未加载，未提供命盘）'),
    '梅花易数起卦（提交时刻 ' + t.y + '-' + t.mo + '-' + t.d + ' ' + t.h + ':' + String(t.mi).padStart(2, '0') + ':' + String(t.s).padStart(2, '0') + '）：上卦' + mh.upper.name + mh.upper.symbol + '，下卦' + mh.lower.name + mh.lower.symbol + '，动爻第' + mh.movingLine + '爻；本卦第' + mh.hexagram.num + '卦' + mh.hexagram.name + '，变卦第' + mh.changedHexagram.num + '卦' + mh.changedHexagram.name + '。',
    '你此刻写的一句话（原样引用，不可改写）' + (sentence ? '：“' + sentence + '”' : '：这次没有写一句话。'),
    '你想象的前世出生地：' + (imagination || '（未填）'),
    '你的出生地：' + (birthplace || '（未填）'),
    '请按三章写：我是谁 / 我从哪来 / 我要去哪。',
  ].join('\n');

  let story = null, guardrail = 'ok', modelUsed = ZIWEI_MODEL, firstError = '';
  try {
    story = ziweiSafeJson(await callZiweiModel(ZIWEI_SYSTEM, userText, ZIWEI_MODEL));
    if (ziweiHasForbidden(story)) {
      story = ziweiSafeJson(await callZiweiModel(
        ZIWEI_SYSTEM + '\n再次提醒：绝对不许出现“注定、必然、命中、你应该、你必须、你的前世是”这类断言词，只讲故事。',
        userText, ZIWEI_MODEL
      ));
      guardrail = 'retried';
    }
    if (!story || !story.story_zh || !story.story_en || ziweiHasForbidden(story)) {
      throw new Error('story_guardrail_fail');
    }
  } catch (e) {
    /* 主模型失败时退到另一模型再试一次 */
    firstError = String((e && e.message) || e).slice(0, 120);
    try {
      story = ziweiSafeJson(await callZiweiModel(ZIWEI_SYSTEM, userText, ZIWEI_MODEL_FALLBACK));
      modelUsed = ZIWEI_MODEL_FALLBACK;
      guardrail = guardrail === 'ok' ? 'fallback-model' : guardrail + '+fallback-model';
      if (!story || !story.story_zh || !story.story_en || ziweiHasForbidden(story)) {
        throw new Error('story_guardrail_fail');
      }
    } catch (e2) {
      await MEMORY.delete(key);
      return json({ error: 'model_failed', message: '故事没写出来，请稍后再试一次（今天的次数还在）。', detail: firstError + ' | ' + String((e2 && e2.message) || e2).slice(0, 120) }, 502, req);
    }
  }

  return json({
    ok: true,
    star: star,
    otherStar: other,
    meihua: mh,
    story: story,
    audit: {
      chart: 'iztro 2.6.1 开源排盘库（与排 Helen 命盘所用的同一套；中州派取象）',
      chartUsed: !!userChart,
      starChartUsed: !!starChart,
      timeKnown: !!body.timeKnown,
      genderNote: body.genderNote || '',
      random: '两颗候选紫微星，服务端 50% 随机掷选',
      userWords: '你写的一句话已原样引用，未改写',
      privacy: '出生信息只用于生成这一次的故事，不保存',
    },
    meta: { model: modelUsed, guardrail: guardrail, firstError: firstError || undefined },
  }, 200, req);
}

async function handleZiweiGift(req) {
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const token = String(body.token || '').slice(0, 64);
  const method = String(body.method || 'manual').slice(0, 20);
  const day = new Date().toISOString().slice(0, 10);
  const key = 'ziwei:gifts:' + day;
  let arr = [];
  try { arr = JSON.parse((await MEMORY.get(key)) || '[]'); } catch (e) {}
  arr.push({ t: new Date().toISOString(), token: token, method: method });
  await MEMORY.put(key, JSON.stringify(arr), { expirationTtl: 7 * 24 * 3600 });
  return json({ ok: true, verified: false, note: 'V1 只记录自愿确认，未接支付回调核对到账。' }, 200, req);
}

addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') {
    event.respondWith(new Response(null, { headers: corsHeaders(req) }));
    return;
  }
  if (url.pathname === '/api/visit' && req.method === 'POST') {
    event.respondWith(handleVisit(req)); return;
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    event.respondWith(handleChat(req)); return;
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    event.respondWith(handleLogin(req)); return;
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    event.respondWith(handleLogout(req)); return;
  }
  if (url.pathname === '/api/ziwei' && req.method === 'POST') {
    event.respondWith(handleZiwei(req)); return;
  }
  if (url.pathname === '/api/ziwei-gift' && req.method === 'POST') {
    event.respondWith(handleZiweiGift(req)); return;
  }
  if (url.pathname === '/api/stats' && req.method === 'GET') {
    event.respondWith(handleStats(req)); return;
  }
  if (url.pathname === '/' || url.pathname === '') {
    event.respondWith(json({ ok: true, service: 'onlymanes-api', v: 'v1-test' }, 200, req)); return;
  }
  event.respondWith(json({ error: 'not found' }, 404, req));
});
