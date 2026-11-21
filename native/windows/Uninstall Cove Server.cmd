@echo off
rem Removes Cove Server (keeps your settings in C:\ProgramData\Cove Server)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0uninstall.ps1\"'"
