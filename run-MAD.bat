@echo off
setlocal
cd /d "%~dp0"

set "MAD_SCRIPT=%~dp0MAD.py"
set "LOGO_FILE=%~dp0Volvo_MAD.png"
set "PYTHON=%ProgramFiles%\Python313\python.exe"
set "PYTHONW=%ProgramFiles%\Python313\pythonw.exe"

if not exist "%MAD_SCRIPT%" (
    echo ERROR: MAD.py was not found in %~dp0
    pause
    exit /b 1
)

if not exist "%LOGO_FILE%" (
    echo ERROR: Volvo_MAD.png was not found in %~dp0
    pause
    exit /b 1
)

where copilot.exe >nul 2>&1
if errorlevel 1 (
    where copilot.cmd >nul 2>&1
    if errorlevel 1 (
        echo WARNING: GitHub Copilot CLI was not found on PATH.
        echo The dashboard will open, but MaoWeiAgent chat requires Copilot CLI and "copilot login".
    )
)

if exist "%PYTHON%" (
    "%PYTHON%" -c "import PySide6" >nul 2>&1
    if errorlevel 1 (
        echo ERROR: PySide6 is not installed for Python 3.13.
        echo Run: "%PYTHON%" -m pip install PySide6
        pause
        exit /b 1
    )
    start "Volvo MAD" "%PYTHONW%" "%MAD_SCRIPT%"
    exit /b 0
)

where pyw.exe >nul 2>&1
if not errorlevel 1 (
    start "Volvo MAD" pyw.exe -3 "%MAD_SCRIPT%"
    exit /b 0
)

echo ERROR: Python 3 was not found.
pause
exit /b 1
