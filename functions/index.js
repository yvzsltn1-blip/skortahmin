const admin = require("firebase-admin");
const { logger } = require("firebase-functions");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");

admin.initializeApp();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;
const { estimateScoreOdds, estimateSingleScoreOdd } = require("./scoreModel");

const REGION = "europe-west1";
const TIME_ZONE = "Europe/Istanbul";
const REMINDER_LEAD_MS = 4 * 60 * 60 * 1000;
const REMINDER_WINDOW_MS = 5 * 60 * 1000;
const RESULT_DIGEST_WAIT_MS = 5 * 60 * 1000;

function teamLine(match) {
  return `${match.homeTeam || "Ev sahibi"} - ${match.awayTeam || "Deplasman"}`;
}

function resultLine(match) {
  return `${match.homeTeam || "Ev sahibi"} ${match.homeScore} - ${match.awayScore} ${match.awayTeam || "Deplasman"}`;
}

function hasResult(match) {
  return match.homeScore !== null
    && match.homeScore !== undefined
    && match.awayScore !== null
    && match.awayScore !== undefined;
}

function scoreChanged(before, after) {
  return before.homeScore !== after.homeScore || before.awayScore !== after.awayScore;
}

async function isAdminUid(uid) {
  if (!uid) return false;
  const userSnap = await db.collection("users").doc(uid).get();
  return userSnap.exists && userSnap.data().isAdmin === true;
}

async function getResultDigestWaitMs() {
  try {
    const snap = await db.collection("settings").doc("notificationSettings").get();
    const minutes = Number(snap.exists ? snap.data().resultDigestDelayMinutes : 5);
    if (minutes >= 1 && minutes <= 60) return minutes * 60 * 1000;
  } catch (err) {
    logger.warn("Notification settings could not be read.", err);
  }
  return RESULT_DIGEST_WAIT_MS;
}

async function getEnabledTokens() {
  const snap = await db.collection("notificationTokens").where("enabled", "==", true).get();
  return snap.docs
    .map(doc => ({ ref: doc.ref, token: doc.data().token }))
    .filter(item => typeof item.token === "string" && item.token.length > 0);
}

async function sendToAllUsers(payload) {
  const tokenDocs = await getEnabledTokens();
  if (!tokenDocs.length) {
    logger.info("No enabled notification tokens.");
    return { successCount: 0, failureCount: 0 };
  }

  let successCount = 0;
  let failureCount = 0;
  const invalidRefs = [];

  for (let i = 0; i < tokenDocs.length; i += 500) {
    const chunk = tokenDocs.slice(i, i + 500);
    const response = await admin.messaging().sendEachForMulticast({
      tokens: chunk.map(item => item.token),
      notification: payload.notification,
      data: payload.data || {},
      android: {
        priority: "high",
        notification: {
          channelId: "matches",
          sound: "default"
        }
      }
    });

    successCount += response.successCount;
    failureCount += response.failureCount;

    response.responses.forEach((result, index) => {
      const code = result.error && result.error.code;
      if (
        code === "messaging/registration-token-not-registered"
        || code === "messaging/invalid-registration-token"
      ) {
        invalidRefs.push(chunk[index].ref);
      }
    });
  }

  if (invalidRefs.length) {
    const batch = db.batch();
    invalidRefs.forEach(ref => batch.set(ref, {
      enabled: false,
      disabledAt: FieldValue.serverTimestamp()
    }, { merge: true }));
    await batch.commit();
  }

  logger.info("Notification send completed.", { successCount, failureCount });
  return { successCount, failureCount };
}

// ================== NESINE ORAN ÇEKME ==================
// Bülten resmi olmayan bir uç; format değişirse oran çekme sessizce devre dışı
// kalır ve elle giriş akışı aynen çalışmaya devam eder.
const NESINE_BULLETIN_URL = "https://cdnbulten.nesine.com/api/bulten/getprebultenfull";
// Bülten yalnızca yakın tarihli maçları içerir; daha uzak maçlar için deneme yapılmaz.
const ODDS_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;

let bulletinCache = { at: 0, data: null };

async function fetchNesineBulletin() {
  if (bulletinCache.data && Date.now() - bulletinCache.at < 5 * 60 * 1000) {
    return bulletinCache.data;
  }
  // Önbellek kırıcı parametre + no-cache: CDN uçlarının bayat bülten kopyası
  // döndürmesini engeller (maç bültene yeni eklendiğinde görünmeme sorunu).
  const res = await fetch(`${NESINE_BULLETIN_URL}?_=${Date.now()}`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache"
    }
  });
  if (!res.ok) throw new Error(`Nesine bulletin HTTP ${res.status}`);
  const data = await res.json();
  bulletinCache = { at: Date.now(), data };
  return data;
}

function footballEvents(bulletin) {
  const events = (bulletin && bulletin.sg && bulletin.sg.EA) || [];
  return events.filter(e => e.GT === 1 && e.HN && e.AN);
}

function normalizeTeamName(name) {
  return String(name || "")
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Nesine D/T alanları İstanbul saatiyle "dd.MM.yyyy" / "HH:mm" formatında.
function nesineEventTime(event) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(event.D || "");
  if (!m) return null;
  const t = /^(\d{2}):(\d{2})$/.exec(event.T || "") || [null, "00", "00"];
  const iso = `${m[3]}-${m[2]}-${m[1]}T${t[1]}:${t[2]}:00+03:00`;
  const date = new Date(iso);
  return isNaN(date.getTime()) ? null : date;
}

function findBulletinEvent(bulletin, match, toleranceMs = 36 * 60 * 60 * 1000) {
  const home = normalizeTeamName(match.homeTeam);
  const away = normalizeTeamName(match.awayTeam);
  if (!home || !away) return null;

  const matchMs = match.datetime && match.datetime.toMillis
    ? match.datetime.toMillis()
    : (match.datetime ? new Date(match.datetime).getTime() : null);

  const nameMatches = (eventName, target) => {
    const n = normalizeTeamName(eventName);
    return n === target || n.includes(target) || target.includes(n);
  };

  const candidates = footballEvents(bulletin).filter(e =>
    nameMatches(e.HN, home) && nameMatches(e.AN, away)
  );
  if (!candidates.length) return null;

  // Aynı eşleşmeden birden fazla varsa maç saatine en yakın olanı seç;
  // saat bilgisi yoksa tek adaya ancak güvenilir.
  if (matchMs == null) return candidates.length === 1 ? candidates[0] : null;

  let best = null;
  let bestDiff = Infinity;
  for (const event of candidates) {
    const eventTime = nesineEventTime(event);
    const diff = eventTime ? Math.abs(eventTime.getTime() - matchMs) : Infinity;
    if (diff < bestDiff) { best = event; bestDiff = diff; }
  }
  // Toleranstan fazla sapma varsa muhtemelen başka bir karşılaşmadır.
  return bestDiff <= toleranceMs ? best : null;
}

// MTID 1 = Maç Sonucu (N: 1→"1", 2→"X", 3→"2"), MTID 777 = Maç Skoru (ON: "2:1", "diğer").
function extractOdds(event) {
  const markets = event.MA || [];
  const odds = {};

  const msMarket = markets.find(m => m.MTID === 1 && (m.OCA || []).length >= 3);
  if (msMarket) {
    const byN = {};
    msMarket.OCA.forEach(o => { byN[o.N] = o.O; });
    if (byN[1] && byN[2] && byN[3]) {
      odds.ms = { "1": byN[1], "X": byN[2], "2": byN[3] };
    }
  }

  const scoreMarket = markets.find(m => m.MTID === 777 && (m.OCA || []).length);
  if (scoreMarket) {
    const score = {};
    scoreMarket.OCA.forEach(o => {
      const label = String(o.ON || "").trim();
      const scoreKey = /^(\d+):(\d+)$/.exec(label);
      if (scoreKey) score[`${scoreKey[1]}-${scoreKey[2]}`] = o.O;
      else if (label) score.diger = o.O;
    });
    if (Object.keys(score).length) odds.score = score;
  }

  // Nesine skor marketi vermemişse 1X2'den tahmini skor oranları üret.
  if (!odds.score && odds.ms) {
    const est = estimateScoreOdds(odds.ms);
    if (est) {
      odds.score = est;
      odds.scoreEstimated = true;
    }
  }

  return (odds.ms || odds.score) ? odds : null;
}

async function tryAttachOdds(matchRef, match) {
  const bulletin = await fetchNesineBulletin();
  const event = findBulletinEvent(bulletin, match);
  const odds = event ? extractOdds(event) : null;

  if (!odds) {
    await matchRef.set({
      oddsStatus: "not_found",
      oddsCheckedAt: FieldValue.serverTimestamp(),
      oddsAttempts: FieldValue.increment(1)
    }, { merge: true });
    return false;
  }

  await matchRef.set({
    odds: {
      source: "nesine",
      eventNo: event.ENO || null,
      eventCode: event.C || null,
      ...odds
    },
    oddsStatus: "found",
    oddsCheckedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  logger.info("Odds attached.", { matchId: matchRef.id, home: match.homeTeam, away: match.awayTeam });
  return true;
}

exports.fetchOddsOnMatchCreate = onDocumentCreated({
  region: REGION,
  document: "matches/{matchId}"
}, async event => {
  const match = event.data.data();
  if (match.finalized || match.odds) return;
  try {
    await tryAttachOdds(event.data.ref, match);
  } catch (err) {
    logger.warn("Odds fetch on create failed.", { matchId: event.params.matchId, error: String(err) });
  }
});

// Maç girildiğinde bültende yoksa (çok erken girilmişse) 4 saatte bir yeniden dene.
exports.retryMissingOdds = onSchedule({
  region: REGION,
  schedule: "every 4 hours",
  timeZone: TIME_ZONE
}, async () => {
  const nowMs = Date.now();
  const snap = await db.collection("matches")
    .where("finalized", "==", false)
    .where("datetime", ">", Timestamp.fromMillis(nowMs))
    .where("datetime", "<", Timestamp.fromMillis(nowMs + ODDS_LOOKAHEAD_MS))
    .orderBy("datetime", "desc")
    .get();

  // Oranı olup skor marketi eksik kalmış maçlara tahmini skor oranı doldur.
  for (const doc of snap.docs) {
    const m = doc.data();
    if (m.odds && m.odds.ms && !m.odds.score) {
      const est = estimateScoreOdds(m.odds.ms);
      if (est) {
        await doc.ref.set({
          odds: { ...m.odds, score: est, scoreEstimated: true },
          oddsCheckedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        logger.info("Estimated score odds backfilled.", { matchId: doc.id });
      }
    }
  }

  const missing = snap.docs.filter(doc => !doc.data().odds);
  if (!missing.length) return;

  let bulletin;
  try {
    bulletin = await fetchNesineBulletin();
  } catch (err) {
    logger.warn("Bulletin fetch failed in retry job.", { error: String(err) });
    return;
  }

  for (const doc of missing) {
    try {
      const match = doc.data();
      const event = findBulletinEvent(bulletin, match);
      const odds = event ? extractOdds(event) : null;
      if (odds) {
        await doc.ref.set({
          odds: {
            source: "nesine",
            eventNo: event.ENO || null,
            eventCode: event.C || null,
            ...odds
          },
          oddsStatus: "found",
          oddsCheckedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      } else {
        await doc.ref.set({
          oddsStatus: "not_found",
          oddsCheckedAt: FieldValue.serverTimestamp(),
          oddsAttempts: FieldValue.increment(1)
        }, { merge: true });
      }
    } catch (err) {
      logger.warn("Odds retry failed for match.", { matchId: doc.id, error: String(err) });
    }
  }
});

// ================== FİKSTÜR TARİH SENKRONU (NESINE) ==================
// Hafta bazlı girilen (dateTbd:true, datetime = yer tutucu) maçların gerçek
// gün/saatini Nesine bülteninden bulur ve admin onayı için proposedDatetime
// alanına yazar; datetime'a asla dokunmaz — onay admin panelinden verilir.
const DATE_SYNC_LOOKAHEAD_MS = 10 * 24 * 60 * 60 * 1000;
const DATE_SYNC_LOOKBEHIND_MS = 7 * 24 * 60 * 60 * 1000;
// Yer tutucu (örn. pazar 18:00) gerçek tarihten Cuma-Pazartesi bandında sapabilir.
const DATE_SYNC_TOLERANCE_MS = 5 * 24 * 60 * 60 * 1000;

async function pendingTbdMatches() {
  const nowMs = Date.now();
  const snap = await db.collection("matches").where("dateTbd", "==", true).get();
  return snap.docs.filter(doc => {
    const m = doc.data();
    if (m.finalized) return false;
    const ms = m.datetime && m.datetime.toMillis ? m.datetime.toMillis() : null;
    return ms != null
      && ms > nowMs - DATE_SYNC_LOOKBEHIND_MS
      && ms < nowMs + DATE_SYNC_LOOKAHEAD_MS;
  });
}

// Henüz güncel önerisi olmayan maçlar (retry job'ının "çalışmaya değer mi" testi).
function needsProposal(match) {
  return match.proposalStatus !== "pending";
}

async function proposeFixtureDates(trigger) {
  const docs = await pendingTbdMatches();
  const summary = {
    trigger,
    checked: docs.length,
    proposed: 0,
    unmatched: 0,
    error: null,
    details: []
  };

  if (docs.length) {
    let bulletin;
    try {
      bulletin = await fetchNesineBulletin();
    } catch (err) {
      logger.warn("Bulletin fetch failed in date sync.", { error: String(err) });
      summary.error = String(err);
      await writeDateSyncSummary(summary);
      return summary;
    }

    for (const doc of docs) {
      try {
        const match = doc.data();
        const label = teamLine(match);
        const event = findBulletinEvent(bulletin, match, DATE_SYNC_TOLERANCE_MS);
        const eventTime = event ? nesineEventTime(event) : null;
        if (!eventTime) {
          summary.unmatched++;
          summary.details.push({ matchId: doc.id, match: label, status: "unmatched" });
          continue;
        }

        const prevMs = match.proposedDatetime && match.proposedDatetime.toMillis
          ? match.proposedDatetime.toMillis() : null;
        if (prevMs === eventTime.getTime()) {
          // Aynı öneri zaten duruyor (bekliyor ya da admin reddetti) — tekrar yazma.
          if (match.proposalStatus === "pending") summary.proposed++;
          summary.details.push({
            matchId: doc.id, match: label, status: match.proposalStatus || "pending",
            proposed: eventTime.toISOString()
          });
          continue;
        }

        await doc.ref.set({
          proposedDatetime: Timestamp.fromDate(eventTime),
          proposalStatus: "pending",
          proposalSource: "nesine",
          proposalCheckedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        summary.proposed++;
        summary.details.push({
          matchId: doc.id, match: label, status: "proposed_now",
          proposed: eventTime.toISOString()
        });
        logger.info("Fixture date proposed.", {
          matchId: doc.id, home: match.homeTeam, away: match.awayTeam,
          proposed: eventTime.toISOString()
        });
      } catch (err) {
        logger.warn("Date proposal failed for match.", { matchId: doc.id, error: String(err) });
      }
    }
  }

  await writeDateSyncSummary(summary);
  return summary;
}

function writeDateSyncSummary(summary) {
  const { details, ...counts } = summary;
  return db.collection("settings").doc("fixtureSync").set({
    ...counts,
    lastRunAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

// TFF programı genelde çarşamba açıklanır; haftalık ana koşu.
exports.fixtureDateSyncWeekly = onSchedule({
  region: REGION,
  schedule: "every wednesday 12:00",
  timeZone: TIME_ZONE
}, async () => {
  await proposeFixtureDates("weekly");
});

// Çarşamba çekilemezse (bülten gecikmesi vb.) 12 saatte bir tekrar dener;
// penceredeki tüm TBD maçların güncel önerisi varsa bülteni hiç çekmez.
exports.fixtureDateSyncRetry = onSchedule({
  region: REGION,
  schedule: "every 12 hours",
  timeZone: TIME_ZONE
}, async () => {
  const docs = await pendingTbdMatches();
  if (!docs.some(doc => needsProposal(doc.data()))) return;
  await proposeFixtureDates("retry");
});

// Admin panelindeki "Nesine'den Tarihleri Çek" butonunun ucu
// (nesineHealthCheck ile aynı desen: public onRequest + anında sonuç).
exports.fixtureDateSyncNow = onRequest({
  region: REGION,
  invoker: "public",
  cors: true
}, async (req, res) => {
  try {
    const summary = await proposeFixtureDates("manual");
    res.json({ ok: true, ...summary });
  } catch (err) {
    logger.warn("Manual fixture date sync failed.", { error: String(err) });
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Teşhis ucu: Nesine erişimini test eder ve son 24 saat + gelecekteki maçların
// oran durumunu listeler. ?run=1 ile oranı eksik olanlar için hemen çekmeyi dener.
exports.nesineHealthCheck = onRequest({ region: REGION, invoker: "public", cors: true }, async (req, res) => {
  try {
    // ?scores=1 → bekleyen maçlar için skor taramasını hemen çalıştır.
    if (req.query.scores === "1") {
      const scoreReport = await sweepPendingScores();
      res.json({ ok: true, mode: "scores", report: scoreReport });
      return;
    }
    // ?reestimate=1 → başlamamış maçların TAHMİNİ skor oranlarını güncel
    // modelle yeniden hesaplar (model kalibrasyonu değiştiğinde bir kez çağır).
    if (req.query.reestimate === "1") {
      const snap = await db.collection("matches")
        .where("finalized", "==", false)
        .where("datetime", ">", Timestamp.now())
        .orderBy("datetime", "desc")
        .get();
      const refreshed = [];
      for (const doc of snap.docs) {
        const m = doc.data();
        if (!(m.odds && m.odds.ms && m.odds.scoreEstimated)) continue;
        const est = estimateScoreOdds(m.odds.ms);
        if (!est) continue;
        await doc.ref.set({
          odds: { ...m.odds, score: est },
          oddsCheckedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        refreshed.push(`${m.homeTeam} - ${m.awayTeam}`);
      }
      res.json({ ok: true, mode: "reestimate", upcoming: snap.size, refreshed });
      return;
    }
    // ?refinalize=<matchId> → skoru girilmiş bir maçın puanlarını oranlardan
    // yeniden hesaplar (skorboard + lider tablosu farkla düzeltilir).
    if (req.query.refinalize) {
      const doc = await db.collection("matches").doc(String(req.query.refinalize)).get();
      if (!doc.exists) { res.status(404).json({ ok: false, error: "match not found" }); return; }
      const m = doc.data();
      if (m.homeScore == null || m.awayScore == null) {
        res.status(400).json({ ok: false, error: "match has no score yet" });
        return;
      }
      const outcome = await finalizeMatchWithScore(doc, { home: m.homeScore, away: m.awayScore });
      res.json({ ok: true, mode: "refinalize", matchId: doc.id, result: outcome });
      return;
    }
    bulletinCache = { at: 0, data: null };
    const bulletin = await fetchNesineBulletin();
    const events = footballEvents(bulletin);

    // ?grep=<isim> → sunucunun gördüğü bültende takım adı ara (eşleşme sorunlarını
    // ayıklamak için; ör. ?grep=fransa).
    if (req.query.grep) {
      const q = String(req.query.grep).toLocaleLowerCase("tr-TR");
      const hits = ((bulletin && bulletin.sg && bulletin.sg.EA) || [])
        .filter(e => `${e.HN || ""} ${e.AN || ""}`.toLocaleLowerCase("tr-TR").includes(q))
        .map(e => ({ HN: e.HN, AN: e.AN, D: e.D, T: e.T, GT: e.GT, ENO: e.ENO, markets: (e.MA || []).length }));
      res.json({ ok: true, mode: "grep", footballEventCount: events.length, hits });
      return;
    }

    // Sadece 7 gün içinde oynanacak maçlar taranır; bülten zaten daha ilerisini içermez.
    const since = Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
    const until = Timestamp.fromMillis(Date.now() + ODDS_LOOKAHEAD_MS);
    const snap = await db.collection("matches")
      .where("finalized", "==", false)
      .where("datetime", ">", since)
      .where("datetime", "<", until)
      .orderBy("datetime", "desc")
      .get();

    const doAttach = req.query.run === "1";
    const matchesReport = [];
    for (const doc of snap.docs) {
      const match = doc.data();
      let status = match.odds ? "found" : (match.oddsStatus || "none");
      if (doAttach && !match.odds) {
        try {
          status = (await tryAttachOdds(doc.ref, match)) ? "found_now" : "not_found";
        } catch (err) {
          status = "error: " + String(err);
        }
      }
      matchesReport.push({
        id: doc.id,
        match: `${match.homeTeam} - ${match.awayTeam}`,
        datetime: match.datetime && match.datetime.toDate ? match.datetime.toDate().toISOString() : null,
        odds: status
      });
    }

    res.json({ ok: true, footballEventCount: events.length, matches: matchesReport });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ================== OTOMATİK SKOR ÇEKME (NESINE LIVESCORE) ==================
// Biten maçların skorunu ls.nesine.com'dan çekip admin "Kaydet" akışının yaptığı
// işlemleri (puan hesabı + skorboard dondurma + lider tablosu + arşiv indeksi)
// birebir uygular. Eşleştirme, oran çekilirken kaydedilen odds.eventCode iledir.
const LIVESCORE_BASE = "https://ls.nesine.com/api/v2/LiveScore";
const DEFAULT_TOURNAMENT = "World Cup 2026";
// İddaa kuralı gibi normal süre (90 dk) skoru esas alınır: ES T=3, yoksa T=1.
const FINISHED_STATUSES = new Set([5, 22, 24]); // Finished, FinishedAET, FinishedAP
// Uzatma/penaltı evreleri: 90 dk bitmiştir, T=3 (normal süre) skoru kesinleşmiştir.
const EXTRA_TIME_STATUSES = new Set([16, 19, 20, 21, 25, 26, 28]);

function tournamentOf(match) {
  return (match && match.tournament && String(match.tournament).trim()) || DEFAULT_TOURNAMENT;
}

function toDate(value) {
  if (!value) return null;
  if (value.toDate) return value.toDate();
  return new Date(value);
}

// Türkiye sabit UTC+3; ISO gün anahtarını İstanbul saatine göre üretir.
function istanbulDateStr(date) {
  return new Date(date.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function istanbulDayLabel(date) {
  return date.toLocaleDateString("tr-TR", {
    day: "numeric", month: "long", weekday: "long", timeZone: "Europe/Istanbul"
  });
}

async function fetchLivescoreJson(url) {
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
  });
  if (!res.ok) throw new Error(`Livescore HTTP ${res.status} (${url})`);
  const data = await res.json();
  return Array.isArray(data.d) ? data.d : [];
}

// Verilen İstanbul günleri + canlı liste üzerinden eventCode → skor kaydı haritası.
async function fetchScoreEntries(dates) {
  const byCode = new Map();
  for (const d of dates) {
    const list = await fetchLivescoreJson(`${LIVESCORE_BASE}/GetUnliveMatches?sportType=1&date=${d}`);
    list.forEach(m => { if (m && m.C != null) byCode.set(m.C, m); });
  }
  const live = await fetchLivescoreJson(`${LIVESCORE_BASE}/GetLiveMatchListWithVersion?sportType=1&v=0`);
  live.forEach(m => { if (m && m.C != null && !byCode.has(m.C)) byCode.set(m.C, m); });
  return byCode;
}

function finalScoreOf(entry) {
  if (!entry) return null;
  const es = Array.isArray(entry.ES) ? entry.ES : [];
  const ordinary = es.find(e => e.T === 3);
  if (FINISHED_STATUSES.has(entry.S)) {
    const row = ordinary || es.find(e => e.T === 1);
    if (!row || typeof row.H !== "number" || typeof row.A !== "number") return null;
    return { home: row.H, away: row.A };
  }
  // Maç uzatmada/penaltıda: 90 dk skoru (T=3) kesinleşmiştir, onu kullan.
  if (EXTRA_TIME_STATUSES.has(entry.S)) {
    if (!ordinary || typeof ordinary.H !== "number" || typeof ordinary.A !== "number") return null;
    return { home: ordinary.H, away: ordinary.A };
  }
  return null;
}

// ---- Yaklaşma tavanı: app.js ile birebir aynı kural ----
// 21 Temmuz 2026 ve sonrasında başlayan maçlarda yaklaşmanın yarım skor puanı,
// oyuncunun SÖYLEDİĞİ skorun kendi iddaa oranının %85'ini geçemez.
const APPROX_CAP_RATIO = 0.85;
const APPROX_CAP_START_MS = Date.UTC(2026, 6, 20, 21, 0, 0); // 21 Tem 2026 00:00 (TR)

// app.js scoreOddFor karşılığı: söylenen skorun oranı (listede yoksa modelden)
function predScoreOddFor(match, h, a) {
  const odds = match.odds || {};
  const s = odds.score;
  if (!s) return null;
  const v = s[`${h}-${a}`];
  if (typeof v === "number") return v;
  return estimateSingleScoreOdd(odds.ms, h, a);
}

function approxHalfScorePts(match, ph, pa, sp) {
  const half = sp / 2;
  const dt = match.datetime;
  const dtMs = dt && typeof dt.toMillis === "function" ? dt.toMillis()
    : (dt ? new Date(dt).getTime() : 0);
  if (!dtMs || dtMs < APPROX_CAP_START_MS) return half;
  const predOdd = predScoreOddFor(match, ph, pa);
  if (typeof predOdd !== "number" || !(predOdd > 0)) return half;
  return Math.min(half, predOdd * APPROX_CAP_RATIO);
}

// ---- Derbi ×2: app.js ile birebir aynı kural ----
// Dört büyükler kendi arasında oynayınca tüm puanlar (sonuç, skor, yaklaşma, +3 bonus) katlanır.
const DERBY_X2_START_MS = APPROX_CAP_START_MS;
const DERBY_TEAMS = ["galatasaray", "fenerbahçe", "fenerbahce", "trabzonspor", "beşiktaş", "besiktas"];

function isDerbyTeam(name) {
  const n = String(name || "").toLocaleLowerCase("tr");
  return DERBY_TEAMS.some(t => n.includes(t));
}

function derbyMultiplier(match) {
  if (!match) return 1;
  const dt = match.datetime;
  const dtMs = dt && typeof dt.toMillis === "function" ? dt.toMillis()
    : (dt ? new Date(dt).getTime() : 0);
  if (!dtMs || dtMs < DERBY_X2_START_MS) return 1;
  return isDerbyTeam(match.homeTeam) && isDerbyTeam(match.awayTeam) ? 2 : 1;
}

// ---- index.html'deki puanlama mantığının birebir kopyası ----
function autoPointsFor(pred, match, preds) {
  const ah = match.homeScore, aa = match.awayScore;
  if (ah == null || aa == null) return null;

  const op = match.outcomePoints != null ? Number(match.outcomePoints) : 0;
  const sp = match.scorePoints != null ? Number(match.scorePoints) : 0;

  const ph = pred.homePred, pa = pred.awayPred;
  const predOutcome = Math.sign(ph - pa);
  const actOutcome = Math.sign(ah - aa);
  if (predOutcome !== actOutcome) return 0;

  const diff = Math.abs(ph - ah) + Math.abs(pa - aa);
  const approxDiff = (actOutcome === 0) ? 2 : 1;

  let pts;
  if (diff === 0) {
    pts = op + sp;
  } else if (diff === approxDiff) {
    const someoneExact = preds.some(q => q.homePred === ah && q.awayPred === aa);
    pts = someoneExact ? op : (op + approxHalfScorePts(match, ph, pa, sp));
  } else {
    pts = op;
  }

  const correctOutcomeCount = preds.filter(q =>
    Math.sign(q.homePred - q.awayPred) === actOutcome).length;
  if (correctOutcomeCount === 1) pts += 3;

  // Derbi ×2: sonuç + skor/yaklaşma + tek bilme bonusu hepsi birden katlanır.
  return pts * derbyMultiplier(match);
}

function computeScoreboard(match, preds, usersMap) {
  const scoreboard = preds.map(p => {
    const profile = usersMap[p.uid] || {};
    return {
      uid: p.uid,
      name: profile.displayName || profile.email || "Oyuncu",
      h: p.homePred,
      a: p.awayPred,
      pts: autoPointsFor(p, match, preds) || 0
    };
  }).sort((a, b) => (a.name || "").localeCompare(b.name || "", "tr"));

  const totalsByUid = {};
  scoreboard.forEach(s => { totalsByUid[s.uid] = (totalsByUid[s.uid] || 0) + s.pts; });
  return { scoreboard, totalsByUid };
}

async function loadUsersMap() {
  const snap = await db.collection("users").get();
  const map = {};
  snap.docs.forEach(doc => { map[doc.id] = doc.data(); });
  return map;
}

// Lig kuralı: puanlar maçın KENDİ iddaa oranlarından gelir.
// Sonuç puanı = gerçekleşen sonucun (1/X/2) oranı, tam skor puanı = gerçekleşen skorun oranı.
function pointsFromOdds(match, score) {
  const odds = match.odds || {};
  const ms = odds.ms || {};
  const outcome = Math.sign(score.home - score.away);
  const msKey = outcome > 0 ? "1" : (outcome === 0 ? "X" : "2");
  const op = typeof ms[msKey] === "number" ? ms[msKey] : null;

  const sc = odds.score || {};
  let sp = sc[`${score.home}-${score.away}`];
  if (typeof sp !== "number") {
    // Skor Nesine listesinde yok (örn. 5-4): oranını modelden hesapla, tavan 200.
    sp = estimateSingleScoreOdd(ms, score.home, score.away);
  }
  return (op != null && sp != null) ? { outcomePoints: op, scorePoints: sp } : null;
}

// saveResult (optimized mod) akışının sunucu tarafı kopyası.
async function finalizeMatchWithScore(doc, score) {
  const matchId = doc.id;
  const prev = doc.data();
  const tournament = tournamentOf(prev);

  const aggSnap = await db.collection("settings").doc("leaderboard").get();
  const optimizedMode = aggSnap.exists;

  const points = pointsFromOdds(prev, score);
  if (!points) {
    // Oran verisi eksikse skoru yazıp finalize etmeden admin'e bırak.
    await doc.ref.set({
      homeScore: score.home,
      awayScore: score.away,
      autoScoreStatus: "points_missing",
      autoScoreCheckedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    logger.warn("Score written but odds-based points unavailable; left unfinalized.", { matchId });
    return "score_only";
  }

  const data = {
    homeScore: score.home,
    awayScore: score.away,
    outcomePoints: points.outcomePoints,
    scorePoints: points.scorePoints,
    autoScoreStatus: "finalized",
    autoScoredAt: FieldValue.serverTimestamp()
  };

  if (!optimizedMode) {
    await doc.ref.set(data, { merge: true });
    return "legacy_score";
  }

  const predsSnap = await db.collection("predictions").where("matchId", "==", matchId).get();
  const preds = predsSnap.docs.map(d => {
    const p = d.data();
    return { uid: p.uid, homePred: p.homePred, awayPred: p.awayPred };
  });
  const usersMap = await loadUsersMap();

  const matchForCalc = { ...prev, ...data, id: matchId };
  const { scoreboard, totalsByUid } = computeScoreboard(matchForCalc, preds, usersMap);

  const prevSb = Array.isArray(prev.scoreboard) ? prev.scoreboard : [];
  const delta = {};
  prevSb.forEach(s => { delta[s.uid] = (delta[s.uid] || 0) - (s.pts || 0); });
  Object.entries(totalsByUid).forEach(([uid, pts]) => { delta[uid] = (delta[uid] || 0) + pts; });

  const overall = {};
  const perTour = {};
  Object.entries(delta).forEach(([uid, d]) => {
    if (!d) return;
    overall[uid] = FieldValue.increment(d);
    perTour[uid] = FieldValue.increment(d);
  });

  const batch = db.batch();
  // `finalizedAt` is the cursor used by browsers to pull only newly finished
  // matches into their form/analysis archive cache.
  batch.set(doc.ref, {
    ...data,
    finalized: true,
    finalizedAt: FieldValue.serverTimestamp(),
    scoreboard
  }, { merge: true });
  // Write a version signal even for 0-point results. Those results still belong
  // in every player's recent form and detailed analysis.
  batch.set(db.collection("settings").doc("leaderboard"), {
    ...(Object.keys(overall).length ? {
      totals: overall,
      totalsByTournament: { [tournament]: perTour }
    } : {}),
    archiveVersion: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  // Arşiv gün indeksi (upsertArchiveDayIndex kopyası).
  const dt = toDate(prev.datetime);
  if (dt) {
    const key = istanbulDateStr(dt);
    const dayStartIst = new Date(`${key}T00:00:00+03:00`).getTime();
    batch.set(db.collection("settings").doc("archiveDays"), {
      days: {
        [key]: {
          key,
          ts: dayStartIst,
          label: istanbulDayLabel(dt),
          tournaments: { [tournament]: true },
          matches: { [matchId]: tournament }
        }
      },
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }

  await batch.commit();
  logger.info("Match auto-finalized from livescore.", {
    matchId,
    match: `${prev.homeTeam} - ${prev.awayTeam}`,
    score: `${score.home}-${score.away}`
  });
  return "finalized";
}

// Bekleyen (başlamış ama skoru girilmemiş) maçları tarayıp biten skorları işler.
async function sweepPendingScores() {
  const nowMs = Date.now();
  const snap = await db.collection("matches")
    .where("finalized", "==", false)
    .where("datetime", "<", Timestamp.fromMillis(nowMs - 100 * 60 * 1000))
    .where("datetime", ">", Timestamp.fromMillis(nowMs - 36 * 60 * 60 * 1000))
    .orderBy("datetime", "desc")
    .get();

  const report = [];
  const pending = snap.docs.filter(doc => {
    const m = doc.data();
    if (m.homeScore != null && m.awayScore != null) return false;
    if (!(m.odds && m.odds.eventCode != null)) {
      report.push({ id: doc.id, match: `${m.homeTeam} - ${m.awayTeam}`, result: "no_event_code" });
      return false;
    }
    return true;
  });
  if (!pending.length) return report;

  const dates = [...new Set(pending.map(doc => {
    const dt = toDate(doc.data().datetime);
    return dt ? istanbulDateStr(dt) : null;
  }).filter(Boolean))];

  const entries = await fetchScoreEntries(dates);

  for (const doc of pending) {
    const m = doc.data();
    const label = `${m.homeTeam} - ${m.awayTeam}`;
    try {
      const entry = entries.get(m.odds.eventCode);
      const score = finalScoreOf(entry);
      if (!score) {
        await doc.ref.set({ autoScoreCheckedAt: FieldValue.serverTimestamp() }, { merge: true });
        report.push({ id: doc.id, match: label, result: entry ? "not_finished" : "not_in_feed" });
        continue;
      }
      const outcome = await finalizeMatchWithScore(doc, score);
      report.push({ id: doc.id, match: label, result: outcome, score: `${score.home}-${score.away}` });
    } catch (err) {
      logger.warn("Auto score failed for match.", { matchId: doc.id, error: String(err) });
      report.push({ id: doc.id, match: label, result: "error: " + String(err) });
    }
  }
  return report;
}

exports.autoFetchScores = onSchedule({
  region: REGION,
  schedule: "every 30 minutes",
  timeZone: TIME_ZONE
}, async () => {
  const report = await sweepPendingScores();
  if (report.length) logger.info("Score sweep completed.", { report });
});

// APK bildirimleri kullanılmadığı için otomatik bildirim fonksiyonları devre dışı
// (2026-07-07). Yeniden açmak için aşağıdaki üç fonksiyonda "const _disabled_..."
// yerine "exports...." yazıp deploy etmek yeterli.
const _disabled_sendFourHourMatchReminders = onSchedule({
  region: REGION,
  schedule: "every 5 minutes",
  timeZone: TIME_ZONE
}, async () => {
  const now = Date.now();
  const start = Timestamp.fromDate(new Date(now + REMINDER_LEAD_MS - REMINDER_WINDOW_MS));
  const end = Timestamp.fromDate(new Date(now + REMINDER_LEAD_MS + REMINDER_WINDOW_MS));

  const snap = await db.collection("matches")
    .where("datetime", ">=", start)
    .where("datetime", "<", end)
    .get();

  for (const doc of snap.docs) {
    const match = doc.data();
    if (match.reminder4hSentAt) continue;

    const sent = await sendToAllUsers({
      notification: {
        title: "AEFY LIG: Mac yaklasiyor",
        body: `${teamLine(match)} maci 4 saat sonra basliyor. Tahminini unutma!`
      },
      data: {
        type: "match_reminder_4h",
        matchId: doc.id
      }
    });

    await doc.ref.set({
      reminder4hSentAt: FieldValue.serverTimestamp(),
      reminder4hSendStats: sent
    }, { merge: true });
  }
});

const _disabled_queueResultNotifications = onDocumentUpdated({
  region: REGION,
  document: "matches/{matchId}"
}, async event => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const matchId = event.params.matchId;

  if (!after.finalized || !hasResult(after)) return;
  if (before.finalized === true && !scoreChanged(before, after)) return;

  const digestRef = db.collection("settings").doc("resultNotificationDigest");
  await db.runTransaction(async transaction => {
    const digestSnap = await transaction.get(digestRef);
    const digest = digestSnap.exists ? digestSnap.data() : {};
    const matches = digest.matches || {};

    matches[matchId] = {
      matchId,
      line: resultLine(after),
      homeTeam: after.homeTeam || "",
      awayTeam: after.awayTeam || "",
      homeScore: after.homeScore,
      awayScore: after.awayScore,
      updatedAt: Timestamp.now()
    };

    const keepFirstAddedAt = digest.status === "pending" && digest.firstAddedAt;
    transaction.set(digestRef, {
      matches,
      firstAddedAt: keepFirstAddedAt || FieldValue.serverTimestamp(),
      lastAddedAt: FieldValue.serverTimestamp(),
      status: "pending"
    }, { merge: true });

    transaction.set(event.data.after.ref, {
      resultNotificationQueuedAt: FieldValue.serverTimestamp(),
      resultNotificationSentAt: FieldValue.delete(),
      resultNotificationSendStats: FieldValue.delete()
    }, { merge: true });
  });
});

const _disabled_sendResultNotificationDigest = onSchedule({
  region: REGION,
  schedule: "every 1 minutes",
  timeZone: TIME_ZONE
}, async () => {
  const digestRef = db.collection("settings").doc("resultNotificationDigest");
  const digestSnap = await digestRef.get();
  if (!digestSnap.exists) return;

  const digest = digestSnap.data();
  const matches = digest.matches || {};
  const entries = Object.values(matches);
  if (!entries.length || digest.status !== "pending" || !digest.lastAddedAt) return;

  const lastAddedMs = digest.lastAddedAt.toMillis ? digest.lastAddedAt.toMillis() : 0;
  const waitMs = await getResultDigestWaitMs();
  if (Date.now() - lastAddedMs < waitMs) return;

  const count = entries.length;
  const body = count === 1
    ? `${entries[0].line} sonucu ve puanlar guncellendi.`
    : `${count} macin sonucu ve puanlari girildi. Puan tablosu guncellendi.`;

  const sent = await sendToAllUsers({
    notification: {
      title: count === 1 ? "AEFY LIG: Sonuc girildi" : "AEFY LIG: Toplu sonuc guncellemesi",
      body
    },
    data: {
      type: count === 1 ? "match_result" : "match_result_digest",
      matchId: count === 1 ? entries[0].matchId : "",
      matchCount: String(count)
    }
  });

  const batch = db.batch();
  entries.forEach(entry => {
    batch.set(db.collection("matches").doc(entry.matchId), {
      resultNotificationSentAt: FieldValue.serverTimestamp(),
      resultNotificationSendStats: sent
    }, { merge: true });
  });
  batch.set(digestRef, {
    matches: {},
    status: "sent",
    lastSentAt: FieldValue.serverTimestamp(),
    lastSendStats: sent,
    lastSentCount: count,
    lastSentLines: entries.slice(0, 10).map(entry => entry.line)
  }, { merge: true });
  await batch.commit();
});

exports.sendAdminNotification = onDocumentCreated({
  region: REGION,
  document: "adminNotifications/{notificationId}"
}, async event => {
  const ref = event.data.ref;
  const notification = event.data.data();
  const title = String(notification.title || "").trim();
  const body = String(notification.body || "").trim();
  const createdBy = notification.createdBy || "";

  if (!await isAdminUid(createdBy)) {
    await ref.set({
      status: "blocked",
      error: "Only admins can send notifications.",
      completedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return;
  }

  if (!title || !body) {
    await ref.set({
      status: "error",
      error: "Title and body are required.",
      completedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return;
  }

  const sent = await sendToAllUsers({
    notification: { title, body },
    data: {
      type: "admin_manual",
      notificationId: event.params.notificationId
    }
  });

  await ref.set({
    status: "sent",
    sentAt: FieldValue.serverTimestamp(),
    sendStats: sent
  }, { merge: true });
});
