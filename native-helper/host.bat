@echo off
:: Windows launcher for host.py.
:: Chrome cannot execute .py files directly on Windows — this batch file
:: is the "path" in the host manifest. It hands off to Python immediately.
python "%~dp0host.py"
