# AEFY LİG - Skor Tahmin Web Sitesi ⚽

Tamamen HTML + JavaScript ile yapılmış, Firebase destekli arkadaş grubu skor tahmin uygulaması.

## Özellikler
- Firebase Authentication (E-posta / Şifre) ile giriş ve kayıt
- **Admin** hesabı: Maç ekleme, toplu örnek veri yükleme, maç sonuçlarını girme/güncelleme, maç silme
- Kullanıcılar **maç başlamadan 15 dakika önceye kadar** tek tahmin girer. Tahmin kaydedildiği anda kilitlenir ve değiştirilemez.
- Her maç için tüm kullanıcıların tahminleri gerçek zamanlı listelenir.
- Toplu fikstür metni `takım → saat → takım` düzeninden otomatik ayrıştırılır.
- Doğru skor = **3 puan**, doğru sonuç (kazanan/berabere) = **1 puan**
- Gerçek zamanlı puan tablosu (leaderboard)
- Responsive koyu / futbol temalı arayüz (siyah + yeşil vurgular)
- Admin kullanıcı ekleme (whitelist) + diğer kullanıcıları admin yapma

## Kullanım

1. **Yerel test için** `index.html` dosyasını çift tıklayarak veya tarayıcıda açın.
   - Daha iyi sonuç için VS Code "Live Server" eklentisi veya `npx serve` / python http.server kullan.

2. **İlk Kayıt (Admin olmak için)**
   - "Kayıt Ol" sekmesine geçin.
   - `admin@aefy-lig.com` ile kayıt ol (kod içinde sabitlendiği için otomatik admin yetkisi alır).
   - Başka bir mail kullanmak istersen index.html içindeki `ADMIN_EMAIL` sabitini güncelle.

3. **Maç Ekleme (Admin)**
   - Admin paneline gidin (üstteki sekmelerde görünecek).
   - Formu kullanarak tek tek maç ekleyin veya **"Örnek Maçları Yükle (16-18 Haziran)"** butonuna tıklayın.
   - Listeye eklenen maçları **"Maçları Kaydet"** ile Firebase'e gönderin.
   - Maçlar otomatik olarak tarih/saat sırasına göre sıralanır.

4. **Tahmin Yapma**
   - Normal kullanıcılar maç kartlarında skor kutularına sayı girip **"TAHMİNİ KİLİTLE"** butonuna basar.
   - Onaylanan tahmin daha sonra değiştirilemez.
   - Maç saatinden 15 dakika önce tahmin hakkı biter.
   - Maç tamamlandıktan ve admin sonucu girdikten sonra puanınız görünür.

5. **Sonuç Girme**
   - Admin panelinde her maçın yanında skor inputları bulunur.
   - Maç bittikten sonra gerçek skorları girin ve "Sonucu Kaydet / Güncelle" deyin.
   - Tüm kullanıcıların puanları anında güncellenir.

6. **Kullanıcı Ekleme (Admin)**
   - Admin panelinde "Whitelist E-posta Ekle" bölümünü kullanın.
   - Arkadaşlarınızın e-postalarını ekleyin.
   - Onlar aynı e-posta ile kayıt olduklarında sisteme katılabilirler.

## Firebase
Mevcut `firebaseConfig` zaten index.html içine gömülüdür. 
İsterseniz güvenlik kurallarını (Firestore + Auth) Firebase Console'dan ayarlayın:
- Authentication → Sign-in method → Email/Password aktif edin.
- Firestore → Rules: Geliştirme için test modunda tutabilirsiniz (üretimde kısıtlayın).

## Puanlama Detayı
```js
function calculatePoints(predHome, predAway, actualHome, actualAway) {
  if (predHome === actualHome && predAway === actualAway) return 3; // Tam isabet
  const predOutcome = Math.sign(predHome - predAway);
  const actOutcome = Math.sign(actualHome - actualAway);
  if (predOutcome === actOutcome) return 1; // Sadece sonucu doğru bildin
  return 0;
}
```

## Admin Tanımlama (Önemli!)
Uygulamada **kalıcı bir admin** tanımlandı:

- **Önerilen Admin E-postası:** `admin@aefy-lig.com`

Bu e-posta ile **kayıt olan veya giriş yapan** kullanıcı otomatik olarak admin yetkisi alır (kod içinde `ADMIN_EMAIL` sabiti ile kontrol edilir).

### Adımlar:
1. Tarayıcıda siteyi aç.
2. "Kayıt Ol" ile `admin@aefy-lig.com` adresini ve bir şifre kullanarak hesap oluştur.
3. Giriş yaptıktan sonra üst menüde **Admin** sekmesi görünecek.
4. Admin panelinden örnek maçları yükle, whitelist'e diğer arkadaşlarının e-postalarını ekle.

İstersen `index.html` dosyasını açıp `const ADMIN_EMAIL = "admin@aefy-lig.com";` satırını kendi e-postanla değiştirebilirsin.

## Canlı Deploy → aefy-lig.web.app (Hazır)

Senin projen zaten `aefy-lig` olarak Firebase'de kayıtlı ve `https://aefy-lig.web.app` adresi verilmiş.

`firebase.json` dosyası hazır ve `index.html` direkt root'ta.

### Hızlı Deploy Komutları (PowerShell'de çalıştır):

```powershell
# 1. Proje klasörüne git
cd "C:\Users\YAVUZ\Documents\SkorTahmin"

# 2. Firebase CLI kurulu değilse kur (bir kereye mahsus)
npm install -g firebase-tools

# 3. Firebase hesabınla giriş yap (Google hesabınla)
firebase login

# 4. Projeyi seç (aefy-lig)
firebase use aefy-lig

# 5. Deploy et (sadece hosting)
firebase deploy --only hosting
```

Deploy tamamlanınca site **hemen** şu adreste yayında olacak:

**https://aefy-lig.web.app**

Sonraki güncellemeler için sadece 5. adımı tekrarlaman yeterli:
```powershell
firebase deploy --only hosting
```

> Not: `firebase login` sırasında Firebase projesine erişim yetkisi olan Google hesabıyla giriş yapman lazım.

### Deploy Sonrası Yapılacaklar:
1. Tarayıcıda https://aefy-lig.web.app adresine gir.
2. `admin@aefy-lig.com` ile **kayıt ol** (otomatik admin olacak).
3. Admin panelinden örnek maçları yükle.
4. Arkadaşlarına linki paylaş. Onlar da kendi hesaplarıyla kaydolup tahmin yapabilecek.

## Alternatif (İstersen)
Netlify Drop ile de hızlıca deploy edebilirsin ama sen zaten `aefy-lig.web.app` istediğin için Firebase Hosting en doğrusu.

## Dosyalar
- `index.html` → Tek dosya uygulama
- `firebase.json` → Firebase Hosting yapılandırması (hazır)
- Bu README

## İpuçları
- Maçları ekledikten sonra "Yenile" butonuna basın.
- Canlı sitede birden fazla arkadaş farklı hesaplarla aynı anda test edebilir.
- Güvenlik için Firebase Console'dan Firestore kurallarını production'a göre sıkılaştır (şu an test modunda çalışır).

İyi eğlenceler! ⚽🏆
Sorun yaşarsan Firebase Console → Authentication ve Hosting sekmelerini kontrol et.
