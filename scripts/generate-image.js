const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const GENERATED_DIR = path.join(PUBLIC_DIR, "generated");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "latest.json");
const PUBLIC_DATA_FILE = path.join(PUBLIC_DIR, "latest.json");
const IMAGE_FILE = path.join(GENERATED_DIR, "latest-image.png");
const SCREENSHOT_FILE = path.join(ROOT, "artifacts", "final-v1.png");

const DEFAULT_PROMPTS = [
  "A cheerful panda astronaut floating through a paper-cut galaxy, ultra vivid, whimsical illustration",
  "A tiny robot tending a rooftop garden at sunrise, cinematic lighting, detailed digital art",
  "A friendly sea otter barista serving coffee inside a glass submarine cafe, vibrant concept art",
  "A retro-futuristic city park filled with giant flowers and people on bicycles, colorful poster style",
];

async function main() {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(ROOT, "artifacts"), { recursive: true });

  const prompt = process.env.IMAGE_PROMPT || pickRandom(DEFAULT_PROMPTS);
  const existingData = readExistingData();
  const images = preserveExistingImages(existingData);
  const session = await createBrowserSession();
  const { context } = session;
  let page = await pickStartingPage(context);

  try {
    page.setDefaultTimeout(10000);
    console.log("Opening ChatGPT Images...");
    await page.goto("https://chatgpt.com/images", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(3000);

    page = await ensureImagePage(page);
    await waitForRateLimitToClear(page);

    const input = await findPromptInput(page);
    const baselineImageKeys = await listGeneratedImageKeys(page);
    console.log(`Found prompt input. Baseline generated image count: ${baselineImageKeys.length}`);
    await input.click();
    await input.fill(prompt);
    await submitPrompt(page, input);

    console.log("Prompt submitted. Waiting for final image...");
    const image = await waitForFinalImage(page, baselineImageKeys);
    const generatedAt = new Date().toISOString();
    const nextImagePath = buildPublicImagePath(generatedAt);
    const nextImageFile = path.join(PUBLIC_DIR, nextImagePath.replace(/^\//, ""));

    await image.screenshot({ path: nextImageFile });
    fs.copyFileSync(nextImageFile, IMAGE_FILE);

    images.push({
      id: buildImageId(generatedAt),
      prompt,
      imagePath: nextImagePath,
      generatedAt,
    });

    const siteData = {
      prompt,
      imagePath: nextImagePath,
      generatedAt,
      status: "ready",
      images,
    };

    fs.writeFileSync(DATA_FILE, `${JSON.stringify(siteData, null, 2)}\n`);
    fs.writeFileSync(PUBLIC_DATA_FILE, `${JSON.stringify(siteData, null, 2)}\n`);

    try {
      const previewPage = await context.newPage();
      await previewPage.goto("http://127.0.0.1:4173", { waitUntil: "domcontentloaded" });
      await previewPage.waitForSelector(".image-preview");
      await previewPage.screenshot({ path: SCREENSHOT_FILE, fullPage: true });
      await previewPage.close();
    } catch (error) {
      console.warn(`Skipped preview screenshot: ${error.message}`);
    }

    console.log(`Prompt used: ${prompt}`);
    console.log(`Saved image to ${IMAGE_FILE}`);
    console.log(`Saved page preview to ${SCREENSHOT_FILE}`);
  } finally {
    await session.dispose();
  }
}

async function createBrowserSession() {
  const debugUrl = process.env.CHROME_DEBUG_URL;
  if (debugUrl) {
    const browser = await chromium.connectOverCDP(debugUrl);
    const context = browser.contexts()[0] || await browser.newContext();

    return {
      context,
      async dispose() {
        await Promise.resolve();
      },
    };
  }

  const chromePath = resolveChromePath();
  const userDataDir = resolveChromeUserDataDir();
  const profileDirectory = process.env.CHROME_PROFILE_DIR || "Default";

  if (!userDataDir) {
    throw new Error(
      "Could not find a Chrome user data directory. Set CHROME_USER_DATA_DIR to your logged-in Chrome profile root and rerun."
    );
  }

  try {
    const context = await launchChromeContext({
      chromePath,
      profileDirectory,
      userDataDir,
    });

    return {
      context,
      async dispose() {
        await context.close();
      },
    };
  } catch (error) {
    const tempUserDataDir = createMirroredUserDataDir(userDataDir, profileDirectory);
    const context = await launchChromeContext({
      chromePath,
      profileDirectory,
      userDataDir: tempUserDataDir,
    });

    return {
      context,
      async dispose() {
        await context.close();
        fs.rmSync(tempUserDataDir, { recursive: true, force: true });
      },
    };
  }
}

async function ensureImagePage(page) {
  const redirectedToLogin = /auth\.openai\.com|accounts\.google\.com/i.test(page.url());
  if (redirectedToLogin) {
    throw new Error(
      "Playwright was redirected to sign-in. Close Chrome, confirm the target profile is logged into ChatGPT, then rerun."
    );
  }

  return page;
}

async function pickStartingPage(context) {
  const pages = context.pages();
  const existingImagePage = pages.find((candidate) =>
    /chatgpt\.com\/images/i.test(candidate.url())
  );

  if (existingImagePage) {
    return existingImagePage;
  }

  if (pages.length) {
    return pages[0];
  }

  return context.newPage();
}

async function findPromptInput(page) {
  const selectors = [
    "[contenteditable='true'][role='textbox']",
    "textarea[placeholder*='Describe a new image']",
    "textarea[placeholder*='Describe']",
    "textarea",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      await locator.waitFor({ state: "visible", timeout: 10000 });
      return locator;
    }
  }

  throw new Error("Could not find the ChatGPT image prompt input.");
}

async function submitPrompt(page, input) {
  const sendButtonSelectors = [
    "button[aria-label='Send prompt']",
    "button[aria-label*='Send']",
    "button[data-testid*='send']",
  ];

  for (const selector of sendButtonSelectors) {
    const button = page.locator(selector).first();
    if (await button.count()) {
      await button.waitFor({ state: "visible", timeout: 10000 });

      if (await button.isDisabled()) {
        await page.waitForTimeout(500);
      }

      await button.click();
      await page.waitForTimeout(1000);
      return;
    }
  }

  await input.press("Enter");
  await page.waitForTimeout(1000);
}

async function waitForRateLimitToClear(page) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const message = await readRateLimitMessage(page);
    if (!message) {
      return;
    }

    const waitMs = extractSuggestedWaitMs(message);
    if (!waitMs) {
      console.log(`Rate limit detected. Waiting 60 seconds before retrying...`);
      await page.waitForTimeout(60000);
      continue;
    }

    const roundedSeconds = Math.ceil(waitMs / 1000);
    console.log(`Rate limit detected. Waiting ${roundedSeconds} seconds before retrying...`);
    await page.waitForTimeout(waitMs + 2000);
  }
}

async function readRateLimitMessage(page) {
  const bodyText = await page.locator("body").innerText();
  const lines = bodyText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const matchedLine = lines.find((line) =>
    /generating images too quickly|try again in|please wait/i.test(line)
  );

  return matchedLine || null;
}

function extractSuggestedWaitMs(message) {
  if (!message) {
    return null;
  }

  const minuteMatch = message.match(/(\d+)\s*minute/i);
  const secondMatch = message.match(/(\d+)\s*second/i);

  if (minuteMatch) {
    return Number(minuteMatch[1]) * 60000;
  }

  if (secondMatch) {
    return Number(secondMatch[1]) * 1000;
  }

  return null;
}

async function listGeneratedImageKeys(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll("main img"))
      .filter((img) => {
        const width = Number(img.naturalWidth || img.width || 0);
        const height = Number(img.naturalHeight || img.height || 0);
        const alt = String(img.alt || "").toLowerCase();
        const src = String(img.currentSrc || img.src || "").toLowerCase();

        if (!src || src.startsWith("data:")) {
          return false;
        }

        if (width < 256 || height < 256) {
          return false;
        }

        return !/avatar|icon|logo|favicon|profile/.test(`${alt} ${src}`);
      })
      .map((img) => `${img.currentSrc || img.src || ""}::${img.alt || ""}`);
  });
}

async function waitForFinalImage(page, baselineImageKeys = []) {
  const deadline = Date.now() + 180000;
  let latestIndex = -1;
  let stablePolls = 0;

  while (Date.now() < deadline) {
    latestIndex = await findBestNewImageIndex(page, baselineImageKeys);

    if (latestIndex >= 0) {
      stablePolls += 1;
      if (stablePolls >= 2) {
        break;
      }
    } else {
      stablePolls = 0;
    }

    await page.waitForTimeout(2000);
  }

  if (latestIndex < 0) {
    throw new Error("No image elements were found after generation.");
  }

  await page.waitForTimeout(1000);
  latestIndex = await findBestNewImageIndex(page, baselineImageKeys);

  if (latestIndex < 0) {
    stablePolls = 0;

    while (Date.now() < deadline) {
      latestIndex = await findBestNewImageIndex(page, baselineImageKeys);

      if (latestIndex >= 0) {
        stablePolls += 1;
        if (stablePolls >= 2) {
          break;
        }
      } else {
        stablePolls = 0;
      }

      await page.waitForTimeout(2000);
    }
  }

  if (latestIndex < 0) {
    throw new Error("The generated image disappeared before capture.");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const locator = page.locator("main img").nth(latestIndex);

    try {
      await locator.scrollIntoViewIfNeeded();
      await locator.waitFor({ state: "visible", timeout: 10000 });
      return locator;
    } catch (error) {
      if (attempt === 1) {
        throw error;
      }

      await page.waitForTimeout(1000);
      latestIndex = await findBestNewImageIndex(page, baselineImageKeys);
    }
  }

  throw new Error("Unable to stabilize the generated image for capture.");
}

async function findBestNewImageIndex(page, baselineImageKeys = []) {
  return page.evaluate((baseline) => {
    const baselineSet = new Set(baseline);
    const images = Array.from(document.querySelectorAll("main img"));
    const generatedCandidates = images
      .map((img, index) => ({ img, index }))
      .filter(({ img }) => {
        const width = Number(img.naturalWidth || img.width || 0);
        const height = Number(img.naturalHeight || img.height || 0);
        const alt = String(img.alt || "").toLowerCase();
        const src = String(img.currentSrc || img.src || "").toLowerCase();

        if (!src || src.startsWith("data:")) {
          return false;
        }

        if (width < 256 || height < 256) {
          return false;
        }

        if (/avatar|icon|logo|favicon|profile/.test(`${alt} ${src}`)) {
          return false;
        }

        const key = `${img.currentSrc || img.src || ""}::${img.alt || ""}`;
        if (baselineSet.has(key)) {
          return false;
        }

        return Boolean(img.complete && img.naturalWidth > 0);
      })
      .sort((left, right) => {
        const leftArea = (left.img.naturalWidth || left.img.width || 0) * (left.img.naturalHeight || left.img.height || 0);
        const rightArea = (right.img.naturalWidth || right.img.width || 0) * (right.img.naturalHeight || right.img.height || 0);
        return rightArea - leftArea;
      });

    return generatedCandidates[0]?.index ?? -1;
  }, baselineImageKeys);
}

function pickRandom(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function readExistingData() {
  if (!fs.existsSync(DATA_FILE)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (error) {
    console.warn(`Failed to read existing data file: ${error.message}`);
    return null;
  }
}

function preserveExistingImages(existingData) {
  if (Array.isArray(existingData?.images) && existingData.images.length > 0) {
    return existingData.images
      .filter((entry) => entry && entry.imagePath)
      .map((entry) => ({
        id: entry.id || buildImageId(entry.generatedAt || new Date().toISOString()),
        prompt: entry.prompt || "",
        imagePath: entry.imagePath,
        generatedAt: entry.generatedAt || null,
      }));
  }

  if (!existingData?.imagePath) {
    return [];
  }

  const currentFile = path.join(PUBLIC_DIR, existingData.imagePath.replace(/^\//, ""));
  if (!fs.existsSync(currentFile)) {
    return [];
  }

  const generatedAt = existingData.generatedAt || new Date().toISOString();
  const archivedPath = buildPublicImagePath(generatedAt);
  const archivedFile = path.join(PUBLIC_DIR, archivedPath.replace(/^\//, ""));

  if (path.resolve(currentFile) !== path.resolve(archivedFile)) {
    fs.copyFileSync(currentFile, archivedFile);
  }

  return [
    {
      id: buildImageId(generatedAt),
      prompt: existingData.prompt || "",
      imagePath: archivedPath,
      generatedAt,
    },
  ];
}

function buildImageId(isoDate) {
  return `image-${sanitizeTimestamp(isoDate)}`;
}

function buildPublicImagePath(isoDate) {
  return `/generated/${buildImageId(isoDate)}.png`;
}

function sanitizeTimestamp(isoDate) {
  return String(isoDate || Date.now()).replace(/[^0-9a-z]/gi, "").toLowerCase();
}

async function launchChromeContext({ chromePath, profileDirectory, userDataDir }) {
  return chromium.launchPersistentContext(userDataDir, {
    channel: chromePath ? undefined : "chrome",
    executablePath: chromePath || undefined,
    headless: false,
    viewport: { width: 1440, height: 1100 },
    args: [`--profile-directory=${profileDirectory}`],
  });
}

function createMirroredUserDataDir(sourceRoot, profileDirectory) {
  const destinationRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "image-utility-panda-chrome-")
  );
  const sourceProfile = path.join(sourceRoot, profileDirectory);
  const destinationProfile = path.join(destinationRoot, profileDirectory);

  copyIfPresent(path.join(sourceRoot, "Local State"), path.join(destinationRoot, "Local State"));
  copyDirectory(sourceProfile, destinationProfile);

  return destinationRoot;
}

function copyDirectory(sourceDirectory, destinationDirectory) {
  if (!fs.existsSync(sourceDirectory)) {
    return;
  }

  fs.cpSync(sourceDirectory, destinationDirectory, {
    recursive: true,
    force: true,
    filter: (sourcePath) => !shouldSkipChromeCopy(sourcePath),
  });
}

function copyIfPresent(sourcePath, destinationPath) {
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

function shouldSkipChromeCopy(sourcePath) {
  const skippedNames = new Set([
    "blob_storage",
    "Cache",
    "CacheStorage",
    "Code Cache",
    "Crashpad",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GPUCache",
    "GrShaderCache",
    "lockfile",
    "ShaderCache",
    "SingletonCookie",
    "SingletonLock",
    "SingletonSocket",
  ]);

  return skippedNames.has(path.basename(sourcePath));
}

function resolveChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveChromeUserDataDir() {
  const candidates = [
    process.env.CHROME_USER_DATA_DIR,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data")
      : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
