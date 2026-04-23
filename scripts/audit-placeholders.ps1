param(
  [string]$PostsFile,
  [string]$GeneratedDir,
  [string]$SignatureFile,
  [string]$OutFile
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$PostsFile = if ($PostsFile) { $PostsFile } else { Join-Path $root "data\posts.json" }
$GeneratedDir = if ($GeneratedDir) { $GeneratedDir } else { Join-Path $root "public\generated" }
$SignatureFile = if ($SignatureFile) { $SignatureFile } else { Join-Path $root "data\bad-image-signatures.json" }
$OutFile = if ($OutFile) { $OutFile } else { Join-Path $root "artifacts\placeholder-audit.json" }

function Read-JsonFile {
  param([string]$Path)
  return Get-Content -Raw $Path | ConvertFrom-Json
}

if (-not (Test-Path $PostsFile)) {
  throw "Posts file not found: $PostsFile"
}

if (-not (Test-Path $GeneratedDir)) {
  throw "Generated image directory not found: $GeneratedDir"
}

if (-not (Test-Path $SignatureFile)) {
  throw "Signature file not found: $SignatureFile"
}

$postsData = Read-JsonFile -Path $PostsFile
$signaturesData = Read-JsonFile -Path $SignatureFile
$posts = @($postsData.posts)
$signatures = @($signaturesData.signatures)

$signatureByHash = @{}
foreach ($signature in $signatures) {
  $signatureByHash[[string]$signature.sha256.ToUpperInvariant()] = $signature
}

$hashByFile = @{}
$matches = New-Object System.Collections.ArrayList

foreach ($post in $posts) {
  $fileName = [System.IO.Path]::GetFileName([string]$post.imagePath)
  $filePath = Join-Path $GeneratedDir $fileName
  if (-not (Test-Path $filePath)) {
    continue
  }

  if (-not $hashByFile.ContainsKey($fileName)) {
    $hashByFile[$fileName] = (Get-FileHash $filePath -Algorithm SHA256).Hash.ToUpperInvariant()
  }

  $hash = [string]$hashByFile[$fileName]
  if ($signatureByHash.ContainsKey($hash)) {
    $signature = $signatureByHash[$hash]
    $null = $matches.Add([pscustomobject]@{
      index = [int]$post.index
      concept = [string]$post.concept
      selectedIdea = [string]$post.selectedIdea
      imagePath = [string]$post.imagePath
      signatureId = [string]$signature.id
      reason = [string]$signature.reason
      sha256 = $hash
    })
  }
}

$result = [ordered]@{
  generatedAt = [DateTime]::UtcNow.ToString("o")
  affectedPosts = $matches.Count
  uniqueFiles = @($matches | Select-Object -ExpandProperty imagePath -Unique).Count
  matches = @($matches | Sort-Object index)
}

$outDir = Split-Path -Parent $OutFile
if (-not (Test-Path $outDir)) {
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$json = $result | ConvertTo-Json -Depth 10
Set-Content -Path $OutFile -Value ($json + "`n")

Write-Host "Affected posts: $($result.affectedPosts)"
Write-Host "Unique files:   $($result.uniqueFiles)"
Write-Host "Report:         $OutFile"

if ($matches.Count -gt 0) {
  $matches | Sort-Object index | Format-Table index, concept, selectedIdea, imagePath -AutoSize | Out-String | Write-Host
}