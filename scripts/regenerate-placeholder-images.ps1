param(
  [string]$Provider = "meta"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$postsFile = Join-Path $root "data\posts.json"
$conceptsFile = Join-Path $root "data\concepts-complete.json"
$signaturesFile = Join-Path $root "data\bad-image-signatures.json"
$generatedDir = Join-Path $root "public\generated"
$generatorScript = Join-Path $PSScriptRoot "generate-four-cdp.ps1"

function Read-JsonFile {
  param([string]$Path)
  return Get-Content -Raw $Path | ConvertFrom-Json
}

$posts = @((Read-JsonFile -Path $postsFile).posts)
$concepts = @((Read-JsonFile -Path $conceptsFile).concepts)
$signatures = @((Read-JsonFile -Path $signaturesFile).signatures)

$badHashes = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($signature in $signatures) {
  [void]$badHashes.Add([string]$signature.sha256)
}

$conceptByIdea = @{}
foreach ($entry in $concepts) {
  $conceptByIdea[[string]$entry.selectedIdea] = $entry
}

$seenFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$targets = foreach ($post in $posts) {
  $fileName = [System.IO.Path]::GetFileName([string]$post.imagePath)
  if (-not $seenFiles.Add($fileName)) {
    continue
  }

  $filePath = Join-Path $generatedDir $fileName
  if (-not (Test-Path $filePath)) {
    continue
  }

  $hash = (Get-FileHash $filePath -Algorithm SHA256).Hash
  if (-not $badHashes.Contains($hash)) {
    continue
  }

  $conceptEntry = $conceptByIdea[[string]$post.selectedIdea]
  $prompt = [string]$conceptEntry.image.prompt
  $gender = if ($prompt -match "an attractive male") {
    "male"
  }
  elseif ($prompt -match "an attractive female") {
    "female"
  }
  else {
    "random"
  }

  $variantId = if ($prompt -match "^attention-getter centered on") {
    "educator_scene_v2"
  }
  else {
    "single_object_v1"
  }

  [pscustomobject]@{
    concept = [string]$post.concept
    idea = [string]$post.selectedIdea
    gender = $gender
    variantId = $variantId
    fileName = $fileName
  }
}

if (-not $targets -or @($targets).Count -eq 0) {
  Write-Host "No placeholder-backed images were found."
  return
}

$results = New-Object System.Collections.ArrayList

foreach ($target in $targets) {
  Write-Host "Regenerating $($target.fileName) via $Provider..."

  try {
    $generatorParams = @{
      Idea = $target.idea
      VariantId = $target.variantId
      PersonGender = $target.gender
      Providers = @($Provider)
      OutputFileName = $target.fileName
    }

    & $generatorScript @generatorParams

    $null = $results.Add([pscustomobject]@{
      file = $target.fileName
      status = "ok"
    })
  }
  catch {
    $null = $results.Add([pscustomobject]@{
      file = $target.fileName
      status = "failed"
      error = $_.Exception.Message
    })
    Write-Warning "Failed to regenerate $($target.fileName): $($_.Exception.Message)"
  }
}

$results | ConvertTo-Json -Compress