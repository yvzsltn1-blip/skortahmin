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

  // logo img'ini izleyen ilk <span>Takim Adi</span> ile eslestir.
  const re = /<img src="(https:\/\/[^"]+)" class="ofs-standing-table-team-logo" \/>[\s\S]*?<span>([^<]+)<\/span>/g;
  const teams = new Map();
  let m;
  while ((m = re.exec(html))) {
    const name = decodeEntities(m[2].trim());
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
