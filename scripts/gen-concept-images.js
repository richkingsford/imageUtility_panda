const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { buildImagePromptFromIdea } = require("./prompt-template");

const ROOT = path.resolve(__dirname, "..");
const GENERATED_DIR = path.join(ROOT, "public", "generated");
const DATA_DIR = path.join(ROOT, "data");
const NEEDS_FILE = path.join(DATA_DIR, "needs-generation.json");

const PROVIDERS = ["chatgpt", "meta"];

// ── Captcha detection ──
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
    if (i === 0) console.log(`\n  ⚠️  [${providerName}] CAPTCHA detected — please solve it manually...`);
    await page.waitForTimeout(2000);
  }
  throw new Error(`[${providerName}] Captcha not solved within 2 minutes`);
}

// ── Save image with retry ──
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

// ── Wait for new image ──
async function waitForNewImage(page, baseline, selector, minSize, excludePattern, providerName) {
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

async function main() {
  const needs = JSON.parse(fs.readFileSync(NEEDS_FILE, "utf8"));
  if (needs.length === 0) { console.log("Nothing to generate!"); return; }

  const rounds = Math.ceil(needs.length / PROVIDERS.length);
  console.log(`\n=== Generating ${needs.length} concept images across ${rounds} round(s) ===\n`);

  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const context = browser.contexts()[0];
  let totalOk = 0, totalFail = 0, offset = 0;
  const failed = [];

  for (let round = 0; round < rounds; round++) {
    const chunk = needs.slice(offset, offset + PROVIDERS.length);
    if (chunk.length === 0) break;

    const assignments = chunk.map((item, i) => ({
      provider: PROVIDERS[i % PROVIDERS.length],
      concept: item.concept,
      idea: item.idea,
      prompt: buildImagePromptFromIdea(item.idea, { personGender: "random" }),
      outputFile: path.join(GENERATED_DIR, item.concept.toLowerCase() + ".png"),
    }));

    console.log(`── Round ${round + 1}/${rounds} ──`);
    assignments.forEach(a => console.log(`  ${a.provider.padEnd(8)} -> [${a.concept}] -> "${a.idea}"`));
    console.log("");

    const pages = context.pages();
    const findTab = (provider) => {
      if (provider === "chatgpt") return pages.find(p => p.url().includes("chatgpt.com/images")) || pages.find(p => p.url().includes("chatgpt.com"));
      if (provider === "meta") return pages.find(p => p.url().includes("meta.ai"));
      if (provider === "gemini") return pages.find(p => p.url().includes("gemini.google.com") && !p.url().includes("RotateCookies"));
      if (provider === "copilot") return pages.find(p => p.url().includes("copilot.microsoft.com"));
    };
    const generators = { chatgpt: generateChatGPT, meta: generateMeta, gemini: generateGemini, copilot: generateCopilot };

    const results = await Promise.allSettled(assignments.map(async (a) => {
      const page = findTab(a.provider);
      if (!page) throw new Error(`No ${a.provider} tab found`);
      page.setDefaultTimeout(15000);
      console.log(`[${a.provider}] Starting "${a.concept}"...`);
      await generators[a.provider](page, context, a.prompt, a.outputFile);
      console.log(`[${a.provider}] ✓ ${a.concept}.png`);
      return a;
    }));

    const ok = results.filter(r => r.status === "fulfilled").length;
    const fail = results.filter(r => r.status === "rejected").length;
    results.forEach((r, i) => { if (r.status === "rejected") { console.error(`  [FAILED] ${assignments[i].concept}: ${r.reason.message.split("\n")[0]}`); failed.push(assignments[i]); } });
    totalOk += ok;
    totalFail += fail;
    offset += chunk.length;

    console.log(`  Round ${round + 1}: ${ok} ok, ${fail} failed\n`);

    if (round < rounds - 1) {
      console.log("  Pausing 5s...\n");
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // Save remaining failures for retry
  if (failed.length) {
    fs.writeFileSync(NEEDS_FILE, JSON.stringify(failed.map(f => ({ concept: f.concept, idea: f.idea })), null, 2) + "\n");
  } else {
    fs.writeFileSync(NEEDS_FILE, "[]\n");
  }

  console.log(`=== DONE: ${totalOk} succeeded, ${totalFail} failed ===`);
  if (failed.length) console.log(`Remaining failures saved to needs-generation.json for retry.`);
  await browser.close();
}

main().then(() => process.exit(0)).catch(err => { console.error(err.message); process.exit(1); });
