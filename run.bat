@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\activate.bat" (
  echo Run setup.bat first.
  pause
  exit /b 1
)
call .venv\Scripts\activate.bat
start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:8000"
echo GenAI Studio is running at http://127.0.0.1:8000  (close this window to stop it)
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload --reload-dir backend
