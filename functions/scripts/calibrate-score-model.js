// Ofsayt veri setiyle skor modeli kalibrasyonu.
// Kullanim: node calibrate-score-model.js <dataset.json>
// Model: 1X2 -> Dixon-Coles Poisson (rho) -> oran = C * (1/p)^B.
// (rho, B, C) parametrelerini gercek "Mac Skoru" oranlarina gore optimize eder.
const fs = require("fs");

const MAXG = 12;

function poissonPmf(k, lambda) {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

function dcTau(h, a, lh, la, rho) {
  if (h === 0 && a === 0) return 1 - lh * la * rho;
  if (h === 0 && a === 1) return 1 + lh * rho;
  if (h === 1 && a === 0) return 1 + la * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

function scoreMatrix(lh, la, rho) {
  const m = [];
  let total = 0;
  for (let h = 0; h <= MAXG; h++) {
    m[h] = [];
    for (let a = 0; a <= MAXG; a++) {
      const p = Math.max(0, poissonPmf(h, lh) * poissonPmf(a, la) * dcTau(h, a, lh, la, rho));
      m[h][a] = p;
      total += p;
    }
  }
  for (let h = 0; h <= MAXG; h++) for (let a = 0; a <= MAXG; a++) m[h][a] /= total;
  return m;
}

function outcomeProbs(m) {
  let ph = 0, pd = 0;
  for (let h = 0; h <= MAXG; h++) {
    for (let a = 0; a <= MAXG; a++) {
      if (h > a) ph += m[h][a];
      else if (h === a) pd += m[h][a];
    }
  }
  return { ph, pd };
}

function fitLambdas(pH, pD, rho, mu0) {
  let mu = mu0;
  let d = Math.log((pH + 0.25) / (1 - pH - pD + 0.25));
  for (let iter = 0; iter < 120; iter++) {
    const expD = Math.exp(d);
    const lh = mu * expD / (expD + 1);
    const la = mu - lh;
    const { ph, pd } = outcomeProbs(scoreMatrix(lh, la, rho));
    const errH = pH - ph;
    const errD = pD - pd;
    if (Math.abs(errH) < 1e-6 && Math.abs(errD) < 1e-6) break;
    mu = Math.max(0.4, Math.min(7, mu - errD * 6));
    d += errH * 3.5;
  }
  const expD = Math.exp(d);
  const lh = mu * expD / (expD + 1);
  return { lh, la: mu - lh };
}

function normalizeMs(ms) {
  const ih = 1 / ms["1"], id = 1 / ms.X, ia = 1 / ms["2"];
  const sum = ih + id + ia;
  return { pH: ih / sum, pD: id / sum };
}

// --- Dataset degerlendirme ---
function evaluate(rows, params, capListed, keyCorr) {
  const { rho, B, C, mu0 } = params;
  const errors = [];
  const digerRows = [];
  for (const row of rows) {
    const { pH, pD } = normalizeMs(row.ms);
    const { lh, la } = fitLambdas(pH, pD, rho, mu0);
    const m = scoreMatrix(lh, la, rho);
    let listedP = 0;
    for (const [key, real] of Object.entries(row.score)) {
      if (key === "diger") continue;
      const [h, a] = key.split("-").map(Number);
      if (h <= MAXG && a <= MAXG) listedP += m[h][a];
      if (!(real > 1)) continue;
      if (h > MAXG || a > MAXG) continue;
      const p = m[h][a];
      let pred = p > 0 ? C * Math.pow(1 / p, B) : 999;
      if (keyCorr && keyCorr[key]) pred *= keyCorr[key];
      pred = Math.max(1.01, pred);
      if (capListed) pred = Math.min(130, pred);
      const realCapped = Math.min(130, real);
      // 130 tavaninda ikisi de tavandaysa hatasiz say
      const err = Math.abs(Math.log(pred / realCapped));
      errors.push({ key, real: realCapped, pred, err, ape: Math.abs(pred - realCapped) / realCapped });
    }
    if (row.score.diger > 1) {
      const pOther = Math.max(1 - listedP, 1e-4);
      digerRows.push({ real: row.score.diger, pred: C * Math.pow(1 / pOther, B) });
    }
  }
  const n = errors.length;
  const mse = errors.reduce((s, e) => s + e.err * e.err, 0) / n;
  const mape = errors.reduce((s, e) => s + e.ape, 0) / n;
  const sorted = errors.map(e => e.ape).sort((x, y) => x - y);
  return {
    n, mse, mape,
    medape: sorted[Math.floor(n / 2)],
    p90: sorted[Math.floor(n * 0.9)],
    over20: sorted.filter(x => x > 0.2).length / n,
    errors, digerRows
  };
}

// Train verisinden skor bazli carpimsal duzeltme tablosu cikarir.
function fitKeyCorrections(rows, params) {
  const r = evaluate(rows, params, false, null);
  const byKey = new Map();
  for (const e of r.errors) {
    if (e.real >= 130 || e.pred >= 130) continue; // tavana yapisik satirlar sapmayi bozar
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key).push(Math.log(e.real / e.pred));
  }
  const corr = {};
  for (const [key, v] of byKey.entries()) {
    if (v.length < 20) continue;
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    corr[key] = Math.max(0.85, Math.min(1.18, Math.exp(mean)));
  }
  return corr;
}

// --- Nelder-Mead (3 boyut: rho, logB, logC) ---
function nelderMead(f, x0, steps, iters) {
  const dim = x0.length;
  let simplex = [x0.slice()];
  for (let i = 0; i < dim; i++) {
    const p = x0.slice();
    p[i] += steps[i];
    simplex.push(p);
  }
  let vals = simplex.map(f);
  for (let it = 0; it < iters; it++) {
    const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    simplex = order.map(i => simplex[i]);
    vals = order.map(i => vals[i]);
    const best = simplex[0], worst = simplex[dim];
    const centroid = Array(dim).fill(0);
    for (let i = 0; i < dim; i++) for (let j = 0; j < dim; j++) centroid[j] += simplex[i][j] / dim;
    const refl = centroid.map((c, j) => 2 * c - worst[j]);
    const fr = f(refl);
    if (fr < vals[0]) {
      const exp = centroid.map((c, j) => 3 * c - 2 * worst[j]);
      const fe = f(exp);
      if (fe < fr) { simplex[dim] = exp; vals[dim] = fe; }
      else { simplex[dim] = refl; vals[dim] = fr; }
    } else if (fr < vals[dim - 1]) {
      simplex[dim] = refl; vals[dim] = fr;
    } else {
      const contr = centroid.map((c, j) => 0.5 * (c + worst[j]));
      const fc = f(contr);
      if (fc < vals[dim]) { simplex[dim] = contr; vals[dim] = fc; }
      else {
        for (let i = 1; i <= dim; i++) {
          simplex[i] = simplex[i].map((v, j) => 0.5 * (v + best[j]));
          vals[i] = f(simplex[i]);
        }
      }
    }
  }
  const bi = vals.indexOf(Math.min(...vals));
  return { x: simplex[bi], val: vals[bi] };
}

function main() {
  const file = process.argv[2] || "ofsayt-dataset.json";
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`Dataset: ${rows.length} mac`);

  // %80 train / %20 test ayir (deterministik)
  const train = rows.filter((_, i) => i % 5 !== 0);
  const test = rows.filter((_, i) => i % 5 === 0);

  const current = { rho: -0.08, B: 0.9537, C: 0.8303, mu0: 2.6 };
  const base = evaluate(test, current, true);
  console.log(`Mevcut model (test): MAPE ${(base.mape * 100).toFixed(2)}% | medyan ${(base.medape * 100).toFixed(2)}% | p90 ${(base.p90 * 100).toFixed(2)}% | >%20 hata orani ${(base.over20 * 100).toFixed(1)}% | n=${base.n}`);

  const cache = new Map();
  const objective = x => {
    const key = x.map(v => v.toFixed(5)).join(",");
    if (cache.has(key)) return cache.get(key);
    const params = { rho: Math.max(-0.35, Math.min(0.35, x[0])), B: Math.exp(x[1]), C: Math.exp(x[2]), mu0: 2.6 };
    const r = evaluate(train, params, true);
    cache.set(key, r.mse);
    return r.mse;
  };

  const start = [current.rho, Math.log(current.B), Math.log(current.C)];
  const res = nelderMead(objective, start, [0.05, 0.05, 0.05], 120);
  const fitted = { rho: Math.max(-0.35, Math.min(0.35, res.x[0])), B: Math.exp(res.x[1]), C: Math.exp(res.x[2]), mu0: 2.6 };
  console.log(`\nOptimize edilen: rho=${fitted.rho.toFixed(4)} B=${fitted.B.toFixed(4)} C=${fitted.C.toFixed(4)}`);

  const after = evaluate(test, fitted, true);
  console.log(`Yeni model (test): MAPE ${(after.mape * 100).toFixed(2)}% | medyan ${(after.medape * 100).toFixed(2)}% | p90 ${(after.p90 * 100).toFixed(2)}% | >%20 hata orani ${(after.over20 * 100).toFixed(1)}%`);

  // Asama 2: skor bazli duzeltme tablosu
  const corr = fitKeyCorrections(train, fitted);
  const withCorr = evaluate(test, fitted, true, corr);
  console.log(`Duzeltmeli (test): MAPE ${(withCorr.mape * 100).toFixed(2)}% | medyan ${(withCorr.medape * 100).toFixed(2)}% | p90 ${(withCorr.p90 * 100).toFixed(2)}% | >%20 hata orani ${(withCorr.over20 * 100).toFixed(1)}%`);

  // Diger orani kalibrasyonu: train'den carpimsal duzeltme, test'te olc
  const dgTrain = evaluate(train, fitted, false, null).digerRows
    .filter(d => d.real < 130 && d.pred < 130);
  const dgLogs = dgTrain.map(d => Math.log(d.real / d.pred)).sort((a, b) => a - b);
  const digerCorr = dgLogs.length ? Math.exp(dgLogs[Math.floor(dgLogs.length / 2)]) : 1;
  const dg = withCorr.digerRows;
  if (dg.length) {
    const reals = dg.map(d => d.real).sort((a, b) => a - b);
    const oldApes = dg.map(d => Math.abs(Math.min(90, Math.max(26, d.pred)) - d.real) / d.real).sort((a, b) => a - b);
    const newApes = dg.map(d => Math.abs(Math.min(130, Math.max(1.01, d.pred * digerCorr)) - Math.min(130, d.real)) / Math.min(130, d.real)).sort((a, b) => a - b);
    console.log(`\nDiger orani: n=${dg.length}, gercek min/medyan/max = ${reals[0]} / ${reals[Math.floor(dg.length / 2)]} / ${reals[dg.length - 1]}`);
    console.log(`Diger eski (26-90 kelepce) medyan hata: ${(oldApes[Math.floor(oldApes.length / 2)] * 100).toFixed(1)}%`);
    console.log(`Diger yeni (corr=${digerCorr.toFixed(3)}, tavan 130) medyan hata: ${(newApes[Math.floor(newApes.length / 2)] * 100).toFixed(1)}%`);
  }

  console.log("\n--- scoreModel.js icin degerler ---");
  console.log(`EST_RHO = ${fitted.rho.toFixed(4)}; EST_B = ${fitted.B.toFixed(4)}; EST_C = ${fitted.C.toFixed(4)}; EST_DIGER_CORR = ${digerCorr.toFixed(3)};`);
  console.log("EST_KEY_CORR = " + JSON.stringify(
    Object.fromEntries(Object.entries(corr).map(([k, v]) => [k, Number(v.toFixed(3))]))) + ";");
}

main();
