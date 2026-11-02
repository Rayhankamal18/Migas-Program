@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "VENV=%~dp0.venv"
set "PY=%VENV%\Scripts\python.exe"

echo ============================================
echo   Migas — install / update local libraries
echo   Target: %cd%\.venv
echo ============================================

if not exist "%PY%" (
  echo Creating .venv ...
  where py >nul 2>nul
  if !ERRORLEVEL!==0 (
    py -3 -m venv "%VENV%"
  ) else (
    python -m venv "%VENV%"
  )
)

if not exist "%PY%" (
  echo ERROR: Could not create virtual environment.
  pause
  exit /b 1
)

"%PY%" -m pip install -U pip setuptools wheel
"%PY%" -m pip install flask flask-cors waitress pandas numpy scikit-learn joblib matplotlib optuna lightgbm psutil nevergrad

set "ALEX_VER=1.6.10"
for /f "delims=" %%V in ('"%PY%" -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"') do set "PYVER=%%V"
echo Detected Python !PYVER!
echo !PYVER! | findstr /b "3.8 3.9 3.10" >nul
if !ERRORLEVEL!==0 set "ALEX_VER=2023.3.11"
"%PY%" -m pip install "automl-alex==!ALEX_VER!"
if errorlevel 1 "%PY%" -m pip install automl-alex

echo.
"%PY%" -c "import sys; print('Python', sys.version)"
"%PY%" -c "import flask,pandas,sklearn; print('flask/pandas/sklearn OK')"
"%PY%" -c "import automl_alex; print('automl-alex', getattr(automl_alex,'__version__','OK'))" 2>nul || echo automl-alex: not installed
echo.
echo Done. Double-click Start_Migas.bat to run the local app.
pause
