@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "VENV=%~dp0.venv"
set "PY=%VENV%\Scripts\python.exe"

if not exist "%PY%" (
  echo Run Start_Migas.bat or Install_Or_Update.bat first to create .venv
  pause
  exit /b 1
)

echo Building EXE with local .venv Python...
"%PY%" -m pip install pyinstaller
"%PY%" -m PyInstaller --noconfirm --clean --name MigasPortable --onefile --console ^
  --add-data "Migas Program.html;." ^
  --add-data "migas.html;." ^
  --add-data "shared;shared" ^
  --add-data "azimuth;azimuth" ^
  --add-data "casing;casing" ^
  --add-data "drilling;drilling" ^
  --add-data "boxplot;boxplot" ^
  --add-data "ai;ai" ^
  --add-data "automl;automl" ^
  --add-data "server;server" ^
  launcher.py

echo.
echo EXE: %cd%\dist\MigasPortable.exe
pause
