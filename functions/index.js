const admin = require("firebase-admin");
const { logger } = require("firebase-functions");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
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
const OFSAYT_HOST = "ofsayt.com";

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

function teamLogoSlug(teamName) {
  return String(teamName || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;|&#39;/g, "'");
}

async function requireAdminRequest(req) {
  const authorization = String(req.get("authorization") || "");
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) throw new Error("Oturum doğrulanamadı.");
  const decoded = await admin.auth().verifyIdToken(match[1]);
  if (!await isAdminUid(decoded.uid)) throw new Error("Admin yetkisi gerekli.");
  return decoded.uid;
}

function validateOfsaytUrl(rawUrl) {
  const url = new URL(String(rawUrl || "").trim());
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  if (url.protocol !== "https:" || (hostname !== OFSAYT_HOST && !hostname.endsWith(`.${OFSAYT_HOST}`))) {
    throw new Error("Yalnızca https://ofsayt.com puan durumu adresi kullanılabilir.");
  }
  return url.toString();
}

function extractOfsaytWeeks(html) {
  const marker = "const weeks = ";
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) return [];
  const start = html.indexOf("[", markerAt);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "[") depth++;
    else if (char === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch (_) {
          return [];
        }
      }
    }
  }
  return [];
}

function logosFromOfsaytPage(html) {
  const logos = {};
  const weeks = extractOfsaytWeeks(html);
  for (const week of weeks) {
    for (const day of (week && week.dates) || []) {
      for (const fixture of (day && day.fixtureOfDay) || []) {
        for (const team of [fixture.homeTeam, fixture.awayTeam]) {
          if (!team || !team.Name || !team.logo) continue;
          const slug = teamLogoSlug(team.Name);
          if (slug && /^https:\/\//i.test(team.logo)) logos[slug] = team.logo;
        }
      }
    }
  }

  const standingsBlocks = Array.from(
    html.matchAll(/<tbody[^>]*class=["'][^"']*\bcurrent-stand-tbody\b[^"']*["'][^>]*>[\s\S]*?<\/tbody>/gi),
    match => match[0]
  );
  const standingsHtml = standingsBlocks.join("\n");
  const logoPattern = /<img(?=[^>]*\bclass=["'][^"']*\bofs-standing-table-team-logo\b[^"']*["'])(?=[^>]*\bsrc=["'](https:\/\/[^"']+)["'])[^>]*>[\s\S]{0,1200}?<a\b[^>]*href=["'][^"']*\/futbol\/takim\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = logoPattern.exec(standingsHtml))) {
    const teamName = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, "").trim());
    const slug = teamLogoSlug(teamName);
    if (slug && !logos[slug]) logos[slug] = decodeHtmlEntities(match[1]);
  }
  return logos;
}

async function findOfsaytTeamLogo(teamName) {
  const response = await fetch(
    `https://ofsayt.com/search/${encodeURIComponent(teamName)}?sport=futbol`,
    { headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } }
  );
  if (!response.ok) return null;
  const data = await response.json();
  const candidates = (Array.isArray(data.results) ? data.results : [])
    .filter(item => item && item.type === "team" && /^https:\/\//i.test(item.logo || ""))
    .filter(item => !/placeholder/i.test(item.logo));
  if (!candidates.length) return null;

  const wanted = teamLogoSlug(teamName);
  const ranked = candidates.map((item, index) => {
    const candidate = teamLogoSlug(item.name);
    const score = candidate === wanted
      ? 0
      : (candidate.startsWith(`${wanted}-`) || wanted.startsWith(`${candidate}-`) ? 1 : 2);
    return { item, score, index };
  }).sort((a, b) => a.score - b.score || a.index - b.index);
  return ranked[0].item.logo;
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
// 12 gün: hafta bazlı fikstürde bir hafta, önceki hafta biter bitmez topluca
// açılıyor ve haftanın son maçı ~10 gün ileride olabiliyor. Pencere 7 gün kalınca
// kullanıcı tahmin girebildiği hâlde oranı göremiyordu (Samsunspor-Göztepe vakası:
// maç 7,86 gün uzaktaydı, taramaya hiç girmiyordu). Pencere fikstürden geniş olmalı.
const ODDS_LOOKAHEAD_MS = 12 * 24 * 60 * 60 * 1000;

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
// scheduledTasks dispatcher'ından çağrılır (bkz. dosya sonu).
async function retryMissingOddsTask() {
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
  // Nesine skor marketini (MTID 777) çoğu zaman maça birkaç gün kala açıyor;
  // o ana kadar modelden üretilmiş tahmini oranlarla duruyoruz. Gerçek market
  // açıldığı an tahmin onunla DEĞİŞTİRİLİR — Nesine oranı her zaman modelin
  // önüne geçer. Market hiç açılmazsa tahmini oran olduğu gibi kalır.
  // Değişim maç başına tek seferliktir: scoreEstimated kalkınca bir daha
  // dokunulmaz, ayrıca sorgu zaten yalnızca BAŞLAMAMIŞ maçları kapsar — yani
  // oynanmış maçların puanları asla geriye dönük oynamaz.
  const estimated = snap.docs.filter(doc => {
    const odds = doc.data().odds;
    return odds && odds.scoreEstimated === true;
  });
  if (!missing.length && !estimated.length) return;

  let bulletin;
  try {
    bulletin = await fetchNesineBulletin();
  } catch (err) {
    logger.warn("Bulletin fetch failed in retry job.", { error: String(err) });
    return;
  }

  for (const doc of estimated) {
    try {
      const match = doc.data();
      const event = findBulletinEvent(bulletin, match);
      const fresh = event ? extractOdds(event) : null;
      // fresh.scoreEstimated true ise Nesine hâlâ skor marketini açmamış demektir
      // (extractOdds yine modele düşmüş) — o durumda mevcut tahmini koru.
      if (!fresh || !fresh.score || fresh.scoreEstimated) continue;

      // DİKKAT: set(merge:true) iç içe haritayı BİRLEŞTİRİR — tahmini skor
      // anahtarları (Nesine'de olmayan skorlar) altta kalırdı. update() alanı
      // bütünüyle değiştirdiği için oran haritası temiz yazılır; `scoreEstimated`
      // de anahtarı hiç koymayarak düşer.
      await doc.ref.update({
        odds: {
          source: "nesine",
          eventNo: event.ENO || null,
          eventCode: event.C || null,
          ...fresh
        },
        oddsStatus: "found",
        oddsUpgradedAt: FieldValue.serverTimestamp(),
        oddsCheckedAt: FieldValue.serverTimestamp()
      });
      logger.info("Estimated score odds upgraded to real Nesine market.", {
        matchId: doc.id, home: match.homeTeam, away: match.awayTeam
      });
    } catch (err) {
      logger.warn("Odds upgrade failed for match.", { matchId: doc.id, error: String(err) });
    }
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
}

// ================== FİKSTÜR TARİH SENKRONU (NESINE) ==================
// Hafta bazlı girilen (dateTbd:true, datetime = yer tutucu) maçların gerçek
// gün/saatini Nesine bülteninden bulur ve admin onayı için proposedDatetime
// alanına yazar; datetime'a asla dokunmaz — onay admin panelinden verilir.
const DATE_SYNC_LOOKAHEAD_MS = 10 * 24 * 60 * 60 * 1000;
const DATE_SYNC_LOOKBEHIND_MS = 7 * 24 * 60 * 60 * 1000;
// Yer tutucu (örn. pazar 18:00) gerçek tarihten Cuma-Pazartesi bandında sapabilir.
const DATE_SYNC_TOLERANCE_MS = 5 * 24 * 60 * 60 * 1000;

// Hafta bazlı maçlarda gün penceresi yerine "aktif hafta" kuralı geçerli:
// aktif hafta = sonucu girilmemiş maçı olan en küçük hafta. Sıradaki haftanın
// tarihi, hafta biter bitmez çekilebilsin diye aktif hafta + 1 de taranır.
const DATE_SYNC_WEEK_LOOKAHEAD = 1;

// ---- Hafta / aşama (round) modeli — app.js'teki kopyayla birebir aynı olmalı ----
// `week` lig haftası (1..MAX_WEEK_NO), `stage` eleme turu adı. İkisi de tek bir
// sıra sayısına (roundOrder) indirgenir; eleme turları hafta numaralarından
// SONRA gelsin diye STAGE_ORDER_BASE'ten başlar.
const KNOCKOUT_STAGES = ["Play-Off", "Son 16", "Çeyrek Final", "Yarı Final", "Final"];
const STAGE_ORDER_BASE = 1000;
const MAX_WEEK_NO = 60;

function stageOrderOf(stage) {
  const index = KNOCKOUT_STAGES.indexOf(String(stage || "").trim());
  return index < 0 ? null : STAGE_ORDER_BASE + index;
}

function roundOrderOf(match) {
  const stage = stageOrderOf(match && match.stage);
  if (stage != null) return stage;
  const week = Number(match && match.week);
  return Number.isInteger(week) && week >= 1 && week <= MAX_WEEK_NO ? week : null;
}

function roundLabelFromOrder(order) {
  if (order == null) return "";
  return order >= STAGE_ORDER_BASE
    ? (KNOCKOUT_STAGES[order - STAGE_ORDER_BASE] || "Eleme Turu")
    : `${order}. Hafta`;
}

// Bir turun tüm maçlarını getirir (hafta no ya da aşama adı üzerinden).
async function matchesOfRound(tournament, roundOrder) {
  const query = roundOrder >= STAGE_ORDER_BASE
    ? db.collection("matches").where("stage", "==", KNOCKOUT_STAGES[roundOrder - STAGE_ORDER_BASE])
    : db.collection("matches").where("week", "==", roundOrder);
  const snap = await query.get();
  return snap.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(m => tournamentOf(m) === tournament);
}

async function activeWeekByTournament() {
  const snap = await db.collection("matches").where("finalized", "==", false).get();
  const active = {};
  snap.docs.forEach(doc => {
    const m = doc.data();
    const order = roundOrderOf(m);
    if (order == null) return;
    // Ertelenen maç turu kilitlemez (app.js computeActiveWeeks ile aynı kural).
    if (m.postponed === true) return;
    const key = tournamentOf(m);
    if (active[key] == null || order < active[key]) active[key] = order;
  });
  return active;
}

async function pendingTbdMatches() {
  const nowMs = Date.now();
  const [snap, activeWeeks] = await Promise.all([
    db.collection("matches").where("dateTbd", "==", true).get(),
    activeWeekByTournament()
  ]);
  return snap.docs.filter(doc => {
    const m = doc.data();
    if (m.finalized) return false;
    const order = roundOrderOf(m);
    if (order != null) {
      const active = activeWeeks[tournamentOf(m)];
      return active == null || order <= active + DATE_SYNC_WEEK_LOOKAHEAD;
    }
    const ms = m.datetime && m.datetime.toMillis ? m.datetime.toMillis() : null;
    return ms != null
      && ms > nowMs - DATE_SYNC_LOOKBEHIND_MS
      && ms < nowMs + DATE_SYNC_LOOKAHEAD_MS;
  });
}

// ---- Ofsayt.com fikstür yedeği ----
// Nesine bülteni yalnızca yakın tarihli maçları taşır; bültende bulunamayan
// hafta maçlarının resmi gün/saati Ofsayt lig sayfasındaki fikstür JSON'undan
// okunur. Ofsayt resmi fikstür kaynağı olduğu için sonuç öneri olarak değil
// doğrudan datetime'a yazılır (admin onayı beklemez).
// Turnuva -> lig sayfası adresi eşlemesi settings/app.ofsaytFixtureUrls altında.
// Ofsayt lig adresi iki GUID taşır: /futbol/lig/<slug>/<LİG-ID>/detay/puan-durumu/<SEZON-ID>
// LİG-ID kalıcıdır, SEZON-ID her sezon değişir — sezon ekli adres bir yıl sonra
// hâlâ eski sezonun fikstürünü döndürür. Sezon parçası atılınca sayfa her zaman
// GÜNCEL sezona çözülür (doğrulandı: sezonsuz adres de 34 haftayı veriyor).
const OFSAYT_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeOfsaytFixtureUrl(rawUrl) {
  const url = new URL(String(rawUrl || "").trim());
  const parts = url.pathname.split("/").filter(Boolean);
  const ligAt = parts.indexOf("lig");
  // Beklenen biçim dışındaki adreslere dokunma (bozmaktansa olduğu gibi bırak).
  if (ligAt < 0 || !OFSAYT_GUID_RE.test(parts[ligAt + 2] || "")) return url.toString();
  url.pathname = "/" + parts.slice(0, ligAt + 3).concat("detay", "puan-durumu").join("/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function ofsaytFixtureUrlMap() {
  const snap = await db.collection("settings").doc("app").get();
  const map = snap.exists ? snap.data().ofsaytFixtureUrls : null;
  return map && typeof map === "object" ? map : {};
}

function ofsaytFixtureDate(dateUtc) {
  // "2026-08-16T18:00:00+03:00" — ofset string'in içinde, doğrudan ayrıştırılır.
  const date = new Date(String(dateUtc || ""));
  return isNaN(date.getTime()) ? null : date;
}

// ÖNEMLİ: Ofsayt sezonun TAMAMININ fikstürünü verir, ama programı henüz
// açıklanmamış haftalara yer tutucu koyar — o haftanın bütün maçları TEK gün ve
// TEK saatte görünür (Süper Lig'de tipik olarak hepsi 18:00). Programı açıklanmış
// haftada maçlar birden fazla güne ve saate yayılır (ör. Cuma 21:30, Cumartesi 19:00).
// Bu yüzden yalnızca "birden fazla farklı başlama zamanı olan" haftalar resmi
// kabul edilir. Tek-zamanlı haftalar yok sayılır; tarihleri yaklaştıkça Nesine
// bülteninden gelir (sezonun son haftası gerçekten tek saatte oynansa bile o
// tarihte Nesine penceresine girmiş olur).
function isAnnouncedOfsaytWeek(dates) {
  return new Set(dates.map(date => date.getTime())).size > 1;
}

function ofsaytFixtureList(html) {
  const fixtures = [];
  const skippedWeeks = [];
  for (const week of extractOfsaytWeeks(html)) {
    const weekNo = parseInt(String((week && week.week) || ""), 10);
    const weekFixtures = [];
    for (const day of (week && week.dates) || []) {
      for (const fixture of (day && day.fixtureOfDay) || []) {
        const date = ofsaytFixtureDate(fixture.dateUtc);
        const home = fixture.homeTeam && fixture.homeTeam.Name;
        const away = fixture.awayTeam && fixture.awayTeam.Name;
        if (!date || !home || !away) continue;
        weekFixtures.push({
          week: Number.isInteger(weekNo) ? weekNo : null,
          home: normalizeTeamName(home),
          away: normalizeTeamName(away),
          date
        });
      }
    }
    if (weekFixtures.length && isAnnouncedOfsaytWeek(weekFixtures.map(f => f.date))) {
      fixtures.push(...weekFixtures);
    } else if (weekFixtures.length) {
      skippedWeeks.push(String((week && week.week) || "?").trim());
    }
  }
  if (skippedWeeks.length) {
    logger.info("Ofsayt: programı açıklanmamış haftalar atlandı.", { weeks: skippedWeeks });
  }
  return fixtures;
}

function findOfsaytFixtureDate(fixtures, match) {
  const home = normalizeTeamName(match.homeTeam);
  const away = normalizeTeamName(match.awayTeam);
  if (!home || !away) return null;
  const same = (a, b) => a === b || a.includes(b) || b.includes(a);
  const hits = fixtures.filter(f => same(f.home, home) && same(f.away, away));
  if (!hits.length) return null;

  // Hafta numarası varsa çift kayıt riskini eler (rövanş aynı eşleşmedir).
  // Eleme turlarında Ofsayt hafta numarası vermediği için ad eşleşmesine düşülür.
  const week = Number(match && match.week);
  if (Number.isInteger(week) && week >= 1) {
    const sameWeek = hits.filter(f => f.week === week);
    if (sameWeek.length === 1) return sameWeek[0].date;
    if (sameWeek.length > 1) return null;
  }
  return hits.length === 1 ? hits[0].date : null;
}

// Nesine'de bulunamayan maçlar için Ofsayt fikstürünü dener; bulunan tarihi
// doğrudan uygular. Dönen değer uygulanan maç sayısıdır.
async function applyOfsaytFixtureDates(docs, summary) {
  if (!docs.length) return 0;
  let urlMap;
  try {
    urlMap = await ofsaytFixtureUrlMap();
  } catch (err) {
    logger.warn("Ofsayt fixture URL map could not be read.", { error: String(err) });
    return 0;
  }

  // Turnuva başına tek sayfa indirilir.
  const byTournament = new Map();
  docs.forEach(doc => {
    const key = tournamentOf(doc.data());
    if (!byTournament.has(key)) byTournament.set(key, []);
    byTournament.get(key).push(doc);
  });

  let applied = 0;
  for (const [tournament, tournamentDocs] of byTournament) {
    const rawUrl = urlMap[tournament];
    if (!rawUrl) continue;
    let fixtures;
    try {
      // Kayıtlı adreste sezon GUID'i varsa burada da düşürülür — eski kayıtlar
      // yeni sezonda sessizce geçen sezonun fikstürünü okumasın.
      const url = validateOfsaytUrl(normalizeOfsaytFixtureUrl(rawUrl));
      const response = await fetch(url, {
        headers: {
          "Accept": "text/html,*/*",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        }
      });
      if (!response.ok) throw new Error(`Ofsayt HTTP ${response.status}`);
      fixtures = ofsaytFixtureList(await response.text());
    } catch (err) {
      logger.warn("Ofsayt fixture fetch failed.", { tournament, error: String(err) });
      continue;
    }
    if (!fixtures.length) continue;

    for (const doc of tournamentDocs) {
      const match = doc.data();
      const date = findOfsaytFixtureDate(fixtures, match);
      if (!date) continue;
      try {
        await doc.ref.set({
          datetime: Timestamp.fromDate(date),
          dateSource: "ofsayt",
          dateTbd: FieldValue.delete(),
          postponed: FieldValue.delete(),
          proposedDatetime: FieldValue.delete(),
          proposalStatus: FieldValue.delete(),
          proposalSource: FieldValue.delete(),
          proposalCheckedAt: FieldValue.delete()
        }, { merge: true });
        applied++;
        summary.unmatched = Math.max(0, summary.unmatched - 1);
        summary.details.push({
          matchId: doc.id, match: teamLine(match), status: "ofsayt_applied",
          proposed: date.toISOString()
        });
        logger.info("Fixture date applied from Ofsayt.", {
          matchId: doc.id, tournament, home: match.homeTeam, away: match.awayTeam,
          date: date.toISOString()
        });
      } catch (err) {
        logger.warn("Ofsayt date write failed.", { matchId: doc.id, error: String(err) });
      }
    }
  }
  return applied;
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
    applied: 0,
    unmatched: 0,
    error: null,
    details: []
  };
  // Nesine bülteninde bulunamayanlar Ofsayt fikstürüne devredilir.
  const unmatchedDocs = [];

  if (docs.length) {
    let bulletin = null;
    try {
      bulletin = await fetchNesineBulletin();
    } catch (err) {
      // Bülten çekilemezse akış durmaz; tüm maçlar Ofsayt yedeğine düşer.
      logger.warn("Bulletin fetch failed in date sync.", { error: String(err) });
      summary.error = String(err);
    }

    for (const doc of (bulletin ? docs : [])) {
      try {
        const match = doc.data();
        const label = teamLine(match);
        const event = findBulletinEvent(bulletin, match, DATE_SYNC_TOLERANCE_MS);
        const eventTime = event ? nesineEventTime(event) : null;
        if (!eventTime) {
          summary.unmatched++;
          unmatchedDocs.push(doc);
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

    // Bülten hiç çekilemediyse tüm maçlar, çekildiyse yalnızca eşleşmeyenler
    // Ofsayt fikstüründen tamamlanır.
    const fallbackDocs = bulletin ? unmatchedDocs : docs;
    if (!bulletin) summary.unmatched = docs.length;
    summary.applied = await applyOfsaytFixtureDates(fallbackDocs, summary);
    if (summary.applied) summary.error = null;
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
async function fixtureDateSyncWeeklyTask() {
  await proposeFixtureDates("weekly");
}

// Haftalık Ofsayt taraması (salı gecesi). proposeFixtureDates'ten farkı:
// aktif hafta penceresine BAKMAZ — Ofsayt'ta programı açıklanmış TÜM haftaların
// tarihlerini uygular. Ofsayt 2-3 hafta ileriyi yayınladığı için hafta sırası
// geldiğinde tarih zaten yerinde olur; fikstür kapısı görünürlüğü yine tur tur
// yönetir. Yer tutucu (tek-zamanlı) haftalar ofsaytFixtureList'te elenir.
async function ofsaytFixtureSweepTask() {
  const urlMap = await ofsaytFixtureUrlMap();
  if (!Object.values(urlMap).some(Boolean)) {
    logger.info("Ofsayt sweep atlandı: tanımlı fikstür adresi yok.");
    return;
  }

  const snap = await db.collection("matches").where("dateTbd", "==", true).get();
  const docs = snap.docs.filter(doc => !doc.data().finalized);
  if (!docs.length) return;

  const summary = {
    trigger: "ofsayt-weekly",
    checked: docs.length,
    proposed: 0,
    applied: 0,
    unmatched: 0,
    error: null,
    details: []
  };
  summary.applied = await applyOfsaytFixtureDates(docs, summary);
  summary.unmatched = docs.length - summary.applied;
  await writeDateSyncSummary(summary);
  logger.info("Ofsayt fixture sweep completed.", {
    checked: summary.checked, applied: summary.applied
  });
}

// Çarşamba çekilemezse (bülten gecikmesi vb.) 12 saatte bir tekrar dener;
// penceredeki tüm TBD maçların güncel önerisi varsa bülteni hiç çekmez.
async function fixtureDateSyncRetryTask() {
  const docs = await pendingTbdMatches();
  if (!docs.some(doc => needsProposal(doc.data()))) return;
  await proposeFixtureDates("retry");
}

// Haftanın SON maçının sonucu girilince (finalized false -> true) sıradaki hafta
// aktif hale gelir; tarihleri hemen çekilsin diye senkron tetiklenir.
// Nesine'de yoksa Ofsayt fikstüründen doğrudan uygulanır.
exports.syncNextWeekOnFinalize = onDocumentUpdated({
  document: "matches/{matchId}",
  region: REGION
}, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.finalized === true || after.finalized !== true) return;

  const order = roundOrderOf(after);
  if (order == null) return;
  const tournament = tournamentOf(after);

  // Tur gerçekten bitti mi? Ertelenen maçlar hariç sonucu girilmemiş maç kaldıysa
  // bekle (ertelenen maç sonraki turu kilitlemez; hafta bonusu ise onu bekler).
  const rest = await matchesOfRound(tournament, order);
  if (rest.some(m => m.finalized !== true && m.postponed !== true)) return;

  logger.info("Round completed, syncing next round fixture dates.", { tournament, order });
  try {
    await proposeFixtureDates(`round-complete:${tournament}:${order}`);
  } catch (err) {
    logger.warn("Next-round date sync failed.", { tournament, order, error: String(err) });
  }
});

// ================== HAFTA BONUSU ==================
// Bir turun (hafta ya da eleme aşaması) TÜM maçları sonuçlandığında, o turda
// maç sonucunu (1/X/2) doğru bilen sayısına göre ek puan verilir. Kural
// turnuva bazlıdır: settings/app.weekBonus[turnuva] = { enabled, tiers:[{correct,points}] }
// Örn. Süper Lig: 9 doğru → +30, 8 → +20, 7 → +10. Tanımlı olmayan turnuvada bonus yoktur.
//
// Ertelenen maç turu "tamamlanmamış" bırakır: 8/8 bilen bir oyuncunun bonusu,
// ertelenen maç oynanıp sonucu girilene kadar VERİLMEZ; o an tur tamamlanır ve
// bonus 9 maç üzerinden yeniden hesaplanır.
//
// Sonuçlar weekBonus/{turnuva__roundOrder} dokümanında saklanır ve puan farkı
// (yeni - eski) settings/leaderboard toplamlarına increment olarak işlenir —
// böylece sonuç düzeltilirse/temizlenirse bonus da kendiliğinden düzelir.

function weekBonusDocId(tournament, roundOrder) {
  return `${encodeURIComponent(tournament)}__${roundOrder}`;
}

async function weekBonusTiers(tournament) {
  const snap = await db.collection("settings").doc("app").get();
  const all = snap.exists ? snap.data().weekBonus : null;
  const config = all && typeof all === "object" ? all[tournament] : null;
  if (!config || config.enabled === false) return null;
  const tiers = (Array.isArray(config.tiers) ? config.tiers : [])
    .map(tier => ({ correct: Number(tier.correct), points: Number(tier.points) }))
    .filter(tier => Number.isInteger(tier.correct) && tier.correct > 0 && Number.isFinite(tier.points))
    .sort((a, b) => b.correct - a.correct);
  return tiers.length ? tiers : null;
}

function weekBonusPointsFor(correct, tiers) {
  const tier = tiers.find(t => correct >= t.correct);
  return tier ? tier.points : 0;
}

async function evaluateWeekBonus(tournament, roundOrder) {
  const bonusRef = db.collection("weekBonus").doc(weekBonusDocId(tournament, roundOrder));
  const [tiers, prevSnap] = await Promise.all([
    weekBonusTiers(tournament),
    bonusRef.get()
  ]);
  const prevAwards = prevSnap.exists ? (prevSnap.data().awards || {}) : {};
  // Kural yok ve daha önce de verilmiş bonus yok → yapacak bir şey yok.
  if (!tiers && !prevSnap.exists) return null;

  const roundMatches = await matchesOfRound(tournament, roundOrder);
  const complete = roundMatches.length > 0
    && roundMatches.every(m => m.finalized === true && hasResult(m));

  const awards = {};
  if (tiers && complete) {
    // Puanlar dondurulmuş `scoreboard`dan okunur — tahmin koleksiyonuna hiç
    // gidilmez (arşiv okuma maliyeti sıfır).
    const correctCounts = {};
    const names = {};
    roundMatches.forEach(match => {
      const actual = Math.sign(match.homeScore - match.awayScore);
      (Array.isArray(match.scoreboard) ? match.scoreboard : []).forEach(entry => {
        if (!entry || !entry.uid || entry.h == null || entry.a == null) return;
        names[entry.uid] = entry.name || names[entry.uid] || "Oyuncu";
        if (Math.sign(entry.h - entry.a) === actual) {
          correctCounts[entry.uid] = (correctCounts[entry.uid] || 0) + 1;
        }
      });
    });
    Object.entries(correctCounts).forEach(([uid, correct]) => {
      const points = weekBonusPointsFor(correct, tiers);
      if (points) awards[uid] = { name: names[uid] || "Oyuncu", correct, points };
    });
  }

  const delta = {};
  Object.entries(prevAwards).forEach(([uid, award]) => {
    delta[uid] = (delta[uid] || 0) - (Number(award && award.points) || 0);
  });
  Object.entries(awards).forEach(([uid, award]) => {
    delta[uid] = (delta[uid] || 0) + award.points;
  });
  const changedUids = Object.entries(delta).filter(([, d]) => d !== 0);

  const batch = db.batch();
  batch.set(bonusRef, {
    tournament,
    roundOrder,
    roundLabel: roundLabelFromOrder(roundOrder),
    matchCount: roundMatches.length,
    complete,
    awards,                       // merge YOK: kaldırılan kullanıcılar dokümandan da düşer
    updatedAt: FieldValue.serverTimestamp()
  });

  if (changedUids.length) {
    const overall = {};
    const perTournament = {};
    changedUids.forEach(([uid, d]) => {
      overall[uid] = FieldValue.increment(d);
      perTournament[uid] = FieldValue.increment(d);
    });
    batch.set(db.collection("settings").doc("leaderboard"), {
      totals: overall,
      totalsByTournament: { [tournament]: perTournament },
      archiveVersion: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
  await batch.commit();

  if (changedUids.length) {
    logger.info("Week bonus applied.", {
      tournament, roundOrder, complete,
      winners: Object.keys(awards).length,
      changed: changedUids.length
    });
  }
  return { awards, complete };
}

// Bonusu etkileyebilecek bir alan değişti mi? (gereksiz yeniden hesabı önler)
function bonusRelevantChange(before, after) {
  return before.finalized !== after.finalized
    || before.homeScore !== after.homeScore
    || before.awayScore !== after.awayScore
    || roundOrderOf(before) !== roundOrderOf(after)
    || tournamentOf(before) !== tournamentOf(after)
    || JSON.stringify(before.scoreboard || []) !== JSON.stringify(after.scoreboard || []);
}

// Maç yazıldığında (oluştur/güncelle/sil) ilgili tur(lar)ın bonusunu tazeler.
// Yalnızca weekBonus + settings/leaderboard yazar, matches'a dokunmaz → döngü yok.
exports.weekBonusOnMatchWrite = onDocumentWritten({
  document: "matches/{matchId}",
  region: REGION
}, async (event) => {
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after = event.data.after.exists ? event.data.after.data() : null;
  if (before && after && !bonusRelevantChange(before, after)) return;

  // Tur/turnuva değiştiyse hem eski hem yeni kova yeniden hesaplanır.
  const targets = new Map();
  [before, after].forEach(match => {
    if (!match) return;
    const order = roundOrderOf(match);
    if (order == null) return;
    const tournament = tournamentOf(match);
    targets.set(`${tournament}|${order}`, { tournament, order });
  });

  for (const target of targets.values()) {
    try {
      await evaluateWeekBonus(target.tournament, target.order);
    } catch (err) {
      logger.warn("Week bonus evaluation failed.", {
        tournament: target.tournament, order: target.order, error: String(err)
      });
    }
  }
});

// Admin panelindeki "Nesine'den Tarihleri Çek" butonunun ucu
// (nesineHealthCheck ile aynı desen: public onRequest + anında sonuç).
exports.fixtureDateSyncNow = onRequest({
  region: REGION,
  invoker: "public",
  cors: true
}, async (req, res) => {
  try {
    // Önce yakın pencere (Nesine öncelikli), sonra Ofsayt'ta programı açıklanmış
    // TÜM haftaların tam taraması — admin butonu her iki kaynağı da kapsasın.
    const summary = await proposeFixtureDates("manual");
    let sweptApplied = 0;
    try {
      const before = summary.applied || 0;
      await ofsaytFixtureSweepTask();
      const sweepSnap = await db.collection("settings").doc("fixtureSync").get();
      const swept = sweepSnap.exists ? sweepSnap.data() : {};
      sweptApplied = swept.trigger === "ofsayt-weekly" ? (Number(swept.applied) || 0) : 0;
      summary.applied = before + sweptApplied;
    } catch (err) {
      logger.warn("Manual Ofsayt sweep failed.", { error: String(err) });
    }
    res.json({ ok: true, ...summary, sweptApplied });
  } catch (err) {
    logger.warn("Manual fixture date sync failed.", { error: String(err) });
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Admin yeni turnuva eklerken Ofsayt puan durumu sayfasından takım-logo
// eşleşmesini çıkarır. İstemci bu küçük URL haritasını settings/app altında
// saklar; böylece yeni logolar hosting deploy edilmeden görünür.
exports.ofsaytTeamLogos = onRequest({
  region: REGION,
  invoker: "public",
  cors: true,
  timeoutSeconds: 30
}, async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "POST gerekli." });
      return;
    }
    await requireAdminRequest(req);
    const logos = {};
    const rawUrl = String((req.body && req.body.url) || "").trim();
    const teamNames = Array.from(new Set(
      (Array.isArray(req.body && req.body.teamNames) ? req.body.teamNames : [])
        .map(name => String(name || "").trim())
        .filter(Boolean)
    )).slice(0, 80);
    if (!rawUrl && !teamNames.length) throw new Error("Turnuva adresi veya takım adları gerekli.");

    if (rawUrl) {
      const url = validateOfsaytUrl(rawUrl);
      const response = await fetch(url, {
        headers: {
          "Accept": "text/html,*/*",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        }
      });
      if (!response.ok) throw new Error(`Ofsayt HTTP ${response.status}`);
      Object.assign(logos, logosFromOfsaytPage(await response.text()));
    }

    // URL verilmeyen kupa/karma turnuvalarda veya sayfada eksik kalan
    // takımlarda Ofsayt'ın futbol takım aramasıyla ad bazlı tamamla.
    for (let i = 0; i < teamNames.length; i += 5) {
      const chunk = teamNames.slice(i, i + 5);
      const found = await Promise.all(chunk.map(async teamName => ({
        teamName,
        logo: await findOfsaytTeamLogo(teamName)
      })));
      for (const item of found) {
        const slug = teamLogoSlug(item.teamName);
        if (slug && item.logo) logos[slug] = item.logo;
      }
    }
    const count = Object.keys(logos).length;
    if (!count) throw new Error("Takım logosu bulunamadı.");
    res.json({ ok: true, count, logos });
  } catch (err) {
    logger.warn("Ofsayt logo sync failed.", { error: String(err) });
    const authError = /Oturum|Admin/.test(String(err && err.message));
    res.status(authError ? 403 : 400).json({ ok: false, error: err.message || String(err) });
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

async function autoFetchScoresTask() {
  const report = await sweepPendingScores();
  if (report.length) logger.info("Score sweep completed.", { report });
}

// ================== TEK SCHEDULER JOB (MALİYET) ==================
// Cloud Scheduler faturalama hesabı başına yalnızca 3 job ücretsiz; sonrası
// job başına ~$0.10/ay. Bu yüzden dört ayrı zamanlanmış iş, 30 dakikada bir
// koşan TEK bir job'ın içinde kendi periyotlarına göre tetikleniyor.
const SCHEDULER_STATE_DOC = "schedulerState";

// Her görevin en son ne zaman koştuğunu settings/schedulerState altında tutar.
async function runIfDue(state, key, minIntervalMs, task) {
  const last = state[key];
  const lastMs = last && last.toMillis ? last.toMillis() : 0;
  // Job her 30 dk'da bir tetiklendiği için tetikleme jitter'ı periyodu
  // kaydırmasın diye 1 dakikalık tolerans bırakıyoruz.
  if (Date.now() - lastMs < minIntervalMs - 60 * 1000) return false;
  await task();
  await db.collection("settings").doc(SCHEDULER_STATE_DOC)
    .set({ [key]: FieldValue.serverTimestamp() }, { merge: true });
  return true;
}

// "her <gün> <saat>:00" karşılığı: İstanbul saatiyle o güne/saate ulaşıldıktan
// sonraki ilk tetiklemede koşar, o hafta bir daha koşmaz. (Ana job 30 dakikada
// bir tetiklendiği için koşu, hedef saatten en fazla ~30 dk sonra gerçekleşir.)
function isWeeklySlotFor(state, stateKey, weekday, hour) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const today = parts.find(p => p.type === "weekday").value;
  const nowHour = Number(parts.find(p => p.type === "hour").value);
  if (today !== weekday || nowHour < hour) return false;
  const last = state[stateKey];
  const lastMs = last && last.toMillis ? last.toMillis() : 0;
  return Date.now() - lastMs > 6 * 24 * 60 * 60 * 1000;
}

exports.scheduledTasks = onSchedule({
  region: REGION,
  schedule: "every 30 minutes",
  timeZone: TIME_ZONE,
  timeoutSeconds: 540
}, async () => {
  const snap = await db.collection("settings").doc(SCHEDULER_STATE_DOC).get();
  const state = snap.exists ? snap.data() : {};

  // Bir görevin hatası diğerlerini engellemesin.
  const tasks = [
    ["autoFetchScores", 30 * 60 * 1000, autoFetchScoresTask],
    ["retryMissingOdds", 4 * 60 * 60 * 1000, retryMissingOddsTask],
    ["fixtureDateSyncRetry", 12 * 60 * 60 * 1000, fixtureDateSyncRetryTask]
  ];
  for (const [key, intervalMs, task] of tasks) {
    try {
      await runIfDue(state, key, intervalMs, task);
    } catch (err) {
      logger.error("Scheduled task failed.", { task: key, error: String(err) });
    }
  }

  // Haftalık slotlar: salı 00:00 Ofsayt taraması (Ofsayt haftanın programını
  // hafta başında yayınlıyor), çarşamba 12:00 Nesine ana koşusu.
  const weeklySlots = [
    ["ofsaytFixtureSweep", "Tue", 0, ofsaytFixtureSweepTask],
    ["fixtureDateSyncWeekly", "Wed", 12, fixtureDateSyncWeeklyTask]
  ];
  for (const [key, weekday, hour, task] of weeklySlots) {
    if (!isWeeklySlotFor(state, key, weekday, hour)) continue;
    try {
      await task();
      await db.collection("settings").doc(SCHEDULER_STATE_DOC)
        .set({ [key]: FieldValue.serverTimestamp() }, { merge: true });
    } catch (err) {
      logger.error("Scheduled task failed.", { task: key, error: String(err) });
    }
  }
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
