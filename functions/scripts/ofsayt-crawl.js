// Ofsayt.com arsivinden kalibrasyon verisi toplar:
// her mac icin Iddaa "Mac Sonucu" (1X2) ve "Mac Skoru" oranlari.
// Kullanim: node ofsayt-crawl.js <cikti.json> [gun listesi DD.MM.YYYY ...]
const fs = require("fs");

const BASE = "https://ofsayt.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const CONCURRENCY = 10;

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ");
}

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "*/*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

// Sadece iddaa'si olan maclari alir (has-iddaa sinifli match-item bloklari).
function extractMatchIds(listHtml) {
  const ids = new Map();
  const blocks = listHtml.split(/class="match-item/);
  for (let i = 1; i < blocks.length; i++) {
    const header = blocks[i].slice(0, 200);
    if (!header.includes("has-iddaa")) continue;
    const m = /href="\/futbol\/mac\/([a-z0-9-]+)\/([0-9a-f-]{36})\/detay"/.exec(blocks[i]);
    if (m) ids.set(m[2], m[1]);
  }
  return ids;
}

// Iddaa bolumundeki marketleri ayristirir: her market bir
// "ofs-match-detail-odd-id" basligi + ardindan gelen odd-square ciftleri.
function parseMarkets(html) {
  const text = decodeEntities(html);
  const markets = [];
  const headerRe = /ofs-match-detail-odd-id[^>]*>([^<]+)</g;
  const positions = [];
  let m;
  while ((m = headerRe.exec(text))) positions.push({ name: m[1].trim(), start: m.index });

  for (let i = 0; i < positions.length; i++) {
    const chunk = text.slice(positions[i].start, positions[i + 1] ? positions[i + 1].start : positions[i].start + 60000);
    const options = [];
    const optRe = /ofs-match-detail-odd-value fw-normal[^>]*>([^<]+)<[\s\S]{0,600}?ofs-match-detail-odd-value fw-bold[^>]*>([^<]+)</g;
    let o;
    while ((o = optRe.exec(chunk))) {
      const label = o[1].trim();
      const value = parseFloat(o[2].trim().replace(",", "."));
      options.push({ label, value: isFinite(value) ? value : null });
    }
    markets.push({ name: positions[i].name, options });
  }
  return markets;
}

function pickMs(markets) {
  const market = markets.find(mk =>
    mk.name === "Maç Sonucu" && mk.options.length >= 3 &&
    mk.options.some(o => o.label === "1" || o.label === "MS 1"));
  if (!market) return null;
  const get = lbls => { const o = market.options.find(x => lbls.includes(x.label)); return o && o.value > 1 ? o.value : null; };
  const ms = { "1": get(["1", "MS 1"]), "X": get(["0", "X", "MS 0"]), "2": get(["2", "MS 2"]) };
  return ms["1"] && ms.X && ms["2"] ? ms : null;
}

function pickScore(markets) {
  const market = markets.find(mk => mk.name === "Maç Skoru" && mk.options.length >= 10);
  if (!market) return null;
  const score = {};
  for (const o of market.options) {
    if (!(o.value > 1)) continue;
    let mm = /^Ev (\d+)-(\d+)$/.exec(o.label);
    if (mm) { score[`${mm[1]}-${mm[2]}`] = o.value; continue; }
    mm = /^Dep (\d+)-(\d+)$/.exec(o.label);
    if (mm) { score[`${mm[2]}-${mm[1]}`] = o.value; continue; }
    mm = /^(\d+)-(\d+)$/.exec(o.label);
    if (mm) { score[`${mm[1]}-${mm[2]}`] = o.value; continue; }
    if (/Diğer/i.test(o.label)) score.diger = o.value;
  }
  return Object.keys(score).length >= 10 ? score : null;
}

async function crawlMatch(id, slug) {
  const html = await get(`${BASE}/api/match/getMatchDetail/${id}/1`);
  const markets = parseMarkets(html);
  const ms = pickMs(markets);
  const score = pickScore(markets);
  if (!ms || !score) return null;
  return { id, slug, ms, score };
}

async function main() {
  const out = process.argv[2] || "ofsayt-dataset.json";
  const dates = process.argv.slice(3);
  if (!dates.length) throw new Error("Tarih listesi verin (DD.MM.YYYY)");

  const allIds = new Map();
  for (const date of dates) {
    try {
      const html = await get(`${BASE}/api/live/datesorted?type=futbol&date=${date}`);
      const ids = extractMatchIds(html);
      ids.forEach((slug, id) => allIds.set(id, slug));
      console.log(`${date}: ${ids.size} mac (toplam benzersiz ${allIds.size})`);
    } catch (e) {
      console.log(`${date}: HATA ${e.message}`);
    }
  }

  // Var olan ciktiyi yukle (devam edebilme icin) ve o maclari atla.
  let rows = [];
  const seen = new Set();
  if (fs.existsSync(out)) {
    rows = JSON.parse(fs.readFileSync(out, "utf8"));
    rows.forEach(r => seen.add(r.id));
    console.log(`Devam: ${rows.length} mevcut veri yuklendi`);
  }

  const entries = [...allIds.entries()].filter(([id]) => !seen.has(id));
  let done = 0;
  async function worker() {
    while (entries.length) {
      const [id, slug] = entries.shift();
      try {
        const row = await crawlMatch(id, slug);
        if (row) rows.push(row);
      } catch (e) { /* iddaa yok / hata: atla */ }
      done++;
      if (done % 25 === 0) {
        console.log(`${done} mac tarandi, ${rows.length} veri`);
        fs.writeFileSync(out, JSON.stringify(rows, null, 1));
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  fs.writeFileSync(out, JSON.stringify(rows, null, 1));
  console.log(`Bitti: ${rows.length} mac -> ${out}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
