@echo off
cd /d "%~dp0"
echo ============================================
echo  Bot Nefertiti - commit + empaquetado v1.3.1
echo ============================================

echo.
echo [0/4] Limpiando lock viejo de git (si existe)...
if exist ".git\index.lock" del /f ".git\index.lock"

echo [1/4] Sacando de git los archivos que no deben versionarse (dist, session, logs)...
git rm -r --cached dist session logs >nul 2>&1

echo [2/4] Commit de los cambios...
git add -A
git commit -m "feat: modificar turno + aviso opcional al reactivar cliente (v1.3.1)"
if errorlevel 1 (
  echo.
  echo ATENCION: el commit fallo o no habia cambios. Revisa el mensaje de arriba.
  pause
  exit /b 1
)

echo.
echo [3/4] Reconstruyendo better-sqlite3 para Electron...
call npx electron-rebuild -f -w better-sqlite3
if errorlevel 1 (
  echo ERROR: fallo electron-rebuild.
  pause
  exit /b 1
)

echo.
echo [4/4] Generando el instalador (puede tardar varios minutos)...
call npm run build
if errorlevel 1 (
  echo ERROR: fallo el build.
  pause
  exit /b 1
)

echo.
echo ============================================
echo  LISTO. Instalador generado en:
echo  dist\Bot Nefertiti Setup 1.3.1.exe
echo  Copialo a la notebook e instalalo sobre la version existente.
echo ============================================
pause
