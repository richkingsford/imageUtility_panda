const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const GENERATED_DIR = path.join(PUBLIC_DIR, "generated");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "latest.json");
const PUBLIC_DATA_FILE = path.join(PUBLIC_DIR, "latest.json");
const DEBUG_URL = process.env.CHROME_DEBUG_URL || "http://127.0.0.1:9222";

async function main() {
  const existingData = readJson(DATA_FILE);
  if (!existingData?.images?.length) {
    throw new Error("No existing image entries were found in data/latest.json.");
  }

  const targetImages = existingData.images.filter((entry) =>
    /^attention-getter /i.test(String(entry.prompt || ""))
  );

  if (!targetImages.length) {
    throw new Error("No brainstorm prompt entries were found to backfill.");
  }

  fs.mkdirSync(GENERATED_DIR, { recursive: true });

  const browser = await chromium.connectOverCDP(DEBUG_URL);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages().find((candidate) =>
    /chatgpt\.com\/(images|c\/)/i.test(candidate.url())
  ) || await context.newPage();

  page.setDefaultTimeout(10000);

  const linkRecords = await collectRecentChatRecords(page);

  for (const entry of targetImages) {
    const record = linkRecords.find((candidate) =>
      String(candidate.mainText || "").includes(entry.prompt)
    );

    if (!record) {
      throw new Error(`Could not find a recent chat containing prompt: ${entry.prompt}`);
    }

    if (!record.imageSrc) {
      throw new Error(`Recent chat did not expose a downloadable image for: ${entry.prompt}`);
    }

    const filePath = path.join(PUBLIC_DIR, String(entry.imagePath || "").replace(/^\//, ""));
    await downloadPng(context, record.imageSrc, filePath);
    console.log(`Backfilled clean PNG for ${entry.prompt}`);
  }

  const latestEntry = targetImages[targetImages.length - 1];
  const nextData = {
    prompt: latestEntry.prompt,
    imagePath: latestEntry.imagePath,
    generatedAt: latestEntry.generatedAt,
    status: "ready",
    images: targetImages,
  };

  writeJson(DATA_FILE, nextData);
  writeJson(PUBLIC_DATA_FILE, nextData);
  removeOrphanedGeneratedFiles(targetImages);

  console.log(`Backfilled ${targetImages.length} clean images and removed older test entries.`);
}

async function collectRecentChatRecords(page) {
  await page.goto("https://chatgpt.com/images", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(3000);

  const recentLinks = await page.evaluate(() => {
    const unique = new Map();

    for (const link of Array.from(document.querySelectorAll("a[href*='/c/']"))) {
      const href = link.href;
      const text = (link.innerText || link.textContent || "").trim().replace(/\s+/g, " ");

      if (!href || !text || unique.has(href)) {
        continue;
      }

      unique.set(href, { href, text });
    }

    return Array.from(unique.values());
  });

  const records = [];

  for (const recentLink of recentLinks) {
    await page.goto(recentLink.href, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(2500);

    const mainText = await page.locator("main").innerText().catch(() => "");
    const imageSrc = await waitForLargestImageSrc(page);

    records.push({
      href: recentLink.href,
      title: recentLink.text,
      mainText,
      imageSrc,
    });
  }

  return records;
}

async function waitForLargestImageSrc(page) {
  const deadline = Date.now() + 20000;

  while (Date.now() < deadline) {
    const imageSrc = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("main img"))
        .filter((img) => {
          const width = Number(img.naturalWidth || img.width || 0);
          const height = Number(img.naturalHeight || img.height || 0);
          const alt = String(img.alt || "").toLowerCase();
          const src = String(img.currentSrc || img.src || "");

          if (!src || src.startsWith("data:")) {
            return false;
          }

          if (width < 256 || height < 256) {
            return false;
          }

          return !/avatar|icon|logo|favicon|profile/.test(`${alt} ${src}`.toLowerCase());
        })
        .sort((left, right) => {
          const leftArea = (left.naturalWidth || left.width || 0) * (left.naturalHeight || left.height || 0);
          const rightArea = (right.naturalWidth || right.width || 0) * (right.naturalHeight || right.height || 0);
          return rightArea - leftArea;
        });

      return candidates[0] ? (candidates[0].currentSrc || candidates[0].src || "") : "";
    });

    if (imageSrc) {
      return imageSrc;
    }

    await page.waitForTimeout(1000);
  }

  return null;
}

async function downloadPng(context, imageSrc, filePath) {
  const response = await context.request.get(imageSrc);
  const contentType = String(response.headers()["content-type"] || "").toLowerCase();

  if (!response.ok()) {
    throw new Error(`Image download failed with status ${response.status()} for ${imageSrc}`);
  }

  if (!contentType.startsWith("image/png")) {
    throw new Error(`Expected image/png but received "${contentType || "unknown"}" for ${imageSrc}`);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, await response.body());
}

function removeOrphanedGeneratedFiles(images) {
  const referenced = new Set(
    images
      .map((entry) => path.basename(String(entry.imagePath || "")))
      .filter(Boolean)
  );

  for (const file of fs.readdirSync(GENERATED_DIR)) {
    if (!referenced.has(file)) {
      fs.rmSync(path.join(GENERATED_DIR, file), { force: true });
    }
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
