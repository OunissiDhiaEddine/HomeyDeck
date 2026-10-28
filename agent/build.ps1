# Builds the agent on Windows. Output: agent\dist\homeydeck-agent.exe
param([string]$Version = "dev")
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force -Path dist | Out-Null
$env:GOOS = "windows"; $env:GOARCH = "amd64"; $env:CGO_ENABLED = "0"
go build -trimpath -ldflags "-s -w -H windowsgui -X main.version=$Version" -o dist\homeydeck-agent.exe .
Write-Host "built dist\homeydeck-agent.exe ($Version)"
