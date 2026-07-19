    if (window.Capacitor?.isNativePlatform?.()) {
      document.documentElement.classList.add('native-app');
    }

    // ================== FIREBASE CONFIG ==================
    const firebaseConfig = {
      apiKey: "AIzaSyBMp64COG3svS1KbIXZ3YOYefNbvsL4gCU",
      authDomain: "aefy-lig.firebaseapp.com",
      projectId: "aefy-lig",
      storageBucket: "aefy-lig.firebasestorage.app",
      messagingSenderId: "1092591602529",
      appId: "1:1092591602529:web:7560f2bd0748d81b191320"
    };

    // Initialize Firebase
    firebase.initializeApp(firebaseConfig);
    const auth = firebase.auth();
    const db = firebase.firestore();

    // ================== ADMIN EMAIL ==================
    const ADMIN_EMAIL = "admin@aefy-lig.com";

    // ================== TOURNAMENTS / ETİKETLER ==================
    // Maçlar bir turnuva etiketiyle işaretlenir (World Cup 2026, Süper Lig, vb.).
    // Etiketsiz eski maçlar varsayılan olarak DEFAULT_TOURNAMENT sayılır.
    const DEFAULT_TOURNAMENT = "World Cup 2026";
    const ALL_TOURNAMENTS = "__ALL__";   // filtrelerde "Tümü" değeri
    // Yeni maç eklerken seçilen etiket (toplu + tekli ekleme bunu kullanır)
    let selectedTournament = DEFAULT_TOURNAMENT;
    // Filtre durumları (UI)
    let fixtureTournamentFilter = ALL_TOURNAMENTS;
    let archiveTournamentFilter = null; // will be set to admin's defaultTournament when settings load / archive opened
    let archiveWeekFilter = null;       // null = tarih görünümü; sayı = o haftanın maçları (hafta görünümü)
    let leaderboardTournamentFilter = ALL_TOURNAMENTS;
    let scoreFrequencySortUid = null; // null = toplam, otherwise user uid

    // ================== GLOBAL STATE ==================
    let currentUser = null;
    let currentUserProfile = null;
    let isAdmin = false;
    let matches = [];
    let allPredictions = [];
    let usersMap = {};
    let allowedEmails = [];
    let pendingMatches = [];
    let pushListenersRegistered = false;
    let currentPushToken = null;

    let unsubscribeMatches = null;
    let unsubscribePredictions = null;
    let unsubscribeUsers = null;
    let unsubscribeSettings = null;
    let unsubscribeLeaderboard = null;

    // ----- Sezon bonus tahminleri -----
    let bonusConfigs = [];               // bonus/{docId} config dokümanları
    let bonusTotalsByTournament = {};    // settings/bonus.byTournament: { turnuva: { uid: puan } }
    let unsubscribeBonus = null;
    let unsubscribeBonusTotals = null;
    const bonusPicksCache = {};          // cfgId -> { unsub, docs: null|[] } (arşiv sabiti + admin puanlama)
    const bonusMyPicks = {};             // cfgId -> kendi tahmin dokümanı | null (banner için tek okuma)
    const bonusMyPickLoading = {};

    // ----- Read-optimization state -----
    // Optimized mode is active once the aggregate leaderboard document exists
    // (created by the admin "Yeniden Hesapla" migration). Before that we fall back
    // to the original behaviour (load every match + prediction) so nothing breaks.
    let optimizedMode = false;
    let leaderboardTotals = {};          // { uid: totalPoints } from settings/leaderboard
    let leaderboardTotalsByTournament = {}; // { tournament: { uid: totalPoints } } from settings/leaderboard
    let tournaments = [DEFAULT_TOURNAMENT]; // bilinen etiket listesi (settings/app.tournaments)
    let inactiveTournaments = [];        // yeni maç seçicisinde gösterilmeyen etiketler
    let defaultTournament = DEFAULT_TOURNAMENT; // adminin yeni maçlar için seçtiği kalıcı varsayılan
    let tournamentSettingsInitialized = false;
    let activePredUnsubs = [];           // chunked predictions listeners (optimized mode)
    let activePredChunks = {};           // chunkIndex -> { matchId: predDoc } partial store
    let activePredKey = '';              // signature of the currently-subscribed active match id set
    const PRED_IN_LIMIT = 30;            // Firestore "in" query cap

    // Canlı (sonucu beklenen) maçlar için ileri tarih penceresi.
    // Tüm sezon fikstürü (örn. 34 hafta × 9 maç ≈ 300 maç) baştan girilse bile,
    // her açılışta yalnızca bugünden itibaren bu kadar gün ilerideki maçlar + onların
    // tahminleri okunur. Skor girilen geçmiş maçlar finalized:true olup arşive düşer
    // ve canlı dinleyiciden çıkar; böylece okuma maliyeti haftalık fikstürle sınırlı kalır.
    const ACTIVE_MATCH_WINDOW_DAYS = 9;  // ~1 maç haftası + tampon (istersen değiştir)

    // Archive pagination state (optimized mode, user-facing + admin)
    const ARCHIVE_PAGE_SIZE = 20;
    let archiveDocs = [];                // accumulated finalized match docs (mapped)
    let archiveCursor = null;            // last Firestore doc snapshot for startAfter
    let archiveHasMore = true;
    let archiveLoading = false;
    let archiveDayGroups = [];           // user archive day headers, built without rendering every match
    let archiveDayDocs = {};             // dayKey -> loaded finalized matches for that day
    let archiveDayLoading = {};          // dayKey -> boolean
    let archiveOpenDays = new Set();     // dayKey values opened by the user
    let archiveDaysIndexLoaded = false;
    let archiveDaysIndexLoading = false;
    let archiveUsesDayIndex = false;
    let archiveDayIndexMissing = false;

    // Puan Detayı (göz simgesi) modalı için: tüm finalized maçları bir kez yükleyip
    // önbelleğe alırız ki detay toplamı, sayfalı arşivden bağımsız olarak puan
    // durumundaki birikmiş toplamla (aggregate) birebir aynı olsun.
    let breakdownArchiveDocs = null;     // null = henüz yüklenmedi; [] = yüklendi (boş olabilir)
    let breakdownArchiveLoading = false;

    // Arşiv önbelleği (localStorage): tam finalized listesi cihaz başına 1 kez okunur,
    // sonrasında yalnızca finalizedAt > son senkron olan maçlar (delta) çekilir.
    // archiveEpoch: sonuç temizleme / maç silme / yeniden hesaplama gibi "arşivden
    // çıkarma" işlemlerinde artar → epoch uyuşmazsa önbellek atılır, tam okuma yapılır.
    // v2: v1 could contain auto-finalized matches created without `finalizedAt`.
    // A one-time cache refresh loads those existing matches, then deltas stay cheap.
    const ARCHIVE_CACHE_KEY = 'skorTahminArchiveCache_v2';
    let archiveEpoch = 0;                    // settings/leaderboard.archiveEpoch (0 = hiç bump edilmedi)
    let breakdownArchiveMaxFAms = 0;         // önbellekteki en büyük finalizedAt (ms)
    let archiveDeltaSyncing = false;
    let archiveDeltaQueued = false;          // senkron sürerken yeni istek geldi mi?

    function serializeArchiveDoc(m) {
      return {
        id: m.id,
        tournament: m.tournament,
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        homeScore: m.homeScore != null ? m.homeScore : null,
        awayScore: m.awayScore != null ? m.awayScore : null,
        outcomePoints: m.outcomePoints != null ? m.outcomePoints : null,
        scorePoints: m.scorePoints != null ? m.scorePoints : null,
        scoreboard: Array.isArray(m.scoreboard) ? m.scoreboard : [],
        dt: m.datetime ? m.datetime.getTime() : null,
        fa: matchFinalizedAtMs(m),
        wk: m.week != null ? m.week : null
      };
    }

    function hydrateArchiveDoc(s) {
      return {
        id: s.id,
        tournament: s.tournament,
        homeTeam: s.homeTeam,
        awayTeam: s.awayTeam,
        homeScore: s.homeScore,
        awayScore: s.awayScore,
        outcomePoints: s.outcomePoints,
        scorePoints: s.scorePoints,
        scoreboard: s.scoreboard || [],
        finalized: true,
        datetime: s.dt != null ? new Date(s.dt) : null,
        finalizedAtMs: s.fa || 0,
        week: s.wk != null ? s.wk : null
      };
    }

    function matchFinalizedAtMs(m) {
      if (m.finalizedAtMs) return m.finalizedAtMs;
      const fa = m.finalizedAt;
      if (fa && typeof fa.toMillis === 'function') return fa.toMillis();
      return 0;
    }

    function loadArchiveCache() {
      try {
        const raw = localStorage.getItem(ARCHIVE_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.docs)) return null;
        return parsed;
      } catch (e) { return null; }
    }

    function saveArchiveCache() {
      if (!Array.isArray(breakdownArchiveDocs)) return;
      try {
        localStorage.setItem(ARCHIVE_CACHE_KEY, JSON.stringify({
          epoch: archiveEpoch,
          maxFA: breakdownArchiveMaxFAms,
          docs: breakdownArchiveDocs.map(serializeArchiveDoc)
        }));
      } catch (e) {
        // Kota dolarsa önbelleksiz devam (yalnızca oturum içi bellek kullanılır).
        try { localStorage.removeItem(ARCHIVE_CACHE_KEY); } catch (e2) {}
      }
    }

    // Admin future fixtures: independent from the 9-day live listener and loaded
    // only on demand so a full-season fixture does not increase normal page reads.
    const FUTURE_FIXTURE_PAGE_SIZE = 20;
    let futureFixtureDocs = [];
    let futureFixtureCursor = null;
    let futureFixtureHasMore = true;
    let futureFixtureLoading = false;
    let futureFixtureLoaded = false;
    let futureFixtureError = '';
    let futureFixtureWindowStart = null;

    // Yeni girişlerin varsayılanı takvim yılıdır. Yönetici seçimini cihazında
    // değiştirebilir; Firestore'daki datetime alanı seçilen yılı taşır.
    const DEFAULT_YEAR = new Date().getFullYear();
    const MATCH_YEAR_PREFERENCE_KEY = 'skorTahminDefaultMatchYear';
    const UPCOMING_WINDOW_MS = 4 * 24 * 60 * 60 * 1000; // next 4 days
    const PREDICTION_CUTOFF_MS = 15 * 60 * 1000;

    function isValidMatchYear(year) {
      return Number.isInteger(year) && year >= 2000 && year <= 2100;
    }

    function preferredMatchYear() {
      try {
        const savedYear = Number(localStorage.getItem(MATCH_YEAR_PREFERENCE_KEY));
        return isValidMatchYear(savedYear) ? savedYear : DEFAULT_YEAR;
      } catch (e) {
        return DEFAULT_YEAR;
      }
    }

    function setPreferredMatchYear(value) {
      const year = Number(value);
      if (!isValidMatchYear(year)) return;
      try { localStorage.setItem(MATCH_YEAR_PREFERENCE_KEY, String(year)); } catch (e) {}
      ['bulk-year', 'add-year'].forEach(id => {
        const select = document.getElementById(id);
        if (select) select.value = String(year);
      });
    }

    function initMatchYearSelectors() {
      const selectedYear = preferredMatchYear();
      const years = [...new Set([DEFAULT_YEAR - 1, DEFAULT_YEAR, DEFAULT_YEAR + 1, DEFAULT_YEAR + 2, selectedYear])]
        .filter(isValidMatchYear)
        .sort((a, b) => a - b);

      ['bulk-year', 'add-year'].forEach(id => {
        const select = document.getElementById(id);
        if (!select) return;
        select.innerHTML = years.map(year => `<option value="${year}">${year}</option>`).join('');
        select.value = String(selectedYear);
        select.addEventListener('change', () => setPreferredMatchYear(select.value));
      });
    }

    function isNativeAndroidApp() {
      return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    }

    function getPushNotificationsPlugin() {
      return window.Capacitor?.Plugins?.PushNotifications || null;
    }

    function pushTokenDocId(token) {
      return encodeURIComponent(token);
    }

    async function savePushToken(token) {
      if (!currentUser || !token) return;
      currentPushToken = token;
      await db.collection('notificationTokens').doc(pushTokenDocId(token)).set({
        token,
        uid: currentUser.uid,
        email: currentUser.email,
        platform: 'android',
        appId: 'com.aefylig.skortahmin',
        enabled: true,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    async function initPushNotifications() {
      const PushNotifications = getPushNotificationsPlugin();
      if (!isNativeAndroidApp() || !PushNotifications || !currentUser) return;

      try {
        if (!pushListenersRegistered) {
          PushNotifications.addListener('registration', token => {
            savePushToken(token.value).catch(err => console.warn('Push token kaydedilemedi:', err));
          });
          PushNotifications.addListener('registrationError', err => {
            console.warn('Push registration error:', err);
          });
          PushNotifications.addListener('pushNotificationActionPerformed', () => {
            if (currentUser) switchView('matches');
          });
          pushListenersRegistered = true;
        }

        if (PushNotifications.createChannel) {
          await PushNotifications.createChannel({
            id: 'matches',
            name: 'Mac Bildirimleri',
            description: 'Mac hatirlatmalari, skor ve admin bildirimleri',
            importance: 5,
            visibility: 1,
            sound: 'default'
          });
        }

        let permission = await PushNotifications.checkPermissions();
        if (permission.receive !== 'granted') {
          permission = await PushNotifications.requestPermissions();
        }
        if (permission.receive !== 'granted') {
          console.warn('Bildirim izni verilmedi.');
          return;
        }

        await PushNotifications.register();
      } catch (err) {
        console.warn('Push bildirimleri başlatılamadı:', err);
      }
    }

    // A match is "archived/past" once its kickoff time has passed.
    function isPastMatch(match) {
      return !!match.datetime && match.datetime.getTime() < Date.now();
    }

    // Main page shows only matches in the next 4 days (undated matches stay visible).
    function isUpcomingMatch(match) {
      if (!match.datetime) return true;
      const t = match.datetime.getTime();
      const now = Date.now();
      return t >= now && t <= now + UPCOMING_WINDOW_MS;
    }

    // Played / in-progress matches whose result (and therefore points) hasn't been
    // entered yet. These sit between the live fixture and the archive: kickoff has
    // passed but the admin hasn't finalised a score. In optimized mode `matches`
    // only ever holds finalized==false docs, so this also covers them in legacy mode.
    function isPendingResultMatch(match) {
      const hasResult = match.homeScore != null && match.awayScore != null;
      return isPastMatch(match) && !hasResult && !match.finalized;
    }

    function escapeHTML(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
      })[char]);
    }

    // Auto-scoring based on the two per-match values the admin sets:
    //   match.outcomePoints  -> awarded for predicting the correct winner/draw
    //   match.scorePoints    -> awarded (in full / half) for getting the exact score / off-by-one
    // Returns null when the match has no result yet.
    function autoPointsFor(pred, match, matchPreds) {
      if (!match || !pred) return null;
      const ah = match.homeScore, aa = match.awayScore;
      if (ah == null || aa == null) return null; // no result yet

      const op = match.outcomePoints != null ? Number(match.outcomePoints) : 0;
      const sp = match.scorePoints != null ? Number(match.scorePoints) : 0;

      const ph = pred.homePred, pa = pred.awayPred;
      const predOutcome = Math.sign(ph - pa);
      const actOutcome = Math.sign(ah - aa);

      if (predOutcome !== actOutcome) return 0;        // wrong winner/draw → nothing

      // Predictions for THIS match (for "exact exists" check + lone-correct bonus).
      // Callers may pass the list explicitly (e.g. when finalising an archived match
      // whose predictions are no longer kept in memory).
      const preds = matchPreds || allPredictions.filter(q => q.matchId === match.id);

      const diff = Math.abs(ph - ah) + Math.abs(pa - aa);
      // Closest non-exact prediction that still counts as "yaklaşma":
      //   • decisive result → off by a single goal in total (diff === 1)
      //   • draw            → off by one goal on EACH side (diff === 2),
      //     e.g. predicted 0-0 and the match ended 1-1, or 2-2 vs 1-1.
      const approxDiff = (actOutcome === 0) ? 2 : 1;

      // The outcome (winner/draw) is always correct here, so the outcome points are
      // ALWAYS earned; the score / half-score is added on top of them.
      let pts;
      if (diff === 0) {
        pts = op + sp;                                 // exact score → outcome + full score
      } else if (diff === approxDiff) {
        // No half-point if someone already nailed the exact score for this match.
        const someoneExact = preds.some(q => q.homePred === ah && q.awayPred === aa);
        pts = someoneExact ? op : (op + sp / 2);       // yaklaşma → outcome + half score (unless exact exists)
      } else {
        pts = op;                                      // outcome only
      }

      // Lone-correct bonus: if only one player in the group got the outcome right, +3.
      const correctOutcomeCount = preds.filter(q =>
        Math.sign(q.homePred - q.awayPred) === actOutcome).length;
      if (correctOutcomeCount === 1) pts += 3;

      return pts;
    }

    // Points may be fractional; show them cleanly (e.g. 1, 1.5, 2.25).
    function formatPoints(n) {
      if (n == null || isNaN(n)) return '0';
      return Number.isInteger(n) ? String(n) : String(parseFloat(Number(n).toFixed(2)));
    }

    function predictionPointParts(homePred, awayPred, match, matchPreds) {
      if (!match || homePred == null || awayPred == null) return null;
      const ah = match.homeScore, aa = match.awayScore;
      if (ah == null || aa == null) return null;

      const op = match.outcomePoints != null ? Number(match.outcomePoints) : 0;
      const sp = match.scorePoints != null ? Number(match.scorePoints) : 0;
      const ph = Number(homePred), pa = Number(awayPred);
      const predOutcome = Math.sign(ph - pa);
      const actOutcome = Math.sign(ah - aa);
      const parts = {
        kind: 'miss',
        outcomeHit: false,
        exactHit: false,
        approxHit: false,
        approxAwarded: false,
        approxBlocked: false,
        outcomePoints: 0,
        exactPoints: 0,
        approxPoints: 0,
        approxBlockedPoints: 0,
        bonusPoints: 0,
        totalPoints: 0
      };

      if (predOutcome !== actOutcome) return parts;

      const preds = Array.isArray(matchPreds) ? matchPreds : allPredictions.filter(q => q.matchId === match.id);
      const diff = Math.abs(ph - ah) + Math.abs(pa - aa);
      const approxDiff = (actOutcome === 0) ? 2 : 1;
      const someoneExact = preds.some(q => Number(q.homePred) === ah && Number(q.awayPred) === aa);
      const correctOutcomeCount = preds.filter(q =>
        Math.sign(Number(q.homePred) - Number(q.awayPred)) === actOutcome).length;

      parts.outcomeHit = true;
      parts.outcomePoints = op;

      if (diff === 0) {
        parts.kind = 'exact';
        parts.exactHit = true;
        parts.exactPoints = sp;
      } else if (diff === approxDiff) {
        parts.kind = 'approx';
        parts.approxHit = true;
        parts.approxAwarded = !someoneExact;
        parts.approxBlocked = someoneExact;
        parts.approxPoints = someoneExact ? 0 : sp / 2;
        parts.approxBlockedPoints = someoneExact ? sp / 2 : 0;
      } else {
        parts.kind = 'outcome';
      }

      if (correctOutcomeCount === 1) parts.bonusPoints = 3;
      parts.totalPoints = parts.outcomePoints + parts.exactPoints + parts.approxPoints + parts.bonusPoints;
      return parts;
    }

    // Freeze a finalised match's points + picks so the archive can be rendered (and the
    // leaderboard aggregated) without ever re-reading the prediction documents.
    function computeScoreboard(match, preds) {
      const scoreboard = preds.map(p => {
        const profile = usersMap[p.uid] || {};
        return {
          uid: p.uid,
          name: profile.displayName || profile.email || 'Oyuncu',
          h: p.homePred,
          a: p.awayPred,
          pts: autoPointsFor(p, match, preds) || 0
        };
      }).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'tr'));

      const totalsByUid = {};
      scoreboard.forEach(s => { totalsByUid[s.uid] = (totalsByUid[s.uid] || 0) + s.pts; });
      return { scoreboard, totalsByUid };
    }

    function parseDateTime(dateStr, timeStr, fallbackYear = DEFAULT_YEAR) {
      const dateParts = String(dateStr || '').match(/\d{1,4}/g) || [];
      const day = parseInt(dateParts[0], 10);
      const month = parseInt(dateParts[1], 10);
      const year = dateParts[2] ? parseInt(dateParts[2], 10) : Number(fallbackYear);
      const [hour, minute] = String(timeStr || '').split(':').map(x => parseInt(x, 10));
      if (!day || !month || !Number.isInteger(year) || year < 2000 || year > 2100 ||
          isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
      const dt = new Date(year, month - 1, day, hour, minute);
      // Date constructor taşan değerleri otomatik düzelttiği için gerçek bir tarih
      // olduğunu ayrıca doğrula (ör. 31.02.2027 kabul edilmesin).
      return dt.getFullYear() === year && dt.getMonth() === month - 1 && dt.getDate() === day ? dt : null;
    }

    function formatDateInput(date) {
      if (!date) return '';
      return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
    }

    function formatMatchTime(date) {
      if (!date) return "??";
      const d = date.getDate().toString().padStart(2, '0');
      const m = (date.getMonth() + 1).toString().padStart(2, '0');
      const h = date.getHours().toString().padStart(2, '0');
      const mi = date.getMinutes().toString().padStart(2, '0');
      return `${d}.${m}.${date.getFullYear()} ${h}:${mi}`;
    }

    function formatDayHeading(date) {
      if (!date) return 'Tarih belirtilmedi';
      return date.toLocaleDateString('tr-TR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        weekday: 'long'
      });
    }

    function getDayKey(date) {
      if (!date) return 'unknown';
      return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    }

    function canPredict(matchDate) {
      if (!matchDate) return false;
      const cutoff = new Date(matchDate.getTime() - PREDICTION_CUTOFF_MS);
      return new Date() < cutoff;
    }

    function predictionCutoffTime(match) {
      if (!match || !match.datetime) return null;
      return new Date(match.datetime.getTime() - PREDICTION_CUTOFF_MS);
    }

    function formatCountdown(ms) {
      if (!isFinite(ms) || ms <= 0) return '00:00';
      const totalSeconds = Math.floor(ms / 1000);
      const days = Math.floor(totalSeconds / 86400);
      const hours = Math.floor((totalSeconds % 86400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const pad = value => String(value).padStart(2, '0');
      if (days > 0) return `${days}g ${pad(hours)}s`;
      if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
      return `${pad(minutes)}:${pad(seconds)}`;
    }

    function nextVisibleMatches() {
      let list = matches
        .filter(match => match.datetime && !isPendingResultMatch(match))
        .filter(match => match.homeScore == null || match.awayScore == null)
        .filter(match => match.datetime.getTime() >= Date.now());
      if (fixtureTournamentFilter !== ALL_TOURNAMENTS) {
        list = list.filter(match => tournamentOf(match) === fixtureTournamentFilter);
      }
      return list.sort((a, b) => (a.datetime?.getTime() || 0) - (b.datetime?.getTime() || 0));
    }

    function showToast(message, type = 'success') {
      const container = document.getElementById('toast-container');
      const el = document.createElement('div');
      
      el.className = `toast toast-${type}`;
      el.innerHTML = `
        <div class="toast-content">${message}</div>
        <button onclick="this.parentNode.remove()" class="toast-close">×</button>
      `;
      container.appendChild(el);
      setTimeout(() => {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }, 4200);
    }

    // ================== AUTH ==================
    function switchAuthTab(tab) {
      const loginForm = document.getElementById('login-form');
      const signupForm = document.getElementById('signup-form');
      const tabLogin = document.getElementById('tab-login');
      const tabSignup = document.getElementById('tab-signup');

      if (tab === 'login') {
        loginForm.classList.remove('hidden');
        signupForm.classList.add('hidden');
        tabLogin.classList.add('active');
        tabSignup.classList.remove('active');
      } else {
        signupForm.classList.remove('hidden');
        loginForm.classList.add('hidden');
        tabSignup.classList.add('active');
        tabLogin.classList.remove('active');
      }
    }

    async function handleLogin() {
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;

      if (!email || !password) {
        showToast('E-posta ve şifre girin.', 'error');
        return;
      }

      try {
        await auth.signInWithEmailAndPassword(email, password);
      } catch (err) {
        console.error(err);
        let msg = 'Giriş başarısız.';
        if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password') {
          msg = 'E-posta veya şifre hatalı.';
        } else if (err.code === 'auth/invalid-email') {
          msg = 'Geçersiz e-posta.';
        }
        showToast(msg, 'error');
      }
    }

    async function handleSignup() {
      const email = document.getElementById('signup-email').value.trim();
      const password = document.getElementById('signup-password').value;
      const displayName = document.getElementById('signup-name').value.trim();

      if (!email || !password) {
        showToast('E-posta ve şifre zorunlu.', 'error');
        return;
      }
      if (password.length < 6) {
        showToast('Şifre en az 6 karakter olmalı.', 'error');
        return;
      }

      try {
        let allowed = [];
        let isFirstEver = true;

        try {
          const settingsSnap = await db.collection('settings').doc('app').get();
          const settingsData = settingsSnap.exists ? settingsSnap.data() : {};
          allowed = settingsData.allowedEmails || [];

          const usersSnapshot = await db.collection('users').limit(1).get();
          isFirstEver = usersSnapshot.empty;
        } catch (readErr) {
          console.warn('Whitelist check skipped due to read error:', readErr);
          isFirstEver = true;
          allowed = [];
        }

        if (!isFirstEver && allowed.length > 0 && !allowed.includes(email)) {
          showToast('Bu e-posta adresi admin tarafından eklenmemiş.', 'error');
          return;
        }

        const cred = await auth.createUserWithEmailAndPassword(email, password);
        const user = cred.user;
        const isFirstUser = email === ADMIN_EMAIL;

        // Create profile
        await db.collection('users').doc(user.uid).set({
          email: email,
          displayName: displayName || email.split('@')[0],
          isAdmin: isFirstUser,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        // Seed whitelist if first admin
        if (isFirstUser) {
          await db.collection('settings').doc('app').set({
            allowedEmails: firebase.firestore.FieldValue.arrayUnion(email)
          }, { merge: true });
        }

        showToast('Hesap oluşturuldu! Hoş geldin.', 'success');
      } catch (err) {
        console.error(err);
        let msg = 'Kayıt başarısız.';
        if (err.code === 'auth/email-already-in-use') {
          msg = 'Bu e-posta zaten kayıtlı.';
        } else if (err.code === 'auth/invalid-email') {
          msg = 'Geçersiz e-posta adresi.';
        } else if (err.code === 'auth/weak-password') {
          msg = 'Şifre çok zayıf.';
        }
        showToast(msg, 'error');
      }
    }

    async function logout() {
      try {
        await auth.signOut();
      } catch (e) {}
      location.reload();
    }

    // ================== DATA LISTENERS ==================
    function mapMatchDoc(doc) {
      const data = doc.data();
      let dt = data.datetime;
      if (dt && dt.toDate) dt = dt.toDate();
      else if (typeof dt === 'string') dt = new Date(dt);
      const tournament = (data.tournament && String(data.tournament).trim()) || DEFAULT_TOURNAMENT;
      return { id: doc.id, ...data, tournament, datetime: dt };
    }

    function mapPredDoc(doc) {
      const d = doc.data();
      return { id: doc.id, uid: d.uid, matchId: d.matchId, homePred: d.homePred, awayPred: d.awayPred };
    }

    // ================== İDDAA ORANLARI (NESINE) ==================
    // Oranlar Cloud Function tarafından match.odds alanına yazılır:
    // { ms: {"1":3.20,"X":2.57,"2":2.03}, score: {"2-1":11.6,...,"diger":75} }
    // Sabitler functions/scoreModel.js ile ayni tutulmali (ofsayt.com arsivi
    // 669 macla kalibre, bkz. functions/scripts/calibrate-score-model.js).
    const SCORE_EST_RHO = -0.0669;
    const SCORE_EST_B = 0.9713;
    const SCORE_EST_C = 0.6936;
    const SCORE_EST_SINGLE_CAP = 200;
    const SCORE_EST_MAXG = 12;
    const SCORE_EST_KEY_CORR = {
      "1-0": 0.952, "2-0": 1.019, "2-1": 1.012, "3-0": 1.006, "3-1": 1, "3-2": 1.003,
      "4-0": 0.988, "4-1": 0.988, "4-2": 0.996, "5-0": 0.985, "5-1": 1.001, "6-0": 1.073,
      "0-0": 1.038, "1-1": 1.011, "2-2": 0.927, "3-3": 0.934,
      "0-1": 0.942, "0-2": 1.047, "1-2": 1.024, "0-3": 1.047, "1-3": 1.028, "2-3": 1.017,
      "0-4": 1.007, "1-4": 0.996, "2-4": 0.983, "0-5": 1.006, "1-5": 1.014
    };

    function scorePoissonPmf(k, lambda) {
      let p = Math.exp(-lambda);
      for (let i = 1; i <= k; i++) p *= lambda / i;
      return p;
    }

    function scoreDcTau(h, a, lh, la, rho) {
      if (h === 0 && a === 0) return 1 - lh * la * rho;
      if (h === 0 && a === 1) return 1 + lh * rho;
      if (h === 1 && a === 0) return 1 + la * rho;
      if (h === 1 && a === 1) return 1 - rho;
      return 1;
    }

    function scoreEstMatrix(lh, la) {
      const m = [];
      let total = 0;
      for (let h = 0; h <= SCORE_EST_MAXG; h++) {
        m[h] = [];
        for (let a = 0; a <= SCORE_EST_MAXG; a++) {
          const p = Math.max(0, scorePoissonPmf(h, lh) * scorePoissonPmf(a, la) * scoreDcTau(h, a, lh, la, SCORE_EST_RHO));
          m[h][a] = p;
          total += p;
        }
      }
      for (let h = 0; h <= SCORE_EST_MAXG; h++) {
        for (let a = 0; a <= SCORE_EST_MAXG; a++) m[h][a] /= total;
      }
      return m;
    }

    function scoreEstOutcomeProbs(m) {
      let ph = 0;
      let pd = 0;
      for (let h = 0; h <= SCORE_EST_MAXG; h++) {
        for (let a = 0; a <= SCORE_EST_MAXG; a++) {
          if (h > a) ph += m[h][a];
          else if (h === a) pd += m[h][a];
        }
      }
      return { ph, pd };
    }

    function scoreFitLambdas(pH, pD) {
      let mu = 2.6;
      let d = Math.log((pH + 0.25) / (1 - pH - pD + 0.25));
      for (let iter = 0; iter < 80; iter++) {
        const expD = Math.exp(d);
        const lh = mu * expD / (expD + 1);
        const la = mu - lh;
        const { ph, pd } = scoreEstOutcomeProbs(scoreEstMatrix(lh, la));
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

    function scoreEstOddFromProb(p, corr) {
      if (!(p > 0)) return SCORE_EST_SINGLE_CAP;
      const est = SCORE_EST_C * Math.pow(1 / p, SCORE_EST_B) * (corr || 1);
      return Math.round(Math.max(1.01, est) * 100) / 100;
    }

    function estimateSingleScoreOddClient(msOdds, h, a) {
      const oh = Number(msOdds && msOdds['1']);
      const od = Number(msOdds && msOdds['X']);
      const oa = Number(msOdds && msOdds['2']);
      if (!(oh > 1 && od > 1 && oa > 1)) return null;
      if (h > SCORE_EST_MAXG || a > SCORE_EST_MAXG) return SCORE_EST_SINGLE_CAP;
      const ih = 1 / oh;
      const id = 1 / od;
      const ia = 1 / oa;
      const sum = ih + id + ia;
      const { lh, la } = scoreFitLambdas(ih / sum, id / sum);
      const matrix = scoreEstMatrix(lh, la);
      return Math.min(SCORE_EST_SINGLE_CAP, scoreEstOddFromProb(matrix[h][a], SCORE_EST_KEY_CORR[`${h}-${a}`]));
    }

    function scoreOddFor(match, h, a) {
      const odds = match && match.odds;
      const s = odds && odds.score;
      if (!s) return null;
      const v = s[`${h}-${a}`];
      if (typeof v === 'number') return v;
      return estimateSingleScoreOddClient(odds.ms, h, a);
    }

    // Skor marketi Nesine'de yoksa oranlar 1X2'den tahmin edilir; "~" ile gösterilir.
    function formatScoreOdd(match, odd) {
      if (odd == null) return '';
      const approx = match && match.odds && match.odds.scoreEstimated ? '~' : '';
      return approx + odd.toFixed(2);
    }

    function msOddsStrip(match) {
      const ms = match && match.odds && match.odds.ms;
      if (!ms || typeof ms['1'] !== 'number') return '';
      return `
        <div class="odds-strip">
          <span class="odds-strip-label">İddaa Oranları</span>
          <span class="odds-chip"><span class="odds-chip-key">1</span><b>${ms['1'].toFixed(2)}</b></span>
          <span class="odds-chip"><span class="odds-chip-key">X</span><b>${ms['X'].toFixed(2)}</b></span>
          <span class="odds-chip"><span class="odds-chip-key">2</span><b>${ms['2'].toFixed(2)}</b></span>
        </div>
      `;
    }

    // Skor girilirken canlı "bu skorun oranı" ipucu.
    function updateOddsHint(matchId) {
      const el = document.getElementById(`odds-hint-${matchId}`);
      if (!el) return;
      const match = matches.find(m => m.id === matchId);
      const h = parseInt(document.getElementById(`pred-h-${matchId}`)?.value);
      const a = parseInt(document.getElementById(`pred-a-${matchId}`)?.value);
      if (!match || isNaN(h) || isNaN(a) || h < 0 || a < 0) {
        el.textContent = '';
        return;
      }
      const odd = scoreOddFor(match, h, a);
      el.textContent = odd ? `${h}-${a} skorunun iddaa oranı: ${formatScoreOdd(match, odd)}` : '';
    }

    function renderAll() {
      renderMatches();
      renderBonusEntryBanner();
      renderArchive();
      renderLeaderboard();
      if (isAdmin && !document.getElementById('view-admin').classList.contains('hidden')) {
        renderAdminMatches();
      }
    }

    // ================== TURNUVA / ETİKET YARDIMCILARI ==================
    function tournamentOf(match) {
      return (match && match.tournament && String(match.tournament).trim()) || DEFAULT_TOURNAMENT;
    }

    // Bilinen etiketler + maçlarda fiilen geçen etiketleri birleştirir.
    function knownTournaments() {
      const set = new Set([DEFAULT_TOURNAMENT, ...tournaments]);
      matches.forEach(m => set.add(tournamentOf(m)));
      archiveDocs.forEach(m => set.add(tournamentOf(m)));
      Object.keys(leaderboardTotalsByTournament || {}).forEach(t => set.add(t));
      bonusConfigs.forEach(c => { if (c.tournament) set.add(c.tournament); });
      Object.keys(bonusTotalsByTournament || {}).forEach(t => set.add(t));
      return Array.from(set);
    }

    function activeTournaments() {
      const inactive = new Set(inactiveTournaments);
      return knownTournaments().filter(t => !inactive.has(t));
    }

    // Bir maç kartı için turnuva rozeti HTML'i (aksan noktası CSS ::before ile gelir)
    function tournamentBadge(match) {
      const t = tournamentOf(match);
      return `<span class="tournament-badge">${escapeHTML(t)}</span>`;
    }

    // Tüm turnuva <select> ve filtre menülerini güncel listeyle doldurur.
    function refreshTournamentUI() {
      const all = knownTournaments();
      const active = activeTournaments();

      if (!active.includes(selectedTournament)) {
        selectedTournament = active.includes(defaultTournament) ? defaultTournament : (active[0] || '');
      }

      // Fixture filtresi sadece aktif kullanmalı; pasif seçiliyse Tüm'e çek
      if (fixtureTournamentFilter !== ALL_TOURNAMENTS && !active.includes(fixtureTournamentFilter)) {
        fixtureTournamentFilter = ALL_TOURNAMENTS;
      }

      // Admin "yeni maç ekle" etiket seçici
      const addSel = document.getElementById('add-tournament');
      if (addSel) {
        addSel.innerHTML = active.map(t =>
          `<option value="${escapeHTML(t)}" ${t === selectedTournament ? 'selected' : ''}>${escapeHTML(t)}${t === defaultTournament ? ' (Varsayılan)' : ''}</option>`
        ).join('');
        addSel.disabled = active.length === 0;
      }

      // Filtre menüleri ("Tümü" + her turnuva)
      // fixture için sadece aktif turnuvalar (pasif olanlar ana Maçlar görünümünde kalabalık yapmasın)
      // archive + leaderboard için hepsi (geçmiş turnuvaları arşivde/puanlarda görebilmek için)
      const fillFilter = (id, current, useActiveOnly = false) => {
        const sel = document.getElementById(id);
        if (!sel) return;
        const list = useActiveOnly ? active : all;
        const opts = [`<option value="${ALL_TOURNAMENTS}" ${current === ALL_TOURNAMENTS ? 'selected' : ''}>Tüm Turnuvalar</option>`]
          .concat(list.map(t => `<option value="${escapeHTML(t)}" ${t === current ? 'selected' : ''}>${escapeHTML(t)}</option>`));
        sel.innerHTML = opts.join('');
      };
      fillFilter('fixture-tournament-filter', fixtureTournamentFilter, true);
      fillFilter('archive-tournament-filter', archiveTournamentFilter, false);
      fillFilter('leaderboard-tournament-filter', leaderboardTournamentFilter, false);
      renderTournamentManager();
      renderArchiveTournamentTabs();
    }

    function renderTournamentManager() {
      const container = document.getElementById('tournament-manager-list');
      if (!container) return;
      const inactive = new Set(inactiveTournaments);
      const sorted = knownTournaments().slice().sort((a, b) => {
        const ia = inactive.has(a) ? 1 : 0;
        const ib = inactive.has(b) ? 1 : 0;
        if (ia !== ib) return ia - ib; // aktifler önce
        if (a === defaultTournament) return -1;
        if (b === defaultTournament) return 1;
        return a.localeCompare(b, 'tr');
      });
      container.innerHTML = sorted.map(t => {
        const isInactive = inactive.has(t);
        const isDefault = t === defaultTournament;
        const status = isInactive ? 'Pasif (arşive kalktı)' : (isDefault ? 'Aktif • Varsayılan' : 'Aktif');
        const statusClass = isInactive ? 'is-inactive' : (isDefault ? 'is-default' : '');
        return `
          <div class="tournament-manager-row">
            <div class="tournament-manager-info">
              <span class="tournament-manager-name">${escapeHTML(t)}</span>
              <span class="tournament-manager-status ${statusClass}">${status}</span>
            </div>
            <div class="tournament-manager-actions">
              ${!isInactive && !isDefault ? `<button type="button" class="btn btn-secondary js-default-tournament" data-tournament="${escapeHTML(t)}">Varsayılan Yap</button>` : ''}
              <button type="button" class="btn btn-secondary js-toggle-tournament" data-tournament="${escapeHTML(t)}">${isInactive ? 'Aktif Et' : 'Pasife Al'}</button>
            </div>
          </div>`;
      }).join('');

      container.querySelectorAll('.js-default-tournament').forEach(button => {
        button.addEventListener('click', () => setDefaultTournamentTag(button.dataset.tournament));
      });
      container.querySelectorAll('.js-toggle-tournament').forEach(button => {
        button.addEventListener('click', () => toggleTournamentTag(button.dataset.tournament));
      });
    }

    function onSelectAddTournament(value) { selectedTournament = value; }

    function onFixtureFilterChange(value) {
      fixtureTournamentFilter = value;
      renderMatches();
    }
    function onArchiveFilterChange(value) {
      archiveTournamentFilter = value;
      archiveWeekFilter = null;
      archiveDayGroups = [];
      archiveDayDocs = {};
      archiveDayLoading = {};
      archiveOpenDays = new Set();
      archiveDaysIndexLoaded = false;
      archiveUsesDayIndex = false;
      archiveDayIndexMissing = false;
      renderArchiveTournamentTabs();
      renderArchive();
      if (optimizedMode) loadArchiveDayIndex();
    }

    // Render the prominent tournament tabs shown above dates in Arşiv.
    // User clicks a tournament tab FIRST, then dates for that tournament appear.
    function renderArchiveTournamentTabs() {
      const container = document.getElementById('archive-tournament-tabs');
      if (!container) return;

      const all = knownTournaments();
      const current = archiveTournamentFilter;

      let html = '';

      // "Tümü" first
      const isAll = current === ALL_TOURNAMENTS;
      html += `<button type="button" class="tournament-tab ${isAll ? 'active' : ''}" onclick="selectArchiveTournament('${ALL_TOURNAMENTS}')">Tüm Turnuvalar</button>`;

      const inactiveSet = new Set(inactiveTournaments);
      all.forEach(t => {
        const isActive = t === current;
        const isDef = t === defaultTournament;
        const isInactive = inactiveSet.has(t);
        const safe = String(t).replace(/'/g, "\\'");
        const label = escapeHTML(t) + (isDef ? ' (Varsayılan)' : '');
        const cls = `tournament-tab ${isActive ? 'active' : ''} ${isInactive ? 'inactive' : ''}`;
        const title = isInactive ? 'Pasif turnuva — Arşiv ve geçmiş için saklandı' : '';
        html += `<button type="button" class="${cls}" ${title ? `title="${title}"` : ''} onclick="selectArchiveTournament('${safe}')">${label}</button>`;
      });

      container.innerHTML = html;
    }

    function selectArchiveTournament(value) {
      if (archiveTournamentFilter === value) return;

      archiveTournamentFilter = value;
      archiveWeekFilter = null;

      // Reset day state (same as filter change)
      archiveDayGroups = [];
      archiveDayDocs = {};
      archiveDayLoading = {};
      archiveOpenDays = new Set();
      archiveDaysIndexLoaded = false;
      archiveUsesDayIndex = false;
      archiveDayIndexMissing = false;

      // Keep the old select in sync (if present)
      const sel = document.getElementById('archive-tournament-filter');
      if (sel) sel.value = value;

      renderArchiveTournamentTabs();
      renderArchive();
      if (optimizedMode) loadArchiveDayIndex();
    }

    function onLeaderboardFilterChange(value) { leaderboardTournamentFilter = value; renderLeaderboard(); }

    async function setDefaultTournamentTag(name) {
      if (!isAdmin || !name) return;
      if (inactiveTournaments.includes(name)) {
        showToast('Önce etiketi aktif hale getirin.', 'warning');
        return;
      }
      try {
        const previousDefault = defaultTournament;
        await db.collection('settings').doc('app').set({ defaultTournament: name }, { merge: true });
        defaultTournament = name;
        selectedTournament = name;
        refreshTournamentUI();

        // Arşiv açıksa ve eski varsayılanı izliyorsa yeni varsayılana geç
        if (currentView === 'archive') {
          if (archiveTournamentFilter === previousDefault || archiveTournamentFilter == null) {
            archiveTournamentFilter = name;
          }
          renderArchiveTournamentTabs();
          renderArchive();
        }
        showToast(`"${name}" varsayılan etiket yapıldı.`, 'success');
      } catch (e) {
        console.error(e);
        showToast('Varsayılan etiket değiştirilemedi.', 'error');
      }
    }

    async function toggleTournamentTag(name) {
      if (!isAdmin || !name) return;
      const isInactive = inactiveTournaments.includes(name);
      if (!isInactive && name === defaultTournament) {
        showToast('Varsayılan etiketi pasife almadan önce başka bir etiketi varsayılan yapın.', 'warning');
        return;
      }
      if (!isInactive && activeTournaments().length <= 1) {
        showToast('En az bir aktif etiket bulunmalı.', 'warning');
        return;
      }
      try {
        await db.collection('settings').doc('app').set({
          inactiveTournaments: isInactive
            ? firebase.firestore.FieldValue.arrayRemove(name)
            : firebase.firestore.FieldValue.arrayUnion(name)
        }, { merge: true });
        inactiveTournaments = isInactive
          ? inactiveTournaments.filter(t => t !== name)
          : Array.from(new Set([...inactiveTournaments, name]));
        refreshTournamentUI();
        showToast(`"${name}" etiketi ${isInactive ? 'aktif edildi' : 'pasife alındı'}.`, 'success');
      } catch (e) {
        console.error(e);
        showToast('Etiket durumu değiştirilemedi.', 'error');
      }
    }

    // Admin: yeni turnuva etiketi ekle
    async function addTournamentTag() {
      const name = prompt('Yeni turnuva / etiket adı (örn. Süper Lig, Şampiyonlar Ligi):');
      if (name == null) return;
      const clean = name.trim();
      if (!clean) { showToast('Etiket adı boş olamaz.', 'warning'); return; }
      if (knownTournaments().some(t => t.toLocaleLowerCase('tr-TR') === clean.toLocaleLowerCase('tr-TR'))) {
        showToast('Bu etiket zaten var.', 'warning');
        // Yine de seçili yap
        selectedTournament = knownTournaments().find(t => t.toLocaleLowerCase('tr-TR') === clean.toLocaleLowerCase('tr-TR')) || clean;
        refreshTournamentUI();
        return;
      }
      try {
        await db.collection('settings').doc('app').set({
          tournaments: firebase.firestore.FieldValue.arrayUnion(clean)
        }, { merge: true });
        selectedTournament = clean;
        // onSnapshot listesi tazeleyecek; yine de anında UI için ekle
        if (!tournaments.includes(clean)) tournaments.push(clean);
        refreshTournamentUI();
        showToast(`"${clean}" etiketi eklendi.`, 'success');
      } catch (e) {
        console.error(e);
        showToast('Etiket eklenemedi.', 'error');
      }
    }

    async function listenToData() {
      // Decide the mode once per session: optimized iff the aggregate doc exists.
      try {
        const aggSnap = await db.collection('settings').doc('leaderboard').get();
        optimizedMode = aggSnap.exists;
        archiveEpoch = aggSnap.exists ? (aggSnap.data().archiveEpoch || 0) : 0;
      } catch (e) {
        console.warn('Leaderboard aggregate read failed; using legacy mode.', e);
        optimizedMode = false;
      }

      // Users + app settings listeners are identical in both modes (small collections).
      if (unsubscribeUsers) unsubscribeUsers();
      unsubscribeUsers = db.collection('users').onSnapshot(snapshot => {
        usersMap = {};
        snapshot.docs.forEach(doc => { usersMap[doc.id] = { uid: doc.id, ...doc.data() }; });
        renderAll();
        if (isAdmin) renderAdminUsers();
        if (currentView === 'museum') renderMuseum();
      }, err => console.error(err));

      if (unsubscribeSettings) unsubscribeSettings();
      unsubscribeSettings = db.collection('settings').doc('app').onSnapshot(doc => {
        const data = doc.exists ? doc.data() : {};
        allowedEmails = data.allowedEmails || [];
        const list = Array.isArray(data.tournaments) ? data.tournaments.filter(Boolean) : [];
        inactiveTournaments = Array.isArray(data.inactiveTournaments) ? data.inactiveTournaments.filter(Boolean) : [];
        // DEFAULT_TOURNAMENT her zaman listede bulunsun
        tournaments = Array.from(new Set([DEFAULT_TOURNAMENT, ...list]));
        const configuredDefault = data.defaultTournament && String(data.defaultTournament).trim();
        const active = activeTournaments();
        defaultTournament = configuredDefault && active.includes(configuredDefault)
          ? configuredDefault
          : (active.includes(DEFAULT_TOURNAMENT) ? DEFAULT_TOURNAMENT : (active[0] || DEFAULT_TOURNAMENT));
        if (!tournamentSettingsInitialized || !active.includes(selectedTournament)) {
          selectedTournament = defaultTournament;
        }

        // Archive varsayılanı: admin'in seçtiği defaultTournament gelsin (pasif olmayan)
        // Kullanıcı "Tüm" veya başka birini elle seçmişse bozma.
        if (archiveTournamentFilter == null || archiveTournamentFilter === DEFAULT_TOURNAMENT) {
          archiveTournamentFilter = defaultTournament;
        }

        tournamentSettingsInitialized = true;
        refreshTournamentUI();
        if (isAdmin) renderWhitelist();
      });

      // --- Sezon bonus tahminleri (küçük koleksiyon + tek toplam dokümanı; her iki modda da) ---
      if (unsubscribeBonus) unsubscribeBonus();
      unsubscribeBonus = db.collection('bonus').onSnapshot(snap => {
        bonusConfigs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderBonusEntryBanner();
        if (currentView === 'archive') renderBonusArchivePinned();
        if (isAdmin) renderAdminBonus();
        refreshTournamentUI();
      }, err => console.error(err));

      if (unsubscribeBonusTotals) unsubscribeBonusTotals();
      unsubscribeBonusTotals = db.collection('settings').doc('bonus').onSnapshot(doc => {
        bonusTotalsByTournament = (doc.exists && doc.data().byTournament) || {};
        renderLeaderboard();
        if (currentView === 'archive') renderBonusArchivePinned();
      }, err => console.error(err));

      if (optimizedMode) {
        // --- Aggregate leaderboard (1 doc) ---
        if (unsubscribeLeaderboard) unsubscribeLeaderboard();
        unsubscribeLeaderboard = db.collection('settings').doc('leaderboard').onSnapshot(doc => {
          const data = doc.exists ? doc.data() : {};
          leaderboardTotals = data.totals || {};
          leaderboardTotalsByTournament = data.totalsByTournament || {};
          // Aggregate değişti → bir sonuç finalize edilmiş ya da düzenlenmiş olabilir.
          // Epoch değiştiyse (sonuç temizleme / silme / recompute) önbellek geçersiz:
          // tam okuma gerekir. Değişmediyse yalnızca yeni finalize olan maçlar (delta)
          // çekilir — arşivin tamamı bir daha OKUNMAZ.
          const newEpoch = data.archiveEpoch || 0;
          if (newEpoch !== archiveEpoch) {
            archiveEpoch = newEpoch;
            breakdownArchiveDocs = null;
            breakdownArchiveMaxFAms = 0;
            try { localStorage.removeItem(ARCHIVE_CACHE_KEY); } catch (e) {}
          } else if (Array.isArray(breakdownArchiveDocs)) {
            syncArchiveDelta();
          }
          renderLeaderboard();
        }, err => console.error(err));

        // --- Only NON-finalized matches WITHIN the forward window stay on a live listener ---
        // Far-future fixtures (gelecek haftalar) okunmaz; pencereye girdikçe / sayfa
        // yenilendikçe yüklenirler. Geçmişte skoru girilmemiş maçlar (datetime < now)
        // pencerenin altında kaldığı için dahil olur; admin skoru girince finalized olur.
        const activeWindowEnd = new Date();
        activeWindowEnd.setDate(activeWindowEnd.getDate() + ACTIVE_MATCH_WINDOW_DAYS);
        if (unsubscribeMatches) unsubscribeMatches();
        unsubscribeMatches = db.collection('matches')
          .where('finalized', '==', false)
          .where('datetime', '<', firebase.firestore.Timestamp.fromDate(activeWindowEnd))
          .orderBy('datetime', 'desc')
          .onSnapshot(snapshot => {
            matches = snapshot.docs.map(mapMatchDoc)
              .sort((a, b) => (a.datetime?.getTime() || 0) - (b.datetime?.getTime() || 0));
            subscribeActivePredictions(matches.map(m => m.id));
            renderAll();
          }, err => console.error(err));
        // Archive is fetched on demand (paginated); seed the first page lazily.
        resetArchivePaging();
      } else {
        // --- Legacy mode: load everything (original behaviour) ---
        if (unsubscribeMatches) unsubscribeMatches();
        unsubscribeMatches = db.collection('matches').orderBy('datetime').onSnapshot(snapshot => {
          matches = snapshot.docs.map(mapMatchDoc);
          renderAll();
        }, err => console.error(err));

        if (unsubscribePredictions) unsubscribePredictions();
        unsubscribePredictions = db.collection('predictions').onSnapshot(snapshot => {
          allPredictions = snapshot.docs.map(mapPredDoc);
          renderAll();
        }, err => console.error(err));
      }
    }

    // In optimized mode, predictions are loaded only for the active (non-finalized)
    // matches, via chunked "matchId in [...]" listeners that re-subscribe when the set changes.
    function subscribeActivePredictions(matchIds) {
      const key = matchIds.slice().sort().join(',');
      if (key === activePredKey) return; // unchanged → keep existing listeners
      activePredKey = key;

      activePredUnsubs.forEach(fn => { try { fn(); } catch (e) {} });
      activePredUnsubs = [];
      activePredChunks = {};

      if (!matchIds.length) { allPredictions = []; renderAll(); return; }

      for (let i = 0; i < matchIds.length; i += PRED_IN_LIMIT) {
        const chunk = matchIds.slice(i, i + PRED_IN_LIMIT);
        const chunkIdx = i / PRED_IN_LIMIT;
        const unsub = db.collection('predictions').where('matchId', 'in', chunk).onSnapshot(snap => {
          const store = {};
          snap.docs.forEach(d => { store[d.id] = mapPredDoc(d); });
          activePredChunks[chunkIdx] = store;
          allPredictions = Object.values(activePredChunks).flatMap(s => Object.values(s));
          renderAll();
        }, err => console.error(err));
        activePredUnsubs.push(unsub);
      }
    }

    function stopActivePredictions() {
      activePredUnsubs.forEach(fn => { try { fn(); } catch (e) {} });
      activePredUnsubs = [];
      activePredChunks = {};
      activePredKey = '';
    }

    function stopListeners() {
      if (unsubscribeMatches) unsubscribeMatches();
      if (unsubscribePredictions) unsubscribePredictions();
      if (unsubscribeUsers) unsubscribeUsers();
      if (unsubscribeSettings) unsubscribeSettings();
      if (unsubscribeLeaderboard) unsubscribeLeaderboard();
      if (unsubscribeBonus) unsubscribeBonus();
      if (unsubscribeBonusTotals) unsubscribeBonusTotals();
      Object.keys(bonusPicksCache).forEach(key => {
        try { bonusPicksCache[key].unsub && bonusPicksCache[key].unsub(); } catch (e) {}
        delete bonusPicksCache[key];
      });
      Object.keys(bonusMyPicks).forEach(key => delete bonusMyPicks[key]);
      Object.keys(bonusMyPickLoading).forEach(key => delete bonusMyPickLoading[key]);
      stopActivePredictions();
    }

    async function refreshAllData() {
      renderMatches();
      renderLeaderboard();
      if (isAdmin) {
        renderAdminMatches();
        renderAdminUsers();
        renderWhitelist();
      }
      // Re-pull the archive's first page (picks up newly finalised matches).
      if (optimizedMode) {
        resetArchivePaging();
        if (isAdmin) renderAdminArchive();
      } else {
        renderArchive();
      }
    }

    // ================== RENDER LOGIC ==================
    function getPredictionsForMatch(matchId) {
      return allPredictions
        .filter(prediction => prediction.matchId === matchId)
        .map(prediction => {
          const profile = usersMap[prediction.uid] || {};
          return {
            ...prediction,
            displayName: profile.displayName || profile.email || 'Oyuncu'
          };
        })
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'tr'));
    }

    function renderFriendsPicks(matchId, compact = false) {
      const predictions = getPredictionsForMatch(matchId);
      const match = matches.find(m => m.id === matchId);

      if (!predictions.length) {
        return `<div class="no-picks-text">Henüz kimse tahmin yapmadı.</div>`;
      }

      const visible = compact ? predictions.slice(0, 4) : predictions;
      const picks = visible.map(prediction => {
        const pts = autoPointsFor(prediction, match);
        let ptsClass = '';
        let ptsBadge = '';
        if (pts != null) {
          const exact = prediction.homePred === match.homeScore && prediction.awayPred === match.awayScore;
          if (exact) ptsClass = 'correct';
          else if (pts > 0) ptsClass = 'correct-outcome';
          ptsBadge = `<span class="pick-pts ${pts === 0 ? 'zero' : ''}">+${formatPoints(pts)}</span>`;
        }

        const odd = scoreOddFor(match, prediction.homePred, prediction.awayPred);
        return `
          <span class="friend-pick-badge ${ptsClass}">
            <span class="friend-avatar" aria-hidden="true">${escapeHTML(String(prediction.displayName || '?').trim().charAt(0).toLocaleUpperCase('tr-TR'))}</span>
            <span>${escapeHTML(prediction.displayName)}</span>
            <strong>${prediction.homePred}-${prediction.awayPred}</strong>
            ${odd ? `<em class="pick-odd">${formatScoreOdd(match, odd)}</em>` : ''}
            ${ptsBadge}
          </span>
        `;
      }).join('');

      const remaining = compact && predictions.length > visible.length
        ? `<span class="friend-pick-badge">+${predictions.length - visible.length} kişi</span>`
        : '';

      return `<div class="friends-picks-container">${picks}${remaining}</div>`;
    }

    function teamMonogram(teamName) {
      return String(teamName || '?')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 3)
        .map(word => word.charAt(0))
        .join('')
        .toLocaleUpperCase('tr-TR');
    }

    // Slug üretimi functions/scripts/ofsayt-fixture-crawl.js teamLogoSlug() ile birebir aynı.
    function teamLogoSlug(teamName) {
      return String(teamName || '')
        .toLocaleLowerCase('tr-TR')
        .replace(/ı/g, 'i')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    }

    // Logo varsa (assets/teams/<slug>.png) monogramın üzerine biner; 404'te
    // img kendini kaldırır ve monogram görünür kalır.
    function teamMark(teamName) {
      const slug = teamLogoSlug(teamName);
      const img = slug
        ? `<img class="team-logo-img" src="assets/teams/${slug}.png" alt="" loading="lazy" onerror="this.remove()">`
        : '';
      return `<span class="team-mark" aria-hidden="true">${escapeHTML(teamMonogram(teamName))}${img}</span>`;
    }

    // Uzun takım adlarında yazıyı kademeli küçültür (satır atlamaz, taşmaz).
    function teamNameSpan(teamName) {
      const name = String(teamName || '').trim();
      const sizeClass = name.length > 18 ? ' name-xlong' : name.length > 11 ? ' name-long' : '';
      return `<span class="team-name-text${sizeClass}">${escapeHTML(name)}</span>`;
    }

    function renderMatches() {
      const container = document.getElementById('matches-list');
      const noMatches = document.getElementById('no-matches');
      container.innerHTML = '';

      // Closed-but-not-scored matches get their own collapsible section.
      renderPendingResults();

      // Only the next 4 days are shown here; older matches live in the Archive.
      let upcomingMatches = matches.filter(isUpcomingMatch);
      if (fixtureTournamentFilter !== ALL_TOURNAMENTS) {
        upcomingMatches = upcomingMatches.filter(m => tournamentOf(m) === fixtureTournamentFilter);
      }

      if (!upcomingMatches.length) {
        noMatches.classList.remove('hidden');
        document.getElementById('matches-count').textContent = '';
        const desc = noMatches.querySelector('.no-data-desc');
        if (desc) {
          desc.textContent = matches.length
            ? 'Önümüzdeki 4 günde maç yok. Geçmiş maçlar Arşiv sekmesinde.'
            : 'Admin maç ekleyene kadar lütfen bekleyin.';
        }
        return;
      }
      noMatches.classList.add('hidden');
      document.getElementById('matches-count').textContent = `${upcomingMatches.length}`;

      const userPreds = Object.fromEntries(
        allPredictions
          .filter(prediction => prediction.uid === currentUser.uid)
          .map(prediction => [prediction.matchId, prediction])
      );

      const groupedMatches = new Map();
      upcomingMatches.forEach(match => {
        // Tarihi resmileşmemiş (dateTbd) maçlar gün yerine hafta başlığı altında
        // toplanır; yer tutucu tarihi gün başlığı olarak göstermek yanıltıcı olur.
        const key = match.dateTbd
          ? `tbd|${tournamentOf(match)}|${match.week || '?'}`
          : getDayKey(match.datetime);
        if (!groupedMatches.has(key)) groupedMatches.set(key, []);
        groupedMatches.get(key).push(match);
      });

      groupedMatches.forEach(dayMatches => {
        const first = dayMatches[0];
        const heading = first.dateTbd
          ? (first.week ? `${first.week}. Hafta • Gün ve saat açıklanmadı` : 'Gün ve saat açıklanmadı')
          : formatDayHeading(first.datetime);
        const section = document.createElement('section');
        section.className = 'day-group';
        section.innerHTML = `
          <div class="day-heading">${escapeHTML(heading)}<span class="day-count">${dayMatches.length} Maç</span></div>
          <div class="matches-grid"></div>
        `;
        const grid = section.querySelector('.matches-grid');

        dayMatches.forEach(match => {
          const matchDate = match.datetime;
          const formatted = match.dateTbd
            ? '🗓 Tarih açıklanmadı'
            : matchDate
              ? matchDate.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
              : '??:??';
          const open = canPredict(matchDate);
          const hasResult = match.homeScore != null && match.awayScore != null;
          const myPred = userPreds[match.id];
          
          let statusBadgeText = '';
          let statusClass = '';
          if (hasResult) {
            statusBadgeText = 'Tamamlandı';
            statusClass = 'status-completed';
          } else if (open) {
            statusBadgeText = 'Tahmine Açık';
            statusClass = 'status-open';
          } else {
            statusBadgeText = 'Süre Doldu';
            statusClass = 'status-closed';
          }

          // Horizontal (side-by-side) teams row builder
          const teamsRow = (homeCell, awayCell, caption = '') => `
            <div class="match-teams-row">
              <div class="team-side team-side-home">
                ${teamNameSpan(match.homeTeam)}
                ${teamMark(match.homeTeam)}
              </div>
              <div class="score-center">
                <div class="score-row">
                  ${homeCell}
                  <span class="score-sep">:</span>
                  ${awayCell}
                </div>
                ${caption ? `<span class="score-caption">${caption}</span>` : ''}
              </div>
              <div class="team-side team-side-away">
                ${teamMark(match.awayTeam)}
                ${teamNameSpan(match.awayTeam)}
              </div>
            </div>
          `;

          let teamsHTML = '';
          let actionHTML = '';
          let oddsHTML = '';

          if (hasResult) {
            const pts = myPred ? autoPointsFor(myPred, match) : null;
            const myOdd = myPred ? scoreOddFor(match, myPred.homePred, myPred.awayPred) : null;

            teamsHTML = teamsRow(
              `<div class="actual-score-badge">${match.homeScore}</div>`,
              `<div class="actual-score-badge">${match.awayScore}</div>`,
              'Maç Sonucu'
            );

            actionHTML = `
              <div class="result-banner-completed">
                <div class="locked-label">
                  <span class="locked-eyebrow">MAÇ SONUCU</span>
                  <span class="locked-subtitle">${myPred ? `Tahminin: ${myPred.homePred} - ${myPred.awayPred}${myOdd ? ` (oran ${formatScoreOdd(match, myOdd)})` : ''}` : 'Tahmin yapmadın'}</span>
                </div>
                ${myPred ? `
                  <div class="result-points-earned ${!pts ? 'zero' : ''}">
                    ${pts == null ? 'Puan bekleniyor' : `+${formatPoints(pts)} Puan`}
                  </div>
                ` : ''}
              </div>
            `;
          } else if (myPred) {
            const myOdd = scoreOddFor(match, myPred.homePred, myPred.awayPred);

            teamsHTML = teamsRow(
              `<div class="actual-score-badge pred-highlight">${myPred.homePred}</div>`,
              `<div class="actual-score-badge pred-highlight">${myPred.awayPred}</div>`,
              'Senin Tahminin'
            );

            oddsHTML = msOddsStrip(match);
            actionHTML = `
              <div class="prediction-locked-banner">
                <span class="lock-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="4" y="10" width="16" height="11" rx="2.5" stroke="#E6B24A" stroke-width="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="#E6B24A" stroke-width="2"></path></svg></span>
                <div class="locked-label">
                  <span class="locked-eyebrow">TAHMİNİN KİLİTLENDİ</span>
                  <span class="locked-subtitle">${myOdd ? 'Bu skorun iddaa oranı' : 'Tahminler sonradan değiştirilemez'}</span>
                </div>
                ${myOdd ? `<span class="locked-odd">${formatScoreOdd(match, myOdd)}</span>` : ''}
              </div>
            `;
          } else if (open) {
            teamsHTML = teamsRow(
              `<input id="pred-h-${match.id}" type="number" inputmode="numeric" min="0" max="20" placeholder="0" class="score-number-input" oninput="updateOddsHint('${match.id}')">`,
              `<input id="pred-a-${match.id}" type="number" inputmode="numeric" min="0" max="20" placeholder="0" class="score-number-input" oninput="updateOddsHint('${match.id}')">`
            );

            oddsHTML = msOddsStrip(match);
            actionHTML = `
              <div class="odds-hint" id="odds-hint-${match.id}"></div>
              <button onclick="submitPrediction('${match.id}')" class="btn-lock">
                TAHMİNİ KİLİTLE 🔒
              </button>
            `;
          } else {
            teamsHTML = teamsRow(
              `<div class="actual-score-badge text-muted">-</div>`,
              `<div class="actual-score-badge text-muted">-</div>`
            );

            actionHTML = `
              <div class="prediction-locked-banner closed">
                <div class="locked-label">
                  <span class="locked-eyebrow">SÜRE DOLDU</span>
                  <span class="locked-subtitle">Maç tahminine süre kapandı</span>
                </div>
                <span class="lock-icon">⏳</span>
              </div>
            `;
          }

          // Friend picks are only visible after the user predicts (or match is closed/completed)
          const canSeeFriends = !!myPred || hasResult || !open;
          const friendsBlock = canSeeFriends
            ? renderFriendsPicks(match.id, true)
            : `<div class="friend-locked-hint">🔒 Kendi tahminini yaptıktan sonra görünür.</div>`;

          const card = document.createElement('article');
          card.className = 'match-card';
          card.innerHTML = `
            <div class="match-card-main">
              <div class="match-header">
                <div class="match-status-badge ${statusClass}">${statusBadgeText}</div>
                <div class="match-time">${formatted}</div>
                ${match.postponed ? `<div class="match-status-badge status-closed">Ertelendi</div>` : ''}
                ${match.week && !match.dateTbd ? `<div class="match-week-pill">${match.week}. Hafta</div>` : ''}
                <div class="match-tournament-label">${tournamentBadge(match)}</div>
              </div>

              <div class="match-teams-container">
                ${teamsHTML}
              </div>
              <div class="match-card-bottom">
                ${actionHTML}
              </div>
            </div>

            <div class="prediction-section match-card-panel">
              ${oddsHTML}
              <div class="friends-panel">
                <div class="friend-picks-title">Arkadaş Tahminleri<span class="friend-picks-count">${getPredictionsForMatch(match.id).length}</span></div>
                ${friendsBlock}
              </div>
            </div>
          `;
          grid.appendChild(card);
        });

        container.appendChild(section);
      });
    }

    // Tracks whether the user opened the "henüz skoru girilmemiş maçlar" panel.
    let pendingResultsOpen = false;

    function renderPendingResults() {
      const card = document.getElementById('pending-results-card');
      const list = document.getElementById('pending-results-list');
      const countEl = document.getElementById('pending-results-count');
      const caret = document.getElementById('pending-results-caret');
      const body = document.getElementById('pending-results-body');
      if (!card || !list) return;

      let pending = matches.filter(isPendingResultMatch);
      if (fixtureTournamentFilter !== ALL_TOURNAMENTS) {
        pending = pending.filter(m => tournamentOf(m) === fixtureTournamentFilter);
      }
      // Most recent kickoff first.
      pending.sort((a, b) => (b.datetime?.getTime() || 0) - (a.datetime?.getTime() || 0));

      if (!pending.length) {
        card.classList.add('hidden');
        return;
      }
      card.classList.remove('hidden');
      if (countEl) countEl.textContent = `${pending.length}`;

      // Keep the open/closed state in sync (default closed).
      if (body) body.classList.toggle('hidden', !pendingResultsOpen);
      if (caret) caret.style.transform = pendingResultsOpen ? 'rotate(90deg)' : 'rotate(0deg)';

      const groupedMatches = new Map();
      pending.forEach(match => {
        const key = getDayKey(match.datetime);
        if (!groupedMatches.has(key)) groupedMatches.set(key, []);
        groupedMatches.get(key).push(match);
      });

      list.innerHTML = '';
      groupedMatches.forEach(dayMatches => {
        const section = document.createElement('section');
        section.className = 'day-group';
        section.innerHTML = `
          <div class="day-heading">${escapeHTML(formatDayHeading(dayMatches[0].datetime))}</div>
          <div class="matches-grid"></div>
        `;
        const grid = section.querySelector('.matches-grid');

        dayMatches.forEach(match => {
          const formatted = match.datetime
            ? match.datetime.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
            : '??:??';

          const teamsHTML = `
            <div class="match-teams-row">
              <div class="team-side team-side-home">
                ${teamNameSpan(match.homeTeam)}
                ${teamMark(match.homeTeam)}
              </div>
              <div class="score-center">
                <div class="score-row">
                  <div class="actual-score-badge text-muted">?</div>
                  <span class="score-sep">:</span>
                  <div class="actual-score-badge text-muted">?</div>
                </div>
              </div>
              <div class="team-side team-side-away">
                ${teamMark(match.awayTeam)}
                ${teamNameSpan(match.awayTeam)}
              </div>
            </div>
          `;

          const card = document.createElement('article');
          card.className = 'match-card';
          card.innerHTML = `
            <div class="match-card-main">
              <div class="match-header">
                <div class="match-status-badge status-closed">Skor Bekleniyor</div>
                <div class="match-time">${formatted}</div>
                <div class="match-tournament-label">${tournamentBadge(match)}</div>
              </div>
              <div class="match-teams-container">
                ${teamsHTML}
              </div>
            </div>
            <div class="prediction-section match-card-panel">
              <div class="friends-panel">
                <div class="friend-picks-title">Yapılan Tahminler</div>
                ${renderFriendsPicks(match.id, false)}
              </div>
            </div>
          `;
          grid.appendChild(card);
        });

        list.appendChild(section);
      });
    }

    function togglePendingResults() {
      pendingResultsOpen = !pendingResultsOpen;
      const body = document.getElementById('pending-results-body');
      const caret = document.getElementById('pending-results-caret');
      if (body) body.classList.toggle('hidden', !pendingResultsOpen);
      if (caret) caret.style.transform = pendingResultsOpen ? 'rotate(90deg)' : 'rotate(0deg)';
    }

    function renderPredictionsView() {
      const container = document.getElementById('predictions-list');
      if (!container) return;

      // Past matches live in the Archive; here we show current/upcoming ones only.
      const currentMatches = matches.filter(match => !isPastMatch(match));

      if (!currentMatches.length) {
        container.innerHTML = `<div class="empty-badge">Güncel maç yok. Geçmiş tahminler Arşiv sekmesinde.</div>`;
        return;
      }

      container.innerHTML = currentMatches.map(match => {
        const count = getPredictionsForMatch(match.id).length;
        const formatted = formatMatchTime(match.datetime);
        const hasResult = match.homeScore != null && match.awayScore != null;
        const open = canPredict(match.datetime);
        const iPredicted = currentUser && allPredictions.some(p => p.uid === currentUser.uid && p.matchId === match.id);
        const canSeeFriends = iPredicted || hasResult || !open;
        const statusText = hasResult ? 'Tamamlandı' : open ? 'Tahmine Açık' : 'Süre Doldu';
        const statusClass = hasResult ? 'status-completed' : open ? 'status-open' : 'status-closed';
        return `
          <div class="prediction-match-row">
            <div class="prediction-match-header">
              <span class="match-status-badge ${statusClass}">${statusText}</span>
              <div>
                <span class="prediction-match-date">${escapeHTML(formatted)}</span>
                <div style="margin-top: 4px;">${tournamentBadge(match)}</div>
                <h4 class="match-teams-title" style="margin-top: 4px;">
                  ${escapeHTML(match.homeTeam)}
                  <span style="color: var(--text-muted); font-weight: 400; margin: 0 4px;">vs</span>
                  ${escapeHTML(match.awayTeam)}
                </h4>
              </div>
              <span class="badge-count" style="margin-left: 0;">${count} tahmin</span>
            </div>
            ${canSeeFriends
              ? renderFriendsPicks(match.id)
              : `<div class="friend-locked-hint">🔒 Kendi tahminini yaptıktan sonra görünür.</div>`}
          </div>
        `;
      }).join('');
    }

    // ================== ARCHIVE (past matches) ==================
    function archiveRowHTML(match, count, picksHTML) {
      const formatted = formatMatchTime(match.datetime);
      const hasResult = match.homeScore != null && match.awayScore != null;

      const homeCell = hasResult
        ? `<div class="actual-score-badge">${match.homeScore}</div>`
        : `<div class="actual-score-badge text-muted">-</div>`;
      const awayCell = hasResult
        ? `<div class="actual-score-badge">${match.awayScore}</div>`
        : `<div class="actual-score-badge text-muted">-</div>`;

      return `
        <article class="match-card archive-card">
          <div class="match-card-main">
            <div class="match-header">
              <div class="match-status-badge status-completed">${hasResult ? 'Tamamlandı' : 'Sonuç Bekleniyor'}</div>
              <div class="match-time">${escapeHTML(formatted)}</div>
              ${match.week ? `<div class="match-week-pill">${match.week}. Hafta</div>` : ''}
              <div class="match-tournament-label">${tournamentBadge(match)}</div>
            </div>

            <div class="match-teams-container">
              <div class="match-teams-row">
                <div class="team-side team-side-home">
                  ${teamNameSpan(match.homeTeam)}
                  ${teamMark(match.homeTeam)}
                </div>
                <div class="score-center">
                  <div class="score-row">
                    ${homeCell}
                    <span class="score-sep">:</span>
                    ${awayCell}
                  </div>
                  <span class="score-caption">${hasResult ? 'Maç Sonucu' : ''}</span>
                </div>
                <div class="team-side team-side-away">
                  ${teamMark(match.awayTeam)}
                  ${teamNameSpan(match.awayTeam)}
                </div>
              </div>
            </div>
          </div>

          <div class="prediction-section match-card-panel">
            <div class="friends-panel">
              ${picksHTML}
            </div>
          </div>
        </article>
      `;
    }

    // Render picks straight from a finalised match's frozen scoreboard (no prediction reads).
    function renderScoreboardPicks(scoreboard, match) {
      if (!scoreboard.length) return `<div class="no-picks-text">Bu maç için tahmin yapılmamış.</div>`;
      const picks = scoreboard.map(s => {
        const exact = s.h === match.homeScore && s.a === match.awayScore;
        let cls = '';
        if (exact) cls = 'correct';
        else if ((s.pts || 0) > 0) cls = 'correct-outcome';
        const odd = scoreOddFor(match, s.h, s.a);
        return `
          <span class="friend-pick-badge ${cls}">
            <span class="friend-avatar" aria-hidden="true">${escapeHTML(String(s.name || '?').trim().charAt(0).toLocaleUpperCase('tr-TR'))}</span>
            <span>${escapeHTML(s.name)}</span>
            <strong>${s.h}-${s.a}</strong>
            ${odd ? `<em class="pick-odd">${formatScoreOdd(match, odd)}</em>` : ''}
            <span class="pick-pts ${(s.pts || 0) === 0 ? 'zero' : ''}">+${formatPoints(s.pts || 0)}</span>
          </span>
        `;
      }).join('');
      return `<div class="friends-picks-container">${picks}</div>`;
    }

    function dayStart(date) {
      if (!date) return null;
      return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    }

    function archiveDayRange(dayKey) {
      const group = archiveDayGroups.find(g => g.key === dayKey);
      if (!group) return null;
      const start = dayStart(group.date);
      if (!start) return null;
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      return { start, end };
    }

    function rebuildArchiveDayGroups(sourceDocs) {
      const groups = new Map();
      sourceDocs.forEach(match => {
        if (!match.datetime) return;
        if (archiveTournamentFilter !== ALL_TOURNAMENTS && tournamentOf(match) !== archiveTournamentFilter) return;
        const key = getDayKey(match.datetime);
        if (!groups.has(key)) groups.set(key, {
          key,
          date: dayStart(match.datetime),
          count: 0,
          tournaments: new Set()
        });
        const group = groups.get(key);
        group.count += 1;
        group.tournaments.add(tournamentOf(match));
      });

      archiveDayGroups = Array.from(groups.values())
        .map(group => ({ ...group, tournaments: Array.from(group.tournaments) }))
        .sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
    }

    async function loadArchiveDayIndex() {
      if (!optimizedMode || archiveDaysIndexLoaded || archiveDaysIndexLoading) return;
      archiveDaysIndexLoading = true;
      renderArchive();
      try {
        const snap = await archiveDaysRef().get();
        const days = snap.exists ? (snap.data().days || {}) : {};
        archiveDayIndexMissing = !snap.exists || !Object.keys(days).length;
        archiveDayGroups = Object.values(days)
          .map(day => {
            const matchesById = day.matches || {};
            const allMatchIds = Object.keys(matchesById);
            const filteredMatchIds = archiveTournamentFilter === ALL_TOURNAMENTS
              ? allMatchIds
              : allMatchIds.filter(id => matchesById[id] === true || matchesById[id] === archiveTournamentFilter);
            return {
              key: day.key,
              date: new Date(day.ts),
              count: day.matches
                ? filteredMatchIds.length
                : (archiveTournamentFilter === ALL_TOURNAMENTS ? (day.count || 0) : 0),
              tournaments: Object.keys(day.tournaments || {})
            };
          })
          .filter(day => day.count > 0)
          .filter(day => archiveTournamentFilter === ALL_TOURNAMENTS || day.tournaments.includes(archiveTournamentFilter))
          .sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
        archiveUsesDayIndex = archiveDayGroups.length > 0;
        archiveDaysIndexLoaded = true;
      } catch (e) {
        console.error(e);
        archiveUsesDayIndex = false;
        archiveDaysIndexLoaded = true;
      } finally {
        archiveDaysIndexLoading = false;
        renderArchive();
      }
    }

    function renderArchiveDayBody(dayKey) {
      const body = document.getElementById(`archive-day-body-${dayKey}`);
      if (!body) return;
      const docs = archiveDayDocs[dayKey] || [];
      if (archiveDayLoading[dayKey]) {
        body.innerHTML = `<div class="empty-badge">Yükleniyor…</div>`;
        return;
      }
      if (!docs.length) {
        body.innerHTML = `<div class="empty-badge">Bu günde arşiv maçı bulunamadı.</div>`;
        return;
      }
      body.innerHTML = docs.map(match => {
        const sb = Array.isArray(match.scoreboard) ? match.scoreboard : [];
        return archiveRowHTML(match, sb.length, renderScoreboardPicks(sb, match));
      }).join('');
    }

    async function toggleArchiveDay(dayKey) {
      if (archiveOpenDays.has(dayKey)) {
        archiveOpenDays.delete(dayKey);
        renderArchive();
        return;
      }

      archiveOpenDays.add(dayKey);
      renderArchive();
      if (!optimizedMode || archiveDayDocs[dayKey] || archiveDayLoading[dayKey]) return;

      const range = archiveDayRange(dayKey);
      if (!range) return;

      archiveDayLoading[dayKey] = true;
      renderArchiveDayBody(dayKey);
      try {
        const q = db.collection('matches')
          .where('finalized', '==', true)
          .where('datetime', '>=', firebase.firestore.Timestamp.fromDate(range.start))
          .where('datetime', '<', firebase.firestore.Timestamp.fromDate(range.end))
          .orderBy('datetime', 'desc');
        const snap = await q.get();
        archiveDayDocs[dayKey] = snap.docs.map(mapMatchDoc)
          .filter(match => archiveTournamentFilter === ALL_TOURNAMENTS || tournamentOf(match) === archiveTournamentFilter)
          .sort((a, b) => (b.datetime?.getTime() || 0) - (a.datetime?.getTime() || 0));
      } catch (e) {
        console.error(e);
        showToast('Gün arşivi yüklenemedi. Firestore dizini gerekebilir.', 'error');
        archiveDayDocs[dayKey] = [];
      } finally {
        archiveDayLoading[dayKey] = false;
        renderArchiveDayBody(dayKey);
      }
    }

    // ---- Hafta görünümü (arşiv) ----
    // Haftası girilmiş maçlar için "N. Hafta" chip'leri; kaynak olarak yeni sorgu
    // yerine cihazdaki tam arşiv önbelleği (breakdownArchiveDocs) + yüklü sayfalar
    // kullanılır — ekstra Firestore okuması ve composite index gerekmez.
    function archiveWeekSourceDocs() {
      if (!optimizedMode) return matches.filter(isPastMatch);
      const seen = new Map();
      (breakdownArchiveDocs || []).forEach(m => seen.set(m.id, m));
      archiveDocs.forEach(m => { if (!seen.has(m.id)) seen.set(m.id, m); });
      return Array.from(seen.values());
    }

    function renderArchiveWeekFilter() {
      const container = document.getElementById('archive-week-filter');
      if (!container) return;

      const inTournament = archiveWeekSourceDocs().filter(m =>
        archiveTournamentFilter === ALL_TOURNAMENTS || tournamentOf(m) === archiveTournamentFilter);
      const weeks = Array.from(new Set(
        inTournament.map(m => m.week).filter(w => w != null)
      )).sort((a, b) => a - b);

      if (!weeks.length) {
        container.innerHTML = '';
        container.classList.add('hidden');
        archiveWeekFilter = null;
        return;
      }

      container.classList.remove('hidden');
      let html = `<button type="button" class="tournament-tab ${archiveWeekFilter == null ? 'active' : ''}" onclick="selectArchiveWeek(null)">📅 Tarihe Göre</button>`;
      weeks.forEach(w => {
        html += `<button type="button" class="tournament-tab ${archiveWeekFilter === w ? 'active' : ''}" onclick="selectArchiveWeek(${w})">${w}. Hafta</button>`;
      });
      container.innerHTML = html;
    }

    function selectArchiveWeek(week) {
      if (archiveWeekFilter === week) return;
      archiveWeekFilter = week;
      renderArchive();
    }

    function renderArchiveWeekView(container, countEl) {
      const docs = archiveWeekSourceDocs()
        .filter(m => m.week === archiveWeekFilter)
        .filter(m => archiveTournamentFilter === ALL_TOURNAMENTS || tournamentOf(m) === archiveTournamentFilter)
        .sort((a, b) => (a.datetime?.getTime() || 0) - (b.datetime?.getTime() || 0));

      if (countEl) countEl.textContent = `${archiveWeekFilter}. Hafta • ${docs.length} maç`;

      if (!docs.length) {
        container.innerHTML = breakdownArchiveLoading || formArchiveEnsureStarted
          ? `<div class="empty-badge">Yükleniyor…</div>`
          : `<div class="empty-badge">Bu haftada arşivlenmiş maç yok.</div>`;
        return;
      }

      container.innerHTML = docs.map(m => {
        const sb = Array.isArray(m.scoreboard) ? m.scoreboard : [];
        const picksHTML = sb.length ? renderScoreboardPicks(sb, m) : renderFriendsPicks(m.id);
        const count = sb.length || getPredictionsForMatch(m.id).length;
        return archiveRowHTML(m, count, picksHTML);
      }).join('');
    }

    function renderArchive() {
      // Güvenli varsayılan
      if (!archiveTournamentFilter) archiveTournamentFilter = defaultTournament || DEFAULT_TOURNAMENT;

      renderArchiveTournamentTabs();
      renderBonusArchivePinned();
      renderArchiveWeekFilter();

      const container = document.getElementById('archive-list');
      const countEl = document.getElementById('archive-count');
      if (!container) return;

      const matchesFilter = (m) => archiveTournamentFilter === ALL_TOURNAMENTS || tournamentOf(m) === archiveTournamentFilter;

      if (archiveWeekFilter != null) {
        renderArchiveWeekView(container, countEl);
        return;
      }

      if (optimizedMode) {
        if (!archiveUsesDayIndex) rebuildArchiveDayGroups(archiveDocs);

        if (countEl) {
          let label = archiveDayGroups.length ? `${archiveDayGroups.length} gün${archiveHasMore ? '+' : ''}` : '';
          if (archiveTournamentFilter !== ALL_TOURNAMENTS) label += ` • ${archiveTournamentFilter}`;
          countEl.textContent = label;
        }
        if (!archiveDayGroups.length) {
          container.innerHTML = (archiveLoading || archiveDaysIndexLoading)
            ? `<div class="empty-badge">Yükleniyor…</div>`
            : (archiveDayIndexMissing
                ? `<div class="empty-badge">Gün bazlı arşiv indeksi henüz yok. Admin panelindeki "Puanları Yeniden Hesapla" bir kez çalışınca arşiv günleri maçları okumadan listelenir.</div>`
                : archiveTournamentFilter !== ALL_TOURNAMENTS
                ? `<div class="empty-badge">Bu turnuvada yüklenmiş arşiv günü yok. Aşağıdan daha fazla gün tarayabilirsin.</div>`
                : `<div class="empty-badge">Henüz arşivlenmiş (sonucu girilmiş) maç yok.</div>`);
          if (!archiveUsesDayIndex && archiveTournamentFilter !== ALL_TOURNAMENTS && archiveHasMore) {
            container.innerHTML += `<div style="text-align:center; margin-top:1rem;">
                 <button onclick="loadMoreArchive()" class="btn btn-secondary" ${archiveLoading ? 'disabled' : ''}>
                   ${archiveLoading ? 'Yükleniyor…' : `Daha Fazla Gün Tara (+${ARCHIVE_PAGE_SIZE})`}
                 </button>
               </div>`;
          }
          return;
        }

        const rows = archiveDayGroups.map(group => {
          const open = archiveOpenDays.has(group.key);
          // When a specific tournament is selected, just show count. Otherwise show tournament info.
          let meta = `<span class="admin-mini-pill">${group.count} maç</span>`;
          if (archiveTournamentFilter === ALL_TOURNAMENTS) {
            const tournamentsText = group.tournaments.length > 1
              ? `${group.tournaments.length} turnuva`
              : (group.tournaments[0] || DEFAULT_TOURNAMENT);
            meta += `<span class="admin-mini-pill">${escapeHTML(tournamentsText)}</span>`;
          }
          return `
            <details class="admin-day-group" ${open ? 'open' : ''} ontoggle="if (event.target === this && this.open !== archiveOpenDays.has('${group.key}')) toggleArchiveDay('${group.key}')">
              <summary class="admin-day-summary">
                <span class="admin-day-title">${escapeHTML(formatDayHeading(group.date))}</span>
                <span class="admin-day-meta">
                  ${meta}
                </span>
              </summary>
              <div id="archive-day-body-${group.key}" class="admin-day-body">
                ${open ? `<div class="empty-badge">Açılıyor…</div>` : ''}
              </div>
            </details>
          `;
        }).join('');
        const more = (!archiveUsesDayIndex && archiveHasMore)
          ? `<div style="text-align:center; margin-top:1rem;">
               <button onclick="loadMoreArchive()" class="btn btn-secondary" ${archiveLoading ? 'disabled' : ''}>
                 ${archiveLoading ? 'Yükleniyor…' : `Daha Fazla Gün Tara (+${ARCHIVE_PAGE_SIZE})`}
               </button>
             </div>`
          : '';
        container.innerHTML = rows + more;
        archiveOpenDays.forEach(dayKey => renderArchiveDayBody(dayKey));
        return;
      }

      // ----- Legacy mode: render from in-memory matches -----
      const pastMatches = matches
        .filter(isPastMatch)
        .filter(matchesFilter)
        .slice()
        .sort((a, b) => b.datetime.getTime() - a.datetime.getTime());

      if (countEl) {
        let label = pastMatches.length ? `${pastMatches.length}` : '';
        if (archiveTournamentFilter !== ALL_TOURNAMENTS) label += ` • ${archiveTournamentFilter}`;
        countEl.textContent = label;
      }

      if (!pastMatches.length) {
        container.innerHTML = `<div class="empty-badge">Henüz arşivlenmiş (geçmiş) maç yok.</div>`;
        return;
      }

      container.innerHTML = pastMatches.map(match =>
        archiveRowHTML(match, getPredictionsForMatch(match.id).length, renderFriendsPicks(match.id))
      ).join('');
    }

    // Paginated archive loading (optimized mode). Each page is ~20 match reads.
    function resetArchivePaging() {
      archiveDocs = [];
      archiveCursor = null;
      archiveHasMore = true;
      archiveLoading = false;
      archiveDayGroups = [];
      archiveDayDocs = {};
      archiveDayLoading = {};
      archiveOpenDays = new Set();
      archiveDaysIndexLoaded = false;
      archiveUsesDayIndex = false;
      archiveDayIndexMissing = false;
      if (optimizedMode && currentView === 'archive') {
        loadArchiveDayIndex();
      } else if (optimizedMode && isAdmin && !document.getElementById('view-admin').classList.contains('hidden')) {
        loadMoreArchive();
      } else {
        renderArchive();
      }
    }

    async function loadMoreArchive() {
      if (!optimizedMode || archiveLoading || !archiveHasMore) return;
      archiveLoading = true;
      renderArchive();
      if (isAdmin) renderAdminArchive();
      try {
        let q = db.collection('matches')
          .where('finalized', '==', true)
          .orderBy('datetime', 'desc')
          .limit(ARCHIVE_PAGE_SIZE);
        if (archiveCursor) q = q.startAfter(archiveCursor);
        const snap = await q.get();
        if (snap.docs.length) archiveCursor = snap.docs[snap.docs.length - 1];
        archiveDocs = archiveDocs.concat(snap.docs.map(mapMatchDoc));

        // En eski en altta olsun (yeni → eski sıralama)
        archiveDocs.sort((a, b) => (b.datetime?.getTime() || 0) - (a.datetime?.getTime() || 0));

        if (snap.docs.length < ARCHIVE_PAGE_SIZE) archiveHasMore = false;
      } catch (e) {
        console.error(e);
        showToast('Arşiv yüklenemedi. Firestore dizini gerekebilir.', 'error');
        archiveHasMore = false;
      } finally {
        archiveLoading = false;
        renderArchive();
        if (isAdmin) renderAdminArchive();
      }
    }

    // Tahmin onayı: tema uyumlu özel modal, native confirm yerine. Promise<boolean> döner.
    let _predictConfirmResolver = null;
    function setPredictConfirmTeamBadge(badge, teamName) {
      if (!badge) return;

      const name = String(teamName || '').trim();
      badge.textContent = teamMonogram(name);
      badge.setAttribute('aria-label', `${name || 'Takım'} logosu`);

      const slug = teamLogoSlug(name);
      if (!slug) return;

      const logo = document.createElement('img');
      logo.className = 'pc-team-logo';
      logo.src = `assets/teams/${slug}.png`;
      logo.alt = '';
      logo.addEventListener('error', () => logo.remove(), { once: true });
      badge.appendChild(logo);
    }

    function confirmPrediction(match, h, a) {
      const modal = document.getElementById('predict-confirm-modal');
      document.getElementById('pc-home-name').textContent = match.homeTeam;
      document.getElementById('pc-away-name').textContent = match.awayTeam;
      const homeBadge = document.getElementById('pc-home-badge');
      const awayBadge = document.getElementById('pc-away-badge');
      setPredictConfirmTeamBadge(homeBadge, match.homeTeam);
      setPredictConfirmTeamBadge(awayBadge, match.awayTeam);
      document.getElementById('pc-home-score').textContent = h;
      document.getElementById('pc-away-score').textContent = a;
      const odd = scoreOddFor(match, h, a);
      document.getElementById('pc-odds').textContent = odd
        ? `Bu skorun iddaa oranı: ${formatScoreOdd(match, odd)}`
        : '';
      modal.classList.remove('hidden');
      return new Promise(resolve => { _predictConfirmResolver = resolve; });
    }
    function resolvePredictConfirm(value) {
      document.getElementById('predict-confirm-modal').classList.add('hidden');
      if (_predictConfirmResolver) {
        const r = _predictConfirmResolver;
        _predictConfirmResolver = null;
        r(value);
      }
    }

    async function submitPrediction(matchId) {
      const hInput = document.getElementById(`pred-h-${matchId}`);
      const aInput = document.getElementById(`pred-a-${matchId}`);

      const h = parseInt(hInput.value);
      const a = parseInt(aInput.value);

      if (isNaN(h) || isNaN(a) || h < 0 || a < 0) {
        showToast('Geçerli skor girin (0 ve üzeri)', 'error');
        return;
      }

      const match = matches.find(item => item.id === matchId);
      if (!match || !canPredict(match.datetime)) {
        showToast('Bu maç için tahmin süresi doldu.', 'error');
        return;
      }

      const confirmed = await confirmPrediction(match, h, a);
      if (!confirmed) return;

      try {
        const predictionRef = db.collection('predictions').doc(`${currentUser.uid}_${matchId}`);
        await db.runTransaction(async transaction => {
          const existing = await transaction.get(predictionRef);
          if (existing.exists) {
            throw new Error('prediction-already-exists');
          }
          transaction.set(predictionRef, {
            uid: currentUser.uid,
            matchId: matchId,
            homePred: h,
            awayPred: a,
            submittedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        });
        showToast('Tahmin kaydedildi ve kilitlendi.', 'success');
      } catch (e) {
        console.error(e);
        if (e.message === 'prediction-already-exists') {
          showToast('Bu maç için daha önce tahmin yaptın.', 'warning');
        } else {
          showToast('Tahmin kaydedilemedi.', 'error');
        }
      }
    }

    // ================== LEADERBOARD ==================
    const FORM_LENGTH = 5;
    let formArchiveEnsureStarted = false;

    // Classify a scored prediction for form dots: exact / approx / outcome / miss
    function classifyPickResult(homePred, awayPred, homeScore, awayScore) {
      if (homeScore == null || awayScore == null || homePred == null || awayPred == null) return null;
      const predOutcome = Math.sign(homePred - awayPred);
      const actOutcome = Math.sign(homeScore - awayScore);
      if (predOutcome !== actOutcome) return 'miss';
      const diff = Math.abs(homePred - homeScore) + Math.abs(awayPred - awayScore);
      if (diff === 0) return 'exact';
      const approxDiff = (actOutcome === 0) ? 2 : 1;
      if (diff === approxDiff) return 'approx';
      return 'outcome';
    }

    // Chronological history (newest first) of finished picks for a user, tournament-filtered.
    // Includes 0-point misses so form/streak are accurate.
    function getUserResultHistory(uid) {
      const items = [];
      const seen = new Set();
      const tFilter = leaderboardTournamentFilter;
      const passesTournament = (match) =>
        tFilter === ALL_TOURNAMENTS || tournamentOf(match) === tFilter;

      const matchById = Object.fromEntries(matches.map(m => [m.id, m]));
      allPredictions.filter(p => p.uid === uid).forEach(pred => {
        const match = matchById[pred.matchId];
        if (!match || seen.has(pred.matchId) || !passesTournament(match)) return;
        if (match.homeScore == null || match.awayScore == null) return;
        seen.add(pred.matchId);
        const kind = classifyPickResult(pred.homePred, pred.awayPred, match.homeScore, match.awayScore);
        const pts = autoPointsFor(pred, match);
        if (!kind) return;
        items.push({
          matchId: pred.matchId,
          datetime: match.datetime,
          kind,
          pts: pts != null ? Number(pts) : 0,
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          homePred: pred.homePred,
          awayPred: pred.awayPred,
          homeScore: match.homeScore,
          awayScore: match.awayScore
        });
      });

      const archiveSource = (optimizedMode && Array.isArray(breakdownArchiveDocs))
        ? breakdownArchiveDocs
        : (optimizedMode ? archiveDocs : null);
      if (Array.isArray(archiveSource)) {
        archiveSource.forEach(match => {
          if (seen.has(match.id) || !passesTournament(match)) return;
          if (match.homeScore == null || match.awayScore == null) return;
          const sb = Array.isArray(match.scoreboard) ? match.scoreboard : [];
          const entry = sb.find(s => s.uid === uid);
          if (!entry) return;
          seen.add(match.id);
          const kind = classifyPickResult(entry.h, entry.a, match.homeScore, match.awayScore);
          if (!kind) return;
          items.push({
            matchId: match.id,
            datetime: match.datetime,
            kind,
            pts: entry.pts != null ? Number(entry.pts) : 0,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            homePred: entry.h,
            awayPred: entry.a,
            homeScore: match.homeScore,
            awayScore: match.awayScore
          });
        });
      }

      items.sort((a, b) => {
        const ta = a.datetime ? a.datetime.getTime() : 0;
        const tb = b.datetime ? b.datetime.getTime() : 0;
        return tb - ta;
      });
      return items;
    }

    // Consecutive results with points > 0, counting from the most recent match back.
    function computeStreak(historyNewestFirst) {
      let n = 0;
      for (const it of historyNewestFirst) {
        if (it.pts > 0) n++;
        else break;
      }
      return n;
    }

    // Consecutive exact-score hits, counting from the most recent match back.
    function computeExactStreak(historyNewestFirst) {
      let n = 0;
      for (const it of historyNewestFirst) {
        if (it.kind === 'exact') n++;
        else break;
      }
      return n;
    }

    // Form noktaları tıklanabilir: her dolu nokta bir buton; tıklayınca maç
    // detayı (takımlar, tahmin, sonuç, puan) popover olarak açılır.
    const formDotsRegistry = [];
    function formDotsHTML(historyNewestFirst) {
      // Display oldest → newest (left to right), last FORM_LENGTH picks
      const slice = historyNewestFirst.slice(0, FORM_LENGTH).reverse();
      const labels = { exact: 'S', approx: 'Y', outcome: '1', miss: '✕' };
      const titles = {
        exact: 'Tam skor',
        approx: 'Yaklaşma',
        outcome: 'Sadece sonuç',
        miss: 'Iskalama'
      };
      let html = '';
      for (let i = 0; i < FORM_LENGTH; i++) {
        const it = slice[i];
        if (!it) {
          html += `<span class="form-dot empty" title="Henüz maç yok">·</span>`;
        } else {
          const regIdx = formDotsRegistry.length;
          formDotsRegistry.push({
            teams: `${it.homeTeam != null ? it.homeTeam : '?'} — ${it.awayTeam != null ? it.awayTeam : '?'}`,
            date: it.datetime ? formatMatchTime(it.datetime) : '—',
            pred: `${it.homePred != null ? it.homePred : '?'}-${it.awayPred != null ? it.awayPred : '?'}`,
            result: `${it.homeScore != null ? it.homeScore : '?'}-${it.awayScore != null ? it.awayScore : '?'}`,
            kind: it.kind,
            kindLabel: titles[it.kind] || it.kind,
            pts: it.pts
          });
          html += `<button type="button" class="form-dot ${it.kind}" onclick="event.stopPropagation(); showFormDotInfo(this, ${regIdx})" title="${titles[it.kind] || it.kind} — maç detayı için tıkla">${labels[it.kind] || '?'}</button>`;
        }
      }
      return html;
    }

    function streakBadgeHTML(streak) {
      if (streak > 0) {
        return `<span class="streak-badge" title="Son ${streak} maçta üst üste sonuç bildi"><span class="streak-fire">🔥</span>${streak}</span>`;
      }
      return `<span class="streak-badge cold" title="Aktif sonuç serisi yok">—</span>`;
    }

    function exactStreakBadgeHTML(streak) {
      if (streak > 0) {
        const cls = streak >= 3 ? 'hot' : '';
        return `<span class="exact-streak-badge ${cls}" title="Son ${streak} maçta üst üste tam skor bildi"><span class="exact-streak-icon">🎯</span>${streak}</span>`;
      }
      return `<span class="exact-streak-badge cold" title="Aktif skor isabet serisi yok">—</span>`;
    }

    // ================== FORM DOT POPOVER (maç detayı) ==================
    let formDotCleanup = null;
    function showFormDotInfo(dotEl, regIdx) {
      const info = formDotsRegistry[regIdx];
      if (!info) return;
      const pop = document.getElementById('formdot-pop');
      if (!pop) return;

      // Önce açıksa temizle
      if (formDotCleanup) { formDotCleanup(); formDotCleanup = null; }

      const kindEl = document.getElementById('formdot-pop-kind');
      const teamsEl = document.getElementById('formdot-pop-teams');
      const dateEl = document.getElementById('formdot-pop-date');
      const detailEl = document.getElementById('formdot-pop-detail');

      const labels = { exact: 'S', approx: 'Y', outcome: '1', miss: '✕' };
      kindEl.innerHTML = `<span class="form-dot ${info.kind}">${labels[info.kind] || '?'}</span> ${escapeHTML(info.kindLabel)}`;
      teamsEl.textContent = info.teams;
      dateEl.textContent = info.date;
      const ptsClass = info.pts > 0 ? 'positive' : 'zero';
      const ptsText = info.pts > 0 ? `+${formatPoints(info.pts)}` : '0';
      detailEl.innerHTML = `Tahmin: <strong>${escapeHTML(info.pred)}</strong> &nbsp;•&nbsp; Sonuç: <span class="formdot-pop-result">${escapeHTML(info.result)}</span><br><span class="formdot-pop-pts ${ptsClass}">${ptsText} puan</span>`;

      pop.classList.remove('hidden');

      // Akıllı konumlandırma: tıklanan noktanın yakınına yerleştir
      requestAnimationFrame(() => {
        const card = pop.querySelector('.formdot-pop-card');
        if (!card || !dotEl) return;
        const rect = dotEl.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const margin = 12;

        const placeBelow = rect.bottom + 10 + cardRect.height < vh - margin;
        let top = placeBelow ? rect.bottom + 10 : rect.top - cardRect.height - 10;
        let left = rect.left + rect.width / 2 - cardRect.width / 2;

        left = Math.max(margin, Math.min(left, vw - cardRect.width - margin));
        top = Math.max(margin, Math.min(top, vh - cardRect.height - margin));

        card.style.left = left + 'px';
        card.style.top = top + 'px';
        card.classList.toggle('flip-down', !placeBelow);

        // Ok işaretini tıklanan noktaya hizala
        const arrowLeft = Math.max(16, Math.min(rect.left + rect.width / 2 - left, cardRect.width - 16));
        card.style.setProperty('--arrow-left', arrowLeft + 'px');
      });

      // Kapatma: ESC + scroll + dış tık (overlay onclick)
      const onEsc = (e) => { if (e.key === 'Escape') closeFormDotPop(); };
      const onScroll = () => closeFormDotPop();
      document.addEventListener('keydown', onEsc);
      window.addEventListener('scroll', onScroll, { passive: true });
      formDotCleanup = () => {
        document.removeEventListener('keydown', onEsc);
        window.removeEventListener('scroll', onScroll);
      };
    }

    function closeFormDotPop() {
      const pop = document.getElementById('formdot-pop');
      if (pop) pop.classList.add('hidden');
      if (formDotCleanup) { formDotCleanup(); formDotCleanup = null; }
    }

    // ================== ANALYSIS TILE POPOVER (kategori → maç listesi) ==================
    // Her oyuncunun puan analizi kutucuğuna (Tam Skor / Sonuç / Yaklaşma / Bloke / Bonus)
    // tıklanınca o kategorideki maçlar liste halinde popover olarak açılır.
    const analysisMatchesRegistry = []; // her row için { matches:[], exact:[], approx:[], blocked:[], outcome:[], bonus:[] }

    // getUserResultHistory çıktısını zenginleştir: her maça approxBlocked / approxAwarded / bonusPoints ekle.
    function getAnalysisMatchesForUser(uid) {
      const history = getUserResultHistory(uid);
      if (!history.length) return history;
      const matchById = Object.fromEntries(matches.map(m => [m.id, m]));
      const archiveSource = (optimizedMode && Array.isArray(breakdownArchiveDocs))
        ? breakdownArchiveDocs
        : (optimizedMode ? archiveDocs : null);
      const archiveById = {};
      if (Array.isArray(archiveSource)) {
        archiveSource.forEach(m => { archiveById[m.id] = m; });
      }
      return history.map(item => {
        const match = matchById[item.matchId] || archiveById[item.matchId];
        let matchPreds = null;
        if (match) {
          if (Array.isArray(match.scoreboard)) {
            matchPreds = match.scoreboard.map(e => ({ homePred: e.h, awayPred: e.a }));
          } else {
            matchPreds = allPredictions.filter(q => q.matchId === match.id);
          }
        }
        const parts = match ? predictionPointParts(item.homePred, item.awayPred, match, matchPreds) : null;
        return Object.assign({}, item, {
          approxBlocked: parts ? !!parts.approxBlocked : false,
          approxAwarded: parts ? !!parts.approxAwarded : false,
          bonusPoints: parts ? parts.bonusPoints : 0
        });
      });
    }

    // Bir kategori için maç listesini döndür (zenginleştirilmiş history'den filtrele).
    function filterAnalysisMatches(matchesAll, category) {
      if (category === 'exact')   return matchesAll.filter(m => m.kind === 'exact');
      if (category === 'outcome') return matchesAll.filter(m => m.kind === 'outcome');
      if (category === 'approx')  return matchesAll.filter(m => m.kind === 'approx' && m.approxAwarded);
      if (category === 'blocked') return matchesAll.filter(m => m.kind === 'approx' && m.approxBlocked);
      if (category === 'bonus')   return matchesAll.filter(m => m.bonusPoints > 0);
      return [];
    }

    const analysisCategoryMeta = {
      exact:   { icon: '🎯', label: 'Tam Skor' },
      outcome: { icon: '✅', label: 'Sonuç' },
      approx:  { icon: '📐', label: 'Yaklaşma' },
      blocked: { icon: '🚫', label: 'Bloke' },
      bonus:   { icon: '🔥', label: 'Bonus' }
    };
    const analysisKindLabels = { exact: 'S', approx: 'Y', outcome: '1', miss: '✕' };

    let analysisPopCleanup = null;
    function showAnalysisTileMatches(tileEl, regIdx, category) {
      const entry = analysisMatchesRegistry[regIdx];
      if (!entry) return;
      const matchList = filterAnalysisMatches(entry.matches, category);
      const meta = analysisCategoryMeta[category] || { icon: '▸', label: category };

      const pop = document.getElementById('analysis-matches-pop');
      if (!pop) return;
      if (analysisPopCleanup) { analysisPopCleanup(); analysisPopCleanup = null; }

      const headEl = document.getElementById('analysis-matches-head');
      const listEl = document.getElementById('analysis-matches-list');

      headEl.innerHTML = `${meta.icon} ${meta.label}
        <span class="head-count">${matchList.length} maç</span>`;

      if (!matchList.length) {
        listEl.innerHTML = `<div class="analysis-matches-empty">Bu kategoride henüz maç yok.</div>`;
      } else {
        listEl.innerHTML = matchList.map(m => {
          const pts = m.pts > 0 ? `+${formatPoints(m.pts)}` : '0';
          const ptsClass = category === 'bonus' ? 'bonus' : (m.pts > 0 ? 'positive' : 'zero');
          const dateStr = m.datetime ? formatMatchTime(m.datetime) : '—';
          const teams = `${m.homeTeam != null ? m.homeTeam : '?'} — ${m.awayTeam != null ? m.awayTeam : '?'}`;
          const pred = `${m.homePred != null ? m.homePred : '?'}-${m.awayPred != null ? m.awayPred : '?'}`;
          const result = `${m.homeScore != null ? m.homeScore : '?'}-${m.awayScore != null ? m.awayScore : '?'}`;
          const blockedTag = category === 'blocked'
            ? `<span class="blocked-tag">• tam skor var, yarım puan verilmedi</span>` : '';
          const bonusNote = category === 'bonus'
            ? `<span class="blocked-tag" style="color:#FFB074">• yalnız sen bildin +3</span>` : '';
          return `
            <div class="analysis-match-item">
              <div class="analysis-match-top">
                <span class="form-dot ${m.kind}">${analysisKindLabels[m.kind] || '?'}</span>
                <span class="analysis-match-teams">${escapeHTML(teams)}</span>
                <span class="analysis-match-pts ${ptsClass}">${pts}</span>
              </div>
              <div class="analysis-match-meta">
                <span>${escapeHTML(dateStr)}</span>
                <span class="pred">Tahmin ${escapeHTML(pred)}</span>
                <span class="result">Sonuç ${escapeHTML(result)}</span>
                ${blockedTag}${bonusNote}
              </div>
            </div>`;
        }).join('');
      }

      pop.classList.remove('hidden');

      // Akıllı konumlandırma: tıklanan kutucuğun yakınına yerleştir (form-dot popover mantığı)
      requestAnimationFrame(() => {
        const card = pop.querySelector('.analysis-matches-card');
        if (!card || !tileEl) return;
        const rect = tileEl.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const margin = 12;

        const placeBelow = rect.bottom + 10 + cardRect.height < vh - margin;
        let top = placeBelow ? rect.bottom + 10 : rect.top - cardRect.height - 10;
        let left = rect.left + rect.width / 2 - cardRect.width / 2;

        left = Math.max(margin, Math.min(left, vw - cardRect.width - margin));
        top = Math.max(margin, Math.min(top, vh - cardRect.height - margin));

        card.style.left = left + 'px';
        card.style.top = top + 'px';
        card.classList.toggle('flip-down', !placeBelow);

        const arrowLeft = Math.max(16, Math.min(rect.left + rect.width / 2 - left, cardRect.width - 16));
        card.style.setProperty('--arrow-left', arrowLeft + 'px');
      });

      const onEsc = (e) => { if (e.key === 'Escape') closeAnalysisMatchesPop(); };
      const onScroll = () => closeAnalysisMatchesPop();
      document.addEventListener('keydown', onEsc);
      window.addEventListener('scroll', onScroll, { passive: true });
      analysisPopCleanup = () => {
        document.removeEventListener('keydown', onEsc);
        window.removeEventListener('scroll', onScroll);
      };
    }

    function closeAnalysisMatchesPop() {
      const pop = document.getElementById('analysis-matches-pop');
      if (pop) pop.classList.add('hidden');
      if (analysisPopCleanup) { analysisPopCleanup(); analysisPopCleanup = null; }
    }

    async function ensureLeaderboardFormData() {
      if (!optimizedMode) return;
      if (breakdownArchiveDocs !== null || formArchiveEnsureStarted) return;
      formArchiveEnsureStarted = true;
      try {
        // Başka bir yer (göz ikonu) zaten yüklüyorsa bitmesini bekle
        while (breakdownArchiveLoading) {
          await new Promise(r => setTimeout(r, 120));
        }
        if (breakdownArchiveDocs === null) {
          await ensureBreakdownArchive();
        }
      } catch (e) {
        console.warn('Form/seri için arşiv yüklenemedi:', e);
      } finally {
        formArchiveEnsureStarted = false;
        if (currentView === 'leaderboard') renderLeaderboard();
      }
    }

    function emptyAnalysisStats(uid) {
      const profile = usersMap[uid] || {};
      return {
        uid,
        displayName: profile.displayName || profile.email || 'Bilinmeyen',
        predictions: 0,
        exactCount: 0,
        outcomeCount: 0,
        approxCount: 0,
        approxAwardedCount: 0,
        approxBlockedCount: 0,
        missCount: 0,
        outcomePoints: 0,
        exactPoints: 0,
        approxPoints: 0,
        approxBlockedPoints: 0,
        bonusPoints: 0,
        totalPoints: 0
      };
    }

    function addAnalysisPick(statsByUid, uid, parts) {
      if (!uid || !parts) return;
      if (!statsByUid[uid]) statsByUid[uid] = emptyAnalysisStats(uid);
      const s = statsByUid[uid];
      s.predictions += 1;
      if (parts.exactHit) s.exactCount += 1;
      if (parts.outcomeHit) s.outcomeCount += 1;
      if (parts.approxHit) s.approxCount += 1;
      if (parts.approxAwarded) s.approxAwardedCount += 1;
      if (parts.approxBlocked) s.approxBlockedCount += 1;
      if (!parts.outcomeHit) s.missCount += 1;
      s.outcomePoints += parts.outcomePoints;
      s.exactPoints += parts.exactPoints;
      s.approxPoints += parts.approxPoints;
      s.approxBlockedPoints += parts.approxBlockedPoints;
      s.bonusPoints += parts.bonusPoints;
      s.totalPoints += parts.totalPoints;
    }

    function leaderboardAnalysisRows() {
      const statsByUid = {};
      const seen = new Set();
      const tFilter = leaderboardTournamentFilter;
      const passesTournament = (match) =>
        tFilter === ALL_TOURNAMENTS || tournamentOf(match) === tFilter;

      const matchById = Object.fromEntries(matches.map(m => [m.id, m]));
      const predsByMatch = {};
      allPredictions.forEach(p => {
        if (!predsByMatch[p.matchId]) predsByMatch[p.matchId] = [];
        predsByMatch[p.matchId].push(p);
      });

      allPredictions.forEach(pred => {
        const match = matchById[pred.matchId];
        if (!match || !passesTournament(match)) return;
        if (match.homeScore == null || match.awayScore == null) return;
        const key = `${match.id}:${pred.uid}`;
        if (seen.has(key)) return;
        seen.add(key);
        const parts = predictionPointParts(pred.homePred, pred.awayPred, match, predsByMatch[pred.matchId]);
        addAnalysisPick(statsByUid, pred.uid, parts);
      });

      const archiveSource = (optimizedMode && Array.isArray(breakdownArchiveDocs))
        ? breakdownArchiveDocs
        : (optimizedMode ? archiveDocs : null);
      if (Array.isArray(archiveSource)) {
        archiveSource.forEach(match => {
          if (!passesTournament(match)) return;
          if (match.homeScore == null || match.awayScore == null) return;
          const sb = Array.isArray(match.scoreboard) ? match.scoreboard : [];
          const matchPreds = sb.map(entry => ({ homePred: entry.h, awayPred: entry.a }));
          sb.forEach(entry => {
            const key = `${match.id}:${entry.uid}`;
            if (seen.has(key)) return;
            seen.add(key);
            const parts = predictionPointParts(entry.h, entry.a, match, matchPreds);
            addAnalysisPick(statsByUid, entry.uid, parts);
          });
        });
      }

      return Object.values(statsByUid).sort((a, b) => {
        if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
        if (b.exactCount !== a.exactCount) return b.exactCount - a.exactCount;
        return a.displayName.localeCompare(b.displayName, 'tr');
      });
    }

    function normalizeScoreKey(homePred, awayPred) {
      const h = Number(homePred);
      const a = Number(awayPred);
      if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
      const hi = Math.max(h, a);
      const lo = Math.min(h, a);
      return `${hi}-${lo}`;
    }

    function collectScoreFrequencyStats() {
      const tFilter = leaderboardTournamentFilter;
      const passesTournament = (match) =>
        tFilter === ALL_TOURNAMENTS || tournamentOf(match) === tFilter;
      const matchById = Object.fromEntries(matches.map(m => [m.id, m]));
      const seen = new Set();
      const scores = {};
      const users = {};
      let totalPredictions = 0;

      const addPick = (match, uid, displayName, homePred, awayPred) => {
        if (!match || !uid || !passesTournament(match)) return;
        const key = `${match.id}:${uid}`;
        if (seen.has(key)) return;
        const scoreKey = normalizeScoreKey(homePred, awayPred);
        if (!scoreKey) return;
        seen.add(key);

        if (!users[uid]) {
          const profile = usersMap[uid] || {};
          users[uid] = {
            uid,
            displayName: displayName || profile.displayName || profile.email || 'Bilinmeyen',
            total: 0
          };
        }
        users[uid].total += 1;

        if (!scores[scoreKey]) scores[scoreKey] = { score: scoreKey, total: 0, byUid: {} };
        scores[scoreKey].total += 1;
        scores[scoreKey].byUid[uid] = (scores[scoreKey].byUid[uid] || 0) + 1;
        totalPredictions += 1;
      };

      allPredictions.forEach(pred => {
        addPick(matchById[pred.matchId], pred.uid, null, pred.homePred, pred.awayPred);
      });

      const archiveSource = (optimizedMode && Array.isArray(breakdownArchiveDocs))
        ? breakdownArchiveDocs
        : (optimizedMode ? archiveDocs : null);
      if (Array.isArray(archiveSource)) {
        archiveSource.forEach(match => {
          const sb = Array.isArray(match.scoreboard) ? match.scoreboard : [];
          sb.forEach(entry => {
            addPick(match, entry.uid, entry.name, entry.h, entry.a);
          });
        });
      }

      const userRows = Object.values(users).sort((a, b) => {
        if (b.total !== a.total) return b.total - a.total;
        return a.displayName.localeCompare(b.displayName, 'tr');
      });
      const activeUserExists = !scoreFrequencySortUid || users[scoreFrequencySortUid];
      if (!activeUserExists) scoreFrequencySortUid = null;
      const scoreRows = Object.values(scores).sort((a, b) => {
        if (scoreFrequencySortUid) {
          const ac = a.byUid[scoreFrequencySortUid] || 0;
          const bc = b.byUid[scoreFrequencySortUid] || 0;
          if (bc !== ac) return bc - ac;
        }
        if (b.total !== a.total) return b.total - a.total;
        return a.score.localeCompare(b.score, 'tr', { numeric: true });
      });

      return { userRows, scoreRows, totalPredictions };
    }

    function setScoreFrequencySort(uid) {
      scoreFrequencySortUid = uid || null;
      renderScoreFrequencyAnalysis();
    }

    function renderScoreFrequencyAnalysis() {
      const container = document.getElementById('score-frequency-analysis');
      if (!container) return;
      const { userRows, scoreRows, totalPredictions } = collectScoreFrequencyStats();
      if (!scoreRows.length || !userRows.length) {
        container.innerHTML = `<div class="leaderboard-empty">Skor analizi için henüz tahmin yok.</div>`;
        return;
      }

      const loadingNote = optimizedMode && breakdownArchiveDocs === null
        ? `<div class="analysis-note">Arşiv detayları yükleniyor; tamamlanınca bu tablo otomatik güncellenir.</div>`
        : '';
      const arrow = (uid) => scoreFrequencySortUid === uid ? '↓' : '';
      const userHeads = userRows.map(user =>
        `<th class="${scoreFrequencySortUid === user.uid ? 'is-active' : ''}" title="${escapeHTML(user.displayName)}">
          <button type="button" class="score-frequency-sort ${scoreFrequencySortUid === user.uid ? 'active' : ''}" onclick="setScoreFrequencySort(${escapeHTML(JSON.stringify(user.uid))})">
            <span>${escapeHTML(user.displayName)}</span><span class="score-frequency-sort-arrow">${arrow(user.uid)}</span>
          </button>
        </th>`
      ).join('');
      const bodyRows = scoreRows.map((row, idx) => {
        const rankClass = idx === 0 ? 'top' : idx === 1 ? 'top2' : idx === 2 ? 'top3' : '';
        const cells = userRows.map(user => {
          const count = row.byUid[user.uid] || 0;
          return count
            ? `<td><span class="score-frequency-count">${count}</span></td>`
            : `<td><span class="score-frequency-zero">·</span></td>`;
        }).join('');
        return `
          <tr>
            <td>
              <span class="score-frequency-score-cell">
                <span class="score-frequency-rank ${rankClass}">${idx + 1}</span>
                <span class="score-frequency-score">${escapeHTML(row.score)}</span>
              </span>
            </td>
            <td><span class="score-frequency-total">${row.total}</span></td>
            ${cells}
          </tr>`;
      }).join('');

      container.innerHTML = `
        <div class="score-frequency-wrap">
          <table class="score-frequency-table">
            <thead>
              <tr>
                <th>Skor</th>
                <th class="${scoreFrequencySortUid === null ? 'is-active' : ''}">
                  <button type="button" class="score-frequency-sort ${scoreFrequencySortUid === null ? 'active' : ''}" onclick="setScoreFrequencySort(null)">
                    <span>Toplam</span><span class="score-frequency-sort-arrow">${arrow(null)}</span>
                  </button>
                </th>
                ${userHeads}
              </tr>
            </thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>
        <div class="score-frequency-summary">
          <span class="score-frequency-pill"><span class="score-frequency-pill-ico">🎯</span>${scoreRows.length} farklı skor</span>
          <span class="score-frequency-pill"><span class="score-frequency-pill-ico">🗳️</span>${totalPredictions} tahmin</span>
          <span class="score-frequency-pill"><span class="score-frequency-pill-ico">👥</span>${userRows.length} kullanıcı</span>
        </div>
        ${loadingNote}
      `;
    }

    function renderLeaderboardAnalysis() {
      const container = document.getElementById('leaderboard-analysis');
      if (!container) return;
      const rows = leaderboardAnalysisRows();
      if (!rows.length) {
        container.innerHTML = `<div class="leaderboard-empty">Analiz için henüz puanlandırılmış tahmin yok.</div>`;
        return;
      }

      const loadingNote = optimizedMode && breakdownArchiveDocs === null
        ? `<div class="analysis-note">Arşiv detayları yükleniyor; liste tamamlınınca otomatik güncellenir.</div>`
        : '';

      // Her oyuncu için kategori bazında maç listelerini hazırla (popover için).
      analysisMatchesRegistry.length = 0;

      const analysisTile = (kind, icon, label, countHTML, points, prefix, regIdx, category, hasMatches) => {
        const hasValue = !(points == null || points === '') || (countHTML && countHTML.trim() !== '');
        const pts = (points == null || points === '')
          ? ''
          : `<span class="analysis-tile-pts">${prefix || ''}${formatPoints(points)}<span class="analysis-tile-pts-unit">p</span></span>`;
        const sep = (pts && countHTML) ? `<span class="analysis-tile-sep">·</span>` : '';
        const emptyCls = hasValue ? '' : 'is-empty';
        const clickable = hasMatches ? 'is-clickable' : '';
        const onclick = hasMatches ? `onclick="event.stopPropagation(); showAnalysisTileMatches(this, ${regIdx}, '${category}')"` : '';
        const tap = hasMatches ? `<span class="analysis-tile-tap">👆 maçlar</span>` : '';
        return `
          <div class="analysis-tile ${kind} ${clickable} ${emptyCls}" ${onclick}>
            <div class="analysis-tile-top">
              <span class="analysis-tile-icon">${icon}</span>
              <span class="analysis-tile-label">${label}</span>
            </div>
            <div class="analysis-tile-stats">${pts}${sep}${countHTML || ''}</div>
            ${tap}
          </div>`;
      };

      container.innerHTML = `
        <div class="analysis-rows">
          ${rows.map((row, idx) => {
            const userMatches = getAnalysisMatchesForUser(row.uid);
            const cats = {
              exact:   userMatches.filter(m => m.kind === 'exact'),
              outcome: userMatches.filter(m => m.kind === 'outcome'),
              approx:  userMatches.filter(m => m.kind === 'approx' && m.approxAwarded),
              blocked: userMatches.filter(m => m.kind === 'approx' && m.approxBlocked),
              bonus:   userMatches.filter(m => m.bonusPoints > 0)
            };
            analysisMatchesRegistry.push({ matches: userMatches, ...cats });
            const regIdx = analysisMatchesRegistry.length - 1;
            return `
            <div class="analysis-row">
              <div class="analysis-row-head">
                <div class="analysis-row-rank">${idx + 1}</div>
                <div class="analysis-row-name">${escapeHTML(row.displayName)}</div>
                <div class="analysis-row-meta">🗳️ ${row.predictions} tahmin</div>
                <div class="analysis-row-total">
                  <span class="analysis-row-total-val">${formatPoints(row.totalPoints)}</span>
                  <span class="analysis-row-total-unit">puan</span>
                </div>
              </div>
              <div class="analysis-row-tiles">
                ${analysisTile('exact', '🎯', 'Tam Skor', `<span class="analysis-tile-count">${row.exactCount}<span class="analysis-tile-count-x">×</span></span>`, row.exactPoints, null, regIdx, 'exact', cats.exact.length > 0)}
                ${analysisTile('outcome', '✅', 'Sonuç', `<span class="analysis-tile-count">${row.outcomeCount}<span class="analysis-tile-count-x">×</span></span>`, row.outcomePoints, null, regIdx, 'outcome', cats.outcome.length > 0)}
                ${analysisTile('approx', '📐', 'Yaklaşma', `<span class="analysis-tile-count">${row.approxAwardedCount}<span class="analysis-tile-count-sub">/${row.approxCount}</span></span>`, row.approxPoints, null, regIdx, 'approx', cats.approx.length > 0)}
                ${analysisTile('blocked', '🚫', 'Bloke', `<span class="analysis-tile-count">${row.approxBlockedCount}<span class="analysis-tile-count-x">×</span></span>`, row.approxBlockedPoints, null, regIdx, 'blocked', cats.blocked.length > 0)}
                ${analysisTile('bonus', '🔥', 'Bonus', '', row.bonusPoints, '+', regIdx, 'bonus', cats.bonus.length > 0)}
              </div>
            </div>`;
          }).join('')}
        </div>
        <div class="analysis-note">Yaklaşma kutucuğunda ilk sayı puan alan yaklaşmaları, ikinci sayı toplam yaklaşma isabetini gösterir. Bloke: yaklaşma doğruyken aynı maçta birinin tam skor bilmesi nedeniyle yarım skor puanı verilmeyen tahmin sayısı. Kutucuklara tıklayarak o kategorideki maçları görebilirsin.</div>
        ${loadingNote}
      `;
    }

    function renderLeaderboard() {
      const tbody = document.getElementById('leaderboard-body');
      const podium = document.getElementById('leaderboard-podium');
      const table = document.querySelector('#view-leaderboard .leaderboard-table');
      if (!tbody) return;
      tbody.innerHTML = '';
      if (podium) podium.innerHTML = '';
      formDotsRegistry.length = 0;

      ensureLeaderboardFormData();

      const tFilter = leaderboardTournamentFilter;
      let pointsMap = {};
      if (optimizedMode) {
        // Totals are maintained incrementally in the aggregate doc as results are saved.
        pointsMap = tFilter === ALL_TOURNAMENTS
          ? { ...leaderboardTotals }
          : { ...(leaderboardTotalsByTournament[tFilter] || {}) };
      } else {
        // Legacy mode: compute live from every prediction + match result.
        const matchById = Object.fromEntries(matches.map(m => [m.id, m]));
        allPredictions.forEach(p => {
          const match = matchById[p.matchId];
          if (tFilter !== ALL_TOURNAMENTS && (!match || tournamentOf(match) !== tFilter)) return;
          const pts = autoPointsFor(p, match);
          if (pts == null) return;
          if (!pointsMap[p.uid]) pointsMap[p.uid] = 0;
          pointsMap[p.uid] += pts;
        });
      }

      // Onaylanmış sezon bonus tahmin puanları (settings/bonus) toplamlara eklenir.
      Object.entries(bonusTotalsByTournament || {}).forEach(([t, byUid]) => {
        if (tFilter !== ALL_TOURNAMENTS && t !== tFilter) return;
        Object.entries(byUid || {}).forEach(([uid, pts]) => {
          const v = Number(pts) || 0;
          if (!v) return;
          pointsMap[uid] = (pointsMap[uid] || 0) + v;
        });
      });

      let rows = Object.keys(pointsMap).map(uid => {
        const profile = usersMap[uid] || {};
        const history = getUserResultHistory(uid);
        return {
          uid,
          displayName: profile.displayName || profile.email || 'Bilinmeyen',
          points: pointsMap[uid],
          history,
          streak: computeStreak(history),
          exactStreak: computeExactStreak(history)
        };
      }).sort((a, b) => b.points - a.points);

      renderLeaderboardAnalysis();
      renderScoreFrequencyAnalysis();

      if (rows.length === 0) {
        if (podium) podium.classList.add('empty');
        if (table) table.style.display = '';
        tbody.innerHTML = `<tr><td colspan="3" class="leaderboard-empty">Henüz puan yok. Admin maç sonucunu ve puanlarını girdikçe tablo güncellenir.</td></tr>`;
        return;
      }

      // ---- Premium podium: ilk üç ----
      const PODIUM_COUNT = 3;
      if (podium) {
        podium.classList.remove('empty');
        rows.slice(0, PODIUM_COUNT).forEach((row, idx) => {
          const rank = idx + 1;
          const isMe = !!(currentUser && row.uid === currentUser.uid);
          const card = document.createElement('div');
          card.className = `podium-card podium-rank-${rank}${isMe ? ' is-me' : ''}`;
          card.innerHTML = `
            ${rank === 1 ? '<div class="podium-crown">👑</div>' : ''}
            <button class="podium-eye" onclick="event.stopImmediatePropagation(); showUserBreakdown('${row.uid}')" title="${escapeHTML(row.displayName)} — puan detayı">👁️</button>
            <div class="podium-medal">${rank}</div>
            <div class="podium-name" title="${escapeHTML(row.displayName)}">${escapeHTML(row.displayName)}</div>
            <div class="podium-form" aria-label="Son ${FORM_LENGTH} maç formu">${formDotsHTML(row.history)}</div>
            <div class="podium-streak">${streakBadgeHTML(row.streak)}${exactStreakBadgeHTML(row.exactStreak)}</div>
            <div class="podium-pts">
              <span class="podium-pts-val">${formatPoints(row.points)}</span>
              <span class="podium-pts-unit">puan</span>
            </div>
          `;
          podium.appendChild(card);
        });
      }

      // ---- Kalan sıralama: 4. sıradan itibaren tabloda ----
      const rest = rows.slice(PODIUM_COUNT);
      if (rest.length === 0) {
        if (table) table.style.display = 'none';
        return;
      }
      if (table) table.style.display = '';

      rest.forEach((row, i) => {
        const rank = PODIUM_COUNT + i + 1;
        const rankClass = 'rank-other';
        const rankContent = rank;
        const tr = document.createElement('tr');
        tr.className = `leaderboard-row ${currentUser && row.uid === currentUser.uid ? 'current-user' : ''}`;
        tr.innerHTML = `
          <td><span class="rank-badge ${rankClass}">${rankContent}</span></td>
          <td>
            <div class="lb-user-cell">
              <div class="lb-user-top">
                <div class="user-display-name">${escapeHTML(row.displayName)}</div>
                ${streakBadgeHTML(row.streak)}${exactStreakBadgeHTML(row.exactStreak)}
              </div>
              <div class="lb-form" aria-label="Son ${FORM_LENGTH} maç formu">${formDotsHTML(row.history)}</div>
            </div>
          </td>
          <td class="lb-points-td">
            <div class="lb-points-cell">
              <span class="points-val">${formatPoints(row.points)}</span>
              <span class="points-unit">puan</span>
              <button class="breakdown-eye" onclick="event.stopImmediatePropagation(); showUserBreakdown('${row.uid}')" title="Hangi maçlardan ne kadar puan aldığını gör">👁️</button>
            </div>
          </td>
        `;
        tbody.appendChild(tr);
      });
    }

    // ================== USER POINT BREAKDOWN (Eye icon in Leaderboard) ==================
    // Detay modalı / form / analiz için finalized maç arşivi. localStorage önbelleği
    // sayesinde tam okuma cihaz başına yalnızca 1 kez yapılır; sonraki açılışlarda
    // önbellekten yüklenir ve sadece yeni finalize olan maçlar (delta) okunur.
    async function ensureBreakdownArchive() {
      if (!optimizedMode) return;
      if (breakdownArchiveDocs !== null || breakdownArchiveLoading) return;
      breakdownArchiveLoading = true;
      try {
        const cached = loadArchiveCache();
        if (cached && (cached.epoch || 0) === archiveEpoch) {
          breakdownArchiveDocs = cached.docs.map(hydrateArchiveDoc);
          breakdownArchiveMaxFAms = cached.maxFA || 0;
          breakdownArchiveLoading = false;
          await syncArchiveDelta();      // önbellekten sonrası: sadece yeni maçlar
          return;
        }
        // Önbellek yok ya da epoch uyuşmuyor → tam okuma (cihaz başına 1 kez).
        const snap = await db.collection('matches').where('finalized', '==', true).get();
        breakdownArchiveDocs = snap.docs.map(mapMatchDoc);
        breakdownArchiveMaxFAms = breakdownArchiveDocs.reduce(
          (mx, m) => Math.max(mx, matchFinalizedAtMs(m)), 0);
        saveArchiveCache();
      } catch (e) {
        console.error(e);
        breakdownArchiveDocs = null;   // tekrar denenebilsin
        throw e;
      } finally {
        breakdownArchiveLoading = false;
      }
    }

    // Yalnızca finalizedAt > son senkron olan maçları çeker ve önbelleğe işler.
    // Sonuç girildikçe aggregate listener'ı bunu tetikler: maç başına ~1 okuma.
    async function syncArchiveDelta() {
      if (!optimizedMode || !Array.isArray(breakdownArchiveDocs)) return;
      // Senkron zaten sürüyorsa kaybolmasın: bittiğinde bir tur daha atılır.
      // (Aggregate listener'ı local yazmayla, batch sunucuya ulaşmadan tetiklenebilir;
      // commit sonrası çağrı kuyruğa alınmazsa son maç önbelleğe hiç girmez.)
      if (archiveDeltaSyncing) { archiveDeltaQueued = true; return; }
      archiveDeltaSyncing = true;
      try {
        do {
          archiveDeltaQueued = false;
          const snap = await db.collection('matches')
            .where('finalized', '==', true)
            .where('finalizedAt', '>', firebase.firestore.Timestamp.fromMillis(breakdownArchiveMaxFAms || 0))
            .get();
          if (!snap.empty) {
            const byId = Object.fromEntries(breakdownArchiveDocs.map(m => [m.id, m]));
            snap.docs.forEach(d => { byId[d.id] = mapMatchDoc(d); });
            breakdownArchiveDocs = Object.values(byId);
            breakdownArchiveMaxFAms = breakdownArchiveDocs.reduce(
              (mx, m) => Math.max(mx, matchFinalizedAtMs(m)), breakdownArchiveMaxFAms || 0);
            saveArchiveCache();
            if (currentView === 'leaderboard') renderLeaderboard();
            if (breakdownUid) renderBreakdownBody();
          }
        } while (archiveDeltaQueued);
      } catch (e) {
        console.warn('Arşiv delta senkronu başarısız:', e);
      } finally {
        archiveDeltaSyncing = false;
      }
    }

    function getUserBreakdown(uid, sortMode = 'points') {
      const items = [];
      const seen = new Set();

      // Detay toplamı, puan durumundaki turnuva filtresine uysun.
      const tFilter = leaderboardTournamentFilter;
      const passesTournament = (match) =>
        tFilter === ALL_TOURNAMENTS || tournamentOf(match) === tFilter;

      // 1. Collect from current matches + live predictions (active + any finalized in memory)
      const matchById = Object.fromEntries(matches.map(m => [m.id, m]));

      const userPreds = allPredictions.filter(p => p.uid === uid);

      userPreds.forEach(pred => {
        const match = matchById[pred.matchId];
        if (!match || seen.has(pred.matchId)) return;
        if (!passesTournament(match)) return;

        seen.add(pred.matchId);

        const pts = autoPointsFor(pred, match);
        items.push({
          matchId: pred.matchId,
          datetime: match.datetime,
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          homePred: pred.homePred,
          awayPred: pred.awayPred,
          homeScore: match.homeScore != null ? match.homeScore : null,
          awayScore: match.awayScore != null ? match.awayScore : null,
          points: pts
        });
      });

      // 2. In optimized mode, include frozen scoreboards from the archive.
      //    Tercihen tüm finalized maçları içeren önbellek (breakdownArchiveDocs);
      //    henüz yüklenmediyse sayfalı arşive (archiveDocs) düşer (kısmi liste).
      const archiveSource = (optimizedMode && Array.isArray(breakdownArchiveDocs))
        ? breakdownArchiveDocs
        : (optimizedMode ? archiveDocs : null);
      if (Array.isArray(archiveSource)) {
        archiveSource.forEach(match => {
          if (seen.has(match.id)) return;
          if (!passesTournament(match)) return;
          const sb = Array.isArray(match.scoreboard) ? match.scoreboard : [];
          const entry = sb.find(s => s.uid === uid);
          if (entry) {
            seen.add(match.id);
            items.push({
              matchId: match.id,
              datetime: match.datetime,
              homeTeam: match.homeTeam,
              awayTeam: match.awayTeam,
              homePred: entry.h,
              awayPred: entry.a,
              homeScore: match.homeScore != null ? match.homeScore : null,
              awayScore: match.awayScore != null ? match.awayScore : null,
              points: (entry.pts != null ? entry.pts : null)
            });
          }
        });
      }

      // Yalnızca puan ALINAN maçlar listelenir: "Bekleniyor" (null puan) ve 0 puanlı
      // maçlar gizlenir. 0 puanlılar toplama zaten katkı yapmadığından, gizlemek
      // TOPLAM'ı değiştirmez (toplam yine puan durumundaki birikmiş toplama eşittir).
      const scored = items.filter(it =>
        it.points != null && !isNaN(it.points) && Number(it.points) > 0);

      if (sortMode === 'date') {
        // Son alınan puandan ilkine: en yeni maç en üstte; 0 puanlılar en sona
        scored.sort((a, b) => {
          const za = Number(a.points) === 0 ? 1 : 0;
          const zb = Number(b.points) === 0 ? 1 : 0;
          if (za !== zb) return za - zb;
          const ta = a.datetime ? a.datetime.getTime() : 0;
          const tb = b.datetime ? b.datetime.getTime() : 0;
          return tb - ta;
        });
      } else {
        // Varsayılan: puana göre büyükten küçüğe (0 puanlar doğal olarak en sonda)
        scored.sort((a, b) => {
          const pa = Number(a.points);
          const pb = Number(b.points);
          if (pb !== pa) return pb - pa;
          // Eşit puanlarda tarihi yeni olandan eskiye (tie-breaker)
          const ta = a.datetime ? a.datetime.getTime() : 0;
          const tb = b.datetime ? b.datetime.getTime() : 0;
          return tb - ta;
        });
      }

      return scored;
    }

    // Aktif breakdown durumu (göz simgesi modalı) — sıralama modu değiştirilebilir
    const BREAKDOWN_PAGE = 10;          // detay tablosu her seferinde 10 maç gösterir
    let breakdownUid = null;
    let breakdownSortMode = 'points';   // 'points' (varsayılan) | 'date' (son alınandan ilke)
    let breakdownShown = BREAKDOWN_PAGE;

    function setBreakdownSort(mode) {
      if (mode !== 'points' && mode !== 'date') return;
      breakdownSortMode = mode;
      breakdownShown = BREAKDOWN_PAGE;  // sıralama değişince baştan başla
      const pBtn = document.getElementById('breakdown-sort-points');
      const dBtn = document.getElementById('breakdown-sort-date');
      if (pBtn) pBtn.classList.toggle('active', mode === 'points');
      if (dBtn) dBtn.classList.toggle('active', mode === 'date');
      if (breakdownUid) renderBreakdownBody();
    }

    function loadMoreBreakdown() {
      breakdownShown += BREAKDOWN_PAGE;
      renderBreakdownBody();
    }

    async function showUserBreakdown(uid) {
      const modal = document.getElementById('breakdown-modal');
      if (!modal) return;
      breakdownUid = uid;
      breakdownSortMode = 'points';   // her açılışta varsayılana dön
      breakdownShown = BREAKDOWN_PAGE;
      setBreakdownSort('points');     // buton durumlarını sıfırla + render et (varsa kısmi liste)
      modal.classList.remove('hidden');

      // Close on Escape
      const escHandler = (e) => {
        if (e.key === 'Escape') {
          closeBreakdownModal();
          document.removeEventListener('keydown', escHandler);
        }
      };
      document.addEventListener('keydown', escHandler, { once: true });

      // Detay toplamı puan durumuyla birebir tutsun diye tüm finalized maçları
      // (bir kez) yükle, sonra tam listeyle yeniden çiz.
      if (optimizedMode && breakdownArchiveDocs === null) {
        renderBreakdownBody();          // "yükleniyor…" ipucunu göster
        try {
          await ensureBreakdownArchive();
        } catch (e) {
          showToast('Tüm maçlar yüklenemedi; liste eksik olabilir.', 'error');
        }
        if (breakdownUid === uid && !modal.classList.contains('hidden')) {
          renderBreakdownBody();        // tam veriyle yeniden çiz
        }
      }
    }

    function renderBreakdownBody() {
      const titleEl = document.getElementById('breakdown-title');
      const subEl = document.getElementById('breakdown-subtitle');
      const bodyEl = document.getElementById('breakdown-body');
      const totalEl = document.getElementById('breakdown-total');
      const uid = breakdownUid;
      if (!bodyEl || !uid) return;

      const profile = usersMap[uid] || {};
      const displayName = profile.displayName || profile.email || 'Oyuncu';

      const breakdown = getUserBreakdown(uid, breakdownSortMode);

      // Onaylanmış sezon bonus tahmin puanları — puan durumu filtresine uyar
      const bdFilter = leaderboardTournamentFilter;
      const bonusItems = [];
      Object.entries(bonusTotalsByTournament || {}).forEach(([t, byUid]) => {
        if (bdFilter !== ALL_TOURNAMENTS && t !== bdFilter) return;
        const v = Number((byUid || {})[uid]) || 0;
        if (v) bonusItems.push({ tournament: t, points: v });
      });
      const bonusSum = bonusItems.reduce((acc, it) => acc + it.points, 0);

      titleEl.textContent = `${displayName} — Puan Detayı`;
      const sortLabel = breakdownSortMode === 'date' ? 'Son alınandan ilke' : 'Puanlar yüksekten düşüğe';
      subEl.textContent = breakdown.length ? `${breakdown.length} maç • ${sortLabel}` : '';

      if (!breakdown.length && !bonusItems.length) {
        bodyEl.innerHTML = `<div class="breakdown-empty">Bu kullanıcı için henüz puanlandırılmış maç bulunamadı.</div>`;
        totalEl.textContent = '';
        return;
      }

      // Toplam, listenin tamamı üzerinden hesaplanır (sadece gösterilenler değil)
      const sum = breakdown.reduce((acc, it) => acc + (Number(it.points) || 0), 0) + bonusSum;

      // Sayfalama: yalnızca ilk `breakdownShown` maçı çiz; gerisi "Devamını gör" ile gelir
      const visible = breakdown.slice(0, breakdownShown);

      let html = '';
      bonusItems.forEach(item => {
        html += `
          <div class="breakdown-row">
            <div class="breakdown-match">
              <div class="breakdown-date">Sezon Bonus Tahmini</div>
              <div class="breakdown-teams">🎯 ${escapeHTML(item.tournament)}</div>
              <div class="breakdown-pred">Sezon başı tahmin puanı (admin onaylı)</div>
            </div>
            <div class="breakdown-points positive">+${formatPoints(item.points)}</div>
          </div>
        `;
      });
      visible.forEach(item => {
        const hasResult = item.homeScore != null && item.awayScore != null;
        const pts = item.points;

        const dateStr = item.datetime ? formatMatchTime(item.datetime) : '—';

        const predStr = `${item.homePred}-${item.awayPred}`;
        const resultStr = hasResult ? `${item.homeScore}-${item.awayScore}` : '— : —';

        const ptsClass = pts > 0 ? 'positive' : 'zero';
        const ptsText = `+${formatPoints(pts)}`;

        html += `
          <div class="breakdown-row">
            <div class="breakdown-match">
              <div class="breakdown-date">${escapeHTML(dateStr)}</div>
              <div class="breakdown-teams">${escapeHTML(item.homeTeam)} — ${escapeHTML(item.awayTeam)}</div>
              <div class="breakdown-pred">Tahmin: <strong>${escapeHTML(predStr)}</strong> &nbsp;•&nbsp; Sonuç: <span class="breakdown-result">${escapeHTML(resultStr)}</span></div>
            </div>
            <div class="breakdown-points ${ptsClass}">${ptsText}</div>
          </div>
        `;
      });

      bodyEl.innerHTML = html;

      // "Devamını gör" — kalan maçları 10'ar 10'ar yükler
      if (breakdown.length > visible.length) {
        const remaining = breakdown.length - visible.length;
        const step = Math.min(BREAKDOWN_PAGE, remaining);
        const moreWrap = document.createElement('div');
        moreWrap.style.cssText = 'text-align:center; padding:10px 0 4px;';
        const moreBtn = document.createElement('button');
        moreBtn.className = 'btn btn-secondary btn-sm';
        moreBtn.textContent = `Devamını gör (+${step})`;
        moreBtn.onclick = loadMoreBreakdown;
        moreWrap.appendChild(moreBtn);
        bodyEl.appendChild(moreWrap);
      }

      totalEl.innerHTML = `<span style="color:var(--text-secondary);font-size:0.78rem;font-weight:600;">TOPLAM</span> <span style="font-size:1.1rem;font-weight:900;color:#fff;">${formatPoints(sum)}</span> <span style="font-size:0.7rem;color:var(--text-muted);">puan</span>`;

      // Tüm finalized maçlar yüklenirken bilgilendir; yüklenince liste tam olur.
      if (optimizedMode && breakdownArchiveDocs === null) {
        const hint = document.createElement('div');
        hint.style.cssText = 'padding:8px 18px 4px; font-size:0.68rem; color:var(--text-muted); text-align:center;';
        hint.textContent = 'Tüm maçlar yükleniyor… (liste birazdan tamamlanacak)';
        bodyEl.appendChild(hint);
      }
    }

    function closeBreakdownModal() {
      const modal = document.getElementById('breakdown-modal');
      if (modal) modal.classList.add('hidden');
    }

    // ================== SEZON BONUS TAHMİNLERİ ==================
    // Admin bir turnuvaya bonus tahmin açar (bonus/{docId} config dokümanı):
    //   mode 'ranking'  → ilk N + son M sıra tahmini (doğru sıra başına sabit puan)
    //   mode 'champion' → sadece şampiyon tahmini (puanı admin oran bazlı belirler)
    // Kullanıcı tahminleri bonus/{docId}/picks/{uid} altında tutulur. Sezon sonunda
    // admin her tahmine puan yazar + ekstra ekler + onaylar; onaylanan toplamlar
    // settings/bonus.byTournament'a yazılır ve puan durumu toplamlarına eklenir.

    function bonusDocIdFor(tournament) {
      return String(tournament).trim().replace(/\//g, '_');
    }

    // Etikete (turnuvaya) göre tahmin edilecek sıralar: ranking modda ilk N + son M,
    // champion modda tek "champion" anahtarı. Form ve puanlama hep bu sırayı izler.
    function bonusPositionsFor(cfg) {
      if (!cfg || cfg.mode === 'champion') return ['champion'];
      const total = Number(cfg.totalTeams) || 18;
      const top = Math.min(Number(cfg.topCount) || 0, total);
      const bottom = Number(cfg.bottomCount) || 0;
      const positions = [];
      for (let i = 1; i <= top; i++) positions.push(String(i));
      for (let i = Math.max(total - bottom + 1, top + 1); i <= total; i++) positions.push(String(i));
      return positions;
    }

    function bonusPositionLabel(key) {
      return key === 'champion' ? 'Şampiyon' : `${key}.`;
    }

    function bonusModeText(cfg) {
      return cfg.mode === 'champion'
        ? 'Şampiyon tahmini'
        : `İlk ${cfg.topCount || 6} + Son ${cfg.bottomCount || 3} sıralama tahmini (doğru sıra +${cfg.pointsPerCorrect || 10} puan)`;
    }

    // Turnuvada geçen takım adları — bellekteki maçlardan toplanır (yedek yöntem;
    // asıl liste config.teams'te durur, bkz. fetchTournamentTeams).
    function bonusTeamNamesFor(tournament) {
      const names = new Set();
      const collect = (m) => {
        if (tournamentOf(m) !== tournament) return;
        if (m.homeTeam) names.add(String(m.homeTeam).trim());
        if (m.awayTeam) names.add(String(m.awayTeam).trim());
      };
      matches.forEach(collect);
      archiveDocs.forEach(collect);
      if (Array.isArray(breakdownArchiveDocs)) breakdownArchiveDocs.forEach(collect);
      return Array.from(names).sort((a, b) => a.localeCompare(b, 'tr'));
    }

    // Etiketin TÜM maçlarını (gelecek haftalar dahil) tarayıp takım listesini çıkarır.
    // Config oluştururken / "Takımları Yenile" denince bir kez çalışır; sonuç
    // config.teams'e yazıldığı için kullanıcılar ekstra okuma yapmaz.
    async function fetchTournamentTeams(tournament) {
      const snap = await db.collection('matches').where('tournament', '==', tournament).get();
      const names = new Set();
      snap.docs.forEach(d => {
        const m = d.data();
        if (m.homeTeam) names.add(String(m.homeTeam).trim());
        if (m.awayTeam) names.add(String(m.awayTeam).trim());
      });
      // Bellekte görünen maçlar da katılsın (etiketsiz varsayılan turnuva vb.)
      bonusTeamNamesFor(tournament).forEach(n => names.add(n));
      return Array.from(names).sort((a, b) => a.localeCompare(b, 'tr'));
    }

    // Config'teki takım listesi (yoksa bellekteki maçlardan türetilen yedek liste)
    function bonusTeamsOf(cfg) {
      return (Array.isArray(cfg.teams) && cfg.teams.length)
        ? cfg.teams
        : bonusTeamNamesFor(cfg.tournament);
    }

    async function refreshBonusTeams(cfgId) {
      const cfg = bonusConfigs.find(c => c.id === cfgId);
      if (!cfg || !isAdmin) return;
      try {
        const teams = await fetchTournamentTeams(cfg.tournament);
        await db.collection('bonus').doc(cfgId).set({
          teams,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        showToast(`${cfg.tournament}: ${teams.length} takım bulundu ve listeye kaydedildi.`, 'success');
      } catch (e) {
        console.error(e);
        showToast('Takım listesi güncellenemedi.', 'error');
      }
    }

    // Kendi tahminim (banner durumu için): cihaz başına config başına 1 okuma.
    async function loadMyBonusPick(cfg) {
      if (!currentUser || bonusMyPickLoading[cfg.id]) return;
      bonusMyPickLoading[cfg.id] = true;
      try {
        const snap = await db.collection('bonus').doc(cfg.id).collection('picks').doc(currentUser.uid).get();
        bonusMyPicks[cfg.id] = snap.exists ? { uid: currentUser.uid, ...snap.data() } : null;
      } catch (e) {
        console.error(e);
        bonusMyPicks[cfg.id] = null;
      } finally {
        bonusMyPickLoading[cfg.id] = false;
        renderBonusEntryBanner();
      }
    }

    // Tüm tahminler (arşiv sabiti + admin puanlama): config başına canlı dinleyici.
    function ensureBonusPicks(cfg) {
      if (bonusPicksCache[cfg.id]) return;
      const cache = { unsub: null, docs: null };
      bonusPicksCache[cfg.id] = cache;
      cache.unsub = db.collection('bonus').doc(cfg.id).collection('picks').onSnapshot(snap => {
        cache.docs = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
        if (currentUser) {
          bonusMyPicks[cfg.id] = cache.docs.find(p => p.uid === currentUser.uid) || null;
        }
        if (currentView === 'archive') renderBonusArchivePinned();
        if (currentView === 'matches') renderBonusEntryBanner();
        if (isAdmin) renderAdminBonus();
      }, err => console.error(err));
    }

    // ---------- Kullanıcı: fikstür üstü banner + tahmin modalı ----------
    function renderBonusEntryBanner() {
      const container = document.getElementById('bonus-entry-banner');
      if (!container) return;
      const openConfigs = bonusConfigs.filter(c => c.open === true);
      if (!openConfigs.length) { container.innerHTML = ''; return; }

      container.innerHTML = openConfigs.map(cfg => {
        const mine = bonusMyPicks[cfg.id];
        if (mine === undefined) loadMyBonusPick(cfg);
        const status = mine === undefined
          ? 'Tahmin durumun yükleniyor…'
          : (mine
              ? '✅ Tahminini girdin — giriş kapanana kadar düzenleyebilirsin.'
              : '⏳ Henüz tahmin girmedin!');
        return `
          <div class="bonus-banner" data-bonus-id="${escapeHTML(cfg.id)}">
            <div class="bonus-banner-info">
              <div class="bonus-banner-title">🎯 ${escapeHTML(cfg.tournament)} — Sezon Bonus Tahmini</div>
              <div class="bonus-banner-sub">${escapeHTML(bonusModeText(cfg))}${cfg.desc ? ` • ${escapeHTML(cfg.desc)}` : ''}</div>
              <div class="bonus-banner-status ${mine ? 'done' : 'todo'}">${status}</div>
            </div>
            <button type="button" class="btn btn-primary bonus-banner-btn">${mine ? 'Tahminini Düzenle' : 'Tahmin Yap'}</button>
          </div>`;
      }).join('');

      container.querySelectorAll('.bonus-banner-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.closest('.bonus-banner').dataset.bonusId;
          const cfg = bonusConfigs.find(c => c.id === id);
          if (cfg) openBonusModal(cfg);
        });
      });
    }

    let bonusModalCfgId = null;

    async function openBonusModal(cfg) {
      const modal = document.getElementById('bonus-modal');
      const body = document.getElementById('bonus-modal-body');
      const subEl = document.getElementById('bonus-modal-subtitle');
      const titleEl = document.getElementById('bonus-modal-title');
      if (!modal || !body || !currentUser) return;
      if (cfg.open !== true) { showToast('Bu turnuvanın bonus tahmin girişi kapalı.', 'error'); return; }

      bonusModalCfgId = cfg.id;
      titleEl.textContent = `🎯 ${cfg.tournament} — Sezon Bonus Tahmini`;
      subEl.textContent = bonusModeText(cfg) + (cfg.desc ? ` • ${cfg.desc}` : '');

      // Mevcut tahmin yüklenmeden boş form gösterme (yanlışlıkla üzerine yazılmasın)
      if (bonusMyPicks[cfg.id] === undefined) {
        body.innerHTML = `<div class="empty-badge">Tahminin yükleniyor…</div>`;
        modal.classList.remove('hidden');
        await loadMyBonusPick(cfg);
        if (bonusModalCfgId !== cfg.id || modal.classList.contains('hidden')) return;
      }

      const positions = bonusPositionsFor(cfg);
      const picks = (bonusMyPicks[cfg.id] && bonusMyPicks[cfg.id].picks) || {};
      const teams = bonusTeamsOf(cfg);
      const datalist = teams.length
        ? `<datalist id="bonus-team-datalist">${teams.map(t => `<option value="${escapeHTML(t)}">`).join('')}</datalist>`
        : '';
      const hint = teams.length
        ? `<div class="bonus-teams-hint">Yazmaya başla, listeden seç — yalnızca bu turnuvanın ${teams.length} takımı seçilebilir.</div>`
        : '';

      body.innerHTML = datalist + hint + positions.map(pos => `
        <div class="bonus-pick-row">
          <label class="bonus-pos-label">${bonusPositionLabel(pos)}</label>
          <input type="text" class="input-field bonus-pick-input" data-pos="${pos}"
                 ${teams.length ? 'list="bonus-team-datalist"' : ''}
                 autocomplete="off" placeholder="Takım adı yaz / seç" value="${escapeHTML(picks[pos] || '')}">
        </div>`).join('');

      modal.classList.remove('hidden');
    }

    function closeBonusModal() {
      const modal = document.getElementById('bonus-modal');
      if (modal) modal.classList.add('hidden');
      bonusModalCfgId = null;
    }

    async function saveBonusPicks() {
      const cfg = bonusConfigs.find(c => c.id === bonusModalCfgId);
      const body = document.getElementById('bonus-modal-body');
      if (!cfg || !body || !currentUser) return;

      const picks = {};
      let missing = false;
      body.querySelectorAll('input[data-pos]').forEach(inp => {
        const val = inp.value.trim();
        if (!val) missing = true;
        else picks[inp.dataset.pos] = val;
      });
      if (missing) { showToast('Lütfen tüm sıraları doldur.', 'error'); return; }

      // Yalnızca turnuvanın takım listesindeki adlar kabul edilir; büyük/küçük
      // harf farkı otomatik düzeltilir (galatasaray → Galatasaray).
      const teams = bonusTeamsOf(cfg);
      if (teams.length) {
        const canonical = {};
        teams.forEach(t => { canonical[t.toLocaleLowerCase('tr')] = t; });
        const invalid = [];
        Object.keys(picks).forEach(pos => {
          const match = canonical[picks[pos].toLocaleLowerCase('tr')];
          if (match) picks[pos] = match;
          else invalid.push(picks[pos]);
        });
        if (invalid.length) {
          showToast(`Bu takım(lar) turnuva listesinde yok: ${invalid.join(', ')}. Listeden seç.`, 'error');
          return;
        }
      }

      // Aynı takım iki sıraya yazılmasın (ranking modunda)
      const values = Object.values(picks).map(v => v.toLocaleLowerCase('tr'));
      if (cfg.mode !== 'champion' && new Set(values).size !== values.length) {
        showToast('Aynı takımı birden fazla sıraya yazamazsın.', 'error');
        return;
      }

      const saveBtn = document.getElementById('bonus-modal-save');
      if (saveBtn) saveBtn.disabled = true;
      try {
        await db.collection('bonus').doc(cfg.id).collection('picks').doc(currentUser.uid).set({
          uid: currentUser.uid,
          name: currentUserProfile?.displayName || currentUser.email,
          picks,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        bonusMyPicks[cfg.id] = { ...(bonusMyPicks[cfg.id] || { uid: currentUser.uid }), picks };
        closeBonusModal();
        showToast('Bonus tahminin kaydedildi. 🎯', 'success');
        renderBonusEntryBanner();
        if (currentView === 'archive') renderBonusArchivePinned();
      } catch (e) {
        console.error(e);
        showToast('Tahmin kaydedilemedi. Giriş kapanmış olabilir.', 'error');
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    }

    // ---------- Arşiv üstü: sabitlenmiş tahmin tablosu ----------
    function renderBonusArchivePinned() {
      const container = document.getElementById('bonus-archive-pinned');
      if (!container) return;
      const tf = archiveTournamentFilter;
      const cfgs = bonusConfigs.filter(c =>
        c.pinned === true && (tf == null || tf === ALL_TOURNAMENTS || c.tournament === tf));
      if (!cfgs.length) { container.innerHTML = ''; return; }

      container.innerHTML = cfgs.map(cfg => {
        ensureBonusPicks(cfg);
        const cache = bonusPicksCache[cfg.id];
        const docs = cache && Array.isArray(cache.docs) ? cache.docs : null;

        let rowsHTML;
        if (docs === null) {
          rowsHTML = `<div class="empty-badge">Tahminler yükleniyor…</div>`;
        } else if (!docs.length) {
          rowsHTML = `<div class="empty-badge">Henüz kimse tahmin girmedi.</div>`;
        } else {
          const positions = bonusPositionsFor(cfg);
          const sorted = docs.slice().sort((a, b) => {
            const ta = a.approved ? (Number(a.total) || 0) : -1;
            const tb = b.approved ? (Number(b.total) || 0) : -1;
            if (tb !== ta) return tb - ta;
            const na = (usersMap[a.uid]?.displayName || a.name || '');
            const nb = (usersMap[b.uid]?.displayName || b.name || '');
            return na.localeCompare(nb, 'tr');
          });
          rowsHTML = sorted.map(pick => {
            const name = usersMap[pick.uid]?.displayName || pick.name || 'Bilinmeyen';
            const isMe = currentUser && pick.uid === currentUser.uid;
            const awarded = pick.awarded || {};
            const picksHTML = positions.map(pos => {
              const team = (pick.picks || {})[pos];
              if (!team) return '';
              const pts = Number(awarded[pos]) || 0;
              return `<span class="bonus-pick-chip ${pts > 0 ? 'hit' : (pick.approved ? 'miss' : '')}">
                        ${bonusPositionLabel(pos)} ${escapeHTML(team)}${pts > 0 ? ` <b>+${formatPoints(pts)}</b>` : ''}
                      </span>`;
            }).join('');
            const extra = Number(pick.extra) || 0;
            const totalHTML = pick.approved
              ? `<span class="bonus-total-pill">${extra ? `+${formatPoints(extra)} ekstra • ` : ''}${formatPoints(Number(pick.total) || 0)} puan</span>`
              : `<span class="bonus-total-pill pending">puanlama bekleniyor</span>`;
            return `
              <div class="bonus-pinned-row ${isMe ? 'is-me' : ''}">
                <div class="bonus-pinned-user">${escapeHTML(name)}</div>
                <div class="bonus-pinned-picks">${picksHTML}</div>
                <div class="bonus-pinned-total">${totalHTML}</div>
              </div>`;
          }).join('');
        }

        const entryBtn = (cfg.open === true && currentUser)
          ? `<button type="button" class="btn btn-secondary btn-sm bonus-pinned-entry-btn" data-bonus-id="${escapeHTML(cfg.id)}">
               ${bonusMyPicks[cfg.id] ? 'Tahminini Düzenle' : 'Tahmin Yap'}
             </button>`
          : '';

        return `
          <details class="admin-day-group bonus-pinned-card" open>
            <summary class="admin-day-summary">
              <span class="admin-day-title">🎯 ${escapeHTML(cfg.tournament)} — Sezon Bonus Tahminleri</span>
              <span class="admin-day-meta">
                <span class="admin-mini-pill">${escapeHTML(bonusModeText(cfg))}</span>
                ${cfg.open === true ? '<span class="admin-mini-pill">Giriş açık</span>' : ''}
              </span>
            </summary>
            <div class="admin-day-body bonus-pinned-body">
              ${entryBtn}
              ${rowsHTML}
            </div>
          </details>`;
      }).join('');

      container.querySelectorAll('.bonus-pinned-entry-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const cfg = bonusConfigs.find(c => c.id === btn.dataset.bonusId);
          if (cfg) openBonusModal(cfg);
        });
      });
    }

    // ---------- Admin: oluşturma, aç/kapat, sabit, puanlama, onay ----------
    function onBonusModeChange(mode) {
      const fields = document.getElementById('bonus-ranking-fields');
      if (fields) fields.style.display = mode === 'ranking' ? '' : 'none';
    }

    async function createBonusConfig() {
      if (!isAdmin) return;
      const sel = document.getElementById('bonus-new-tournament');
      const tournament = sel && sel.value;
      if (!tournament) { showToast('Turnuva seç.', 'error'); return; }
      const mode = document.getElementById('bonus-new-mode')?.value === 'champion' ? 'champion' : 'ranking';
      const desc = (document.getElementById('bonus-new-desc')?.value || '').trim();

      const cfg = {
        tournament,
        mode,
        open: false,     // admin hazır olunca "Girişi Aç" der
        pinned: true,    // arşiv üstünde göster (turnuva bitince kaldırılabilir)
        desc,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      if (mode === 'ranking') {
        cfg.topCount = parseInt(document.getElementById('bonus-new-top')?.value, 10) || 6;
        cfg.bottomCount = parseInt(document.getElementById('bonus-new-bottom')?.value, 10) || 3;
        cfg.totalTeams = parseInt(document.getElementById('bonus-new-total')?.value, 10) || 18;
        cfg.pointsPerCorrect = parseFloat(document.getElementById('bonus-new-ppc')?.value) || 10;
      }

      try {
        // Takım listesi turnuva fikstüründen çıkarılır; tahminler yalnızca bu
        // listeden seçilebilir. Fikstür sonradan eklenirse "Takımları Yenile" var.
        cfg.teams = await fetchTournamentTeams(tournament);
        await db.collection('bonus').doc(bonusDocIdFor(tournament)).set(cfg);
        showToast(
          cfg.teams.length
            ? `${tournament} için bonus tahmin oluşturuldu (${cfg.teams.length} takım bulundu). Kullanıcı girişini açmayı unutma!`
            : `${tournament} için oluşturuldu ama fikstürde takım bulunamadı — fikstürü ekledikten sonra "Takımları Yenile"ye bas.`,
          cfg.teams.length ? 'success' : 'error');
        const descInp = document.getElementById('bonus-new-desc');
        if (descInp) descInp.value = '';
      } catch (e) {
        console.error(e);
        showToast('Bonus tahmin oluşturulamadı.', 'error');
      }
    }

    async function toggleBonusField(cfgId, field) {
      const cfg = bonusConfigs.find(c => c.id === cfgId);
      if (!cfg || !isAdmin) return;
      try {
        await db.collection('bonus').doc(cfgId).set({
          [field]: !(cfg[field] === true),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (e) {
        console.error(e);
        showToast('Güncellenemedi.', 'error');
      }
    }

    async function deleteBonusConfig(cfgId) {
      const cfg = bonusConfigs.find(c => c.id === cfgId);
      if (!cfg || !isAdmin) return;
      if (!confirm(`${cfg.tournament} bonus tahmini ve TÜM kullanıcı tahminleri/puanları silinecek. Emin misin?`)) return;
      try {
        const snap = await db.collection('bonus').doc(cfgId).collection('picks').get();
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        batch.delete(db.collection('bonus').doc(cfgId));
        batch.set(db.collection('settings').doc('bonus'), {
          byTournament: { [cfg.tournament]: firebase.firestore.FieldValue.delete() }
        }, { merge: true });
        await batch.commit();
        showToast('Bonus tahmin silindi; puan durumu güncellendi.', 'success');
      } catch (e) {
        console.error(e);
        showToast('Silinemedi.', 'error');
      }
    }

    // Admin puanlama kartlarının açık/kapalı durumu (yeniden çizimde korunur)
    const adminBonusOpenSet = new Set();
    let adminBonusRerenderQueued = false;
    let adminBonusFocusGuardBound = false;

    function renderAdminBonus() {
      if (!isAdmin) return;
      const container = document.getElementById('admin-bonus-list');
      if (!container) return;

      // Admin puan yazarken gelen sunucu güncellemeleri inputları silmesin:
      // odak konteynerin içindeyse çizimi ertele, odak çıkınca çiz.
      if (container.contains(document.activeElement) &&
          /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        adminBonusRerenderQueued = true;
        if (!adminBonusFocusGuardBound) {
          adminBonusFocusGuardBound = true;
          container.addEventListener('focusout', () => {
            setTimeout(() => {
              if (adminBonusRerenderQueued && !container.contains(document.activeElement)) {
                adminBonusRerenderQueued = false;
                renderAdminBonus();
              }
            }, 150);
          });
        }
        return;
      }
      adminBonusRerenderQueued = false;

      // Yeni oluşturma formundaki turnuva seçenekleri (config'i olmayanlar)
      const configured = new Set(bonusConfigs.map(c => c.tournament));
      const sel = document.getElementById('bonus-new-tournament');
      if (sel) {
        const current = sel.value;
        const options = knownTournaments().filter(t => !configured.has(t));
        sel.innerHTML = options.map(t =>
          `<option value="${escapeHTML(t)}" ${t === current ? 'selected' : ''}>${escapeHTML(t)}</option>`).join('');
      }

      if (!bonusConfigs.length) {
        container.innerHTML = `<div class="empty-badge">Henüz bonus tahmin açılmış turnuva yok.</div>`;
        return;
      }

      container.innerHTML = bonusConfigs.map(cfg => {
        ensureBonusPicks(cfg);
        const cache = bonusPicksCache[cfg.id];
        const docs = cache && Array.isArray(cache.docs) ? cache.docs : null;
        const positions = bonusPositionsFor(cfg);
        const approvedCount = docs ? docs.filter(p => p.approved).length : 0;

        let usersHTML;
        if (docs === null) {
          usersHTML = `<div class="empty-badge">Tahminler yükleniyor…</div>`;
        } else if (!docs.length) {
          usersHTML = `<div class="empty-badge">Henüz tahmin giren yok.</div>`;
        } else {
          usersHTML = docs.slice().sort((a, b) => {
            const na = usersMap[a.uid]?.displayName || a.name || '';
            const nb = usersMap[b.uid]?.displayName || b.name || '';
            return na.localeCompare(nb, 'tr');
          }).map(pick => {
            const name = usersMap[pick.uid]?.displayName || pick.name || 'Bilinmeyen';
            const awarded = pick.awarded || {};
            const quickPts = cfg.pointsPerCorrect || 10;
            const rows = positions.map(pos => {
              const team = (pick.picks || {})[pos] || '—';
              const val = awarded[pos] != null ? awarded[pos] : '';
              return `
                <div class="bonus-score-row">
                  <span class="bonus-pos-label">${bonusPositionLabel(pos)}</span>
                  <span class="bonus-score-team">${escapeHTML(team)}</span>
                  <input type="number" step="0.5" class="input-field bonus-score-input" data-pos="${pos}"
                         value="${val === '' ? '' : escapeHTML(String(val))}" placeholder="0">
                  ${cfg.mode !== 'champion' ? `<button type="button" class="btn btn-secondary btn-sm bonus-quick-btn" data-quick="${quickPts}">+${quickPts}</button>` : ''}
                </div>`;
            }).join('');
            return `
              <div class="bonus-admin-user" data-uid="${escapeHTML(pick.uid)}">
                <div class="bonus-admin-user-head">
                  <strong>${escapeHTML(name)}</strong>
                  ${pick.approved
                    ? `<span class="admin-mini-pill bonus-approved-pill">✅ Onaylı • ${formatPoints(Number(pick.total) || 0)} puan</span>`
                    : `<span class="admin-mini-pill">Puanlanmadı</span>`}
                </div>
                ${rows}
                <div class="bonus-score-row bonus-extra-row">
                  <span class="bonus-pos-label">Ekstra</span>
                  <span class="bonus-score-team">Ekstra puan (ops.)</span>
                  <input type="number" step="0.5" class="input-field bonus-score-input" data-extra="1"
                         value="${pick.extra != null && pick.extra !== 0 ? escapeHTML(String(pick.extra)) : ''}" placeholder="0">
                </div>
                <div class="bonus-admin-user-actions">
                  <span class="bonus-total-preview">Toplam: <b>0</b> puan</span>
                  <button type="button" class="btn btn-primary btn-sm bonus-save-btn">${pick.approved ? 'Güncelle ve Onayla' : 'Kaydet ve Onayla'}</button>
                  ${pick.approved ? `<button type="button" class="btn btn-secondary btn-sm bonus-unapprove-btn">Onayı Kaldır</button>` : ''}
                </div>
              </div>`;
          }).join('');
        }

        return `
          <details class="admin-day-group bonus-admin-card" data-bonus-id="${escapeHTML(cfg.id)}" ${adminBonusOpenSet.has(cfg.id) ? 'open' : ''}>
            <summary class="admin-day-summary">
              <span class="admin-day-title">🎯 ${escapeHTML(cfg.tournament)}</span>
              <span class="admin-day-meta">
                <span class="admin-mini-pill">${cfg.mode === 'champion' ? 'Şampiyon' : `İlk ${cfg.topCount || 6} + Son ${cfg.bottomCount || 3}`}</span>
                <span class="admin-mini-pill ${cfg.open === true ? 'bonus-pill-on' : ''}">${cfg.open === true ? 'Giriş AÇIK' : 'Giriş kapalı'}</span>
                <span class="admin-mini-pill ${cfg.pinned === true ? 'bonus-pill-on' : ''}">${cfg.pinned === true ? 'Arşivde sabit' : 'Sabit değil'}</span>
                <span class="admin-mini-pill ${(cfg.teams || []).length ? '' : 'bonus-pill-warn'}">${(cfg.teams || []).length || 'takım yok!'}${(cfg.teams || []).length ? ' takım' : ''}</span>
                ${docs ? `<span class="admin-mini-pill">${docs.length} tahmin • ${approvedCount} onaylı</span>` : ''}
              </span>
            </summary>
            <div class="admin-day-body">
              <div class="admin-btn-group bonus-admin-toggles">
                <button type="button" class="btn btn-secondary btn-sm" data-act="toggle-open">${cfg.open === true ? '🔒 Girişi Kapat' : '🔓 Girişi Aç'}</button>
                <button type="button" class="btn btn-secondary btn-sm" data-act="toggle-pin">${cfg.pinned === true ? '📌 Arşiv Sabitini Kaldır' : '📌 Arşivde Sabitle'}</button>
                <button type="button" class="btn btn-secondary btn-sm" data-act="refresh-teams">🔄 Takımları Yenile</button>
                <button type="button" class="btn btn-secondary btn-sm bonus-delete-btn" data-act="delete">🗑️ Sil</button>
              </div>
              ${(cfg.teams || []).length
                ? `<div class="bonus-teams-hint">Seçilebilir takımlar (${cfg.teams.length}): ${cfg.teams.map(t => escapeHTML(t)).join(' · ')}</div>`
                : `<div class="bonus-teams-hint bonus-teams-warn">⚠️ Takım listesi boş — kullanıcılar serbest yazacak. Fikstürü ekledikten sonra "Takımları Yenile"ye bas.</div>`}
              ${usersHTML}
            </div>
          </details>`;
      }).join('');

      // ---- Etkileşimler ----
      container.querySelectorAll('.bonus-admin-card').forEach(card => {
        const cfgId = card.dataset.bonusId;
        card.addEventListener('toggle', () => {
          if (card.open) adminBonusOpenSet.add(cfgId); else adminBonusOpenSet.delete(cfgId);
        });
        card.querySelectorAll('[data-act]').forEach(btn => {
          btn.addEventListener('click', () => {
            const act = btn.dataset.act;
            if (act === 'toggle-open') toggleBonusField(cfgId, 'open');
            else if (act === 'toggle-pin') toggleBonusField(cfgId, 'pinned');
            else if (act === 'refresh-teams') refreshBonusTeams(cfgId);
            else if (act === 'delete') deleteBonusConfig(cfgId);
          });
        });
        card.querySelectorAll('.bonus-admin-user').forEach(block => {
          const recalc = () => {
            let sum = 0;
            block.querySelectorAll('input[data-pos], input[data-extra]').forEach(inp => {
              const v = parseFloat(inp.value);
              if (!isNaN(v)) sum += v;
            });
            const preview = block.querySelector('.bonus-total-preview b');
            if (preview) preview.textContent = formatPoints(sum);
          };
          recalc();
          block.querySelectorAll('input').forEach(inp => inp.addEventListener('input', recalc));
          block.querySelectorAll('.bonus-quick-btn').forEach(qBtn => {
            qBtn.addEventListener('click', () => {
              const inp = qBtn.parentElement.querySelector('input[data-pos]');
              if (inp) { inp.value = qBtn.dataset.quick; recalc(); }
            });
          });
          const saveBtn = block.querySelector('.bonus-save-btn');
          if (saveBtn) saveBtn.addEventListener('click', () => adminSaveBonusScore(cfgId, block.dataset.uid, block, saveBtn));
          const unBtn = block.querySelector('.bonus-unapprove-btn');
          if (unBtn) unBtn.addEventListener('click', () => adminUnapproveBonus(cfgId, block.dataset.uid));
        });
      });
    }

    // Kullanıcının bonus puanlarını kaydet + onayla; toplam settings/bonus'a yazılır
    // (mutlak değer — düzenlemede fark hesabı gerekmez).
    async function adminSaveBonusScore(cfgId, uid, block, saveBtn) {
      const cfg = bonusConfigs.find(c => c.id === cfgId);
      if (!cfg || !isAdmin || !uid) return;

      const awarded = {};
      let sum = 0;
      block.querySelectorAll('input[data-pos]').forEach(inp => {
        const v = parseFloat(inp.value);
        if (!isNaN(v) && v !== 0) { awarded[inp.dataset.pos] = v; sum += v; }
      });
      const extraRaw = parseFloat(block.querySelector('input[data-extra]')?.value);
      const extra = !isNaN(extraRaw) ? extraRaw : 0;
      const total = sum + extra;

      if (saveBtn) saveBtn.disabled = true;
      try {
        const batch = db.batch();
        // update(): awarded haritası olduğu gibi DEĞİŞTİRİLİR (set+merge eski
        // puanları haritada bırakırdı; admin bir puanı silince kalıntı kalmasın).
        batch.update(db.collection('bonus').doc(cfgId).collection('picks').doc(uid), {
          awarded, extra, total,
          approved: true,
          scoredAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        batch.set(db.collection('settings').doc('bonus'), {
          byTournament: { [cfg.tournament]: { [uid]: total } }
        }, { merge: true });
        await batch.commit();
        const name = usersMap[uid]?.displayName || 'Kullanıcı';
        showToast(`${name}: ${formatPoints(total)} bonus puan onaylandı ve puan durumuna eklendi.`, 'success');
      } catch (e) {
        console.error(e);
        showToast('Puan kaydedilemedi.', 'error');
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    }

    async function adminUnapproveBonus(cfgId, uid) {
      const cfg = bonusConfigs.find(c => c.id === cfgId);
      if (!cfg || !isAdmin || !uid) return;
      try {
        const batch = db.batch();
        batch.set(db.collection('bonus').doc(cfgId).collection('picks').doc(uid), {
          approved: false
        }, { merge: true });
        batch.set(db.collection('settings').doc('bonus'), {
          byTournament: { [cfg.tournament]: { [uid]: firebase.firestore.FieldValue.delete() } }
        }, { merge: true });
        await batch.commit();
        showToast('Onay kaldırıldı; puan durumundan çıkarıldı.', 'success');
      } catch (e) {
        console.error(e);
        showToast('Onay kaldırılamadı.', 'error');
      }
    }

    // ================== ADMIN ==================
    function formatAdminPendingDay(dateStr) {
      const dt = parseDateTime(dateStr, '12:00');
      return dt ? formatDayHeading(dt) : (dateStr || 'Tarih belirtilmedi');
    }

    function createAdminDayGroup(title, metaHTML, open = false) {
      const group = document.createElement('details');
      group.className = 'admin-day-group';
      group.open = open;
      group.innerHTML = `
        <summary class="admin-day-summary">
          <span class="admin-day-title">${escapeHTML(title)}</span>
          <span class="admin-day-meta">${metaHTML}</span>
        </summary>
        <div class="admin-day-body"></div>
      `;
      return group;
    }

    function appendAdminDayGroups(container, entries, options = {}) {
      const {
        emptyHTML = `<div class="empty-badge">Mac bulunmuyor.</div>`,
        newestFirst = false,
        collapsed = false,        // true → tüm gün grupları kapalı başlar
        dayLimit = Infinity,      // gösterilecek azami gün (grup) sayısı
        onLoadMore = null,        // limit aşıldığında "Daha Fazla Yükle" butonunun callback'i
        loadMoreStep = 5,
        groupByTournament = false // true → üst seviye turnuva etiketi, altında hafta/gün grupları
      } = options;
      container.innerHTML = '';
      if (!entries.length) {
        container.innerHTML = emptyHTML;
        return;
      }

      if (groupByTournament) {
        const byTournament = new Map();
        entries.forEach(entry => {
          const t = tournamentOf(entry.match);
          if (!byTournament.has(t)) byTournament.set(t, []);
          byTournament.get(t).push(entry);
        });

        const earliest = list => Math.min(...list.map(e => e.match.datetime?.getTime() || Infinity));
        const list = document.createElement('div');
        list.className = 'admin-day-list';
        Array.from(byTournament.entries())
          .sort((a, b) => earliest(a[1]) - earliest(b[1]))
          .forEach(([tournament, tEntries], idx) => {
            const missing = tEntries.reduce((sum, item) => sum + (item.missingCount || 0), 0);
            const meta = `
              <span class="admin-mini-pill">${tEntries.length} mac</span>
              ${missing ? `<span class="admin-mini-pill warn">${missing} eksik tahmin</span>` : `<span class="admin-mini-pill">tamam</span>`}
            `;
            const outer = createAdminDayGroup(`🏆 ${tournament}`, meta, idx === 0);
            const body = outer.querySelector('.admin-day-body');
            appendAdminDayGroups(body, tEntries, { ...options, groupByTournament: false });
            list.appendChild(outer);
          });
        container.appendChild(list);
        return;
      }

      const groups = new Map();
      entries.forEach(entry => {
        const match = entry.match;
        // Haftası girilmiş maçlar hafta başlığı altında toplanır (turnuva bazında),
        // haftasızlar bugünkü gibi güne göre gruplanır.
        const key = match.week != null
          ? `w|${tournamentOf(match)}|${match.week}`
          : getDayKey(match.datetime);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
      });

      const sortedGroups = Array.from(groups.values()).sort((a, b) => {
        const at = a[0].match.datetime?.getTime() || 0;
        const bt = b[0].match.datetime?.getTime() || 0;
        return newestFirst ? bt - at : at - bt;
      });

      const visibleGroups = sortedGroups.slice(0, dayLimit);

      const list = document.createElement('div');
      list.className = 'admin-day-list';
      visibleGroups.forEach((dayEntries, idx) => {
        dayEntries.sort((a, b) => (a.match.datetime?.getTime() || 0) - (b.match.datetime?.getTime() || 0));
        const firstMatch = dayEntries[0].match;
        const title = firstMatch.week != null
          ? `${firstMatch.week}. Hafta${firstMatch.dateTbd ? ' — tarih bekleniyor' : ` — ${formatDayHeading(firstMatch.datetime)}`}`
          : formatDayHeading(firstMatch.datetime);
        const missing = dayEntries.reduce((sum, item) => sum + (item.missingCount || 0), 0);
        const meta = `
          <span class="admin-mini-pill">${dayEntries.length} mac</span>
          ${missing ? `<span class="admin-mini-pill warn">${missing} eksik tahmin</span>` : `<span class="admin-mini-pill">tamam</span>`}
        `;
        const group = createAdminDayGroup(title, meta, collapsed ? false : idx === 0);
        const body = group.querySelector('.admin-day-body');
        dayEntries.forEach(item => body.appendChild(item.node));
        list.appendChild(group);
      });
      container.appendChild(list);

      if (onLoadMore && sortedGroups.length > visibleGroups.length) {
        const remaining = sortedGroups.length - visibleGroups.length;
        const step = Math.min(loadMoreStep, remaining);
        const more = document.createElement('div');
        more.style.textAlign = 'center';
        more.style.marginTop = '1rem';
        const btn = document.createElement('button');
        btn.className = 'btn btn-secondary';
        btn.textContent = `Daha Fazla Yükle (+${step} gün)`;
        btn.onclick = onLoadMore;
        more.appendChild(btn);
        container.appendChild(more);
      }
    }

    function handleAdminScoreKey(event, matchId) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      saveResult(matchId);
    }

    function handleAdminPredictionKey(event, matchId) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      adminSetPrediction(matchId);
    }

    // Builds one editable admin match card. `picks` is a normalised list:
    //   { uid, displayName, homePred, awayPred, pts }  (pts may be null = "awaiting result")
    function buildAdminMatchItem(match, picks) {
      const formatted = formatMatchTime(match.datetime);
      const hasResult = match.homeScore != null && match.awayScore != null;
      const dateAttr = formatDateInput(match.datetime);
      const timeAttr = match.datetime
        ? `${String(match.datetime.getHours()).padStart(2, '0')}:${String(match.datetime.getMinutes()).padStart(2, '0')}`
        : '';
      const hValAttr = hasResult ? match.homeScore : '';
      const aValAttr = hasResult ? match.awayScore : '';
      const opAttr = match.outcomePoints != null ? match.outcomePoints : '';
      const spAttr = match.scorePoints != null ? match.scorePoints : '';
      const predUids = new Set(picks.map(p => p.uid));
      const totalUsers = Object.keys(usersMap).length;
      const missingCount = Math.max(0, totalUsers - predUids.size);

      const userOptions = Object.values(usersMap)
        .sort((a, b) => (a.displayName || a.email || '').localeCompare(b.displayName || b.email || '', 'tr'))
        .map(u => {
          const label = (u.displayName || u.email || 'Oyuncu') + (predUids.has(u.uid) ? ' ✓' : '');
          return `<option value="${u.uid}">${escapeHTML(label)}</option>`;
        }).join('');
      const addFormHTML = userOptions
        ? `
          <div class="admin-pred-add">
            <span class="admin-pred-pts-label">Adına yaz</span>
            <select id="admin-pred-user-${match.id}" class="admin-pred-select">${userOptions}</select>
            <input id="admin-pred-h-${match.id}" type="number" min="0" max="20" placeholder="0" class="score-number-input" onfocus="this.select()" onkeydown="handleAdminPredictionKey(event, '${match.id}')">
            <span class="score-sep">-</span>
            <input id="admin-pred-a-${match.id}" type="number" min="0" max="20" placeholder="0" class="score-number-input" onfocus="this.select()" onkeydown="handleAdminPredictionKey(event, '${match.id}')">
            <button onclick="adminSetPrediction('${match.id}')" class="btn btn-sm btn-accent-outline">Tahmin Yaz</button>
          </div>
        `
        : `<div class="admin-pred-empty">Kullanıcı bulunmuyor.</div>`;

      const rows = picks.map(p => {
        const pts = p.pts;
        const ptsBadge = pts == null
          ? `<span class="admin-pred-suggest">sonuç bekleniyor</span>`
          : `<span class="result-points-earned ${pts === 0 ? 'zero' : ''}">+${formatPoints(pts)}</span>`;
        const odd = scoreOddFor(match, p.homePred, p.awayPred);
        return `
          <div class="admin-pred-row">
            <span class="admin-pred-user" title="${escapeHTML(p.displayName)}">${escapeHTML(p.displayName)}</span>
            <span class="admin-pred-pick">${p.homePred}-${p.awayPred}</span>
            <span class="pick-odd admin-pred-odd">${odd ? formatScoreOdd(match, odd) : ''}</span>
            <span class="admin-pred-side">${ptsBadge}</span>
          </div>
        `;
      }).join('');

      const predsHTML = `
        <details class="admin-pred-details">
          <summary class="admin-pred-summary">
            <span>${picks.length} tahmin${missingCount ? ` - ${missingCount} eksik` : ''}</span>
          </summary>
          <div class="admin-pred-list">
          ${addFormHTML}
          ${picks.length ? rows : `<div class="admin-pred-empty">Bu maç için henüz tahmin yapılmadı.</div>`}
          </div>
        </details>
      `;

      const div = document.createElement('div');
      div.className = 'admin-match-item';
      div.innerHTML = `
        <div class="admin-match-head">
          <div class="admin-match-headline">
            <span class="admin-match-teams">
              <span class="t-home">${escapeHTML(match.homeTeam)}</span>
              <span class="t-vs">vs</span>
              <span class="t-away">${escapeHTML(match.awayTeam)}</span>
            </span>
            <div class="admin-match-sub">
              <span class="admin-match-date">${formatted}</span>
              ${tournamentBadge(match)}
              ${match.week ? `<span class="admin-mini-pill">${match.week}. Hafta</span>` : ''}
              ${match.postponed ? `<span class="admin-mini-pill warn">Ertelendi</span>` : (match.dateTbd ? `<span class="admin-mini-pill warn">tarih onay bekliyor</span>` : '')}
              ${hasResult ? `<span class="admin-mini-pill">sonuç girildi</span>` : ''}
              ${missingCount ? `<span class="admin-mini-pill warn">${missingCount} eksik tahmin</span>` : `<span class="admin-mini-pill">tahminler tam</span>`}
            </div>
          </div>
          <button onclick="deleteMatch('${match.id}')" class="btn-delete-match" title="Maçı Sil">×</button>
        </div>

        <div class="admin-match-settings">
          <div class="admin-settings-group">
            <span class="admin-group-label">Tarih &amp; Saat</span>
            <div class="admin-group-fields">
              <div class="admin-mini-field">
                <label>Tarih</label>
                <input id="res-date-${match.id}" type="text" value="${dateAttr}" placeholder="GG.AA.YYYY" class="score-number-input date-field" onfocus="this.select()" onkeydown="handleAdminScoreKey(event, '${match.id}')">
              </div>
              <div class="admin-mini-field">
                <label>Saat</label>
                <input id="res-time-${match.id}" type="text" value="${timeAttr}" placeholder="SS:dd" class="score-number-input time-field" onfocus="this.select()" onkeydown="handleAdminScoreKey(event, '${match.id}')">
              </div>
              <div class="admin-mini-field">
                <label>Hafta</label>
                <input id="res-week-${match.id}" type="number" min="1" max="60" value="${match.week || ''}" placeholder="—" class="score-number-input" onfocus="this.select()" onkeydown="handleAdminScoreKey(event, '${match.id}')">
              </div>
              ${!hasResult ? `<button onclick="postponeMatch('${match.id}')" class="btn btn-sm btn-secondary" title="Tarihi belirsize al (yeni tarih Nesine'den önerilir)">⏸ Ertele</button>` : ''}
            </div>
          </div>

          <div class="admin-settings-group result-group">
            <span class="admin-group-label">Maç Sonucu</span>
            <div class="admin-group-fields">
              <div class="admin-mini-field">
                <label>${escapeHTML(match.homeTeam)}</label>
                <input id="res-h-${match.id}" type="number" value="${hValAttr}" min="0" placeholder="-" class="score-number-input" onfocus="this.select()" onkeydown="handleAdminScoreKey(event, '${match.id}')">
              </div>
              <span class="admin-score-sep">-</span>
              <div class="admin-mini-field">
                <label>${escapeHTML(match.awayTeam)}</label>
                <input id="res-a-${match.id}" type="number" value="${aValAttr}" min="0" placeholder="-" class="score-number-input" onfocus="this.select()" onkeydown="handleAdminScoreKey(event, '${match.id}')">
              </div>
            </div>
          </div>

          <div class="admin-settings-group">
            <span class="admin-group-label">Puanlama</span>
            <div class="admin-group-fields">
              <div class="admin-mini-field">
                <label title="Doğru sonuç (kazanan/berabere) puanı">Sonuç P.</label>
                <input id="res-op-${match.id}" type="number" value="${opAttr}" min="0" step="0.01" placeholder="0" class="score-number-input wide" onfocus="this.select()" onkeydown="handleAdminScoreKey(event, '${match.id}')">
              </div>
              <div class="admin-mini-field">
                <label title="Tam skor puanı">Tam Skor P.</label>
                <input id="res-sp-${match.id}" type="number" value="${spAttr}" min="0" step="0.01" placeholder="0" class="score-number-input wide" onfocus="this.select()" onkeydown="handleAdminScoreKey(event, '${match.id}')">
              </div>
            </div>
          </div>

          <div class="admin-settings-save">
            <button onclick="saveResult('${match.id}')" class="btn btn-sm btn-primary">Kaydet</button>
            ${hasResult ? `<span class="badge-saved">✓</span>` : ''}
          </div>
        </div>
        ${predsHTML}
      `;
      return div;
    }

    // Active matches are split by prediction window:
    //   main list   → prediction window is still open
    //   closed list → prediction window is closed and the result is waiting
    const ADMIN_MAIN_DAY_STEP = 5;       // "Maç Sonuçları & Düzenleme" listesi her seferinde +5 gün yükler
    let adminMainDaysShown = ADMIN_MAIN_DAY_STEP;

    function renderAdminMatches() {
      const mainC = document.getElementById('admin-matches-list');
      const closedC = document.getElementById('admin-closed-list');
      if (!mainC) return;
      mainC.innerHTML = '';
      if (closedC) closedC.innerHTML = '';

      const totalUsers = Object.keys(usersMap).length;
      const active = matches.slice().sort((a, b) => (a.datetime?.getTime() || 0) - (b.datetime?.getTime() || 0));

      if (!active.length) {
        mainC.innerHTML = `<div class="empty-badge">Maç bulunmuyor.</div>`;
        if (closedC) closedC.innerHTML = `<div class="empty-badge">—</div>`;
        return;
      }

      const mainEntries = [];
      const closedEntries = [];
      active.forEach(match => {
        const preds = getPredictionsForMatch(match.id);
        const picks = preds.map(p => ({
          uid: p.uid, displayName: p.displayName,
          homePred: p.homePred, awayPred: p.awayPred,
          pts: autoPointsFor(p, match)
        }));
        const predictedCount = new Set(picks.map(p => p.uid)).size;
        const missingCount = Math.max(0, totalUsers - predictedCount);
        const predictionClosed = !canPredict(match.datetime);
        const item = buildAdminMatchItem(match, picks);
        const entry = { match, node: item, missingCount };
        if (predictionClosed && closedC) closedEntries.push(entry);
        else mainEntries.push(entry);
      });

      appendAdminDayGroups(mainC, mainEntries, {
        emptyHTML: `<div class="empty-badge">Tahmin süresi devam eden aktif maç yok.</div>`,
        collapsed: true,
        dayLimit: adminMainDaysShown,
        loadMoreStep: ADMIN_MAIN_DAY_STEP,
        onLoadMore: () => { adminMainDaysShown += ADMIN_MAIN_DAY_STEP; renderAdminMatches(); }
      });
      if (closedC) {
        appendAdminDayGroups(closedC, closedEntries, {
          emptyHTML: `<div class="empty-badge">Tahmine kapanan ve sonuç bekleyen maç yok.</div>`
        });
      }
    }

    function isAdminFutureFixturesOpen() {
      const body = document.getElementById('admin-future-body');
      return !!body && !body.classList.contains('hidden');
    }

    function resetFutureFixturePaging(loadIfOpen = true) {
      futureFixtureDocs = [];
      futureFixtureCursor = null;
      futureFixtureHasMore = true;
      futureFixtureLoading = false;
      futureFixtureLoaded = false;
      futureFixtureError = '';
      futureFixtureWindowStart = new Date();
      renderAdminFutureFixtures();
      if (loadIfOpen && isAdmin && isAdminFutureFixturesOpen()) loadMoreFutureFixtures();
    }

    async function loadMoreFutureFixtures() {
      if (!isAdmin || futureFixtureLoading || !futureFixtureHasMore) return;
      if (!futureFixtureWindowStart) futureFixtureWindowStart = new Date();

      futureFixtureLoading = true;
      futureFixtureError = '';
      renderAdminFutureFixtures();
      try {
        let q = db.collection('matches')
          .where('datetime', '>=', firebase.firestore.Timestamp.fromDate(futureFixtureWindowStart))
          .orderBy('datetime', 'asc')
          .limit(FUTURE_FIXTURE_PAGE_SIZE);
        if (futureFixtureCursor) q = q.startAfter(futureFixtureCursor);

        const snap = await q.get();
        futureFixtureLoaded = true;
        if (snap.docs.length) futureFixtureCursor = snap.docs[snap.docs.length - 1];

        const seen = new Set(futureFixtureDocs.map(match => match.id));
        snap.docs.map(mapMatchDoc).forEach(match => {
          if (!seen.has(match.id)) {
            seen.add(match.id);
            futureFixtureDocs.push(match);
          }
        });
        futureFixtureDocs.sort((a, b) => (a.datetime?.getTime() || 0) - (b.datetime?.getTime() || 0));
        if (snap.docs.length < FUTURE_FIXTURE_PAGE_SIZE) futureFixtureHasMore = false;
      } catch (e) {
        console.error(e);
        futureFixtureLoaded = true;
        futureFixtureError = e.message || 'Gelecek fikstür yüklenemedi.';
        showToast('Gelecek fikstür yüklenemedi.', 'error');
      } finally {
        futureFixtureLoading = false;
        renderAdminFutureFixtures();
      }
    }

    function renderAdminFutureFixtures() {
      const container = document.getElementById('admin-future-list');
      if (!container) return;

      if (!futureFixtureDocs.length) {
        if (futureFixtureLoading) {
          container.innerHTML = `<div class="empty-badge">Gelecek fikstür yükleniyor…</div>`;
        } else if (futureFixtureError) {
          container.innerHTML = `
            <div class="empty-badge">Fikstür yüklenemedi.</div>
            <div style="text-align:center; margin-top:1rem;">
              <button onclick="loadMoreFutureFixtures()" class="btn btn-secondary">Tekrar Dene</button>
            </div>`;
        } else if (futureFixtureLoaded && !futureFixtureHasMore) {
          container.innerHTML = `<div class="empty-badge">Gelecek tarihli maç bulunmuyor.</div>`;
        } else {
          container.innerHTML = `<div class="empty-badge">Fikstürü görüntülemek için bölümü aç.</div>`;
        }
        return;
      }

      const entries = futureFixtureDocs.map(match => {
        const picks = getPredictionsForMatch(match.id).map(prediction => ({
          uid: prediction.uid,
          displayName: prediction.displayName,
          homePred: prediction.homePred,
          awayPred: prediction.awayPred,
          pts: autoPointsFor(prediction, match)
        }));
        const predictedCount = new Set(picks.map(pick => pick.uid)).size;
        return {
          match,
          node: buildAdminMatchItem(match, picks),
          missingCount: Math.max(0, Object.keys(usersMap).length - predictedCount)
        };
      });

      appendAdminDayGroups(container, entries, { collapsed: true, groupByTournament: true });
      const footer = document.createElement('div');
      footer.style.textAlign = 'center';
      footer.style.marginTop = '1rem';
      if (futureFixtureError) {
        footer.innerHTML = `<button onclick="loadMoreFutureFixtures()" class="btn btn-secondary">Yüklemeyi Tekrar Dene</button>`;
      } else if (futureFixtureHasMore) {
        footer.innerHTML = `<button onclick="loadMoreFutureFixtures()" class="btn btn-secondary" ${futureFixtureLoading ? 'disabled' : ''}>${futureFixtureLoading ? 'Yükleniyor…' : `Daha Fazla Yükle (+${FUTURE_FIXTURE_PAGE_SIZE} maç)`}</button>`;
      } else {
        footer.innerHTML = `<span class="empty-badge">Tüm gelecek fikstür yüklendi.</span>`;
      }
      container.appendChild(footer);
    }

    // Finalised (result entered) matches — paginated, still editable by the admin.
    function renderAdminArchive() {
      const c = document.getElementById('admin-archive-list');
      if (!c) return;
      if (!optimizedMode) {
        c.innerHTML = `<div class="empty-badge">Arşiv görünümü, aşağıdaki "Yeniden Hesapla" çalıştırıldıktan sonra aktif olur.</div>`;
        return;
      }
      if (!archiveDocs.length) {
        c.innerHTML = archiveLoading
          ? `<div class="empty-badge">Yükleniyor…</div>`
          : `<div class="empty-badge">Sonucu girilmiş (arşivlenmiş) maç yok.</div>`;
        return;
      }

      // En eski en altta (yeni → eski)
      archiveDocs.sort((a, b) => (b.datetime?.getTime() || 0) - (a.datetime?.getTime() || 0));

      const archiveEntries = [];
      archiveDocs.forEach(match => {
        const sb = Array.isArray(match.scoreboard) ? match.scoreboard : [];
        const picks = sb.map(s => ({ uid: s.uid, displayName: s.name, homePred: s.h, awayPred: s.a, pts: s.pts }));
        archiveEntries.push({ match, node: buildAdminMatchItem(match, picks), missingCount: 0 });
      });
      appendAdminDayGroups(c, archiveEntries, { newestFirst: true });
      const more = document.createElement('div');
      more.style.textAlign = 'center';
      more.style.marginTop = '1rem';
      more.innerHTML = archiveHasMore
        ? `<button onclick="loadMoreArchive()" class="btn btn-secondary" ${archiveLoading ? 'disabled' : ''}>${archiveLoading ? 'Yükleniyor…' : `Daha Fazla Yükle (+${ARCHIVE_PAGE_SIZE})`}</button>`
        : `<span class="empty-badge">Tüm arşiv yüklendi.</span>`;
      c.appendChild(more);
    }

    // One-time migration / drift-fix: load everything once, freeze every finished match's
    // scoreboard, set the `finalized` flag on all matches, and rebuild the aggregate totals.
    // Nesine oranı eksik maçları hemen tarat (retryMissingOdds'un manuel tetiklenmesi).
    async function checkMissingOddsNow() {
      if (!isAdmin) return;
      const btn = document.getElementById('odds-check-btn');
      const resultBox = document.getElementById('odds-check-result');
      btn.disabled = true;
      btn.textContent = '⏳ Nesine bülteni taranıyor…';
      resultBox.innerHTML = '';
      try {
        const res = await fetch('https://europe-west1-aefy-lig.cloudfunctions.net/nesineHealthCheck?run=1');
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Bilinmeyen hata');

        const rows = data.matches || [];
        const foundNow = rows.filter(m => m.odds === 'found_now');
        const stillMissing = rows.filter(m => m.odds === 'not_found' || String(m.odds).startsWith('error'));

        if (foundNow.length) {
          showToast(`${foundNow.length} maçın oranı bulundu ve eklendi.`, 'success');
        } else if (stillMissing.length) {
          showToast('Yeni oran bulunamadı; eksik maçlar henüz Nesine bülteninde yok.', 'warning');
        } else {
          showToast('Tüm maçların oranları zaten çekilmiş.', 'success');
        }

        const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const line = (m, icon, note) =>
          `<div style="font-size:0.78rem; padding:2px 0;">${icon} ${esc(m.match)} <span style="color:var(--text-muted);">— ${note}</span></div>`;
        resultBox.innerHTML =
          foundNow.map(m => line(m, '✅', 'oran eklendi')).join('') +
          stillMissing.map(m => line(m, '⏳', 'bültende bulunamadı')).join('') ||
          '<div style="font-size:0.78rem; color:var(--text-muted);">Oranı eksik maç yok.</div>';
      } catch (err) {
        showToast('Oran kontrolü başarısız: ' + (err.message || err), 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '🔄 Oranları Şimdi Kontrol Et';
      }
    }

    // Nesine bülteninde takım adı arar (nesineHealthCheck?grep=...). Maç "bulunamadı"
    // görünüyorsa sunucunun gördüğü bültende olup olmadığını buradan teşhis ederiz.
    const NESINE_SPORT_NAMES = { 1: 'Futbol', 2: 'Basketbol', 5: 'Tenis', 6: 'Voleybol', 23: 'Hentbol' };
    async function searchNesineBulletin() {
      if (!isAdmin) return;
      const input = document.getElementById('bulletin-search-input');
      const btn = document.getElementById('bulletin-search-btn');
      const resultBox = document.getElementById('bulletin-search-result');
      const query = (input.value || '').trim();
      if (!query) { input.focus(); return; }

      btn.disabled = true;
      btn.textContent = '⏳ Aranıyor…';
      resultBox.innerHTML = '';
      try {
        const res = await fetch('https://europe-west1-aefy-lig.cloudfunctions.net/nesineHealthCheck?grep=' + encodeURIComponent(query));
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Bilinmeyen hata');

        const hits = data.hits || [];
        if (!hits.length) {
          resultBox.innerHTML = `<div style="font-size:0.78rem; color:var(--text-muted);">"${escapeHTML(query)}" için bültende maç bulunamadı. Bülten bayat olabilir — birkaç dakika sonra tekrar dene.</div>`;
          return;
        }
        const rows = hits.map(h => {
          const sport = NESINE_SPORT_NAMES[h.GT] || `Spor #${h.GT}`;
          const sportStyle = h.GT === 1 ? '' : ' color:var(--text-muted);';
          const marketNote = h.markets ? `${h.markets} market` : 'oran açılmamış';
          return `<div style="font-size:0.78rem; padding:3px 0;${sportStyle}">
              ${h.GT === 1 ? '⚽' : '▪️'} <strong>${escapeHTML(h.HN)} - ${escapeHTML(h.AN)}</strong>
              <span style="color:var(--text-muted);">— ${escapeHTML(h.D)} ${escapeHTML(h.T)} • ${sport} • ${marketNote}</span>
            </div>`;
        }).join('');
        resultBox.innerHTML =
          `<div style="font-size:0.72rem; color:var(--text-muted); margin-bottom:4px;">Bültende ${data.footballEventCount} futbol maçı tarandı, ${hits.length} eşleşme:</div>` + rows;
      } catch (err) {
        showToast('Bülten araması başarısız: ' + (err.message || err), 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '🔍 Bültende Ara';
      }
    }

    // ================== TARİH ÖNERİLERİ (hafta bazlı / dateTbd maçlar) ==================
    // dateTbd:true maçların gerçek tarihleri Cloud Function tarafından Nesine'den
    // bulunup proposedDatetime alanına yazılır; buradaki liste admin onayı içindir.
    let dateProposalDocs = [];
    const DATE_PROPOSAL_NO_PROPOSAL_LIMIT = 12;

    function proposalDateOf(match) {
      const raw = match.proposedDatetime;
      if (!raw) return null;
      return raw.toDate ? raw.toDate() : new Date(raw);
    }

    async function loadDateProposals() {
      if (!isAdmin) return;
      const container = document.getElementById('date-proposals-list');
      if (!container) return;
      try {
        const snap = await db.collection('matches').where('dateTbd', '==', true).get();
        dateProposalDocs = snap.docs.map(mapMatchDoc)
          .filter(m => !m.finalized)
          .sort((a, b) => (a.datetime?.getTime() || 0) - (b.datetime?.getTime() || 0));
      } catch (e) {
        console.error(e);
        container.innerHTML = `<div class="empty-badge">Tarih önerileri yüklenemedi.</div>`;
        return;
      }
      renderDateProposals();
    }

    function formatProposalDate(date) {
      if (!date) return '—';
      return date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'short' })
        + ' ' + date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    }

    function renderDateProposals() {
      const container = document.getElementById('date-proposals-list');
      if (!container) return;

      if (!dateProposalDocs.length) {
        container.innerHTML = `<div class="empty-badge">Tarih onayı bekleyen maç yok.</div>`;
        return;
      }

      const pending = dateProposalDocs.filter(m => m.proposalStatus === 'pending');
      const others = dateProposalDocs.filter(m => m.proposalStatus !== 'pending');
      const nowMs = Date.now();

      const row = (m) => {
        const proposal = proposalDateOf(m);
        const isPending = m.proposalStatus === 'pending';
        const urgent = !isPending && m.datetime && (m.datetime.getTime() - nowMs) < 48 * 60 * 60 * 1000;
        const weekPill = m.week ? `<span class="admin-mini-pill">${m.week}. Hafta</span>` : '';
        const postponedPill = m.postponed ? `<span class="admin-mini-pill warn">Ertelendi</span>` : '';
        const statusHTML = isPending
          ? `<span class="proposal-new-date">→ ${escapeHTML(formatProposalDate(proposal))}</span>
             <button onclick="approveProposal('${m.id}')" class="btn btn-sm btn-primary">Onayla</button>
             <button onclick="rejectProposal('${m.id}')" class="btn btn-sm btn-secondary">Reddet</button>`
          : (m.proposalStatus === 'rejected'
            ? `<span class="admin-mini-pill">öneri reddedildi</span>`
            : `<span class="admin-mini-pill${urgent ? ' warn' : ''}">${urgent ? 'yer tutucu yaklaşıyor — bültende yok' : 'Nesine bülteninde henüz yok'}</span>`);
        return `
          <div class="date-proposal-row${isPending ? ' pending' : ''}">
            <div class="date-proposal-info">
              <span class="pending-teams">
                <span class="t-home">${escapeHTML(m.homeTeam)}</span>
                <span class="t-vs">—</span>
                <span class="t-away">${escapeHTML(m.awayTeam)}</span>
              </span>
              ${weekPill}${postponedPill}
              <span class="proposal-placeholder" title="Yer tutucu tarih">${escapeHTML(formatProposalDate(m.datetime))}</span>
            </div>
            <div class="date-proposal-actions">${statusHTML}</div>
          </div>
        `;
      };

      const othersShown = others.slice(0, DATE_PROPOSAL_NO_PROPOSAL_LIMIT);
      const approveAll = pending.length > 1
        ? `<div style="margin-bottom:0.5rem;"><button onclick="approveAllProposals()" class="btn btn-sm btn-primary">✓ Tümünü Onayla (${pending.length})</button></div>`
        : '';
      const rest = others.length > othersShown.length
        ? `<div class="empty-badge" style="margin-top:0.4rem;">+ ${others.length - othersShown.length} maç daha tarih bekliyor (en yakınlar gösteriliyor).</div>`
        : '';

      container.innerHTML = `
        ${approveAll}
        ${pending.map(row).join('')}
        ${othersShown.map(row).join('')}
        ${rest}
      `;
    }

    async function approveProposal(matchId) {
      const m = dateProposalDocs.find(d => d.id === matchId);
      const proposal = m && proposalDateOf(m);
      if (!proposal) { showToast('Önerilen tarih bulunamadı.', 'error'); return; }
      try {
        await db.collection('matches').doc(matchId).update({
          datetime: firebase.firestore.Timestamp.fromDate(proposal),
          dateTbd: firebase.firestore.FieldValue.delete(),
          postponed: firebase.firestore.FieldValue.delete(),
          proposedDatetime: firebase.firestore.FieldValue.delete(),
          proposalStatus: firebase.firestore.FieldValue.delete(),
          proposalSource: firebase.firestore.FieldValue.delete(),
          proposalCheckedAt: firebase.firestore.FieldValue.delete()
        });
        resetFutureFixturePaging();
        showToast('Tarih onaylandı.', 'success');
        loadDateProposals();
      } catch (e) {
        console.error(e);
        showToast('Tarih onaylanamadı.', 'error');
      }
    }

    async function approveAllProposals() {
      const pending = dateProposalDocs.filter(m => m.proposalStatus === 'pending' && proposalDateOf(m));
      if (!pending.length) return;
      if (!confirm(`${pending.length} maçın önerilen tarihi onaylanacak. Emin misin?`)) return;
      try {
        const batch = db.batch();
        pending.forEach(m => {
          batch.update(db.collection('matches').doc(m.id), {
            datetime: firebase.firestore.Timestamp.fromDate(proposalDateOf(m)),
            dateTbd: firebase.firestore.FieldValue.delete(),
            postponed: firebase.firestore.FieldValue.delete(),
            proposedDatetime: firebase.firestore.FieldValue.delete(),
            proposalStatus: firebase.firestore.FieldValue.delete(),
            proposalSource: firebase.firestore.FieldValue.delete(),
            proposalCheckedAt: firebase.firestore.FieldValue.delete()
          });
        });
        await batch.commit();
        resetFutureFixturePaging();
        showToast(`${pending.length} maçın tarihi onaylandı.`, 'success');
        loadDateProposals();
      } catch (e) {
        console.error(e);
        showToast('Toplu onay başarısız.', 'error');
      }
    }

    async function rejectProposal(matchId) {
      try {
        // proposedDatetime silinmez: senkron aynı tarihi tekrar önermesin diye saklanır.
        await db.collection('matches').doc(matchId).update({ proposalStatus: 'rejected' });
        showToast('Öneri reddedildi. Yeni/farklı tarih bulunursa tekrar önerilecek.', 'success');
        loadDateProposals();
      } catch (e) {
        console.error(e);
        showToast('İşlem başarısız.', 'error');
      }
    }

    async function requestFixtureDateSync() {
      if (!isAdmin) return;
      const btn = document.getElementById('date-sync-btn');
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Nesine bülteni taranıyor…'; }
      try {
        const res = await fetch('https://europe-west1-aefy-lig.cloudfunctions.net/fixtureDateSyncNow');
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Bilinmeyen hata');
        if (!data.checked) {
          showToast('Tarih bekleyen maç yok (önümüzdeki 10 gün penceresinde).', 'success');
        } else if (data.proposed) {
          showToast(`${data.proposed} maç için tarih bulundu — aşağıdan onaylayabilirsin.`, 'success');
        } else {
          showToast(`Tarih bulunamadı; ${data.unmatched} maç henüz Nesine bülteninde yok.`, 'warning');
        }
        loadDateProposals();
      } catch (err) {
        showToast('Tarih kontrolü başarısız: ' + (err.message || err), 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "🔄 Nesine'den Tarihleri Çek"; }
      }
    }

    // Bekleyen maçların skorlarını Nesine canlı skor servisinden hemen tarat
    // (autoFetchScores'un manuel tetiklenmesi).
    async function checkPendingScoresNow() {
      if (!isAdmin) return;
      const btn = document.getElementById('score-check-btn');
      const resultBox = document.getElementById('score-check-result');
      btn.disabled = true;
      btn.textContent = '⏳ Skorlar taranıyor…';
      resultBox.innerHTML = '';
      try {
        const res = await fetch('https://europe-west1-aefy-lig.cloudfunctions.net/nesineHealthCheck?scores=1');
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Bilinmeyen hata');

        const rows = data.report || [];
        const processed = rows.filter(r => r.result === 'finalized' || r.result === 'legacy_score');
        const scoreOnly = rows.filter(r => r.result === 'score_only');

        if (processed.length || scoreOnly.length) {
          showToast(`${processed.length + scoreOnly.length} maçın skoru bulundu ve işlendi.`, 'success');
        } else if (rows.length) {
          showToast("Şu an Nesine'de biten maç skoru bulunamadı.", 'warning');
        } else {
          showToast('Skor bekleyen maç yok.', 'success');
        }

        const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const noteOf = r => {
          if (r.result === 'finalized' || r.result === 'legacy_score') return ['✅', `skor işlendi (${r.score})`];
          if (r.result === 'score_only') return ['⚠️', `skor yazıldı (${r.score}) ama oran verisi eksik; puanları elle gir`];
          if (r.result === 'not_finished') return ['⏳', 'maç henüz bitmedi'];
          if (r.result === 'not_in_feed') return ['❓', 'Nesine skor servisinde bulunamadı'];
          if (r.result === 'no_event_code') return ['❓', 'maçın Nesine oran kaydı yok'];
          return ['❌', String(r.result)];
        };
        resultBox.innerHTML = rows.map(r => {
          const [icon, note] = noteOf(r);
          return `<div style="font-size:0.78rem; padding:2px 0;">${icon} ${esc(r.match)} <span style="color:var(--text-muted);">— ${esc(note)}</span></div>`;
        }).join('') ||
          '<div style="font-size:0.78rem; color:var(--text-muted);">Skoru bekleyen maç yok.</div>';
      } catch (err) {
        showToast('Skor kontrolü başarısız: ' + (err.message || err), 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '🔄 Skorları Şimdi Kontrol Et';
      }
    }

    async function recomputeEverything() {
      if (!isAdmin) return;
      if (!confirm('Tüm maçlar ve tahminler bir kez okunup puanlar yeniden hesaplanacak ve arşiv optimizasyonu açılacak. Devam edilsin mi?')) return;
      showToast('Yeniden hesaplanıyor, lütfen bekleyin…', 'info');
      try {
        const [matchesSnap, predsSnap] = await Promise.all([
          db.collection('matches').get(),
          db.collection('predictions').get()
        ]);
        const allMatches = matchesSnap.docs.map(mapMatchDoc);
        const predsByMatch = {};
        predsSnap.docs.forEach(d => {
          const p = mapPredDoc(d);
          (predsByMatch[p.matchId] = predsByMatch[p.matchId] || []).push(p);
        });

        const totals = {};
        const totalsByTournament = {};
        const seenTournaments = new Set();
        const finalizedForArchiveIndex = [];
        let batch = db.batch();
        let ops = 0;
        const commits = [];
        const flush = () => { commits.push(batch.commit()); batch = db.batch(); ops = 0; };

        for (const m of allMatches) {
          const ref = db.collection('matches').doc(m.id);
          // Etiketsiz eski maçları varsayılan turnuvaya taşı
          const tournament = tournamentOf(m);
          seenTournaments.add(tournament);
          const needsTagWrite = !m.tournament;
          const hasResult = m.homeScore != null && m.awayScore != null;
          if (hasResult) {
            const preds = predsByMatch[m.id] || [];
            const { scoreboard, totalsByUid } = computeScoreboard(m, preds);
            const bucket = (totalsByTournament[tournament] = totalsByTournament[tournament] || {});
            Object.entries(totalsByUid).forEach(([uid, pts]) => {
              totals[uid] = (totals[uid] || 0) + pts;
              bucket[uid] = (bucket[uid] || 0) + pts;
            });
            finalizedForArchiveIndex.push({ ...m, tournament, finalized: true });
            const upd = {
              finalized: true,
              scoreboard,
              finalizedAt: firebase.firestore.FieldValue.serverTimestamp()
            };
            if (needsTagWrite) upd.tournament = tournament;
            batch.update(ref, upd);
          } else {
            const upd = {
              finalized: false,
              scoreboard: firebase.firestore.FieldValue.delete(),
              finalizedAt: firebase.firestore.FieldValue.delete()
            };
            if (needsTagWrite) upd.tournament = tournament;
            batch.update(ref, upd);
          }
          if (++ops >= 400) flush();
        }
        batch.set(db.collection('settings').doc('leaderboard'), {
          totals,
          totalsByTournament,
          // Tam yeniden hesaplama tüm istemci arşiv önbelleklerini geçersiz kılmalı;
          // Date.now() her koşuda farklı olduğundan epoch uyuşmazlığı garanti.
          archiveEpoch: Date.now(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        batch.set(archiveDaysRef(), {
          days: buildArchiveDayIndex(finalizedForArchiveIndex),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        // Keşfedilen turnuva etiketlerini app ayarlarına kaydet (etiket listesi).
        const seenList = Array.from(seenTournaments);
        if (!seenList.length) seenList.push(DEFAULT_TOURNAMENT);
        batch.set(db.collection('settings').doc('app'), {
          tournaments: firebase.firestore.FieldValue.arrayUnion(...seenList)
        }, { merge: true });
        flush();
        await Promise.all(commits);
        showToast('Bitti! Optimizasyon açıldı, sayfa yenileniyor…', 'success');
        setTimeout(() => location.reload(), 1300);
      } catch (e) {
        console.error(e);
        showToast('Yeniden hesaplama başarısız: ' + (e.message || ''), 'error');
      }
    }

    // Admin writes (or overwrites) a prediction on behalf of a user
    async function adminSetPrediction(matchId) {
      const sel = document.getElementById(`admin-pred-user-${matchId}`);
      const hEl = document.getElementById(`admin-pred-h-${matchId}`);
      const aEl = document.getElementById(`admin-pred-a-${matchId}`);

      const uid = sel ? sel.value : '';
      const h = parseInt(hEl ? hEl.value : '');
      const a = parseInt(aEl ? aEl.value : '');

      if (!uid) {
        showToast('Kullanıcı seçin.', 'error');
        return;
      }
      if (isNaN(h) || isNaN(a) || h < 0 || a < 0 || h > 20 || a > 20) {
        showToast('Geçerli skor girin (0-20).', 'error');
        return;
      }

      const profile = usersMap[uid] || {};
      const name = profile.displayName || profile.email || 'kullanıcı';
      const existing = allPredictions.some(p => p.uid === uid && p.matchId === matchId);
      if (existing && !confirm(`${name} için zaten bir tahmin var. ${h}-${a} ile değiştirilsin mi?`)) {
        return;
      }

      try {
        await db.collection('predictions').doc(`${uid}_${matchId}`).set({
          uid: uid,
          matchId: matchId,
          homePred: h,
          awayPred: a,
          enteredByAdmin: true,
          submittedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        showToast(`${name} adına tahmin kaydedildi.`, 'success');
        if (hEl) hEl.value = '';
        if (aEl) aEl.value = '';
        // If this is a finalised (archived) match, re-freeze its scoreboard + aggregate.
        if (optimizedMode) {
          try { await refinalizeMatch(matchId); } catch (e) { console.error(e); }
          resetArchivePaging();
        }
      } catch (e) {
        console.error(e);
        showToast('Tahmin kaydedilemedi.', 'error');
      }
    }

    const aggRef = () => db.collection('settings').doc('leaderboard');
    const archiveDaysRef = () => db.collection('settings').doc('archiveDays');

    function archiveDayIndexKey(date) {
      if (!date) return '';
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }

    function archiveDayIndexEntry(match) {
      const dt = match.datetime && match.datetime.toDate ? match.datetime.toDate() : match.datetime;
      const key = archiveDayIndexKey(dt);
      if (!key) return null;
      return {
        key,
        ts: new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime(),
        label: formatDayHeading(dt),
        tournament: tournamentOf(match)
      };
    }

    function buildArchiveDayIndex(finalizedMatches) {
      const days = {};
      finalizedMatches.forEach(match => {
        const entry = archiveDayIndexEntry(match);
        if (!entry) return;
        if (!days[entry.key]) days[entry.key] = {
          key: entry.key,
          ts: entry.ts,
          label: entry.label,
          count: 0,
          tournaments: {},
          matches: {}
        };
        days[entry.key].count += 1;
        days[entry.key].tournaments[entry.tournament] = true;
        days[entry.key].matches[match.id] = entry.tournament;
      });
      return days;
    }

    async function upsertArchiveDayIndex(match) {
      const entry = archiveDayIndexEntry(match);
      if (!entry) return;
      await archiveDaysRef().set({
        days: {
          [entry.key]: {
            key: entry.key,
            ts: entry.ts,
            label: entry.label,
            tournaments: { [entry.tournament]: true },
            matches: { [match.id]: entry.tournament }
          }
        },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    async function removeArchiveDayIndex(match) {
      const entry = archiveDayIndexEntry(match);
      if (!entry) return;
      try {
        await archiveDaysRef().update({
          [`days.${entry.key}.matches.${match.id}`]: firebase.firestore.FieldValue.delete(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) {
        console.warn('archive day index remove skipped', e);
      }
    }

    // Bir maçın puan değişimini (deltaByUid) hem genel `totals`'a hem de o maçın
    // turnuvasının `totalsByTournament[tournament]` kovasına ekleyen set-merge yükü üretir.
    function aggIncrPayload(tournament, deltaByUid) {
      const overall = {};
      const perTour = {};
      Object.entries(deltaByUid).forEach(([uid, d]) => {
        if (!d) return;
        overall[uid] = firebase.firestore.FieldValue.increment(d);
        perTour[uid] = firebase.firestore.FieldValue.increment(d);
      });
      if (!Object.keys(overall).length) return null;
      return { totals: overall, totalsByTournament: { [tournament]: perTour } };
    }

    // Recompute and re-freeze a finalised match's scoreboard + adjust the aggregate by the delta.
    // Used after an admin adds/edits a prediction on an already-finalised match.
    async function refinalizeMatch(matchId) {
      const matchSnap = await db.collection('matches').doc(matchId).get();
      if (!matchSnap.exists) return;
      const prev = matchSnap.data();
      if (prev.homeScore == null || prev.awayScore == null) return; // not finalised yet
      const prevSb = Array.isArray(prev.scoreboard) ? prev.scoreboard : [];
      const predsSnap = await db.collection('predictions').where('matchId', '==', matchId).get();
      const preds = predsSnap.docs.map(mapPredDoc);
      const { scoreboard, totalsByUid } = computeScoreboard({ ...prev, id: matchId }, preds);

      const delta = {};
      prevSb.forEach(s => { delta[s.uid] = (delta[s.uid] || 0) - (s.pts || 0); });
      Object.entries(totalsByUid).forEach(([uid, pts]) => { delta[uid] = (delta[uid] || 0) + pts; });
      const payload = aggIncrPayload(tournamentOf(prev), delta);

      const batch = db.batch();
      batch.update(db.collection('matches').doc(matchId), {
        finalized: true,
        scoreboard,
        finalizedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      // Even when every prediction earns zero, notify all clients to refresh their
      // form/analysis archive. The aggregate listener is the delta-sync trigger.
      batch.set(aggRef(), {
        ...(payload || {}),
        archiveVersion: firebase.firestore.FieldValue.increment(1),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      await batch.commit();
      // Commit sonrası arşiv önbelleğine işle (erken tetiklenen delta bu maçı kaçırabilir).
      syncArchiveDelta();
    }

    // Saves the actual result plus the two point values; scoring is then automatic.
    async function saveResult(matchId) {
      const dateRaw = (document.getElementById(`res-date-${matchId}`)?.value || '').trim();
      const timeRaw = (document.getElementById(`res-time-${matchId}`)?.value || '').trim();
      const hRaw = (document.getElementById(`res-h-${matchId}`)?.value || '').trim();
      const aRaw = (document.getElementById(`res-a-${matchId}`)?.value || '').trim();
      const op = parseFloat(document.getElementById(`res-op-${matchId}`)?.value);
      const sp = parseFloat(document.getElementById(`res-sp-${matchId}`)?.value);
      const nextDateTime = parseDateTime(dateRaw, timeRaw);

      if (!nextDateTime) {
        showToast('Geçerli tarih ve saat girin (GG.AA.YYYY / SS:dd).', 'error');
        return;
      }

      const weekRaw = parseInt(document.getElementById(`res-week-${matchId}`)?.value || '', 10);
      const data = {
        datetime: firebase.firestore.Timestamp.fromDate(nextDateTime),
        week: weekRaw >= 1 ? weekRaw : firebase.firestore.FieldValue.delete(),
        outcomePoints: isNaN(op) ? null : op,
        scorePoints: isNaN(sp) ? null : sp
      };

      // TBD/ertelenmiş maçta admin tarihi elle değiştirdiyse tarih artık resmidir:
      // yer tutucu bayrakları ve bekleyen öneri temizlenir.
      const knownMatch = matches.find(m => m.id === matchId) || futureFixtureDocs.find(m => m.id === matchId);
      if (knownMatch?.dateTbd && knownMatch.datetime && nextDateTime.getTime() !== knownMatch.datetime.getTime()) {
        data.dateTbd = firebase.firestore.FieldValue.delete();
        data.postponed = firebase.firestore.FieldValue.delete();
        data.proposedDatetime = firebase.firestore.FieldValue.delete();
        data.proposalStatus = firebase.firestore.FieldValue.delete();
        data.proposalSource = firebase.firestore.FieldValue.delete();
        data.proposalCheckedAt = firebase.firestore.FieldValue.delete();
      }

      let hasResult = false;
      if (hRaw === '' && aRaw === '') {
        // No result entered yet — keep the match open / scoreless.
        data.homeScore = null;
        data.awayScore = null;
      } else {
        let h = parseInt(hRaw, 10);
        let a = parseInt(aRaw, 10);
        if (isNaN(h)) h = 0;
        if (isNaN(a)) a = 0;
        data.homeScore = h;
        data.awayScore = a;
        hasResult = true;
        // Sonucu girilen maçın tarihi kesinleşmiştir; TBD bayrakları kalkar.
        data.dateTbd = firebase.firestore.FieldValue.delete();
        data.postponed = firebase.firestore.FieldValue.delete();
        data.proposedDatetime = firebase.firestore.FieldValue.delete();
        data.proposalStatus = firebase.firestore.FieldValue.delete();
        data.proposalSource = firebase.firestore.FieldValue.delete();
        data.proposalCheckedAt = firebase.firestore.FieldValue.delete();
      }

      try {
        if (!optimizedMode) {
          await db.collection('matches').doc(matchId).update(data);
          resetFutureFixturePaging();
          showToast('Maç bilgileri kaydedildi.', 'success');
          return;
        }

        // ----- Optimized mode: maintain finalized flag + frozen scoreboard + aggregate -----
        const matchRef = db.collection('matches').doc(matchId);
        const matchSnap = await matchRef.get();
        if (!matchSnap.exists) { showToast('Maç bulunamadı.', 'error'); return; }
        const prev = matchSnap.data();
        const prevSb = Array.isArray(prev.scoreboard) ? prev.scoreboard : [];

        if (!hasResult) {
          // Clearing a result → un-finalise and remove its points from the aggregate.
          data.finalized = false;
          data.scoreboard = firebase.firestore.FieldValue.delete();
          data.finalizedAt = firebase.firestore.FieldValue.delete();
          const delta = {};
          prevSb.forEach(s => { if (s.pts) delta[s.uid] = (delta[s.uid] || 0) - (s.pts || 0); });
          const payload = aggIncrPayload(tournamentOf(prev), delta);
          const batch = db.batch();
          batch.update(matchRef, data);
          // Arşivden maç ÇIKTI → istemci önbellekleri delta ile yakalayamaz;
          // epoch artışı tam yeniden okumaya zorlar (nadir işlem).
          batch.set(aggRef(), {
            ...(payload || {}),
            archiveEpoch: firebase.firestore.FieldValue.increment(1)
          }, { merge: true });
          await batch.commit();
          await removeArchiveDayIndex({ id: matchId, ...prev });
          resetArchivePaging();
          resetFutureFixturePaging();
          showToast('Sonuç temizlendi, maç tekrar aktif.', 'success');
          return;
        }

        // Has a result → freeze the scoreboard from this match's predictions.
        const predsSnap = await db.collection('predictions').where('matchId', '==', matchId).get();
        const preds = predsSnap.docs.map(mapPredDoc);
        const matchForCalc = { ...prev, ...data, id: matchId };
        const { scoreboard, totalsByUid } = computeScoreboard(matchForCalc, preds);

        const delta = {};
        prevSb.forEach(s => { delta[s.uid] = (delta[s.uid] || 0) - (s.pts || 0); });
        Object.entries(totalsByUid).forEach(([uid, pts]) => { delta[uid] = (delta[uid] || 0) + pts; });
        const payload = aggIncrPayload(tournamentOf(prev), delta);

        data.finalized = true;
        data.scoreboard = scoreboard;
        // Delta senkron imzası: istemciler yalnızca finalizedAt > son senkron
        // olan maçları çeker. Düzenlemede de yenilenir ki değişiklik yakalansın.
        data.finalizedAt = firebase.firestore.FieldValue.serverTimestamp();

        const batch = db.batch();
        batch.update(matchRef, data);
        // Always emit an archive change signal. A 0-point result still adds a form
        // dot and analysis entry for every player who predicted the match.
        batch.set(aggRef(), {
          ...(payload || {}),
          archiveVersion: firebase.firestore.FieldValue.increment(1),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        await batch.commit();
        if (prev.finalized) await removeArchiveDayIndex({ id: matchId, ...prev });
        await upsertArchiveDayIndex(matchForCalc);
        resetArchivePaging();
        resetFutureFixturePaging();
        // Commit tamamlandıktan sonra arşiv önbelleğini senkronla: aggregate
        // listener'ı local yazmayla erken tetiklendiği için bu maçı kaçırmış
        // olabilir. Böylece form grafiği / detaylı analiz hemen güncellenir.
        syncArchiveDelta();
        showToast('Sonuç kaydedildi, maç arşive taşındı ve puanlar güncellendi.', 'success');
      } catch (e) {
        console.error(e);
        showToast('Kaydedilemedi.', 'error');
      }
    }

    // Maçı "ertelendi"ye alır: tarih yer tutucuya (+7 gün) kayar, dateTbd işaretlenir;
    // yeni tarih açıklanınca Nesine senkronu öneri üretir ve admin onaylar.
    async function postponeMatch(matchId) {
      const known = matches.find(m => m.id === matchId) || futureFixtureDocs.find(m => m.id === matchId);
      const label = known ? `${known.homeTeam} - ${known.awayTeam}` : 'Bu maç';
      if (!confirm(`${label} ertelensin mi?\nTarih yer tutucu olarak 1 hafta ileri alınır; gerçek tarih açıklanınca Nesine'den önerilir.`)) return;

      const baseMs = Math.max(known?.datetime?.getTime() || Date.now(), Date.now());
      const placeholder = new Date(baseMs + 7 * 24 * 60 * 60 * 1000);
      try {
        await db.collection('matches').doc(matchId).update({
          datetime: firebase.firestore.Timestamp.fromDate(placeholder),
          dateTbd: true,
          postponed: true,
          proposedDatetime: firebase.firestore.FieldValue.delete(),
          proposalStatus: firebase.firestore.FieldValue.delete(),
          proposalSource: firebase.firestore.FieldValue.delete(),
          proposalCheckedAt: firebase.firestore.FieldValue.delete()
        });
        resetFutureFixturePaging();
        loadDateProposals();
        showToast('Maç ertelendi. Yeni tarih Nesine bülteninde bulununca Tarih Önerileri bölümüne düşecek.', 'success');
      } catch (e) {
        console.error(e);
        showToast('Maç ertelenemedi.', 'error');
      }
    }

    async function deleteMatch(matchId) {
      if (!confirm('Bu maçı silmek istediğinize emin misiniz?')) return;
      try {
        const matchRef = db.collection('matches').doc(matchId);
        const matchSnap = await matchRef.get();
        const prev = matchSnap.exists ? matchSnap.data() : {};
        const prevSb = Array.isArray(prev.scoreboard) ? prev.scoreboard : [];

        const preds = await db.collection('predictions').where('matchId', '==', matchId).get();
        const batch = db.batch();
        preds.forEach(doc => batch.delete(doc.ref));
        batch.delete(matchRef);
        // Roll this match's points out of the aggregate leaderboard.
        if (optimizedMode && prev.finalized) {
          const delta = {};
          prevSb.forEach(s => { if (s.pts) delta[s.uid] = (delta[s.uid] || 0) - (s.pts || 0); });
          const payload = aggIncrPayload(tournamentOf(prev), delta);
          // Finalized bir maç silindi → istemci arşiv önbellekleri epoch artışıyla
          // geçersiz kılınır (delta sorgusu silinen maçı yakalayamaz).
          batch.set(aggRef(), {
            ...(payload || {}),
            archiveEpoch: firebase.firestore.FieldValue.increment(1)
          }, { merge: true });
        }
        await batch.commit();
        if (optimizedMode && prev.finalized) await removeArchiveDayIndex({ id: matchId, ...prev });
        if (optimizedMode) resetArchivePaging();
        resetFutureFixturePaging();
        showToast('Maç silindi.', 'success');
      } catch (e) {
        console.error(e);
        showToast('Maç silinemedi.', 'error');
      }
    }

    function addMatchToPending() {
      const dateStr = document.getElementById('add-date').value.trim();
      const yearStr = document.getElementById('add-year').value.trim();
      const timeStr = document.getElementById('add-time').value.trim();
      const home = document.getElementById('add-home').value.trim();
      const away = document.getElementById('add-away').value.trim();
      const dt = parseDateTime(dateStr, timeStr, yearStr);

      if (!dt || !home || !away) {
        showToast('Geçerli tarih, saat ve takım adları girin.', 'error');
        return;
      }

      const weekNo = parseInt(document.getElementById('add-week')?.value || '', 10);
      pendingMatches.push({
        dateStr: formatDateInput(dt), timeStr, homeTeam: home, awayTeam: away,
        tournament: selectedTournament,
        ...(weekNo >= 1 ? { week: weekNo } : {})
      });
      renderPendingMatches();

      document.getElementById('add-home').value = '';
      document.getElementById('add-away').value = '';
    }

    function renderPendingMatches() {
      const container = document.getElementById('pending-matches');
      container.innerHTML = '';

      if (!pendingMatches.length) {
        container.innerHTML = `<div class="empty-badge">Henüz maç eklenmedi. Yukarıdan ekleyin veya örnek veriyi yükleyin.</div>`;
        return;
      }

      const grouped = new Map();
      pendingMatches.forEach((m, idx) => {
        const key = m.dateStr || 'unknown';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push({ m, idx });
      });

      const list = document.createElement('div');
      list.className = 'pending-matches-list';

      Array.from(grouped.entries())
        .sort((a, b) => {
          const da = parseDateTime(a[0], '12:00')?.getTime() || 0;
          const db = parseDateTime(b[0], '12:00')?.getTime() || 0;
          return da - db;
        })
        .forEach(([dateStr, rows], groupIdx) => {
          rows.sort((a, b) => (a.m.timeStr || '').localeCompare(b.m.timeStr || '', 'tr'));
          const group = createAdminDayGroup(
            formatAdminPendingDay(dateStr),
            `<span class="admin-mini-pill">${rows.length} maç</span>`,
            groupIdx === 0
          );
          const body = group.querySelector('.admin-day-body');
          rows.forEach(({ m, idx }) => {
        const row = document.createElement('div');
        row.className = 'pending-match-row';
        row.innerHTML = `
          <div class="pending-match-info">
            <span class="pending-date">${escapeHTML(m.dateStr)} ${escapeHTML(m.timeStr)}</span>
            <span class="pending-teams">
              <span class="t-home">${escapeHTML(m.homeTeam)}</span>
              <span class="t-vs">—</span>
              <span class="t-away">${escapeHTML(m.awayTeam)}</span>
            </span>
            <span class="tournament-badge tournament-badge-sm">${escapeHTML((m.tournament && String(m.tournament).trim()) || DEFAULT_TOURNAMENT)}</span>
            ${m.week ? `<span class="admin-mini-pill">${m.week}. Hafta</span>` : ''}
            ${m.dateTbd ? `<span class="admin-mini-pill warn">tarih onaylanacak</span>` : ''}
          </div>
          <button onclick="removePending(${idx})" class="btn-remove-pending">Sil</button>
        `;
            body.appendChild(row);
          });
          list.appendChild(group);
        });
      container.appendChild(list);
    }

    function removePending(idx) {
      pendingMatches.splice(idx, 1);
      renderPendingMatches();
    }

    function clearPending() {
      pendingMatches = [];
      renderPendingMatches();
    }

    async function savePendingMatches() {
      if (!pendingMatches.length) {
        showToast('Kaydedilecek maç yok.', 'warning');
        return;
      }

      const batch = db.batch();
      let saved = 0;
      const matchKeyOf = (match) => {
        const date = match.datetime;
        return `${date?.getTime()}|${match.homeTeam}|${match.awayTeam}|${tournamentOf(match)}`.toLocaleLowerCase('tr-TR');
      };
      const knownMatches = new Set(matches.map(matchKeyOf));
      // Canlı listener yalnızca yakın tarih penceresini içerir; tüm sezon fikstürü
      // gibi uzak tarihli yapıştırmalarda mükerrer kaydı önlemek için gelecekteki
      // tüm maçların anahtarları bir kez okunur.
      try {
        const futureSnap = await db.collection('matches')
          .where('datetime', '>=', firebase.firestore.Timestamp.fromDate(new Date()))
          .get();
        futureSnap.docs.map(mapMatchDoc).forEach(match => knownMatches.add(matchKeyOf(match)));
      } catch (e) {
        console.warn('Gelecek maçlar dedup için okunamadı; yakın pencereyle devam ediliyor.', e);
      }

      for (const m of pendingMatches) {
        const dt = parseDateTime(m.dateStr, m.timeStr);
        if (!dt) continue;
        const tournament = (m.tournament && String(m.tournament).trim()) || DEFAULT_TOURNAMENT;
        const matchKey = `${dt.getTime()}|${m.homeTeam}|${m.awayTeam}|${tournament}`.toLocaleLowerCase('tr-TR');
        if (knownMatches.has(matchKey)) continue;
        knownMatches.add(matchKey);

        const ref = db.collection('matches').doc();
        batch.set(ref, {
          datetime: dt,
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          tournament: tournament,
          homeScore: null,
          awayScore: null,
          finalized: false,
          ...(m.week ? { week: m.week } : {}),
          ...(m.dateTbd ? { dateTbd: true } : {}),
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        saved++;
      }

      try {
        if (!saved) {
          showToast('Listedeki maçların tamamı zaten kayıtlı.', 'warning');
          return;
        }
        await batch.commit();
        resetFutureFixturePaging();
        showToast(`${saved} maç başarıyla kaydedildi.`, 'success');
        pendingMatches = [];
        renderPendingMatches();
      } catch (e) {
        console.error(e);
        showToast('Maçlar kaydedilemedi.', 'error');
      }
    }

    function loadSampleMatches() {
      const samples = [
        { dateStr: "18.06", timeStr: "19:00", homeTeam: "Çekya", awayTeam: "Güney Afrika" },
        { dateStr: "18.06", timeStr: "22:00", homeTeam: "İsviçre", awayTeam: "Bosna Hersek" },
        { dateStr: "19.06", timeStr: "01:00", homeTeam: "Kanada", awayTeam: "Katar" },
        { dateStr: "19.06", timeStr: "04:00", homeTeam: "Meksika", awayTeam: "Güney Kore" },
        { dateStr: "19.06", timeStr: "22:00", homeTeam: "ABD", awayTeam: "Avustralya" },
        { dateStr: "20.06", timeStr: "01:00", homeTeam: "İskoçya", awayTeam: "Fas" },
        { dateStr: "20.06", timeStr: "03:30", homeTeam: "Brezilya", awayTeam: "Haiti" },
        { dateStr: "20.06", timeStr: "06:00", homeTeam: "Türkiye", awayTeam: "Paraguay" },
        { dateStr: "20.06", timeStr: "20:00", homeTeam: "Hollanda", awayTeam: "İsveç" },
        { dateStr: "20.06", timeStr: "23:00", homeTeam: "Almanya", awayTeam: "Fildişi Sahili" },
        { dateStr: "21.06", timeStr: "03:00", homeTeam: "Ekvador", awayTeam: "Curaçao" },
        { dateStr: "21.06", timeStr: "07:00", homeTeam: "Tunus", awayTeam: "Japonya" },
        { dateStr: "21.06", timeStr: "19:00", homeTeam: "İspanya", awayTeam: "S. Arabistan" },
        { dateStr: "21.06", timeStr: "22:00", homeTeam: "Belçika", awayTeam: "İran" },
        { dateStr: "22.06", timeStr: "01:00", homeTeam: "Uruguay", awayTeam: "Yeşil Burun A." },
        { dateStr: "22.06", timeStr: "04:00", homeTeam: "Yeni Zelanda", awayTeam: "Mısır" },
        { dateStr: "22.06", timeStr: "20:00", homeTeam: "Arjantin", awayTeam: "Avusturya" },
        { dateStr: "23.06", timeStr: "00:00", homeTeam: "Fransa", awayTeam: "Irak" },
        { dateStr: "23.06", timeStr: "03:00", homeTeam: "Norveç", awayTeam: "Senegal" },
        { dateStr: "23.06", timeStr: "06:00", homeTeam: "Ürdün", awayTeam: "Cezayir" },
        { dateStr: "23.06", timeStr: "20:00", homeTeam: "Portekiz", awayTeam: "Özbekistan" },
        { dateStr: "23.06", timeStr: "23:00", homeTeam: "İngiltere", awayTeam: "Gana" },
        { dateStr: "24.06", timeStr: "02:00", homeTeam: "Panama", awayTeam: "Hırvatistan" },
        { dateStr: "24.06", timeStr: "05:00", homeTeam: "Kolombiya", awayTeam: "DR Kongo" }
      ];

      const entryYear = document.getElementById('bulk-year')?.value || DEFAULT_YEAR;
      pendingMatches = samples.map(m => ({ ...m, dateStr: `${m.dateStr}.${entryYear}`, tournament: selectedTournament }));
      renderPendingMatches();
      showToast('Örnek maçlar eklendi. "Maçları Kaydet" ile kaydedin.', 'success');
    }

    // ================== BULK PASTE PARSER ==================
    // Handles several pasted layouts, e.g.:
    //   "Date / Home / Time / Away"  (fixture lists)
    //   "Date / Time / Home / Away"
    //   "Date / Home / 2 - 0 / Away / MS"  (finished results — scores are ignored)
    function parseMatchesFromText(text, fallbackYear = DEFAULT_YEAR) {
      if (!text || !text.trim()) return [];

      const lines = text.split(/\r?\n/)
        .map(l => l.trim().replace(/\s+/g, ' '))
        .filter(l => l.length > 0);

      const months = {
        ocak: 1, şubat: 2, mart: 3, nisan: 4, mayıs: 5, haziran: 6,
        temmuz: 7, ağustos: 8, eylül: 9, ekim: 10, kasım: 11, aralık: 12
      };
      // Status / marker words that are not team names
      const skipWords = new Set(['ms', 'ft', 'ht', 'iy', 'dt', 'maç sonu', 'devam ediyor', 'ertelendi', 'canlı']);

      const matchDate = (line) => {
        const lower = line.toLocaleLowerCase('tr-TR');
        // Match month names as complete words. Substring matching interpreted
        // "Cumartesi" as "Mart" and turned dates such as 4 Temmuz Cumartesi
        // into 04.03, which also placed them before June fixtures.
        const words = lower.match(/\p{L}+/gu) || [];
        const monthName = Object.keys(months).find(month => words.includes(month));
        const dayMatch = line.match(/\b(\d{1,2})\b/);
        if (monthName && dayMatch) {
          const yearMatch = line.match(/\b(20\d{2})\b/);
          const year = yearMatch ? yearMatch[1] : fallbackYear;
          return `${dayMatch[1].padStart(2, '0')}.${String(months[monthName]).padStart(2, '0')}.${year}`;
        }
        return null;
      };
      const matchTime = (line) => {
        const m = line.match(/^(\d{1,2})[:.](\d{2})$/);
        return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
      };
      const isScore = (line) => /^\d{1,2}\s*[-:–]\s*\d{1,2}$/.test(line);

      // "1. Hafta" / "Hafta 5" başlıkları: sonraki maçlara hafta numarası atanır ve
      // başlık altındaki tarihler TFF yer tutucusu sayıldığından dateTbd işaretlenir.
      const matchWeekHeader = (line) => {
        const m = /^(?:(\d{1,2})\s*\.?\s*hafta|hafta\s*(\d{1,2}))$/i.exec(
          line.toLocaleLowerCase('tr-TR').trim()
        );
        return m ? parseInt(m[1] || m[2], 10) : null;
      };

      const results = [];
      let currentDateStr = null;
      let currentTime = null;
      let pendingHome = null;
      let currentWeek = null;

      for (const line of lines) {
        const lower = line.toLocaleLowerCase('tr-TR');

        const weekNo = matchWeekHeader(line);
        if (weekNo) {
          currentWeek = weekNo;
          currentDateStr = null;
          currentTime = null;
          pendingHome = null;
          continue;
        }

        const dateStr = matchDate(line);
        if (dateStr) {
          currentDateStr = dateStr;
          currentTime = null;
          pendingHome = null;
          continue;
        }

        const timeStr = matchTime(line);
        if (timeStr) {
          currentTime = timeStr;
          continue;
        }

        if (isScore(line)) continue;          // ignore score lines
        if (skipWords.has(lower)) continue;    // ignore MS / FT markers
        if (!/[a-zA-ZğüşçıöİĞÜŞÇÖ]/.test(line)) continue; // must contain a letter
        if (!currentDateStr) continue;         // need a date context first

        // It's a team name
        if (!pendingHome) {
          pendingHome = line;
        } else {
          results.push({
            dateStr: currentDateStr,
            timeStr: currentTime || '12:00',
            homeTeam: pendingHome,
            awayTeam: line,
            ...(currentWeek ? { week: currentWeek, dateTbd: true } : {})
          });
          pendingHome = null;
          currentTime = null;
        }
      }

      return results;
    }

    function parseAndAddBulk() {
      const textarea = document.getElementById('bulk-text');
      const text = textarea.value;
      const fallbackYear = document.getElementById('bulk-year')?.value || DEFAULT_YEAR;
      const parsed = parseMatchesFromText(text, fallbackYear);

      if (parsed.length === 0) {
        showToast('Hiç maç algılanamadı. Metni kontrol et.', 'warning');
        return;
      }

      // Metinde hafta başlığı yoksa opsiyonel "Hafta no" alanı tüm batch'e uygulanır.
      // Elle girilen tarihler gerçek kabul edilir; dateTbd yalnızca başlıklı yapıştırmada işaretlenir.
      const fallbackWeek = parseInt(document.getElementById('bulk-week')?.value, 10);
      const withWeek = (m) => (m.week || isNaN(fallbackWeek) || fallbackWeek < 1)
        ? m
        : { ...m, week: fallbackWeek };

      pendingMatches = pendingMatches.concat(parsed.map(m => ({ ...withWeek(m), tournament: selectedTournament })));
      renderPendingMatches();
      showToast(`${parsed.length} maç ayrıştırıldı ve "${selectedTournament}" etiketiyle listeye eklendi.`, 'success');
    }

    function clearBulkTextarea() {
      const textarea = document.getElementById('bulk-text');
      if (textarea) textarea.value = '';
    }

    async function sendManualNotification() {
      if (!isAdmin || !currentUser) {
        showToast('Bu islem icin admin yetkisi gerekli.', 'error');
        return;
      }

      const titleEl = document.getElementById('manual-notification-title');
      const bodyEl = document.getElementById('manual-notification-body');
      const title = (titleEl?.value || '').trim();
      const body = (bodyEl?.value || '').trim();

      if (!title || !body) {
        showToast('Baslik ve mesaj girin.', 'warning');
        return;
      }

      try {
        await db.collection('adminNotifications').add({
          title,
          body,
          createdBy: currentUser.uid,
          createdByEmail: currentUser.email,
          status: 'queued',
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        if (bodyEl) bodyEl.value = '';
        showToast('Bildirim gonderim kuyruguna alindi.', 'success');
      } catch (e) {
        console.error(e);
        showToast('Bildirim gonderilemedi.', 'error');
      }
    }

    async function loadNotificationSettings() {
      if (!isAdmin) return;
      try {
        const snap = await db.collection('settings').doc('notificationSettings').get();
        const data = snap.exists ? snap.data() : {};
        const delay = Number(data.resultDigestDelayMinutes || 5);
        const input = document.getElementById('result-notification-delay');
        if (input && delay >= 1 && delay <= 60) input.value = String(delay);
      } catch (e) {
        console.warn('Bildirim ayarlari yuklenemedi:', e);
      }
    }

    async function saveNotificationSettings() {
      if (!isAdmin || !currentUser) {
        showToast('Bu islem icin admin yetkisi gerekli.', 'error');
        return;
      }

      const input = document.getElementById('result-notification-delay');
      const delay = parseInt(input?.value || '5', 10);
      if (isNaN(delay) || delay < 1 || delay > 60) {
        showToast('Bekleme suresi 1-60 dakika arasinda olmali.', 'warning');
        return;
      }

      try {
        await db.collection('settings').doc('notificationSettings').set({
          resultDigestDelayMinutes: delay,
          updatedBy: currentUser.uid,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        showToast('Bildirim ayari kaydedildi.', 'success');
      } catch (e) {
        console.error(e);
        showToast('Bildirim ayari kaydedilemedi.', 'error');
      }
    }

    // Whitelist + Users
    async function addToWhitelist() {
      const input = document.getElementById('whitelist-email');
      const email = input.value.trim();
      if (!email) return;

      try {
        await db.collection('settings').doc('app').set({
          allowedEmails: firebase.firestore.FieldValue.arrayUnion(email)
        }, { merge: true });
        input.value = '';
        showToast('E-posta whitelist\'e eklendi.', 'success');
      } catch (e) {
        showToast('Ekleme başarısız.', 'error');
      }
    }

    function renderWhitelist() {
      const container = document.getElementById('whitelist-list');
      container.innerHTML = '';

      if (!allowedEmails.length) {
        container.innerHTML = `<span class="empty-badge">Henüz whitelist yok (herkes kayıt olabilir)</span>`;
        return;
      }

      allowedEmails.forEach(email => {
        const pill = document.createElement('div');
        pill.className = `admin-email-pill`;
        pill.innerHTML = `
          <span>${email}</span>
          <button onclick="removeFromWhitelist('${email.replace(/'/g, "\\'")}')">×</button>
        `;
        container.appendChild(pill);
      });
    }

    async function removeFromWhitelist(email) {
      try {
        await db.collection('settings').doc('app').update({
          allowedEmails: firebase.firestore.FieldValue.arrayRemove(email)
        });
      } catch (e) {
        showToast('Silinemedi.', 'error');
      }
    }

    function renderAdminUsers() {
      const container = document.getElementById('admin-users-list');
      container.innerHTML = '';

      const userEntries = Object.values(usersMap);

      if (!userEntries.length) {
        container.innerHTML = `<div class="empty-badge">Kullanıcı yok.</div>`;
        return;
      }

      userEntries.forEach(u => {
        const isCurrentAdmin = !!u.isAdmin;
        const row = document.createElement('div');
        row.className = 'admin-user-row has-cups';
        const cupFields = CUP_TYPES.map(c => `
          <div class="admin-cup-field">
            <div class="admin-cup-row">
              <img src="${c.img}" alt="">
              <label title="${escapeHTML(c.name)}">${escapeHTML(c.name)}</label>
              <input type="number" min="0" step="1" class="admin-cup-count" id="cup-${u.uid}-${c.key}" value="${userCupCount(u, c.key)}">
            </div>
            <input type="text" class="admin-cup-seasons-input" id="cupseason-${u.uid}-${c.key}" value="${escapeHTML(userCupSeasons(u, c.key).join(', '))}" placeholder="Sezonlar: 2019-2020, 2021-2022">
          </div>`).join('');
        row.innerHTML = `
          <div class="admin-user-meta">
            <div class="admin-user-name">${escapeHTML(u.displayName || u.email)} <span style="color:var(--accent-gold);font-size:0.78rem;">· ${userCupTotal(u)} 🏆</span></div>
            <div class="admin-user-email">${escapeHTML(u.email)}</div>
          </div>
          <div class="admin-user-role-actions">
            <span class="role-badge ${isCurrentAdmin ? 'role-admin' : 'role-user'}">
              ${isCurrentAdmin ? 'ADMIN' : 'OYUNCU'}
            </span>
            <button onclick="toggleAdmin('${u.uid}', ${!isCurrentAdmin})"
                    class="btn btn-sm ${isCurrentAdmin ? 'btn-danger-outline' : 'btn-accent-outline'}">
              ${isCurrentAdmin ? 'Adminliği Kaldır' : 'Admin Yap'}
            </button>
          </div>
          <div class="admin-cup-editor">
            <div class="admin-cup-grid">${cupFields}</div>
            <button onclick="saveUserCups('${u.uid}')" class="btn btn-sm btn-accent-outline" style="margin-top:0.7rem;">🏆 Kupaları Kaydet</button>
          </div>
        `;
        container.appendChild(row);
      });
    }

    async function toggleAdmin(uid, makeAdmin) {
      try {
        await db.collection('users').doc(uid).update({ isAdmin: makeAdmin });
        showToast(makeAdmin ? 'Kullanıcı admin yapıldı.' : 'Admin yetkisi kaldırıldı.', 'success');
      } catch (e) {
        showToast('Güncellenemedi.', 'error');
      }
    }

    async function saveUserCups(uid) {
      const cups = {};
      const cupSeasons = {};
      CUP_TYPES.forEach(c => {
        const el = document.getElementById(`cup-${uid}-${c.key}`);
        cups[c.key] = el ? Math.max(0, Math.floor(+el.value || 0)) : 0;
        const sEl = document.getElementById(`cupseason-${uid}-${c.key}`);
        cupSeasons[c.key] = sEl ? parseSeasons(sEl.value) : [];
      });
      try {
        await db.collection('users').doc(uid).set({ cups, cupSeasons }, { merge: true });
        showToast('Kupalar kaydedildi.', 'success');
      } catch (e) {
        console.error(e);
        showToast('Kupalar kaydedilemedi.', 'error');
      }
    }

    // ================== KUPA MÜZESİ ==================
    // Kupa türleri — admin panelindeki giriş alanları ve müze vitrini bu sıraya göre çizilir.
    const CUP_TYPES = [
      { key: 'sampiyonlar', name: 'Şampiyonlar Ligi',     img: 'kupa/sampiyonlar.webp' },
      { key: 'world',       name: 'Dünya Kupası',          img: 'kupa/world.webp' },
      { key: 'eurocup',     name: 'Avrupa Şampiyonası',    img: 'kupa/eurocup.webp' },
      { key: 'avrupa',      name: 'Avrupa Ligi',           img: 'kupa/avrupa.webp' },
      { key: 'superlig',    name: 'Süper Lig',             img: 'kupa/superlig.webp' },
      { key: 'turkiye',     name: 'Türkiye Kupası',        img: 'kupa/turkiye.webp' },
    ];

    function userCupCount(u, key) {
      const n = u?.cups?.[key];
      return Number.isFinite(+n) && +n > 0 ? Math.floor(+n) : 0;
    }
    function userCupTotal(u) {
      return CUP_TYPES.reduce((s, c) => s + userCupCount(u, c.key), 0);
    }
    function userCupSeasons(u, key) {
      const v = u?.cupSeasons?.[key];
      return Array.isArray(v) ? v.map(s => String(s).trim()).filter(Boolean) : [];
    }
    // Serbest metni ("2019-2020, 2021-2022 Sezonu" veya " - " ile ayrılmış) sezon dizisine çevirir.
    function parseSeasons(text) {
      return String(text || '')
        .split(/\s*,\s*|\s*;\s*|\s+-\s+|\n+/)
        .map(s => s.trim())
        .filter(Boolean);
    }
    // Görüntüleme için güzelleştirir: "2019-2020 Sezonu" -> "2019-2020".
    function formatSeason(s) {
      const t = String(s).trim().replace(/\s*sezonu?\s*$/i, '');
      if (/^\d{4}\s*[-/–]\s*\d{2,4}$/.test(t)) return t.replace(/\s*[-/–]\s*/, '-');
      return t;
    }

    function renderMuseum() {
      const rankEl = document.getElementById('museum-rank');
      const cabEl = document.getElementById('museum-cabinets');
      if (!rankEl || !cabEl) return;

      const users = Object.values(usersMap)
        .map(u => ({ ...u, _total: userCupTotal(u) }))
        .sort((a, b) =>
          b._total - a._total ||
          (a.displayName || a.email || '').localeCompare(b.displayName || b.email || '', 'tr')
        );

      const withCups = users.filter(u => u._total > 0);

      // --- Sıralama tablosu ---
      if (!users.length) {
        rankEl.innerHTML = `<div class="museum-empty"><div class="be">🏛️</div><p>Henüz kayıtlı kullanıcı yok.</p></div>`;
        cabEl.innerHTML = '';
        return;
      }

      let rows = '';
      users.forEach((u, i) => {
        const has = u._total > 0;
        const pos = has ? (withCups.indexOf(u) + 1) : 0;
        const rankClass = pos === 1 ? 'r1' : pos === 2 ? 'r2' : pos === 3 ? 'r3' : '';
        const posLabel = pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : (has ? pos : '–');
        const mini = CUP_TYPES
          .filter(c => userCupCount(u, c.key) > 0)
          .map(c => `<span class="mm"><img src="${c.img}" alt="">${userCupCount(u, c.key)}</span>`)
          .join('');
        const onclick = has ? `onclick="scrollToMuseumUser('${u.uid}')"` : '';
        rows += `
          <button type="button" class="museum-rank-row ${rankClass} ${has ? '' : 'empty-row'}" ${onclick}>
            <span class="museum-rank-pos">${posLabel}</span>
            <span class="museum-rank-info">
              <span class="museum-rank-name">${escapeHTML(u.displayName || u.email)}</span>
              <span class="museum-rank-mini">${mini || '<span class="mm">Henüz kupası yok</span>'}</span>
            </span>
            <span class="museum-rank-total"><b>${u._total}</b><span>kupa</span></span>
            ${has ? '<span class="museum-rank-go">›</span>' : ''}
          </button>`;
      });
      rankEl.innerHTML = `<div class="museum-rank-head">🏆 Kupa Sıralaması</div>${rows}`;

      // --- Vitrinler (kupası olan kullanıcılar) ---
      if (!withCups.length) {
        cabEl.innerHTML = `<div class="museum-empty"><div class="be">🏆</div><p>Henüz kimseye kupa eklenmemiş. Admin panelinden kupa girildiğinde burada sergilenecek.</p></div>`;
        return;
      }

      cabEl.innerHTML = withCups.map((u, idx) => {
        const pos = idx + 1;
        const rankClass = pos === 1 ? 'r1' : pos === 2 ? 'r2' : pos === 3 ? 'r3' : '';
        const posLabel = pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : pos;
        const owned = CUP_TYPES.map(c => ({ ...c, n: userCupCount(u, c.key) }));
        const kinds = owned.filter(c => c.n > 0).length;
        const shelf = owned.map(c => {
          const seasons = c.n > 0 ? userCupSeasons(u, c.key) : [];
          const seasonsInner = seasons.length
            ? seasons.map(s => `<span class="season-pill">${escapeHTML(formatSeason(s))}</span>`).join('')
            : `<span class="season-empty">Sezon bilgisi eklenmemiş</span>`;
          const clickable = c.n > 0;
          return `
          <div class="trophy ${c.n > 0 ? '' : 'dim'} ${clickable ? 'clickable' : ''}" ${clickable ? 'onclick="toggleTrophySeasons(this)"' : ''}>
            ${c.n > 0 ? `<span class="trophy-count">×${c.n}</span>` : ''}
            <div class="trophy-stage"><img class="trophy-img" src="${c.img}" alt="${escapeHTML(c.name)}" loading="lazy"></div>
            <div class="trophy-name">${escapeHTML(c.name)}</div>
            <div class="trophy-tag">${c.n > 0 ? `${c.n} adet <span class="trophy-caret">▾</span>` : 'yok'}</div>
            ${clickable ? `<div class="trophy-seasons hidden">${seasonsInner}</div>` : ''}
          </div>`;
        }).join('');
        return `
          <div id="museum-user-${u.uid}" class="museum-cabinet ${rankClass}">
            <div class="museum-cabinet-head">
              <div class="museum-cabinet-rank">${posLabel}</div>
              <div class="museum-cabinet-titles">
                <div class="museum-cabinet-name">${escapeHTML(u.displayName || u.email)}</div>
                <div class="museum-cabinet-meta">${kinds} farklı kupa türü</div>
              </div>
              <div class="museum-cabinet-total"><b>${u._total}</b><span>kupa</span></div>
            </div>
            <div class="museum-shelf">${shelf}</div>
          </div>`;
      }).join('');
    }

    function toggleTrophySeasons(el) {
      const panel = el.querySelector('.trophy-seasons');
      if (!panel) return;
      const willOpen = panel.classList.contains('hidden');
      panel.classList.toggle('hidden');
      el.classList.toggle('open', willOpen);
    }

    function scrollToMuseumUser(uid) {
      const el = document.getElementById('museum-user-' + uid);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.animate(
        [
          { boxShadow: '0 0 0 2px rgba(232,197,71,0.0)' },
          { boxShadow: '0 0 0 2px rgba(232,197,71,0.7), 0 0 28px rgba(232,197,71,0.35)' },
          { boxShadow: '0 0 0 2px rgba(232,197,71,0.0)' }
        ],
        { duration: 1400, easing: 'ease-out' }
      );
    }

    // ================== VIEW SWITCHING ==================
    let currentView = 'matches';

    function switchView(view) {
      const views = {
        matches: document.getElementById('view-matches'),
        leaderboard: document.getElementById('view-leaderboard'),
        archive: document.getElementById('view-archive'),
        museum: document.getElementById('view-museum'),
        admin: document.getElementById('view-admin'),
        rules: document.getElementById('view-rules')
      };

      const btns = {
        matches: document.getElementById('view-btn-matches'),
        leaderboard: document.getElementById('view-btn-leaderboard'),
        archive: document.getElementById('view-btn-archive'),
        museum: document.getElementById('view-btn-museum'),
        admin: document.getElementById('view-btn-admin')
      };

      Object.values(views).forEach(v => {
        if (v) v.classList.add('hidden');
      });
      Object.values(btns).forEach(b => {
        if (b) b.classList.remove('active');
      });

      if (views[view]) views[view].classList.remove('hidden');
      // Rules is reached from leaderboard — keep puan durumu tab highlighted
      if (view === 'rules' && btns.leaderboard) btns.leaderboard.classList.add('active');
      else if (btns[view]) btns[view].classList.add('active');

      currentView = view;

      if (view === 'leaderboard') {
        // Form/analiz/detay verisi breakdownArchiveDocs önbelleğinden gelir
        // (renderLeaderboard → ensureLeaderboardFormData); ayrıca sayfalı arşivi
        // ön-yüklemeye gerek yok.
        renderLeaderboard();
      }
      if (view === 'archive') {
        // İlk açılışta veya hâlâ eski sabit değerdeyse admin'in varsayılan turnuvasını kullan
        if (!archiveTournamentFilter || archiveTournamentFilter === DEFAULT_TOURNAMENT) {
          archiveTournamentFilter = defaultTournament || DEFAULT_TOURNAMENT;
        }
        renderArchive();
        if (optimizedMode && !archiveDaysIndexLoaded) loadArchiveDayIndex();
        // Hafta chip'leri tam arşiv önbelleğinden türetilir; yüklü değilse getir.
        if (optimizedMode && breakdownArchiveDocs === null) {
          ensureLeaderboardFormData().then(() => { if (currentView === 'archive') renderArchive(); });
        }
      }
      if (view === 'museum') renderMuseum();
      if (view === 'admin' && isAdmin) {
        renderAdminMatches();
        renderAdminBonus();
        renderAdminFutureFixtures();
        renderAdminUsers();
        renderWhitelist();
        loadNotificationSettings();
        loadDateProposals();
        renderAdminArchive(); // archive panel stays collapsed; loads on first expand
      }
    }

    // Collapsible admin archive — only fetches the first page when first opened.
    function toggleAdminMain() {
      const body = document.getElementById('admin-main-body');
      const caret = document.getElementById('admin-main-caret');
      if (!body) return;
      const willOpen = body.classList.contains('hidden');
      body.classList.toggle('hidden');
      if (caret) caret.style.transform = willOpen ? 'rotate(90deg)' : 'rotate(0deg)';
    }

    function toggleAdminFutureFixtures() {
      const body = document.getElementById('admin-future-body');
      const caret = document.getElementById('admin-future-caret');
      if (!body) return;
      const willOpen = body.classList.contains('hidden');
      body.classList.toggle('hidden');
      if (caret) caret.style.transform = willOpen ? 'rotate(90deg)' : 'rotate(0deg)';
      if (willOpen) {
        renderAdminFutureFixtures();
        if (!futureFixtureLoaded && !futureFixtureLoading) loadMoreFutureFixtures();
      }
    }

    function toggleAdminArchive() {
      const body = document.getElementById('admin-archive-body');
      const caret = document.getElementById('admin-archive-caret');
      if (!body) return;
      const willOpen = body.classList.contains('hidden');
      body.classList.toggle('hidden');
      if (caret) caret.style.transform = willOpen ? 'rotate(90deg)' : 'rotate(0deg)';
      if (willOpen) {
        renderAdminArchive();
        if (optimizedMode && !archiveDocs.length && archiveHasMore) loadMoreArchive();
      }
    }

    function showApp() {
      document.getElementById('splash-screen').classList.add('hidden');
      document.getElementById('auth-screen').classList.add('hidden');
      document.getElementById('app-screen').classList.remove('hidden');
      
      const headerUser = document.getElementById('header-user');
      headerUser.style.display = 'flex';

      document.getElementById('header-display-name').textContent = currentUserProfile?.displayName || currentUser.email.split('@')[0];
      document.getElementById('header-email').textContent = currentUser.email;

      const adminBtn = document.getElementById('view-btn-admin');
      if (isAdmin) {
        adminBtn.style.display = 'flex';
      } else {
        adminBtn.style.display = 'none';
      }

      switchView('matches');

      listenToData();
      updateClock();
      setInterval(updateClock, 1000);
    }

    function hideApp() {
      document.getElementById('splash-screen').classList.add('hidden');
      document.getElementById('auth-screen').classList.remove('hidden');
      document.getElementById('app-screen').classList.add('hidden');
      
      const headerUser = document.getElementById('header-user');
      headerUser.style.display = 'none';
      stopListeners();
    }

    function updateClock() {
      const el = document.getElementById('current-time');
      if (!el) return;
      const now = new Date();
      el.textContent = now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    }

    // ================== MAIN INIT ==================
    function init() {
      initMatchYearSelectors();
      auth.onAuthStateChanged(async (user) => {
        if (user) {
          currentUser = user;

          try {
            const profileSnap = await db.collection('users').doc(user.uid).get();
            if (profileSnap.exists) {
              currentUserProfile = profileSnap.data();
            } else {
              currentUserProfile = {
                email: user.email,
                displayName: user.email.split('@')[0],
                isAdmin: user.email === ADMIN_EMAIL
              };
              await db.collection('users').doc(user.uid).set(currentUserProfile, { merge: true });
            }

            isAdmin = !!currentUserProfile.isAdmin;

            if (!isAdmin && user.email === ADMIN_EMAIL) {
              isAdmin = true;
              await db.collection('users').doc(user.uid).update({ isAdmin: true });
              currentUserProfile.isAdmin = true;
            }
          } catch (e) {
            console.error('Profile load error', e);
            currentUserProfile = { email: user.email, displayName: user.email.split('@')[0], isAdmin: false };
          }

          showApp();
          initPushNotifications();
        } else {
          currentUser = null;
          currentUserProfile = null;
          isAdmin = false;
          hideApp();
        }
      });

      document.addEventListener('keydown', function (e) {
        // Tahmin onay modalı açıkken: Esc → vazgeç, Enter → kilitle
        if (_predictConfirmResolver) {
          if (e.key === 'Escape') { e.preventDefault(); resolvePredictConfirm(false); }
          else if (e.key === 'Enter') { e.preventDefault(); resolvePredictConfirm(true); }
          return;
        }
        if (e.key === 'Enter') {
          const loginVisible = !document.getElementById('login-form').classList.contains('hidden');
          if (document.getElementById('auth-screen').offsetParent !== null) {
            if (loginVisible) {
              handleLogin();
            } else {
              handleSignup();
            }
          }
        }
      });

      setTimeout(updateClock, 300);
    }

    window.onload = init;
    window.AEFYLIG = { refresh: () => refreshAllData() };
