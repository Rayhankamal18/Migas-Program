@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

REM Always use THIS folder's venv — never another app's Python
set "VENV=%~dp0.venv"
set "PY=%VENV%\Scripts\python.exe"
set "REQ=%~dp0requirements-portable.txt"
set "MARKER=%VENV%\.migas_deps_ok"

echo ============================================
echo   Migas Portable — local environment
echo   Folder: %cd%
echo ============================================

if not exist "%PY%" (
  echo [1/4] Creating local virtual environment in .venv ...
  where py >nul 2>nul
  if !ERRORLEVEL!==0 (
    py -3 -m venv "%VENV%"
  ) else (
    where python >nul 2>nul
    if !ERRORLEVEL!==0 (
      python -m venv "%VENV%"
    ) else (
      echo ERROR: Python not found. Install Python 3.10+ from python.org
      echo Enable "Add python.exe to PATH", then run this again.
      pause
      exit /b 1
    )
  )
  if not exist "%PY%" (
    echo ERROR: Failed to create .venv
    pause
    exit /b 1
  )
) else (
  echo [1/4] Using existing .venv
)

echo [2/4] Upgrading pip / setuptools / wheel ...
"%PY%" -m pip install -U pip setuptools wheel
if errorlevel 1 (
  echo ERROR: pip upgrade failed.
  pause
  exit /b 1
)

echo [3/4] Installing core libraries into local .venv ...
echo       First run can take several minutes.
"%PY%" -m pip install flask flask-cors waitress pandas numpy scikit-learn joblib matplotlib optuna lightgbm psutil nevergrad
if errorlevel 1 (
  echo ERROR: Core package install failed.
  pause
  exit /b 1
)

echo       Installing AutoML library ...
set "ALEX_VER=1.6.10"
for /f "delims=" %%V in ('"%PY%" -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"') do set "PYVER=%%V"
echo       Detected Python !PYVER!
echo !PYVER! | findstr /b "3.8 3.9 3.10" >nul
if !ERRORLEVEL!==0 set "ALEX_VER=2023.3.11"
"%PY%" -m pip install "automl-alex==!ALEX_VER!"
if errorlevel 1 (
  echo.
  echo WARNING: automl-alex==!ALEX_VER! failed. Trying latest available ...
  "%PY%" -m pip install automl-alex
  if errorlevel 1 (
    echo WARNING: automl-alex not installed. Charts + Save/Load still work.
    echo AutoML training needs automl-alex or will be limited.
    echo.
  )
)

"%PY%" -c "import flask,flask_cors,waitress,pandas,numpy,sklearn,joblib; print('Core OK')"
if errorlevel 1 (
  echo ERROR: Core packages missing. Fix pip errors above, then re-run.
  pause
  exit /b 1
)
echo ok>"%MARKER%"

echo [4/4] Starting local server at http://127.0.0.1:5055/ ...
echo       Keep this window open while using AutoML / Save-Load folder.
set "MIGAS_PORT=5055"
set "MIGAS_API_TOKEN="
set "MIGAS_MAX_UPLOAD_MB=500"
set "MIGAS_PYTHON=%PY%"
echo       Max upload: %MIGAS_MAX_UPLOAD_MB% MB
"%PY%" launcher.py
set "ERR=!ERRORLEVEL!"
if not "!ERR!"=="0" (
  echo.
  echo App exited with an error ^(!ERR!^).
  pause
)
exit /b !ERR!
