const { estimateScoreOdds } = require("../scoreModel");

const NESINE_BULLETIN_URL = "https://cdnbulten.nesine.com/api/bulten/getprebultenfull";

function footballEvents(bulletin) {
  const events = (bulletin && bulletin.sg && bulletin.sg.EA) || [];
  return events.filter(event => event.GT === 1 && event.HN && event.AN);
}

function extractMsOdds(event) {
  const market = (event.MA || []).find(m => m.MTID === 1 && (m.OCA || []).length >= 3);
  if (!market) return null;

  const byN = {};
  market.OCA.forEach(option => { byN[option.N] = option.O; });
  if (!(byN[1] > 1 && byN[2] > 1 && byN[3] > 1)) return null;
  return { "1": byN[1], "X": byN[2], "2": byN[3] };
}

function extractScoreOdds(event) {
  const market = (event.MA || []).find(m => m.MTID === 777 && (m.OCA || []).length);
  if (!market) return null;

  const score = {};
  market.OCA.forEach(option => {
    const label = String(option.ON || "").trim();
    const scoreKey = /^(\d+):(\d+)$/.exec(label);
    if (scoreKey && option.O > 1) score[`${scoreKey[1]}-${scoreKey[2]}`] = option.O;
  });

  return Object.keys(score).length ? score : null;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function fmt(n) {
  return Number(n).toFixed(2);
}

async function main() {
  const res = await fetch(NESINE_BULLETIN_URL, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    }
  });

  if (!res.ok) throw new Error(`Nesine bulletin HTTP ${res.status}`);
  const bulletin = await res.json();
  const rows = [];
  const eventSummaries = [];
  const estimatedOnly = [];

  for (const event of footballEvents(bulletin)) {
    const ms = extractMsOdds(event);
    if (!ms) continue;

    const estimated = estimateScoreOdds(ms);
    if (!estimated) continue;

    const actual = extractScoreOdds(event);
    if (!actual) {
      estimatedOnly.push({
        match: `${event.HN} - ${event.AN}`,
        ms,
        sample: {
          "1-0": estimated["1-0"],
          "1-1": estimated["1-1"],
          "2-1": estimated["2-1"],
          diger: estimated.diger
        }
      });
      continue;
    }

    const eventErrors = [];
    Object.entries(actual).forEach(([key, real]) => {
      const pred = estimated[key];
      if (!(pred > 1 && real > 1)) return;
      const ape = Math.abs(pred - real) / real;
      rows.push({
        match: `${event.HN} - ${event.AN}`,
        key,
        real,
        pred,
        ape
      });
      eventErrors.push(ape);
    });

    if (eventErrors.length) {
      eventSummaries.push({
        match: `${event.HN} - ${event.AN}`,
        count: eventErrors.length,
        mean: eventErrors.reduce((sum, value) => sum + value, 0) / eventErrors.length
      });
    }
  }

  if (!rows.length) {
    console.log("No football events with both 1X2 and Match Score markets were found.");
    console.log(`Estimated-only football events: ${estimatedOnly.length}`);
    return;
  }

  const errors = rows.map(row => row.ape);
  const mean = errors.reduce((sum, value) => sum + value, 0) / errors.length;
  const over20 = errors.filter(value => value > 0.2).length;
  const worst = [...rows].sort((a, b) => b.ape - a.ape).slice(0, 10);
  const bestEvents = [...eventSummaries].sort((a, b) => a.mean - b.mean).slice(0, 5);

  console.log("Real Nesine score-market validation");
  console.log(`Football events in bulletin: ${footballEvents(bulletin).length}`);
  console.log(`Events with real score market: ${eventSummaries.length}`);
  console.log(`Compared score odds: ${rows.length}`);
  console.log(`Mean absolute percentage error: ${fmt(mean * 100)}%`);
  console.log(`Median absolute percentage error: ${fmt(percentile(errors, 0.5) * 100)}%`);
  console.log(`90th percentile absolute percentage error: ${fmt(percentile(errors, 0.9) * 100)}%`);
  console.log(`Rows above 20% error: ${over20}/${rows.length}`);
  console.log("");

  console.log("Best event averages:");
  bestEvents.forEach(item => {
    console.log(`- ${item.match}: ${fmt(item.mean * 100)}% over ${item.count} scores`);
  });
  console.log("");

  console.log("Worst score rows:");
  worst.forEach(row => {
    console.log(`- ${row.match} ${row.key}: real ${fmt(row.real)}, model ${fmt(row.pred)}, error ${fmt(row.ape * 100)}%`);
  });

  if (estimatedOnly.length) {
    console.log("");
    console.log(`Events where the app would use estimated score odds: ${estimatedOnly.length}`);
    estimatedOnly.slice(0, 5).forEach(item => {
      console.log(`- ${item.match}: 1=${fmt(item.ms["1"])} X=${fmt(item.ms.X)} 2=${fmt(item.ms["2"])}; 1-0=${fmt(item.sample["1-0"])}, 1-1=${fmt(item.sample["1-1"])}, 2-1=${fmt(item.sample["2-1"])}, diger=${fmt(item.sample.diger)}`);
    });
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
