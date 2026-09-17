$ErrorActionPreference = "Stop"

function Find-DashboardTool([string]$Name, [string[]]$Candidates) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and $command.Source) {
        return $command.Source
    }
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

function Initialize-DashboardTools {
    $codexGit = Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE ".cache\codex-runtimes") `
        -Filter git.exe -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '[\\/]dependencies[\\/]native[\\/]git[\\/]cmd[\\/]git\.exe$' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName

    $git = Find-DashboardTool "git.exe" @(
        "C:\Program Files\Git\cmd\git.exe",
        "C:\Program Files\Git\bin\git.exe",
        $codexGit
    )
    $gh = Find-DashboardTool "gh.exe" @(
        "C:\Program Files\GitHub CLI\gh.exe",
        "C:\Program Files (x86)\GitHub CLI\gh.exe"
    )
    $npm = Find-DashboardTool "npm.cmd" @("C:\Program Files\nodejs\npm.cmd")

    if (-not $git) { throw "Git was not found. Install Git for Windows if the Codex-bundled Git is unavailable." }
    if (-not $gh) { throw "GitHub CLI was not found." }
    if (-not $npm) { throw "npm was not found. Install Node.js." }

    $toolDirs = @((Split-Path $git -Parent), (Split-Path $gh -Parent), (Split-Path $npm -Parent)) |
        Select-Object -Unique
    $env:Path = (($toolDirs + @($env:Path)) -join ";")
    return @{ Git = $git; Gh = $gh; Npm = $npm }
}
