@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM Always use THIS folder's venv — never Hermes or system random Python
set "VENV=%~dp0.venv"
set "PY=%VENV%\Scripts\python.exe"
set "PIP=%VENV%\Scripts\pip.exe"

echo ============================================
echo   Migas Portable — local environment
echo   Folder: %cd%
echo ============================================

if not exist "%PY%" (
  echo [1/3] Creating local virtual environment in .venv ...
  where py >nul 2>nul
  if %ERRORLEVEL%==0 (
    py -3 -m venv "%VENV%"
  ) else (
    where python >nul 2>nul
    if %ERRORLEVEL%==0 (
      python -m venv "%VENV%"
    ) else (
      echo ERROR: Python not found. Install Python 3.10 or 3.11 from python.org
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
)

echo [2/3] Installing / updating packages into local .venv ...
"%PY%" -m pip install -U pip >nul
"%PY%" -m pip install flask flask-cors waitress pandas numpy scikit-learn joblib
"%PY%" -m pip install automl-alex
if errorlevel 1 (
  echo.
  echo WARNING: automl-alex install failed. Charts + Save/Load still work.
  echo AutoML training needs automl-alex. Try Python 3.10 or 3.11 if needed.
  echo.
)

echo [3/3] Starting Migas ...
set "MIGAS_PORT=5055"
set "MIGAS_API_TOKEN="
set "MIGAS_PYTHON=%PY%"
"%PY%" launcher.py
if errorlevel 1 (
  echo.
  echo App exited with an error.
  pause
)
