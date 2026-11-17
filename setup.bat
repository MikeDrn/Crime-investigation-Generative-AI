@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\activate.bat" (
  echo Creating a Python virtual environment in .venv ...
  py -3.12 -m venv .venv 2>nul || py -3.11 -m venv .venv 2>nul || python -m venv .venv
)
if not exist ".venv\Scripts\activate.bat" (
  echo Python wasn't found. Install Python 3.12 from python.org and tick "Add python.exe to PATH".
  pause
  exit /b 1
)
call .venv\Scripts\activate.bat
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"
if errorlevel 1 (
  echo This project needs Python 3.11 or 3.12. Install Python 3.12, delete the .venv folder, and run setup.bat again.
  pause
  exit /b 1
)
python -m pip install --upgrade pip
pip install --upgrade -r requirements.txt
if errorlevel 1 (
  echo.
  echo Installing failed. Scroll up for the error, or send it to whoever helps you with this project.
  pause
  exit /b 1
)
if not exist ".env" copy ".env.example" ".env" >nul
echo.
echo Setup finished. Double-click run.bat to start.
echo Models are kept in %USERPROFILE%\GenAI-Studio-models, so updating the code never deletes them.
pause
