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
  const meta = ctx.pages().find(p => /meta\.ai/i.test(p.url()));
  if (!meta) throw new Error("No Meta AI tab found");

  const prompt = buildImagePromptFromIdea(IDEA);
  const metaPrompt = "Imagine " + prompt;

  await meta.bringToFront();
  await meta.waitForTimeout(1000);

  // Type into contenteditable
  const tb = meta.locator('[contenteditable="true"]').first();
  await tb.click();
  await tb.fill("");
  await meta.keyboard.type(metaPrompt, { delay: 3 });
  await meta.waitForTimeout(500);

  // Find and click send button
  const sendBtn = meta.locator('[aria-label="Send"]').first();
  if (await sendBtn.count()) {
    await sendBtn.click();
  } else {
    await meta.keyboard.press("Enter");
  }
  console.log("Prompt sent to Meta AI. Waiting for image...");

  // Wait for large image
  let imgUrl = null;
  for (let i = 0; i < 90; i++) {
    await meta.waitForTimeout(2000);
    const imgs = await meta.evaluate(() =>
      Array.from(document.querySelectorAll("img"))
        .filter(img => {
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          const src = img.src || "";
          return w >= 512 && h >= 512 && !src.startsWith("data:") && !/avatar|icon|logo|profile/i.test(src);
        })
        .map(img => img.src)
    );
    if (imgs.length > 0) {
      imgUrl = imgs[imgs.length - 1];
      console.log("Found image!");
      break;
    }
  }
  if (!imgUrl) throw new Error("No image found on Meta AI");

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
    provider: "meta",
  });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + "\n");
  console.log("Saved " + OUT_NAME);
}

main().catch(e => { console.error(e.message); process.exit(1); });
