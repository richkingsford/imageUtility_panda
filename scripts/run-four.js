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

const PROVIDERS = ["chatgpt", "meta", "gemini", "copilot"];

function readData() {
  if (!fs.existsSync(DATA_FILE)) return { images: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return { images: [] }; }
}

function getMissing() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith("concept-brainstorms"));
  const all = [];
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
    for (const item of d.items) all.push({ concept: item.concept, idea0: item.brainstorms[0].idea });
  }
  const latest = readData();
  const allPrompts = [latest.prompt || "", ...(latest.images || []).map(i => i.prompt)];
  const done = new Set();
  for (const p of allPrompts) {
    const m = p.match(/single (.+?) object/i);
    if (m) done.add(m[1].toLowerCase());
  }
  return all.filter(c => !done.has(c.idea0.toLowerCase()));
}

// ── Captcha/human check detection ──
async function waitForHumanCheckIfNeeded(page, providerName) {
  for (let i = 0; i < 60; i++) {
    const hasCaptcha = await page.evaluate(() => {
      const iframes = Array.from(document.querySelectorAll("iframe"));
      if (iframes.some(f => /captcha|challenge|turnstile|recaptcha|hcaptcha/i.test(f.src || ""))) return true;
      const bodyText = document.body.innerText || "";
      if (/captcha|verify you.*human|are you a robot|challenge-platform|press and hold|confirm you.*human/i.test(bodyText)) return true;
      return false;
    }).catch(() => false);

    if (!hasCaptcha) return;
    if (i === 0) console.log(`\n  ⚠️  [${providerName}] CAPTCHA/human check detected — please solve it manually...`);
    await page.waitForTimeout(2000);
  }
  throw new Error(`[${providerName}] Captcha not solved within 2 minutes`);
}

// ── Save image with retry for DOM detach ──
async function saveImage(context, locator, outputFile) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await locator.waitFor({ state: "attached", timeout: 5000 });
      await locator.scrollIntoViewIfNeeded();
      const src = await locator.evaluate(el => el.currentSrc || el.src || "");
      if (src) {
        try {
          const resp = await context.request.get(src);
          if (resp.ok()) { fs.writeFileSync(outputFile, await resp.body()); return; }
        } catch {}
      }
      await locator.screenshot({ path: outputFile });
      return;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ── ChatGPT ──
async function generateChatGPT(page, context, prompt, outputFile) {
  await page.goto("https://chatgpt.com/images", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  await waitForHumanCheckIfNeeded(page, "chatgpt");

  const bodyText = await page.locator("body").innerText();
  const rl = bodyText.match(/try again in (\d+)\s*(minute|second)/i);
  if (rl) throw new Error(`RATE_LIMIT: ${rl[0]}`);

  const baseline = await page.evaluate(() =>
    Array.from(document.querySelectorAll("main img"))
      .filter(img => { const w=img.naturalWidth||0,h=img.naturalHeight||0,src=(img.currentSrc||img.src||"").toLowerCase(); return src&&!src.startsWith("data:")&&w>=256&&h>=256&&!/avatar|icon|logo|favicon|profile/.test(`${img.alt} ${src}`); })
      .map(img => `${img.currentSrc||img.src}::${img.alt||""}`)
  );

  await page.evaluate((value) => {
    const el = document.querySelector("[contenteditable='true'][role='textbox']") || document.querySelector("textarea");
    if (!el) throw new Error("No input");
    el.focus();
    if (el.matches("[contenteditable='true']")) { el.innerHTML=""; const p=document.createElement("p"); p.textContent=value; el.appendChild(p); el.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:value})); }
    else { el.value=value; el.dispatchEvent(new Event("input",{bubbles:true})); }
  }, prompt);

  for (const sel of ["button[aria-label='Send prompt']","button[aria-label*='Send']","button[data-testid*='send']"]) {
    const btn = page.locator(sel).first();
    if (await btn.count()) { await btn.waitFor({state:"visible",timeout:5000}); await page.waitForTimeout(300); await btn.click(); break; }
  }

  const img = await waitForNewImage(page, baseline, "main img", 256, /avatar|icon|logo|favicon|profile/, "chatgpt");
  await saveImage(context, img, outputFile);
}

// ── Meta AI ──
async function generateMeta(page, context, prompt, outputFile) {
  await page.goto("https://www.meta.ai/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  await waitForHumanCheckIfNeeded(page, "meta");

  const input = page.locator("[contenteditable='true'][role='textbox']").first();
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.click();
  await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(200);
  await input.pressSequentially(`Imagine ${prompt}`, { delay: 10 });
  await page.waitForTimeout(500);

  const sendBtn = page.locator("button[aria-label='Send']").first();
  if (await sendBtn.count()) await sendBtn.click(); else await page.keyboard.press("Enter");

  const img = await waitForNewImage(page, [], "img", 256, /avatar|icon|logo|favicon|profile/, "meta");
  await saveImage(context, img, outputFile);
}

// ── Gemini ──
async function generateGemini(page, context, prompt, outputFile) {
  await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  await waitForHumanCheckIfNeeded(page, "gemini");

  const input = page.locator(".ql-editor[contenteditable='true']").first();
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.click();
  await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(200);
  await input.pressSequentially(`Generate an image: ${prompt}`, { delay: 10 });
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");

  const img = await waitForNewImage(page, [], "img", 200, /avatar|icon|logo|favicon|profile|sparkle|gemini_sparkle/, "gemini");
  await saveImage(context, img, outputFile);
}

// ── Copilot ──
async function generateCopilot(page, context, prompt, outputFile) {
  await page.goto("https://copilot.microsoft.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  await waitForHumanCheckIfNeeded(page, "copilot");

  const input = page.locator("textarea#userInput");
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.click();
  await input.fill("");
  await page.waitForTimeout(200);
  await input.fill(`Create an image: ${prompt}`);
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");

  const img = await waitForNewImage(page, [], "img", 256, /avatar|icon|logo|favicon|profile/, "copilot");
  await saveImage(context, img, outputFile);
}

// ── Shared: wait for a new large image to appear ──
async function waitForNewImage(page, baseline, selector, minSize = 256, excludePattern = /avatar|icon|logo|favicon|profile/, providerName = "unknown") {
  const baseSet = new Set(baseline);
  const deadline = Date.now() + 180000;
  let idx = -1, stable = 0;

  while (Date.now() < deadline) {
    await waitForHumanCheckIfNeeded(page, providerName);

    idx = await page.evaluate(({ sel, baseKeys, min, excl }) => {
      const baseSet = new Set(baseKeys);
      const exclRe = new RegExp(excl);
      return Array.from(document.querySelectorAll(sel))
        .map((img, i) => ({ img, i }))
        .filter(({ img }) => {
          const w=img.naturalWidth||img.width||0, h=img.naturalHeight||img.height||0;
          const src=(img.currentSrc||img.src||"").toLowerCase();
          if (!src||src.startsWith("data:")||w<min||h<min) return false;
          if (exclRe.test(`${img.alt||""} ${src} ${img.className||""}`)) return false;
          if (baseSet.has(`${img.currentSrc||img.src}::${img.alt||""}`)) return false;
          return img.complete && img.naturalWidth > 0;
        })
        .sort((a,b) => ((b.img.naturalWidth||0)*(b.img.naturalHeight||0)) - ((a.img.naturalWidth||0)*(a.img.naturalHeight||0)))[0]?.i ?? -1;
    }, { sel: selector, baseKeys: [...baseSet], min: minSize, excl: excludePattern.source });

    if (idx >= 0) { stable++; if (stable >= 2) break; } else { stable = 0; }
    await page.waitForTimeout(2000);
  }

  if (idx < 0) throw new Error(`No image found after generation (selector: ${selector})`);
  return page.locator(selector).nth(idx);
}

async function runRound(context, items) {
  const pages = context.pages();

  const findTab = (provider) => {
    if (provider === "chatgpt") return pages.find(p => p.url().includes("chatgpt.com/images")) || pages.find(p => p.url().includes("chatgpt.com"));
    if (provider === "meta") return pages.find(p => p.url().includes("meta.ai"));
    if (provider === "gemini") return pages.find(p => p.url().includes("gemini.google.com") && !p.url().includes("RotateCookies"));
    if (provider === "copilot") return pages.find(p => p.url().includes("copilot.microsoft.com"));
  };

  const generators = { chatgpt: generateChatGPT, meta: generateMeta, gemini: generateGemini, copilot: generateCopilot };

  const results = await Promise.allSettled(items.map(async (a) => {
    const page = findTab(a.provider);
    if (!page) throw new Error(`No ${a.provider} tab found`);
    page.setDefaultTimeout(15000);
    const outputFile = path.join(GENERATED_DIR, `${a.outputName}.png`);
    console.log(`[${a.provider}] Starting...`);
    await generators[a.provider](page, context, a.prompt, outputFile);
    console.log(`[${a.provider}] ✓ Saved: ${a.outputName}.png`);
    return a;
  }));

  return results;
}

function persistResults(results) {
  const data = readData();
  const images = data.images || [];

  for (const r of results) {
    if (r.status === "fulfilled") {
      const a = r.value;
      const generatedAt = new Date().toISOString();
      images.push({
        id: `image-${generatedAt.replace(/[^0-9a-z]/gi, "").toLowerCase()}`,
        prompt: a.prompt,
        imagePath: `/generated/${a.outputName}.png`,
        generatedAt,
        provider: a.provider,
      });
    }
  }

  data.images = images;
  data.status = "ready";
  if (images.length) {
    const last = images[images.length - 1];
    data.prompt = last.prompt;
    data.imagePath = last.imagePath;
    data.generatedAt = last.generatedAt;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + "\n");
  fs.writeFileSync(PUBLIC_DATA_FILE, JSON.stringify(data, null, 2) + "\n");
}

async function main() {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });

  const batchSize = parseInt(process.argv[2] || "4", 10);
  const missing = getMissing();
  const total = Math.min(batchSize, missing.length);
  if (total === 0) { console.log("All concepts done!"); return; }

  const rounds = Math.ceil(total / PROVIDERS.length);
  console.log(`\n=== Batch: ${total} images across ${rounds} round(s) ===\n`);

  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const context = browser.contexts()[0];
  let totalOk = 0, totalFail = 0, offset = 0;

  for (let round = 0; round < rounds; round++) {
    const chunk = missing.slice(offset, offset + PROVIDERS.length);
    if (chunk.length === 0) break;

    const assignments = chunk.map((item, i) => ({
      provider: PROVIDERS[i % PROVIDERS.length],
      concept: item.concept,
      idea: item.idea0,
      prompt: buildImagePromptFromIdea(item.idea0, { personGender: "random" }),
      outputName: item.idea0.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim(),
    }));

    console.log(`── Round ${round + 1}/${rounds} ──`);
    assignments.forEach(a => console.log(`  ${a.provider.padEnd(8)} -> [${a.concept}] -> "${a.idea}"`));
    console.log("");

    const results = await runRound(context, assignments);
    persistResults(results);

    const ok = results.filter(r => r.status === "fulfilled").length;
    const fail = results.filter(r => r.status === "rejected").length;
    results.filter(r => r.status === "rejected").forEach(r => console.error(`  [FAILED] ${r.reason.message}`));
    totalOk += ok;
    totalFail += fail;
    offset += chunk.length;

    console.log(`  Round ${round + 1} result: ${ok} ok, ${fail} failed\n`);

    if (round < rounds - 1) {
      console.log("  Pausing 5s between rounds...\n");
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log(`=== BATCH COMPLETE: ${totalOk} succeeded, ${totalFail} failed out of ${total} ===`);
  await browser.close();
}

main().then(() => process.exit(0)).catch(err => { console.error(err.message); process.exit(1); });
