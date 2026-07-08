// ---- SKOR ORANI TAHMINI (Nesine skor marketi yoksa) ----
// Model: 1X2 oranlari -> payi alinmis olasiliklar -> Dixon-Coles duzeltmeli Poisson
// (lambdaH, lambdaA) -> skor olasiliklari -> oran = C * (1 / p)^B * keyCorr.
// Standart skor marketi Nesine tavanina (130), listelenmeyen gercek skor puani lig
// tavanina (200) gore sinirlanir.
// Parametreler ofsayt.com arsivinden toplanan 669 macin (Mart-Mayis 2026, hem 1X2
// hem Mac Skoru marketi olan) gercek Iddaa oranlariyla kalibre edildi
// (scripts/calibrate-score-model.js). Test setinde MAPE %11.2 -> %7.1.
const EST_RHO = -0.0669;
const EST_B = 0.9713;
const EST_C = 0.6936;
const EST_SCORE_CAP = 130;
const EST_SINGLE_SCORE_CAP = 200;
const EST_MAXG = 12;

// Skor bazli kalan sistematik sapmanin carpimsal duzeltmesi (kalibrasyondan).
const EST_KEY_CORR = {
  "1-0": 0.952, "2-0": 1.019, "2-1": 1.012, "3-0": 1.006, "3-1": 1, "3-2": 1.003,
  "4-0": 0.988, "4-1": 0.988, "4-2": 0.996, "5-0": 0.985, "5-1": 1.001, "6-0": 1.073,
  "0-0": 1.038, "1-1": 1.011, "2-2": 0.927, "3-3": 0.934,
  "0-1": 0.942, "0-2": 1.047, "1-2": 1.024, "0-3": 1.047, "1-3": 1.028, "2-3": 1.017,
  "0-4": 1.007, "1-4": 0.996, "2-4": 0.983, "0-5": 1.006, "1-5": 1.014
};

// "Diger" secenegi: kalan olasiliktan ayni formul + kalibre carpan; gercek
// oranlar 5-130 bandinda gozlendi.
const EST_DIGER_CORR = 0.946;

// Nesine "Mac Skoru" marketinin standart sonuc kumesi.
const EST_SCORE_KEYS = [
  "1-0", "2-0", "2-1", "3-0", "3-1", "3-2", "4-0", "4-1", "4-2", "5-0", "5-1", "6-0",
  "0-0", "1-1", "2-2", "3-3",
  "0-1", "0-2", "1-2", "0-3", "1-3", "2-3", "0-4", "1-4", "2-4", "0-5", "1-5", "0-6"
];

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

function estScoreMatrix(lh, la) {
  const m = [];
  let total = 0;

  for (let h = 0; h <= EST_MAXG; h++) {
    m[h] = [];
    for (let a = 0; a <= EST_MAXG; a++) {
      const p = Math.max(0, poissonPmf(h, lh) * poissonPmf(a, la) * dcTau(h, a, lh, la, EST_RHO));
      m[h][a] = p;
      total += p;
    }
  }

  for (let h = 0; h <= EST_MAXG; h++) {
    for (let a = 0; a <= EST_MAXG; a++) {
      m[h][a] /= total;
    }
  }

  return m;
}

function estOutcomeProbs(m) {
  let ph = 0;
  let pd = 0;

  for (let h = 0; h <= EST_MAXG; h++) {
    for (let a = 0; a <= EST_MAXG; a++) {
      if (h > a) ph += m[h][a];
      else if (h === a) pd += m[h][a];
    }
  }

  return { ph, pd };
}

// 1X2 olasiliklarini tutturan (lambdaH, lambdaA) ciftini koordinat inisiyle cozer.
function fitLambdas(pH, pD) {
  let mu = 2.6;
  let d = Math.log((pH + 0.25) / (1 - pH - pD + 0.25));

  for (let iter = 0; iter < 80; iter++) {
    const expD = Math.exp(d);
    const lh = mu * expD / (expD + 1);
    const la = mu - lh;
    const { ph, pd } = estOutcomeProbs(estScoreMatrix(lh, la));
    const errH = pH - ph;
    const errD = pD - pd;

    if (Math.abs(errH) < 1e-5 && Math.abs(errD) < 1e-5) break;
    mu = Math.max(0.4, Math.min(7, mu - errD * 6));
    d += errH * 3.5;
  }

  const expD = Math.exp(d);
  const lh = mu * expD / (expD + 1);
  return { lh, la: mu - lh };
}

function estOddFromProb(p, corr) {
  if (!(p > 0)) return EST_SINGLE_SCORE_CAP;
  const est = EST_C * Math.pow(1 / p, EST_B) * (corr || 1);
  return Math.round(Math.max(1.01, est) * 100) / 100;
}

function fitMarket(msOdds) {
  const oh = Number(msOdds && msOdds["1"]);
  const od = Number(msOdds && msOdds["X"]);
  const oa = Number(msOdds && msOdds["2"]);
  if (!(oh > 1 && od > 1 && oa > 1)) return null;

  const ih = 1 / oh;
  const id = 1 / od;
  const ia = 1 / oa;
  const sum = ih + id + ia;
  const { lh, la } = fitLambdas(ih / sum, id / sum);
  return estScoreMatrix(lh, la);
}

// Tek bir skorun oranini 1X2'den hesaplar (listede olmayan skorlarin puani icin).
function estimateSingleScoreOdd(msOdds, h, a) {
  const matrix = fitMarket(msOdds);
  if (!matrix) return null;
  if (h > EST_MAXG || a > EST_MAXG) return EST_SINGLE_SCORE_CAP;
  return Math.min(EST_SINGLE_SCORE_CAP, estOddFromProb(matrix[h][a], EST_KEY_CORR[`${h}-${a}`]));
}

function estimateScoreOdds(msOdds) {
  const matrix = fitMarket(msOdds);
  if (!matrix) return null;

  const score = {};
  let listed = 0;
  for (const key of EST_SCORE_KEYS) {
    const [h, a] = key.split("-").map(Number);
    const p = matrix[h][a];
    listed += p;
    score[key] = Math.min(EST_SCORE_CAP, estOddFromProb(p, EST_KEY_CORR[key]));
  }

  score.diger = Math.min(EST_SCORE_CAP, Math.max(5, estOddFromProb(Math.max(1 - listed, 1e-4), EST_DIGER_CORR)));
  return score;
}

module.exports = {
  EST_SCORE_KEYS,
  estimateScoreOdds,
  estimateSingleScoreOdd
};
