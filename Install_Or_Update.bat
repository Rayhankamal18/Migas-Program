@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "VENV=%~dp0.venv"
set "PY=%VENV%\Scripts\python.exe"

echo Installing Migas into: %cd%
echo (packages go only into .venv here — not Hermes, not global)

if not exist "%PY%" (
  where py >nul 2>nul && py -3 -m venv "%VENV%" || python -m venv "%VENV%"
)

"%PY%" -m pip install -U pip
"%PY%" -m pip install -r "%~dp0requirements-portable.txt"
"%PY%" -m pip install automl-alex

echo.
echo Done. Double-click Start_Migas.bat to run.
pause
