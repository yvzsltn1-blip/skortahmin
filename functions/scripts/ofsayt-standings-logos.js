// Ofsayt.com puan durumu sayfasindaki takim logolarini (circle-flags) indirir:
//   assets/teams/<slug>.png
// Slug uretimi app.js teamLogoSlug() ile birebir ayni olmali.
// Kullanim: node ofsayt-standings-logos.js <puan-durumu-url> <logoDir>
const fs = require("fs");
const path = require("path");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

function teamLogoSlug(teamName) {
  return String(teamName || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// &#xDC; gibi HTML sayisal varliklarini cozer.
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

async function main() {
  const url = process.argv[2];
  const dir = process.argv[3];
  if (!url || !dir) throw new Error("Kullanim: node ofsayt-standings-logos.js <url> <logoDir>");

  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "*/*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const html = await res.text();

  // Sayfada aynı logo sınıfı fikstür ve haber kartlarında da kullanılıyor.
  // Yalnızca puan durumu sekmelerinin tbody bloklarını tara.
  const standingsBlocks = Array.from(
    html.matchAll(/<tbody[^>]*class=["'][^"']*\bcurrent-stand-tbody\b[^"']*["'][^>]*>[\s\S]*?<\/tbody>/gi),
    match => match[0]
  );
  if (!standingsBlocks.length) throw new Error("Sayfada puan durumu tablosu bulunamadi.");
  const standingsHtml = standingsBlocks.join("\n");

  // Güncel tabloda takım adı logodan sonraki takım detay <a> etiketinde.
  // Sınıf/özellik sırası değişse de aynı tablo hücresi içinde eşleşmeye devam etsin.
  const re = /<img(?=[^>]*\bclass=["'][^"']*\bofs-standing-table-team-logo\b[^"']*["'])(?=[^>]*\bsrc=["'](https:\/\/[^"']+)["'])[^>]*>[\s\S]{0,1200}?<a\b[^>]*href=["'][^"']*\/futbol\/takim\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  const teams = new Map();
  let m;
  while ((m = re.exec(standingsHtml))) {
    const name = decodeEntities(m[2].replace(/<[^>]+>/g, "").trim());
    if (name && !teams.has(name)) teams.set(name, m[1]);
  }
  if (!teams.size) throw new Error("Sayfada takim logosu bulunamadi.");

  fs.mkdirSync(dir, { recursive: true });
  let ok = 0, skip = 0, fail = 0;
  for (const [name, logoUrl] of teams) {
    const slug = teamLogoSlug(name);
    if (!slug) continue;
    const file = path.join(dir, `${slug}.png`);
    if (fs.existsSync(file)) { skip++; continue; }
    try {
      const r = await fetch(logoUrl, { headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      console.log(`${name} -> ${slug}.png`);
      ok++;
    } catch (e) {
      console.log(`logo alinamadi: ${name} (${e.message})`);
      fail++;
    }
  }
  console.log(`Logo: ${teams.size} takim -> ${ok} indirildi, ${skip} zaten vardi, ${fail} hata (${dir})`);
}

main().catch(e => { console.error(e.message || e); process.exitCode = 1; });
