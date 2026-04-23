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
$OutFile = if ($OutFile) { $OutFile } else { Join-Path $root "artifacts\posts-audit.json" }

Add-Type -AssemblyName System.Drawing

function Read-JsonFile {
  param([string]$Path)
  Get-Content -Raw $Path | ConvertFrom-Json
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

$badHashes = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($signature in $signatures) {
  if (-not [string]::IsNullOrWhiteSpace([string]$signature.sha256)) {
    [void]$badHashes.Add(([string]$signature.sha256).ToUpperInvariant())
  }
}

$blankFields = New-Object System.Collections.ArrayList
$missingImages = New-Object System.Collections.ArrayList
$unreadableImages = New-Object System.Collections.ArrayList
$smallImages = New-Object System.Collections.ArrayList
$placeholderMatches = New-Object System.Collections.ArrayList
$duplicateImageRefs = @{}
$duplicatePostTexts = @{}
$imageHashCache = @{}

foreach ($post in $posts) {
  foreach ($field in "concept", "selectedIdea", "imagePath", "post") {
    $value = [string]$post.$field
    if ([string]::IsNullOrWhiteSpace($value)) {
      $null = $blankFields.Add([pscustomobject]@{
        index = [int]$post.index
        concept = [string]$post.concept
        selectedIdea = [string]$post.selectedIdea
        field = $field
      })
    }
  }

  $normalizedPost = ([string]$post.post -replace "\s+", " ").Trim().ToLowerInvariant()
  if (-not [string]::IsNullOrWhiteSpace($normalizedPost)) {
    if (-not $duplicatePostTexts.ContainsKey($normalizedPost)) {
      $duplicatePostTexts[$normalizedPost] = New-Object System.Collections.ArrayList
    }
    $null = $duplicatePostTexts[$normalizedPost].Add([int]$post.index)
  }

  $imagePath = [string]$post.imagePath
  if ([string]::IsNullOrWhiteSpace($imagePath)) {
    continue
  }

  if (-not $duplicateImageRefs.ContainsKey($imagePath)) {
    $duplicateImageRefs[$imagePath] = New-Object System.Collections.ArrayList
  }
  $null = $duplicateImageRefs[$imagePath].Add([int]$post.index)

  $fileName = [System.IO.Path]::GetFileName($imagePath)
  $filePath = Join-Path $GeneratedDir $fileName
  if (-not (Test-Path $filePath)) {
    $null = $missingImages.Add([pscustomobject]@{
      index = [int]$post.index
      concept = [string]$post.concept
      selectedIdea = [string]$post.selectedIdea
      imagePath = $imagePath
    })
    continue
  }

  $fileInfo = Get-Item $filePath
  try {
    $image = [System.Drawing.Image]::FromFile($filePath)
    try {
      $width = [int]$image.Width
      $height = [int]$image.Height
      $sizeKB = [math]::Round($fileInfo.Length / 1kb, 1)
      if ($width -lt 200 -or $height -lt 200 -or $fileInfo.Length -lt 10240) {
        $null = $smallImages.Add([pscustomobject]@{
          index = [int]$post.index
          concept = [string]$post.concept
          selectedIdea = [string]$post.selectedIdea
          imagePath = $imagePath
          width = $width
          height = $height
          sizeKB = $sizeKB
        })
      }
    }
    finally {
      $image.Dispose()
    }
  }
  catch {
    $null = $unreadableImages.Add([pscustomobject]@{
      index = [int]$post.index
      concept = [string]$post.concept
      selectedIdea = [string]$post.selectedIdea
      imagePath = $imagePath
      error = $_.Exception.Message
    })
    continue
  }

  if (-not $imageHashCache.ContainsKey($fileName)) {
    $imageHashCache[$fileName] = (Get-FileHash $filePath -Algorithm SHA256).Hash.ToUpperInvariant()
  }

  $hash = [string]$imageHashCache[$fileName]
  if ($badHashes.Contains($hash)) {
    $null = $placeholderMatches.Add([pscustomobject]@{
      index = [int]$post.index
      concept = [string]$post.concept
      selectedIdea = [string]$post.selectedIdea
      imagePath = $imagePath
      sha256 = $hash
    })
  }
}

$duplicateImageResults = foreach ($key in $duplicateImageRefs.Keys) {
  $indexes = @($duplicateImageRefs[$key] | Sort-Object)
  if ($indexes.Count -gt 1) {
    [pscustomobject]@{
      imagePath = $key
      indexes = $indexes
    }
  }
}

$duplicatePostResults = foreach ($key in $duplicatePostTexts.Keys) {
  $indexes = @($duplicatePostTexts[$key] | Sort-Object)
  if ($indexes.Count -gt 1) {
    [pscustomobject]@{
      indexes = $indexes
      sample = if ($key.Length -gt 160) { $key.Substring(0, 160) } else { $key }
    }
  }
}

$result = [ordered]@{
  generatedAt = [DateTime]::UtcNow.ToString("o")
  totalPosts = $posts.Count
  blankFieldCount = $blankFields.Count
  missingImageCount = $missingImages.Count
  unreadableImageCount = $unreadableImages.Count
  smallImageCount = $smallImages.Count
  placeholderMatchCount = $placeholderMatches.Count
  duplicateImageRefCount = @($duplicateImageResults).Count
  duplicatePostTextCount = @($duplicatePostResults).Count
  blankFields = @($blankFields | Sort-Object index, field)
  missingImages = @($missingImages | Sort-Object index)
  unreadableImages = @($unreadableImages | Sort-Object index)
  smallImages = @($smallImages | Sort-Object index)
  placeholderMatches = @($placeholderMatches | Sort-Object index)
  duplicateImageRefs = @($duplicateImageResults | Sort-Object imagePath)
  duplicatePostTexts = @($duplicatePostResults | Sort-Object { $_.indexes[0] })
}

$outDir = Split-Path -Parent $OutFile
if (-not (Test-Path $outDir)) {
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$json = $result | ConvertTo-Json -Depth 10
Set-Content -Path $OutFile -Value ($json + "`n")

Write-Host "Total posts:              $($result.totalPosts)"
Write-Host "Blank required fields:    $($result.blankFieldCount)"
Write-Host "Missing image files:      $($result.missingImageCount)"
Write-Host "Unreadable image files:   $($result.unreadableImageCount)"
Write-Host "Small image files:        $($result.smallImageCount)"
Write-Host "Known placeholder hashes: $($result.placeholderMatchCount)"
Write-Host "Duplicate image refs:     $($result.duplicateImageRefCount)"
Write-Host "Duplicate post texts:     $($result.duplicatePostTextCount)"
Write-Host "Report:                   $OutFile"

if ($blankFields.Count -gt 0) {
  Write-Host ""
  Write-Host "Blank fields:"
  $blankFields | Sort-Object index, field | Format-Table index, concept, selectedIdea, field -AutoSize | Out-String | Write-Host
}

if ($missingImages.Count -gt 0) {
  Write-Host ""
  Write-Host "Missing images:"
  $missingImages | Sort-Object index | Format-Table index, concept, selectedIdea, imagePath -AutoSize | Out-String | Write-Host
}

if ($unreadableImages.Count -gt 0) {
  Write-Host ""
  Write-Host "Unreadable images:"
  $unreadableImages | Sort-Object index | Format-Table index, concept, selectedIdea, imagePath, error -AutoSize | Out-String | Write-Host
}

if ($smallImages.Count -gt 0) {
  Write-Host ""
  Write-Host "Small images:"
  $smallImages | Sort-Object index | Format-Table index, concept, selectedIdea, imagePath, width, height, sizeKB -AutoSize | Out-String | Write-Host
}

if ($placeholderMatches.Count -gt 0) {
  Write-Host ""
  Write-Host "Known placeholder matches:"
  $placeholderMatches | Sort-Object index | Format-Table index, concept, selectedIdea, imagePath -AutoSize | Out-String | Write-Host
}

if (@($duplicateImageResults).Count -gt 0) {
  Write-Host ""
  Write-Host "Duplicate image refs:"
  $duplicateImageResults | Sort-Object imagePath | Format-Table imagePath, indexes -AutoSize | Out-String | Write-Host
}

if (@($duplicatePostResults).Count -gt 0) {
  Write-Host ""
  Write-Host "Duplicate post texts:"
  $duplicatePostResults | Sort-Object { $_.indexes[0] } | Format-Table indexes, sample -AutoSize | Out-String | Write-Host
}