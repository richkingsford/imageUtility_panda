const { chromium } = require("playwright");

const WS = "ws://127.0.0.1:9222/devtools/browser/5efd98ee-57e1-4605-b67b-7a749b856bdf";

async function main() {
  const browser = await chromium.connectOverCDP(WS);
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();

  console.log(`Connected! ${pages.length} tabs open:`);
  for (const p of pages) {
    console.log(`  - ${await p.title()} => ${p.url().substring(0, 80)}`);
  }

  // Test ChatGPT
  const chatgpt = pages.find(p => /chatgpt\.com/i.test(p.url()));
  if (chatgpt) {
    console.log("\n[ChatGPT] Bringing to front...");
    await chatgpt.bringToFront();
    console.log("[ChatGPT] OK - page responsive");
  } else {
    console.log("\n[ChatGPT] NO TAB FOUND");
  }

  // Test Meta AI
  const meta = pages.find(p => /meta\.ai/i.test(p.url()));
  if (meta) {
    console.log("\n[Meta AI] Bringing to front...");
    await meta.bringToFront();
    console.log("[Meta AI] OK - page responsive");
  } else {
    console.log("\n[Meta AI] NO TAB FOUND");
  }

  // Test Copilot
  const copilot = pages.find(p => /copilot\.microsoft/i.test(p.url()));
  if (copilot) {
    console.log("\n[Copilot] Bringing to front...");
    await copilot.bringToFront();
    console.log("[Copilot] OK - page responsive");
  } else {
    console.log("\n[Copilot] NO TAB FOUND");
  }

  console.log("\nSmoke test complete!");
}

main().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
