@echo off
chcp 65001 >nul
setlocal EnableExtensions

REM ============================================================
REM  SkorTahmin - GitHub yedekleme
REM  https://github.com/yvzsltn1-blip/skortahmin
REM ============================================================

cd /d "%~dp0"
set "REPO_URL=https://github.com/yvzsltn1-blip/skortahmin.git"
set "BRANCH=main"

echo.
echo ========================================
echo   SkorTahmin GitHub Yedekleme
echo ========================================
echo   Klasor: %CD%
echo   Hedef : %REPO_URL%
echo ========================================
echo.

where git >nul 2>&1
if errorlevel 1 (
    echo [HATA] Git bulunamadi: https://git-scm.com/download/win
    goto :fail
)

REM CRLF uyari selini kapat (sadece bu oturum)
set "GIT_CONFIG_COUNT=1"
set "GIT_CONFIG_KEY_0=core.safecrlf"
set "GIT_CONFIG_VALUE_0=false"

REM Bozuk .git
if exist ".git\" (
    if not exist ".git\HEAD" (
        echo [BILGI] Bozuk .git temizleniyor...
        rmdir /s /q ".git" 2>nul
    )
)

if not exist ".git\HEAD" (
    echo [1/6] Git deposu olusturuluyor...
    git init -b %BRANCH% 2>nul
    if errorlevel 1 (
        git init
        git branch -M %BRANCH%
    )
    if errorlevel 1 (
        echo [HATA] git init basarisiz.
        goto :fail
    )
) else (
    echo [1/6] Git deposu hazir.
)

REM Onceki hatali eklemeler: SDK vb. staging'den cikar
echo [2/6] Buyuk / gereksiz klasorler kontrol ediliyor...
git rm -r --cached --ignore-unmatch .apk-toolchain >nul 2>&1
git rm -r --cached --ignore-unmatch .android-sdk >nul 2>&1
git rm -r --cached --ignore-unmatch node_modules >nul 2>&1
git rm -r --cached --ignore-unmatch functions/node_modules >nul 2>&1
git rm -r --cached --ignore-unmatch dist >nul 2>&1
git rm -r --cached --ignore-unmatch build >nul 2>&1
git rm --cached --ignore-unmatch "*.apk" >nul 2>&1
git rm --cached --ignore-unmatch "*.aab" >nul 2>&1
git rm --cached --ignore-unmatch "AEFY-LIG-*.apk" >nul 2>&1
git rm --cached --ignore-unmatch "android/app/google-services.json" >nul 2>&1
git rm --cached --ignore-unmatch "GoogleService-Info.plist" >nul 2>&1
git rm --cached --ignore-unmatch "serviceAccount*.json" >nul 2>&1
git rm --cached --ignore-unmatch "*-firebase-adminsdk-*.json" >nul 2>&1
git rm --cached --ignore-unmatch "index.backup-*.html" >nul 2>&1

echo [3/6] Remote ayarlaniyor...
git remote get-url origin >nul 2>&1
if errorlevel 1 (
    git remote add origin "%REPO_URL%"
) else (
    git remote set-url origin "%REPO_URL%"
)
if errorlevel 1 (
    echo [HATA] remote ayarlanamadi.
    goto :fail
)

echo [4/6] Dosyalar ekleniyor (.gitignore haric)...
echo       Bu adim normalde birkac saniye surer.
git add -A
if errorlevel 1 (
    echo [HATA] git add basarisiz.
    goto :fail
)

git rm -r --cached --ignore-unmatch .apk-toolchain >nul 2>&1
git rm -r --cached --ignore-unmatch node_modules >nul 2>&1
git rm -r --cached --ignore-unmatch functions/node_modules >nul 2>&1
git rm -r --cached --ignore-unmatch dist >nul 2>&1
git rm --cached --ignore-unmatch "*.apk" >nul 2>&1
git rm --cached --ignore-unmatch "*.aab" >nul 2>&1
git rm --cached --ignore-unmatch "android/app/google-services.json" >nul 2>&1
git rm --cached --ignore-unmatch "index.backup-*.html" >nul 2>&1

echo [5/6] Commit...
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "Yedek %date% %time%"
    if errorlevel 1 (
        echo [HATA] commit basarisiz.
        echo Once sunlari calistirin:
        echo   git config --global user.name "Adiniz"
        echo   git config --global user.email "email@ornek.com"
        goto :fail
    )
    echo       Commit tamam.
) else (
    echo       Yeni degisiklik yok; mevcut commit kontrol edilecek.
)

echo [6/6] GitHub'a gonderiliyor...
git branch -M %BRANCH% 2>nul
git push -u origin %BRANCH%
if errorlevel 1 (
    echo.
    echo [HATA] Push basarisiz.
    echo  - Repo var mi? https://github.com/yvzsltn1-blip/skortahmin
    echo  - Giris / token: Git Credential Manager acilmali
    echo  - Ilk seferde cakisma varsa:
    echo      git pull origin main --allow-unrelated-histories
    echo    sonra bu bat'i tekrar calistirin.
    goto :fail
)

echo.
echo ========================================
echo   YEDEKLEME BASARILI
echo   https://github.com/yvzsltn1-blip/skortahmin
echo ========================================
echo.
pause
exit /b 0

:fail
echo.
echo ========================================
echo   YEDEKLEME BASARISIZ
echo ========================================
echo.
pause
exit /b 1
