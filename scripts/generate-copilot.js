const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { buildImagePromptFromIdea } = require("./prompt-template");

const WS = process.env.CHROME_DEBUG_URL;
const IDEA = process.env.IMAGE_IDEA;
const OUT_NAME = process.env.IMAGE_OUTPUT_NAME;
const ROOT = path.resolve(__dirname, "..");
const GEN_DIR = path.join(ROOT, "public", "generated");
const DATA_FILE = path.join(ROOT, "data", "latest.json");

async function main() {
  const browser = await chromium.connectOverCDP(WS);
  const ctx = browser.contexts()[0];
  const cp = ctx.pages().find(p => /copilot\.microsoft/i.test(p.url()));
  if (!cp) throw new Error("No Copilot tab found");

  const prompt = buildImagePromptFromIdea(IDEA);
  const copilotPrompt = "Create an image: " + prompt;

  await cp.bringToFront();
  await cp.waitForTimeout(1000);

  // Baseline existing 1024x1024 images
  const baseline = await cp.evaluate(() =>
    Array.from(document.querySelectorAll("img"))
      .filter(img => (img.naturalWidth || 0) === 1024 && (img.naturalHeight || 0) === 1024)
      .map(img => img.src)
  );

  const ta = cp.locator("textarea#userInput").first();
  await ta.click();
  await ta.fill(copilotPrompt);
  await cp.keyboard.press("Enter");
  console.log("Prompt sent to Copilot. Waiting for image...");

  let imgUrl = null;
  for (let i = 0; i < 90; i++) {
    await cp.waitForTimeout(2000);
    const imgs = await cp.evaluate((bl) => {
      const blSet = new Set(bl);
      return Array.from(document.querySelectorAll("img"))
        .filter(img => {
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          return w === 1024 && h === 1024 && !blSet.has(img.src);
        })
        .map(img => img.src);
    }, baseline);
    if (imgs.length > 0) {
      imgUrl = imgs[imgs.length - 1];
      console.log("Found 1024x1024 image!");
      break;
    }
  }
  if (!imgUrl) throw new Error("No image found on Copilot");

  const resp = await ctx.request.get(imgUrl);
  const buf = await resp.body();
  const outFile = path.join(GEN_DIR, OUT_NAME);
  fs.writeFileSync(outFile, buf);

  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const now = new Date().toISOString();
  data.prompt = prompt;
  data.imagePath = "/generated/" + OUT_NAME;
  data.generatedAt = now;
  data.images.push({
    id: "image-" + now.replace(/[^0-9a-z]/gi, "").toLowerCase(),
    prompt,
    imagePath: "/generated/" + OUT_NAME,
    generatedAt: now,
    provider: "copilot",
  });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + "\n");
  console.log("Saved " + OUT_NAME);
}

main().catch(e => { console.error(e.message); process.exit(1); });
