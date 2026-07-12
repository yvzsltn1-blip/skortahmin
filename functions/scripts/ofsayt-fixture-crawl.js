// Ofsayt.com lig detay sayfasindaki gomulu fikstur verisini (const weeks = [...])
// cekip toplu yapistirma formatinda metin uretir:
//   1. Hafta
//   16 Ağustos 2026
//   18:00
//   Ev Sahibi
//   Deplasman
//   ...
// Takim logolarini da indirir (logoDir verilirse): assets/teams/<slug>.png
// Slug uretimi app.js teamLogoSlug() ile birebir ayni olmali.
// Kullanim: node ofsayt-fixture-crawl.js <lig-detay-url> [cikti.txt] [logoDir]
const fs = require("fs");
const path = require("path");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const MONTHS_TR = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
  "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "*/*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

// "const weeks = [" ifadesinden itibaren dengeli koseli parantez tarayarak
// JSON dizisini cikarir (string icindeki parantezleri atlar).
function extractWeeksJson(html) {
  const marker = "const weeks = ";
  const at = html.indexOf(marker);
  if (at < 0) throw new Error("Sayfada 'const weeks' verisi bulunamadi.");
  const start = html.indexOf("[", at);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error("weeks dizisi kapanmadan sayfa bitti.");
}

// dateUtc "2026-08-16T18:00:00+03:00" (Istanbul saati) — string'den dogrudan ayristir.
function parseLocalParts(dateUtc) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(dateUtc || "");
  if (!m) return null;
  return {
    dateLabel: `${Number(m[3])} ${MONTHS_TR[Number(m[2]) - 1]} ${m[1]}`,
    timeLabel: `${m[4]}:${m[5]}`
  };
}

function teamLogoSlug(teamName) {
  return String(teamName || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function downloadLogos(weeks, dir) {
  const teams = new Map();
  for (const week of weeks) {
    for (const day of (week.dates || [])) {
      for (const match of (day.fixtureOfDay || [])) {
        for (const team of [match.homeTeam, match.awayTeam]) {
          if (team && team.Name && team.logo) teams.set(team.Name, team.logo);
        }
      }
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  let ok = 0, skip = 0, fail = 0;
  for (const [name, logoUrl] of teams) {
    const slug = teamLogoSlug(name);
    if (!slug) continue;
    const file = path.join(dir, `${slug}.png`);
    if (fs.existsSync(file)) { skip++; continue; }
    try {
      const res = await fetch(logoUrl, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      ok++;
    } catch (e) {
      console.log(`logo alinamadi: ${name} (${e.message})`);
      fail++;
    }
  }
  console.log(`Logo: ${teams.size} takim -> ${ok} indirildi, ${skip} zaten vardi, ${fail} hata (${dir})`);
}

async function main() {
  const url = process.argv[2];
  const out = process.argv[3] || "fikstur.txt";
  const logoDir = process.argv[4];
  if (!url) throw new Error("Lig detay URL'si verin.");

  const html = await get(url);
  const weeks = extractWeeksJson(html);

  const lines = [];
  let matchCount = 0;
  for (const week of weeks) {
    if (!week || !Array.isArray(week.dates)) continue;
    lines.push(String(week.week || "").trim());
    let lastDate = null;
    for (const day of week.dates) {
      for (const match of (day.fixtureOfDay || [])) {
        const parts = parseLocalParts(match.dateUtc);
        const home = match.homeTeam && match.homeTeam.Name;
        const away = match.awayTeam && match.awayTeam.Name;
        if (!parts || !home || !away) continue;
        if (parts.dateLabel !== lastDate) {
          lines.push(parts.dateLabel);
          lastDate = parts.dateLabel;
        }
        lines.push(parts.timeLabel, home, away);
        matchCount++;
      }
    }
    lines.push("");
  }

  fs.writeFileSync(out, lines.join("\n"), "utf8");
  console.log(`${weeks.length} hafta, ${matchCount} mac -> ${out}`);

  if (logoDir) await downloadLogos(weeks, logoDir);
}

main().catch(e => { console.error(e.message || e); process.exitCode = 1; });
