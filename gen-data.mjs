// gen-data.mjs —— 在 GitHub Actions 里跑：抓榜单 + 生成功能摘要和中文，写出 data.json
// 会复用上一次 data.json 里已有的功能和译文，避免重复翻译、重复请求
import fs from 'node:fs';

const OUT = './data.json';
const UA = { 'user-agent': 'ghbbb-actions/1.0', accept: 'application/vnd.github+json' };
const TOP = Number(process.env.TOP || 20);
const MAX_MIN = Number(process.env.MAX_MIN || 9);

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const daysAgo = (n) => ymd(new Date(Date.now() - n * 86400000));

const BAD = ['crack', 'cracked', 'keygen', 'activat', 'pre-activat', 'nulled', 'torrent',
  'pirat', 'serial key', 'license key', 'full version', 'repack', 'warez',
  'aimbot', 'wallhack', 'cheat engine', 'mod menu', 'for windows', 'for mac', 'installer',
  '破解', '激活', '下载'];
const isSpam = (r) => {
  const t = `${r.name} ${r.description || ''} ${(r.topics || []).join(' ')}`.toLowerCase();
  if (BAD.some((b) => t.includes(b))) return true;
  if (r.stargazers_count >= 50 && r.forks_count === 0) return true;
  return false;
};

const shape = (r) => ({
  full: r.full_name, desc: r.description || '', lang: r.language || '',
  stars: r.stargazers_count, forks: r.forks_count,
  created: (r.created_at || '').slice(0, 10), pushed: (r.pushed_at || '').slice(0, 10),
  url: r.html_url, topics: (r.topics || []).slice(0, 4),
  license: (r.license && (r.license.spdx_id || r.license.name)) || '',
  features: [], trDesc: '', trFeat: '',
});

const get = (url, t = 20000) => fetch(url, { headers: UA, signal: AbortSignal.timeout(t) });

async function buildList(q, pages) {
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const r = await get(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100&page=${p}`);
    if (!r.ok) throw new Error('search HTTP ' + r.status);
    const items = (await r.json()).items || [];
    all.push(...items);
    if (items.length < 100) break;
  }
  const seen = new Set();
  const out = [];
  for (const r of all) {
    if (seen.has(r.full_name) || isSpam(r)) continue;
    if (!r.description || r.description.length < 8) continue;
    seen.add(r.full_name);
    out.push(shape(r));
  }
  out.sort((a, b) => b.stars - a.stars);
  return out.slice(0, 50);
}

function splitDigest(md) {
  const lines = md.replace(/\r/g, '').split('\n');
  const heads = [''], blocks = [[]];
  let code = false, front = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (l.startsWith('```')) { code = !code; continue; }
    if (code) continue;
    if (front) { if (l === '---') front = false; continue; }
    if (l === '---' && blocks.length === 1 && blocks[0].length === 0) { front = true; continue; }
    if (l.startsWith('#')) { heads.push(l.replace(/^#+/, '').trim()); blocks.push([]); continue; }
    blocks[blocks.length - 1].push(l);
  }
  const score = (h) => {
    const s = h.toLowerCase(); let v = 0;
    if (/(feature|功能|特性|亮点|highlight|capabilit|about|overview|what)/.test(s)) v += 20;
    if (/(install|build|setup|requirement|prerequisit|getting started|quick ?start|usage|compile|deploy|faq|license|contribut|changelog|credit|acknowledg|system|hardware|compatib|dependenc|安装|构建|编译|部署|许可|贡献)/.test(s)) v -= 40;
    return v;
  };
  const isBullet = (l) => /^([-*+•]\s|\d+[.)]\s)/.test(l);
  const strip = (l) => l.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`_>|#]/g, '').replace(/\s+/g, ' ').trim();
  let best = -1, bestScore = -999;
  heads.forEach((h, i) => {
    const sc = score(h) + Math.min(blocks[i].filter(isBullet).length, 8) - Math.floor(i / 3) + (i === 0 ? 3 : 0);
    if (sc > bestScore) { bestScore = sc; best = i; }
  });
  const bullets = (arr, max) => arr.filter(isBullet).map(strip)
    .filter((s) => s.length >= 6 && s.length <= 220 && !/https?:\/\/|npm i |pip install|cargo install|sudo /.test(s)).slice(0, max);
  let f = [];
  if (best >= 0 && bestScore > 0) f = bullets(blocks[best], 12);
  if (!f.length) f = bullets(blocks[0], 12);
  if (!f.length) {
    const para = blocks[0].map(strip).filter((s) => s.length > 12).join(' ');
    if (para) f = [para.slice(0, 500)];
  }
  return f;
}

const isChinese = (s) => {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const lat = (s.match(/[a-zA-Z]/g) || []).length;
  return cjk > 0 && cjk * 4 >= lat;
};

const trCache = {};
let trStop = false;
let trFails = 0;

async function translate(text) {
  if (!text || isChinese(text) || trStop) return '';
  if (trCache[text] !== undefined) return trCache[text];
  const chunks = [];
  let rest = text.trim();
  while (rest.length > 420) {
    let cut = -1;
    for (let i = 420; i > 210; i--) if (/[.!?;\n。]/.test(rest[i])) { cut = i; break; }
    if (cut < 0) cut = 420;
    chunks.push(rest.slice(0, cut + 1)); rest = rest.slice(cut + 1).trim();
  }
  if (rest) chunks.push(rest);
  const parts = [];
  for (const c of chunks) {
    try {
      const r = await get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(c)}&langpair=en|zh-CN`, 15000);
      if (!r.ok) { if (++trFails >= 3) trStop = true; return ''; }
      const j = await r.json();
      const t = (j.responseData && j.responseData.translatedText) || '';
      if (!t || /MYMEMORY WARNING|QUERY LENGTH LIMIT|TOO MANY/i.test(t)) { if (++trFails >= 3) trStop = true; return ''; }
      parts.push(t.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
      trFails = 0;
    } catch { if (++trFails >= 3) trStop = true; return ''; }
  }
  const out = parts.join(' ').trim();
  trCache[text] = out;
  return out;
}

(async () => {
  const t0 = Date.now();
  // 复用上次结果
  let prev = { byFull: {}, stars: {}, date: '' };
  try {
    const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    for (const it of [...(old.today || []), ...(old.week || [])]) {
      prev.byFull[it.full] = it;
      prev.stars[it.full] = it.stars;
    }
    prev.date = (old.updated || '').slice(0, 10);
    prev.todayList = old.today || [];
  } catch (e) { console.log('没有可复用的旧 data.json'); }

  console.log('拉取榜单…');
  const week = await buildList(`created:>${daysAgo(7)} stars:>=50 forks:>=3`, 2);
  let today = [];
  try {
    today = await buildList(`created:>=${todayStr()} stars:>=2 forks:>=1`, 2);
  } catch (e) {
    console.log('today 抓取失败，沿用上一次的今日榜：', e.message);
    today = (prev.todayList || []).map((x) => { const o = prev.byFull[x.full] || {}; return Object.assign({}, o, { full: x.full, desc: x.desc || o.desc || '', stars: o.stars || x.stars }); });
  }
  console.log(`今日 ${today.length} / 近7天 ${week.length}`);

  const mark = (l) => l.forEach((r) => {
    const old = prev.byFull[r.full];
    r.delta = old && typeof old.stars === 'number' ? r.stars - old.stars : null;
  });
  mark(today); mark(week);

  const targets = [];
  const seen = new Set();
  for (const it of [...today.slice(0, TOP), ...week.slice(0, TOP)]) {
    if (seen.has(it.full)) continue;
    seen.add(it.full);
    targets.push(it);
  }

  console.log(`生成详情/中文（${targets.length} 个）…`);
  const deadline = t0 + MAX_MIN * 60000;
  let i = 0;
  for (const item of targets) {
    i++;
    const old = prev.byFull[item.full];
    // 复用：描述没变就直接用旧的功能与译文
    if (old && old.desc === item.desc && old.features && old.features.length) {
      item.features = old.features; item.trDesc = old.trDesc || ''; item.trFeat = old.trFeat || '';
      console.log(`  ${i}/${targets.length} ${item.full} (复用)`);
      continue;
    }
    if (Date.now() > deadline) { console.log('  超时，先发布已有的'); break; }
    try {
      const r = await get(`https://api.github.com/repos/${item.full}/readme`);
      if (r.ok) {
        const j = await r.json();
        if (j.content) item.features = splitDigest(Buffer.from(j.content, 'base64').toString('utf8'));
      } else if (r.status === 403 || r.status === 429) {
        console.log('  接口限流，停止补全'); break;
      }
    } catch { }
    item.trDesc = await translate(item.desc);
    if (item.features.length) item.trFeat = await translate(item.features.join('\n'));
    console.log(`  ${i}/${targets.length} ${item.full}${item.trDesc ? ' ✓' : ''}`);
  }

  // 没轮到的条目：如果上次有详情就带上
  for (const it of [...today, ...week]) {
    const old = prev.byFull[it.full];
    if (old && old.desc === it.desc && (!it.features || !it.features.length) && old.features) {
      it.features = old.features; it.trDesc = old.trDesc || ''; it.trFeat = old.trFeat || '';
    }
  }

  const out = { updated: new Date().toISOString(), today, week };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`写入 ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
