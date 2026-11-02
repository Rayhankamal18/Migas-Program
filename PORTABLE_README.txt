Migas Portable — auto local environment
=======================================

HOW IT WORKS
- Extract this folder anywhere, e.g.
    D:\ML\AI AGENT EDITABLE\migas-portable
- Double-click  Start_Migas.bat
- First run creates  .venv\  INSIDE this folder and installs packages there
- Never uses Hermes or another app's Python

RUN
1. Double-click  Start_Migas.bat
2. Browser opens http://127.0.0.1:5055/
3. Settings → API base URL = empty → Test API
4. Data saved in  migas_data\  next to this folder

OPTIONAL
- Install_Or_Update.bat  — only install/update packages
- build_exe.bat          — build dist\MigasPortable.exe (uses same .venv)

DATA FOLDER
- Default:  <this_folder>\migas_data\
- Change in Settings → Local data folder

NOTE
- automl-alex may need Python 3.10 or 3.11
- If AutoML install fails, charts + save/load still work
