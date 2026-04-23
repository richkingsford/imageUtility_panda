param(
  [string]$Idea = "Education Conference Handshake",
  [string]$VariantId = "educator_scene_v2",
  [string]$PersonGender = "female",
  [string]$DebugUrl = "http://127.0.0.1:9222",
  [string[]]$Providers = @("chatgpt", "meta", "gemini", "copilot"),
  [string]$OutputFileName
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root "data"
$publicDir = Join-Path $root "public"
$generatedDir = Join-Path $publicDir "generated"
$latestDataFile = Join-Path $dataDir "latest.json"
$publicLatestFile = Join-Path $publicDir "latest.json"
$promptVariantsFile = Join-Path $dataDir "prompt-variants.json"

New-Item -ItemType Directory -Force -Path $generatedDir | Out-Null

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    return $null
  }

  return Get-Content -Raw $Path | ConvertFrom-Json
}

function Write-JsonFile {
  param(
    [string]$Path,
    [object]$Value
  )

  $json = $Value | ConvertTo-Json -Depth 20
  Set-Content -Path $Path -Value ($json + "`n")
}

function Get-PersonPhrase {
  param([string]$Gender)

  $normalizedGender = if ($null -eq $Gender) { "" } else { $Gender.ToLowerInvariant() }

  switch ($normalizedGender) {
    "male" { return "an attractive male" }
    "female" { return "an attractive female" }
    default { return "an attractive female" }
  }
}

function Build-Prompt {
  param(
    [string]$IdeaText,
    [string]$VariantIdText,
    [string]$Gender
  )

  $data = Read-JsonFile -Path $promptVariantsFile
  if (-not $data) {
    throw "Could not read prompt variants from $promptVariantsFile"
  }

  $targetVariantId = if ([string]::IsNullOrWhiteSpace($VariantIdText)) {
    $data.defaultVariantId
  } else {
    $VariantIdText
  }

  $variant = $data.variants | Where-Object { $_.id -eq $targetVariantId } | Select-Object -First 1
  if (-not $variant) {
    $variant = $data.variants | Where-Object { $_.id -eq $data.defaultVariantId } | Select-Object -First 1
  }
  if (-not $variant) {
    throw "No prompt variants found in $promptVariantsFile"
  }

  $person = Get-PersonPhrase -Gender $Gender
  $parts = foreach ($part in $variant.templateParts) {
    [string]$part.Replace("{IDEA}", $IdeaText).Replace("{PERSON}", $person)
  }

  return ($parts -join " ")
}

function Get-WebSocketDebuggerUrl {
  param([string]$BaseUrl)
  $version = Invoke-WebRequest -UseBasicParsing "$BaseUrl/json/version" -TimeoutSec 5
  $data = $version.Content | ConvertFrom-Json
  return $data.webSocketDebuggerUrl
}

function Get-DebugTargets {
  param([string]$BaseUrl)
  $response = Invoke-WebRequest -UseBasicParsing "$BaseUrl/json/list" -TimeoutSec 5
  return $response.Content | ConvertFrom-Json
}

function New-CdpClient {
  param([string]$WebSocketUrl)

  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $cts = [System.Threading.CancellationTokenSource]::new()
  $socket.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(20)
  $null = $socket.ConnectAsync([Uri]$WebSocketUrl, $cts.Token).GetAwaiter().GetResult()

  return New-Object psobject -Property @{
    Socket = $socket
    Token = $cts.Token
    NextId = 0
  }
}

function Close-CdpClient {
  param($Client)
  if (-not $Client) {
    return
  }

  if ($Client.Socket -and $Client.Socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
    $null = $Client.Socket.CloseAsync(
      [System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure,
      "done",
      [System.Threading.CancellationToken]::None
    ).GetAwaiter().GetResult()
  }
}

function Receive-CdpMessage {
  param($Client)

  $buffer = New-Object byte[] 65536
  $stream = New-Object System.IO.MemoryStream

  while ($true) {
    $segment = [ArraySegment[byte]]::new($buffer)
    $result = $Client.Socket.ReceiveAsync($segment, $Client.Token).GetAwaiter().GetResult()

    if ($result.Count -gt 0) {
      $stream.Write($buffer, 0, $result.Count)
    }

    if ($result.EndOfMessage) {
      break
    }
  }

  $json = [System.Text.Encoding]::UTF8.GetString($stream.ToArray())
  return $json | ConvertFrom-Json
}

function Invoke-Cdp {
  param(
    $Client,
    [string]$Method,
    [hashtable]$Params = @{}
  )

  $Client.NextId = [int]$Client.NextId + 1
  $id = [int]$Client.NextId
  $payload = @{
    id = $id
    method = $Method
    params = $Params
  } | ConvertTo-Json -Compress -Depth 20

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $segment = [ArraySegment[byte]]::new($bytes)
  $null = $Client.Socket.SendAsync(
    $segment,
    [System.Net.WebSockets.WebSocketMessageType]::Text,
    $true,
    $Client.Token
  ).GetAwaiter().GetResult()

  while ($true) {
      $message = Receive-CdpMessage -Client $Client
      if ($null -ne $message.id -and [int]$message.id -eq $id) {
        if ($message.error) {
        throw "CDP error for ${Method}: $($message.error.message)"
        }
        return $message.result
      }
  }
}

function Invoke-CdpEval {
  param(
    $Client,
    [string]$Expression
  )

  $result = Invoke-Cdp -Client $Client -Method "Runtime.evaluate" -Params @{
    expression = $Expression
    awaitPromise = $true
    returnByValue = $true
    userGesture = $true
  }

  if ($result.exceptionDetails) {
    $detailText = $result.exceptionDetails.text
    $description = $null
    if ($result.exceptionDetails.exception) {
      $description = $result.exceptionDetails.exception.description
      if (-not $description) {
        $description = $result.exceptionDetails.exception.value
      }
    }
    throw "JavaScript evaluation failed: $detailText $description"
  }

  return $result.result.value
}

function Enable-PageClient {
  param($Client)
  Invoke-Cdp -Client $Client -Method "Page.enable" | Out-Null
  Invoke-Cdp -Client $Client -Method "Runtime.enable" | Out-Null
  Invoke-Cdp -Client $Client -Method "DOM.enable" | Out-Null
}

function Navigate-Page {
  param(
    $Client,
    [string]$Url
  )

  Invoke-Cdp -Client $Client -Method "Page.navigate" -Params @{ url = $Url } | Out-Null
  Start-Sleep -Seconds 4
}

function Focus-And-Clear {
  param(
    $Client,
    [string]$Selector,
    [switch]$ContentEditable
  )

  $selectorText = [string](@($Selector) | Select-Object -First 1)
  $selectorJson = $selectorText | ConvertTo-Json -Compress
  $mode = if ($ContentEditable) { "contenteditable" } else { "input" }
  $expression = @"
(() => {
  const el = document.querySelector($selectorJson);
  if (!el) return false;
  el.focus();
  if ("$mode" === "contenteditable") {
    el.textContent = "";
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  } else {
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return true;
})()
"@

  return [bool](Invoke-CdpEval -Client $Client -Expression $expression)
}

function Insert-Text {
  param(
    $Client,
    [string]$Text
  )

  Invoke-Cdp -Client $Client -Method "Input.insertText" -Params @{ text = $Text } | Out-Null
  Start-Sleep -Milliseconds 500
}

function Set-ElementValue {
  param(
    $Client,
    [string]$Selector,
    [string]$Text,
    [switch]$ContentEditable
  )

  $selectorText = [string](@($Selector) | Select-Object -First 1)
  $selectorJson = $selectorText | ConvertTo-Json -Compress
  $textJson = $Text | ConvertTo-Json -Compress
  $mode = if ($ContentEditable) { "contenteditable" } else { "input" }
  $expression = @"
(() => {
  const el = document.querySelector($selectorJson);
  if (!el) return false;
  el.focus();
  if ("$mode" === "contenteditable") {
    el.textContent = "";
    const paragraph = document.createElement("p");
    paragraph.textContent = $textJson;
    el.replaceChildren(paragraph);
    el.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: $textJson
    }));
  } else {
    el.value = $textJson;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return true;
})()
"@

  return [bool](Invoke-CdpEval -Client $Client -Expression $expression)
}

function Set-FirstMatchingElementValue {
  param(
    $Client,
    [string[]]$Selectors,
    [string]$Text,
    [switch]$ContentEditable
  )

  foreach ($selector in $Selectors) {
    if (Set-ElementValue -Client $Client -Selector $selector -Text $Text -ContentEditable:$ContentEditable) {
      return $true
    }
  }

  return $false
}

function Press-Enter {
  param($Client)

  $params = @{
    type = "keyDown"
    windowsVirtualKeyCode = 13
    nativeVirtualKeyCode = 13
    key = "Enter"
    code = "Enter"
    text = "`r"
    unmodifiedText = "`r"
  }

  Invoke-Cdp -Client $Client -Method "Input.dispatchKeyEvent" -Params $params | Out-Null
  Invoke-Cdp -Client $Client -Method "Input.dispatchKeyEvent" -Params @{
    type = "keyUp"
    windowsVirtualKeyCode = 13
    nativeVirtualKeyCode = 13
    key = "Enter"
    code = "Enter"
  } | Out-Null
}

function Get-BaselineKeys {
  param(
    $Client,
    [string]$Provider
  )

  $query = if ($Provider -eq "chatgpt") { "main img" } else { "img" }
  $minWidth = if ($Provider -eq "gemini") { 200 } else { 256 }
  $queryJson = $query | ConvertTo-Json -Compress
  $expression = @"
(() => {
  return Array.from(document.querySelectorAll($queryJson))
    .filter((img) => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      const src = (img.currentSrc || img.src || "").toLowerCase();
      const alt = String(img.alt || "").toLowerCase();
      if (!src || src.startsWith("data:")) return false;
      if (w < $minWidth || h < $minWidth) return false;
      return !/avatar|icon|logo|favicon|profile|emoji|sparkle/.test((alt + " " + src));
    })
    .map((img) => String(img.currentSrc || img.src) + "::" + String(img.alt || ""));
})()
"@

  $value = Invoke-CdpEval -Client $Client -Expression $expression
  if ($null -eq $value) {
    return @()
  }

  return @($value)
}

function Try-Click-Send {
  param(
    $Client,
    [string[]]$Selectors
  )

  $selectorsJson = ConvertTo-Json -InputObject @($Selectors) -Compress
  $expression = @"
(() => {
  const selectors = $selectorsJson;
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      el.click();
      return true;
    }
  }
  return false;
})()
"@

  return [bool](Invoke-CdpEval -Client $Client -Expression $expression)
}

function Try-ClickButtonByText {
  param(
    $Client,
    [string[]]$Labels
  )

  $labelsJson = ConvertTo-Json -InputObject @($Labels) -Compress
  $expression = @"
(() => {
  const rawLabels = $labelsJson;
  const labels = (Array.isArray(rawLabels) ? rawLabels : [rawLabels]).map((label) => String(label).trim().toLowerCase());
  const buttons = Array.from(document.querySelectorAll("button"));
  for (const button of buttons) {
    const text = String(button.innerText || button.textContent || "").trim().toLowerCase();
    const aria = String(button.getAttribute("aria-label") || "").trim().toLowerCase();
    if (labels.includes(text) || labels.includes(aria)) {
      button.click();
      return true;
    }
  }
  return false;
})()
"@

  return [bool](Invoke-CdpEval -Client $Client -Expression $expression)
}

function Try-ClickButtonByAria {
  param(
    $Client,
    [string[]]$Labels
  )

  $labelsJson = ConvertTo-Json -InputObject @($Labels) -Compress
  $expression = @"
(() => {
  const rawLabels = $labelsJson;
  const labels = (Array.isArray(rawLabels) ? rawLabels : [rawLabels]).map((label) => String(label).trim().toLowerCase());
  const buttons = Array.from(document.querySelectorAll("button"));
  for (const button of buttons) {
    const aria = String(button.getAttribute("aria-label") || "").trim().toLowerCase();
    if (labels.includes(aria)) {
      button.click();
      return true;
    }
  }
  return false;
})()
"@

  return [bool](Invoke-CdpEval -Client $Client -Expression $expression)
}

function Find-NewImageCandidate {
  param(
    $Client,
    [string]$Provider,
    [string[]]$BaselineKeys
  )

  $query = if ($Provider -eq "chatgpt") { "main img" } else { "img" }
  $minWidth = if ($Provider -eq "gemini") { 200 } else { 256 }
  $queryJson = $query | ConvertTo-Json -Compress
  $baselineJson = if ($BaselineKeys -and @($BaselineKeys).Count -gt 0) {
    @($BaselineKeys) | ConvertTo-Json -Compress -Depth 10
  } else {
    "[]"
  }

  $expression = @"
(() => {
  const baseline = new Set($baselineJson);
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const candidates = Array.from(document.querySelectorAll($queryJson))
    .filter((img) => {
      const rect = img.getBoundingClientRect();
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      const src = (img.currentSrc || img.src || "").toLowerCase();
      const alt = String(img.alt || "").toLowerCase();
      const key = String(img.currentSrc || img.src || "") + "::" + String(img.alt || "");
      if (!src || src.startsWith("data:")) return false;
      if (w < $minWidth || h < $minWidth) return false;
      if (rect.width < 150 || rect.height < 150) return false;
      if (/avatar|icon|logo|favicon|profile|emoji|sparkle/.test((alt + " " + src))) return false;
      if (baseline.has(key)) return false;
      if ("$Provider" === "meta") {
        const rectRatio = rect.width / rect.height;
        if (rect.width > viewportWidth * 0.72) return false;
        if (rect.height > viewportHeight * 0.95) return false;
        if (rectRatio > 0.85) return false;
      }
      return img.complete && img.naturalWidth > 0;
    })
    .sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      if ("$Provider" === "meta") {
        const ratioA = rectA.width / rectA.height;
        const ratioB = rectB.width / rectB.height;
        const portraitPenaltyA = Math.abs(ratioA - 0.58);
        const portraitPenaltyB = Math.abs(ratioB - 0.58);
        if (portraitPenaltyA !== portraitPenaltyB) {
          return portraitPenaltyA - portraitPenaltyB;
        }
      }
      return (rectB.width * rectB.height) - (rectA.width * rectA.height);
    });

  const img = candidates[0];
  if (!img) return null;

  img.scrollIntoView({ block: "center", inline: "center" });
  const rect = img.getBoundingClientRect();
  return {
    src: img.currentSrc || img.src || "",
    x: Math.max(0, window.scrollX + rect.left),
    y: Math.max(0, window.scrollY + rect.top),
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height)
  };
})()
"@

  return Invoke-CdpEval -Client $Client -Expression $expression
}

function Wait-ForNewImage {
  param(
    $Client,
    [string]$Provider,
    [string[]]$BaselineKeys,
    [int]$TimeoutSeconds = 180
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $stableHits = 0
  $lastCandidate = $null

  while ((Get-Date) -lt $deadline) {
    $candidate = Find-NewImageCandidate -Client $Client -Provider $Provider -BaselineKeys $BaselineKeys
    if ($candidate) {
      $stableHits += 1
      $lastCandidate = $candidate
      if ($stableHits -ge 2) {
        return $candidate
      }
    } else {
      $stableHits = 0
    }

    Start-Sleep -Seconds 3
  }

  throw "Timed out waiting for a generated image on $Provider"
}

function Save-ClipScreenshot {
  param(
    $Client,
    $Clip,
    [string]$OutFile
  )

  $result = Invoke-Cdp -Client $Client -Method "Page.captureScreenshot" -Params @{
    format = "png"
    captureBeyondViewport = $true
    clip = @{
      x = [double]$Clip.x
      y = [double]$Clip.y
      width = [double]$Clip.width
      height = [double]$Clip.height
      scale = 1
    }
  }

  [System.IO.File]::WriteAllBytes($OutFile, [Convert]::FromBase64String($result.data))
}

function Save-ImageFromSource {
  param(
    $Client,
    [string]$Source,
    [string]$OutFile
  )

  if ([string]::IsNullOrWhiteSpace($Source) -or $Source.StartsWith("data:")) {
    return $false
  }

  $sourceJson = $Source | ConvertTo-Json -Compress
  $expression = @"
(async () => {
  const source = $sourceJson;
  const response = await fetch(source, {
    credentials: "include"
  });

  if (!response.ok) {
    throw new Error("Image fetch failed with status " + response.status);
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }

  return btoa(binary);
})()
"@

  try {
    $base64 = Invoke-CdpEval -Client $Client -Expression $expression
    if ([string]::IsNullOrWhiteSpace($base64)) {
      return $false
    }

    [System.IO.File]::WriteAllBytes($OutFile, [Convert]::FromBase64String($base64))
    return $true
  }
  catch {
    Write-Warning "Direct image save failed for ${Source}: $($_.Exception.Message)"
    return $false
  }
}

function Generate-ProviderImage {
  param(
    [string]$Provider,
    [string]$IdeaText,
    [string]$PromptText,
    [string]$BaseDebugUrl,
    [string]$OutputName
  )

  $targets = Get-DebugTargets -BaseUrl $BaseDebugUrl
  $target = switch ($Provider) {
    "chatgpt" { $targets | Where-Object { $_.type -eq "page" -and $_.url -match "chatgpt\.com" } | Select-Object -First 1 }
    "meta" { $targets | Where-Object { $_.type -eq "page" -and $_.url -match "meta\.ai" } | Select-Object -First 1 }
    "gemini" { $targets | Where-Object { $_.type -eq "page" -and $_.url -match "gemini\.google\.com" } | Select-Object -First 1 }
    "copilot" { $targets | Where-Object { $_.type -eq "page" -and $_.url -match "copilot\.microsoft\.com" } | Select-Object -First 1 }
  }

  if (-not $target) {
    throw "No open $Provider tab found in the debug browser."
  }

  $client = New-CdpClient -WebSocketUrl $target.webSocketDebuggerUrl

  try {
    Enable-PageClient -Client $client

    $url = switch ($Provider) {
      "chatgpt" { "https://chatgpt.com/images" }
      "meta" { "https://meta.ai/" }
      "gemini" { "https://gemini.google.com/app" }
      "copilot" { "https://copilot.microsoft.com/" }
    }

    Navigate-Page -Client $client -Url $url

    $baseline = Get-BaselineKeys -Client $client -Provider $Provider

    switch ($Provider) {
      "chatgpt" {
        if (-not (Set-ElementValue -Client $client -Selector "[contenteditable='true'][role='textbox']" -Text $PromptText -ContentEditable)) {
          if (-not (Set-ElementValue -Client $client -Selector "textarea" -Text $PromptText)) {
            throw "Could not focus the ChatGPT prompt input."
          }
        }
        if (-not (Try-Click-Send -Client $client -Selectors @("button[aria-label='Send prompt']", "button[aria-label*='Send']", "button[data-testid*='send']"))) {
          Press-Enter -Client $client
        }
      }
      "meta" {
        $null = Try-ClickButtonByText -Client $client -Labels @("Create image")
        Start-Sleep -Milliseconds 700
        if (-not (Set-ElementValue -Client $client -Selector "textarea[placeholder='Ask Meta AI...']" -Text ("Imagine " + $PromptText))) {
          if (-not (Set-ElementValue -Client $client -Selector "textarea" -Text ("Imagine " + $PromptText))) {
          throw "Could not focus the Meta AI prompt input."
          }
        }
        if (-not (Try-Click-Send -Client $client -Selectors @("button[aria-label='Send']"))) {
          Press-Enter -Client $client
        }
      }
      "gemini" {
        if (-not (Set-ElementValue -Client $client -Selector ".ql-editor[contenteditable='true']" -Text ("Generate an image: " + $PromptText) -ContentEditable)) {
          throw "Could not focus the Gemini prompt input."
        }
        Press-Enter -Client $client
      }
      "copilot" {
        $null = Try-ClickButtonByAria -Client $client -Labels @("New chat")
        Start-Sleep -Seconds 2
        $null = Try-ClickButtonByText -Client $client -Labels @("Create an image", "Create image")
        Start-Sleep -Seconds 1
        if (-not (Set-ElementValue -Client $client -Selector "textarea#userInput" -Text ("Create an image: " + $PromptText))) {
          throw "Could not focus the Copilot prompt input."
        }
        Press-Enter -Client $client
      }
    }

    Start-Sleep -Seconds 2
    $candidate = Wait-ForNewImage -Client $client -Provider $Provider -BaselineKeys $baseline
    if ([string]::IsNullOrWhiteSpace($OutputName)) {
      $fileName = ($IdeaText.ToLowerInvariant() -replace "[^a-z0-9 ]", "").Trim() + " " + $Provider + ".png"
    }
    else {
      $fileName = $OutputName
    }
    $outFile = Join-Path $generatedDir $fileName
    if (-not (Save-ImageFromSource -Client $client -Source $candidate.src -OutFile $outFile)) {
      Save-ClipScreenshot -Client $client -Clip $candidate -OutFile $outFile
    }

    return [pscustomobject]@{
      provider = $Provider
      prompt = $PromptText
      imagePath = "/generated/$fileName"
      generatedAt = [DateTime]::UtcNow.ToString("o")
      idea = $IdeaText
      promptVariantId = $VariantId
    }
  }
  finally {
    Close-CdpClient -Client $client
  }
}

$prompt = Build-Prompt -IdeaText $Idea -VariantIdText $VariantId -Gender $PersonGender
$results = @()

foreach ($provider in $providers) {
  Write-Host "Generating $provider image for '$Idea'..."
  $results += Generate-ProviderImage -Provider $provider -IdeaText $Idea -PromptText $prompt -BaseDebugUrl $DebugUrl -OutputName $OutputFileName
}

$siteData = [ordered]@{
  prompt = $prompt
  imagePath = $results[-1].imagePath
  generatedAt = $results[-1].generatedAt
  status = "ready"
  images = $results
}

Write-JsonFile -Path $latestDataFile -Value $siteData
Write-JsonFile -Path $publicLatestFile -Value $siteData

Write-Host "Generated $($results.Count) comparison images and updated the internal site data."
