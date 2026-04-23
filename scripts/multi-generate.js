const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { buildImagePromptFromIdea } = require("./prompt-template");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const GENERATED_DIR = path.join(PUBLIC_DIR, "generated");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "latest.json");
const PUBLIC_DATA_FILE = path.join(PUBLIC_DIR, "latest.json");
const BROWSER_WS = process.env.CHROME_DEBUG_URL || "ws://127.0.0.1:9222/devtools/browser/5efd98ee-57e1-4605-b67b-7a749b856bdf";

const PROVIDERS = ["chatgpt", "meta", "gemini", "copilot"];

function extractIdeaFromPrompt(prompt) {
  const text = String(prompt || "");
  let match = text.match(/centered on "([^"]+)"/i);
  if (match) return match[1];
  match = text.match(/single (.+?) object/i);
  if (match) return match[1];
  return null;
}

async function main() {
  const mode = process.argv[2] || "test";
  const batchSize = mode === "batch" ? parseInt(process.argv[3] || "20", 10) : 1;
  const providerArg = process.argv[4] || null;

  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const missing = getMissing();
  if (missing.length === 0) {
    console.log("All idea[0] images are generated!");
    return;
  }

  const browser = await chromium.connectOverCDP(BROWSER_WS);
  const context = browser.contexts()[0];

  try {
    if (mode === "test") {
      // Test one image from each provider (or a specific one)
      const providers = providerArg ? [providerArg] : PROVIDERS;
      for (const provider of providers) {
        const item = missing.shift();
        if (!item) break;
        console.log(`\n=== TEST: ${provider} -> "${item.concept}" -> "${item.idea0}" ===`);
        await generateOne(context, provider, item);
      }
    } else {
      // Batch mode: rotate providers
      let providerIndex = 0;
      const rateLimitUntil = { chatgpt: 0, meta: 0, gemini: 0 };
      let generated = 0;

      for (let i = 0; i < Math.min(batchSize, missing.length); i++) {
        const item = missing[i];
        let success = false;
        let attempts = 0;

        while (!success && attempts < PROVIDERS.length * 2) {
          const provider = PROVIDERS[providerIndex % PROVIDERS.length];
          const now = Date.now();

          if (rateLimitUntil[provider] > now) {
            console.log(`  ${provider} rate-limited until ${new Date(rateLimitUntil[provider]).toLocaleTimeString()}, skipping...`);
            providerIndex++;
            attempts++;
            continue;
          }

          console.log(`\n[${i + 1}/${batchSize}] ${provider}: "${item.concept}" -> "${item.idea0}"`);
          try {
            await generateOne(context, provider, item);
            success = true;
            generated++;
            providerIndex++;
          } catch (err) {
            const msg = err.message || "";
            console.log(`  Error: ${msg}`);
            const waitMin = extractWaitMinutes(msg);
            if (waitMin > 0) {
              const waitMs = (waitMin + 1) * 60000;
              rateLimitUntil[provider] = Date.now() + waitMs;
              console.log(`  ${provider} rate-limited. Will retry after ${waitMin + 1} minutes.`);
            } else {
              rateLimitUntil[provider] = Date.now() + 120000;
              console.log(`  ${provider} failed. Cooling down 2 min.`);
            }
            providerIndex++;
            attempts++;
          }
        }

        if (!success) {
          // All providers blocked — wait for the earliest one to clear
          const earliest = Math.min(...Object.values(rateLimitUntil));
          const waitMs = Math.max(earliest - Date.now(), 60000);
          console.log(`\n  All providers rate-limited. Waiting ${Math.ceil(waitMs / 1000)}s...`);
          await sleep(waitMs);
          i--; // retry this item
        }
      }

      console.log(`\n=== BATCH COMPLETE: ${generated}/${batchSize} ===`);
    }

    // Sync website
    if (fs.existsSync(DATA_FILE)) {
      fs.copyFileSync(DATA_FILE, PUBLIC_DATA_FILE);
      console.log("Website updated.");
    }
  } finally {
    await browser.close();
  }
}

async function generateOne(context, provider, item) {
  const outputName = item.idea0.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const outputFile = path.join(GENERATED_DIR, `${outputName}.png`);
  const prompt = buildImagePromptFromIdea(item.idea0, { personGender: "random" });

  let page;
  if (provider === "chatgpt") {
    page = context.pages().find(p => p.url().includes("chatgpt.com"));
  } else if (provider === "meta") {
    page = context.pages().find(p => p.url().includes("meta.ai"));
  } else if (provider === "gemini") {
    page = context.pages().find(p => p.url().includes("gemini.google.com") && !p.url().includes("RotateCookies"));
  } else if (provider === "copilot") {
    page = context.pages().find(p => p.url().includes("copilot.microsoft.com"));
  }

  if (!page) throw new Error(`No ${provider} tab found`);
  page.setDefaultTimeout(15000);

  if (provider === "chatgpt") {
    await generateChatGPT(page, context, prompt, outputFile);
  } else if (provider === "meta") {
    await generateMeta(page, context, prompt, outputFile);
  } else if (provider === "gemini") {
    await generateGemini(page, context, prompt, outputFile);
  } else if (provider === "copilot") {
    await generateCopilot(page, context, prompt, outputFile);
  }

  // Update latest.json
  const data = readData();
  const images = data.images || [];
  const generatedAt = new Date().toISOString();
  images.push({
    id: `image-${generatedAt.replace(/[^0-9a-z]/gi, "").toLowerCase()}`,
    prompt,
    imagePath: `/generated/${outputName}.png`,
    generatedAt,
    provider,
  });
  data.prompt = prompt;
  data.imagePath = `/generated/${outputName}.png`;
  data.generatedAt = generatedAt;
  data.status = "ready";
  data.images = images;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + "\n");

  console.log(`  Saved: ${outputFile}`);
}

// ── ChatGPT ──
async function generateChatGPT(page, context, prompt, outputFile) {
  await page.goto("https://chatgpt.com/images", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);

  // Check rate limit text
  const bodyText = await page.locator("body").innerText();
  const rlMatch = bodyText.match(/try again in (\d+)\s*(minute|second)/i);
  if (rlMatch) {
    const num = parseInt(rlMatch[1], 10);
    const unit = rlMatch[2].toLowerCase();
    const mins = unit.startsWith("minute") ? num : Math.ceil(num / 60);
    throw new Error(`RATE_LIMIT:${mins}`);
  }

  const baselineKeys = await listChatGPTImages(page);
  await setChatGPTPrompt(page, prompt);
  await submitChatGPT(page);
  await page.waitForTimeout(2000);

  // Check for rate limit after submit
  const bodyText2 = await page.locator("body").innerText();
  const rlMatch2 = bodyText2.match(/try again in (\d+)\s*(minute|second)/i);
  if (rlMatch2) {
    const num = parseInt(rlMatch2[1], 10);
    const unit = rlMatch2[2].toLowerCase();
    const mins = unit.startsWith("minute") ? num : Math.ceil(num / 60);
    throw new Error(`RATE_LIMIT:${mins}`);
  }

  const imgLocator = await waitForNewChatGPTImage(page, baselineKeys);
  await saveImage(context, imgLocator, outputFile);
}

async function listChatGPTImages(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll("main img"))
      .filter(img => {
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        const src = (img.currentSrc || img.src || "").toLowerCase();
        if (!src || src.startsWith("data:") || w < 256 || h < 256) return false;
        return !/avatar|icon|logo|favicon|profile/.test(`${img.alt} ${src}`);
      })
      .map(img => `${img.currentSrc || img.src}::${img.alt || ""}`);
  });
}

async function setChatGPTPrompt(page, prompt) {
  await page.evaluate((value) => {
    const el = document.querySelector("[contenteditable='true'][role='textbox']") || document.querySelector("textarea");
    if (!el) throw new Error("No input");
    el.focus();
    if (el.matches("[contenteditable='true']")) {
      el.innerHTML = "";
      const p = document.createElement("p");
      p.textContent = value;
      el.appendChild(p);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    } else {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, prompt);
}

async function submitChatGPT(page) {
  for (const sel of ["button[aria-label='Send prompt']", "button[aria-label*='Send']", "button[data-testid*='send']"]) {
    const btn = page.locator(sel).first();
    if (await btn.count()) {
      await btn.waitFor({ state: "visible", timeout: 5000 });
      await page.waitForTimeout(300);
      await btn.click();
      await page.waitForTimeout(1000);
      return;
    }
  }
  await page.keyboard.press("Enter");
}

async function waitForNewChatGPTImage(page, baselineKeys) {
  const deadline = Date.now() + 180000;
  let idx = -1, stable = 0;
  while (Date.now() < deadline) {
    idx = await page.evaluate((baseline) => {
      const baseSet = new Set(baseline);
      return Array.from(document.querySelectorAll("main img"))
        .map((img, i) => ({ img, i }))
        .filter(({ img }) => {
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          const src = (img.currentSrc || img.src || "").toLowerCase();
          if (!src || src.startsWith("data:") || w < 256 || h < 256) return false;
          if (/avatar|icon|logo|favicon|profile/.test(`${img.alt} ${src}`)) return false;
          if (baseSet.has(`${img.currentSrc || img.src}::${img.alt || ""}`)) return false;
          return img.complete && img.naturalWidth > 0;
        })
        .sort((a, b) => {
          const aA = (a.img.naturalWidth || 0) * (a.img.naturalHeight || 0);
          const bA = (b.img.naturalWidth || 0) * (b.img.naturalHeight || 0);
          return bA - aA;
        })[0]?.i ?? -1;
    }, baselineKeys);
    if (idx >= 0) { stable++; if (stable >= 2) break; } else { stable = 0; }
    await page.waitForTimeout(2000);
  }
  if (idx < 0) throw new Error("No ChatGPT image found after generation");
  return page.locator("main img").nth(idx);
}

// ── Meta AI ──
async function generateMeta(page, context, prompt, outputFile) {
  await page.goto("https://www.meta.ai/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);

  const input = page.locator("[contenteditable='true'][role='textbox']").first();
  await input.waitFor({ state: "visible", timeout: 10000 });

  // Clear and type
  await input.click();
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(200);

  // Type the prompt prefixed with "imagine " to trigger image generation
  const metaPrompt = `Imagine ${prompt}`;
  await input.pressSequentially(metaPrompt, { delay: 10 });
  await page.waitForTimeout(500);

  // Submit
  const sendBtn = page.locator("button[aria-label='Send']").first();
  if (await sendBtn.count()) {
    await sendBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }

  // Wait for generated image
  const deadline = Date.now() + 180000;
  let imgEl = null;
  while (Date.now() < deadline) {
    // Check for rate limit
    const text = await page.locator("body").innerText();
    const rl = text.match(/try again in (\d+)\s*(minute|second)/i) || text.match(/wait (\d+)\s*(minute|second)/i);
    if (rl) {
      const num = parseInt(rl[1], 10);
      const unit = rl[2].toLowerCase();
      const mins = unit.startsWith("minute") ? num : Math.ceil(num / 60);
      throw new Error(`RATE_LIMIT:${mins}`);
    }

    imgEl = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll("img"));
      const candidate = imgs.find(img => {
        const src = (img.currentSrc || img.src || "").toLowerCase();
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        if (w < 256 || h < 256) return false;
        if (!src || src.startsWith("data:")) return false;
        // Meta AI generated images typically come from scontent or imagine
        if (/avatar|icon|logo|favicon|profile|emoji/.test(`${img.alt} ${src}`)) return false;
        return img.complete && img.naturalWidth > 0;
      });
      if (!candidate) return null;
      return { src: candidate.currentSrc || candidate.src, idx: imgs.indexOf(candidate) };
    });

    if (imgEl) break;
    await page.waitForTimeout(3000);
  }

  if (!imgEl) throw new Error("No Meta AI image found after generation");

  const locator = page.locator("img").nth(imgEl.idx);
  await saveImage(context, locator, outputFile);
}

// ── Gemini ──
async function generateGemini(page, context, prompt, outputFile) {
  await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);

  const input = page.locator(".ql-editor[contenteditable='true']").first();
  await input.waitFor({ state: "visible", timeout: 10000 });

  await input.click();
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(200);

  const gemPrompt = `Generate an image: ${prompt}`;
  await input.pressSequentially(gemPrompt, { delay: 10 });
  await page.waitForTimeout(500);

  // Submit with Enter
  await page.keyboard.press("Enter");

  // Wait for generated image
  const deadline = Date.now() + 180000;
  let imgInfo = null;
  while (Date.now() < deadline) {
    // Check for rate limit
    const text = await page.locator("body").innerText();
    const rl = text.match(/try again in (\d+)\s*(minute|second)/i) || text.match(/wait (\d+)\s*(minute|second)/i) || text.match(/quota|limit.*?(\d+)\s*(minute|second)/i);
    if (rl) {
      const num = parseInt(rl[1], 10);
      const unit = rl[2].toLowerCase();
      const mins = unit.startsWith("minute") ? num : Math.ceil(num / 60);
      throw new Error(`RATE_LIMIT:${mins}`);
    }

    imgInfo = await page.evaluate(() => {
      // Gemini puts generated images in message-content areas
      const imgs = Array.from(document.querySelectorAll("img"));
      const candidate = imgs.find(img => {
        const src = (img.currentSrc || img.src || "").toLowerCase();
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        if (w < 200 || h < 200) return false;
        if (!src || src.startsWith("data:")) return false;
        if (/avatar|icon|logo|favicon|profile|sparkle|gemini_sparkle/.test(`${img.alt} ${src} ${img.className}`)) return false;
        return img.complete && img.naturalWidth > 0;
      });
      if (!candidate) return null;
      return { src: candidate.currentSrc || candidate.src, idx: imgs.indexOf(candidate) };
    });

    if (imgInfo) break;
    await page.waitForTimeout(3000);
  }

  if (!imgInfo) throw new Error("No Gemini image found after generation");

  const locator = page.locator("img").nth(imgInfo.idx);
  await saveImage(context, locator, outputFile);
}

// ── Copilot ──
async function generateCopilot(page, context, prompt, outputFile) {
  await page.goto("https://copilot.microsoft.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);

  const input = page.locator("textarea#userInput");
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.click();
  await input.fill("");
  await page.waitForTimeout(200);

  const copilotPrompt = `Create an image: ${prompt}`;
  await input.fill(copilotPrompt);
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");

  const deadline = Date.now() + 180000;
  let imgInfo = null;
  while (Date.now() < deadline) {
    const text = await page.locator("body").innerText();
    const rl = text.match(/try again in (\d+)\s*(minute|second)/i) || text.match(/wait (\d+)\s*(minute|second)/i);
    if (rl) {
      const num = parseInt(rl[1], 10);
      const unit = rl[2].toLowerCase();
      const mins = unit.startsWith("minute") ? num : Math.ceil(num / 60);
      throw new Error(`RATE_LIMIT:${mins}`);
    }

    imgInfo = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll("img"));
      const candidate = imgs.filter(img => {
        const src = (img.currentSrc || img.src || "").toLowerCase();
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        if (w < 256 || h < 256) return false;
        if (!src || src.startsWith("data:")) return false;
        if (/avatar|icon|logo|favicon|profile/.test((img.alt || "").toLowerCase())) return false;
        return img.complete && img.naturalWidth > 0;
      }).sort((a, b) => {
        const aA = (a.naturalWidth || 0) * (a.naturalHeight || 0);
        const bA = (b.naturalWidth || 0) * (b.naturalHeight || 0);
        return bA - aA;
      });
      if (!candidate[0]) return null;
      return { src: candidate[0].currentSrc || candidate[0].src, idx: imgs.indexOf(candidate[0]) };
    });

    if (imgInfo) break;
    await page.waitForTimeout(3000);
  }

  if (!imgInfo) throw new Error("No Copilot image found after generation");

  const locator = page.locator("img").nth(imgInfo.idx);
  await saveImage(context, locator, outputFile);
}

// ── Shared helpers ──
async function saveImage(context, locator, outputFile) {
  await locator.scrollIntoViewIfNeeded();
  const src = await locator.evaluate(el => el.currentSrc || el.src || "");
  if (src) {
    try {
      const resp = await context.request.get(src);
      if (resp.ok()) {
        const buf = await resp.body();
        fs.writeFileSync(outputFile, buf);
        return;
      }
    } catch (e) { /* fall through to screenshot */ }
  }
  await locator.screenshot({ path: outputFile });
}

function readData() {
  if (!fs.existsSync(DATA_FILE)) return { images: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return { images: [] }; }
}

function getMissing() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith("concept-brainstorms"));
  const allConcepts = [];
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
    for (const item of data.items) {
      allConcepts.push({ concept: item.concept, idea0: item.brainstorms[0].idea });
    }
  }
  const latest = readData();
  const allPrompts = [latest.prompt || "", ...(latest.images || []).map(i => i.prompt)];
  const done = new Set();
  for (const p of allPrompts) {
    const idea = extractIdeaFromPrompt(p);
    if (idea) done.add(idea.toLowerCase());
  }
  return allConcepts.filter(c => !done.has(c.idea0.toLowerCase()));
}

function extractWaitMinutes(msg) {
  const m = msg.match(/RATE_LIMIT:(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().then(() => process.exit(0)).catch(err => { console.error(err.message); process.exit(1); });
