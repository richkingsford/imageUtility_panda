const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const CHROME_DEBUG_URL = "ws://127.0.0.1:9222/devtools/browser/5efd98ee-57e1-4605-b67b-7a749b856bdf";

function getNext20Missing() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith("concept-brainstorms"));
  const allConcepts = [];
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
    for (const item of data.items) {
      allConcepts.push({ concept: item.concept, idea0: item.brainstorms[0].idea });
    }
  }

  const latest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "latest.json"), "utf8"));
  const allPrompts = [latest.prompt, ...(latest.images || []).map(i => i.prompt)];
  const generatedIdeas = new Set();
  for (const p of allPrompts) {
    const m = p.match(/single (.+?) object/i);
    if (m) generatedIdeas.add(m[1].toLowerCase());
  }

  return allConcepts
    .filter(c => !generatedIdeas.has(c.idea0.toLowerCase()))
    .slice(0, 20);
}

function makeOutputName(idea) {
  return idea.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const batch = getNext20Missing();
  console.log(`\n=== BATCH GENERATE: ${batch.length} images ===\n`);

  let completed = 0;
  let failed = 0;

  for (let i = 0; i < batch.length; i++) {
    const { concept, idea0 } = batch[i];
    const outputName = makeOutputName(idea0);
    console.log(`\n[${i + 1}/${batch.length}] Concept: "${concept}" -> Idea: "${idea0}" -> File: "${outputName}.png"`);

    let attempts = 0;
    const maxAttempts = 5;
    let success = false;

    while (attempts < maxAttempts && !success) {
      attempts++;
      try {
        const env = {
          ...process.env,
          CHROME_DEBUG_URL,
          IMAGE_IDEA: idea0,
          IMAGE_OUTPUT_NAME: outputName,
        };

        const result = execSync("node scripts/generate-image.js", {
          cwd: ROOT,
          env,
          timeout: 600000,
          stdio: "pipe",
          encoding: "utf8",
        });

        console.log(result);
        success = true;
        completed++;
      } catch (err) {
        const output = (err.stdout || "") + (err.stderr || "");
        console.log(output);

        const rateLimitMatch = output.match(/(\d+)\s*(minute|second)/i);
        if (rateLimitMatch || /rate.?limit|too quickly|please wait|try again/i.test(output)) {
          let waitMs = 120000;
          if (rateLimitMatch) {
            const num = parseInt(rateLimitMatch[1], 10);
            const unit = rateLimitMatch[2].toLowerCase();
            waitMs = unit.startsWith("minute") ? num * 60000 + 10000 : num * 1000 + 5000;
          }
          const waitSec = Math.ceil(waitMs / 1000);
          console.log(`Rate limited. Waiting ${waitSec}s before retry (attempt ${attempts}/${maxAttempts})...`);
          await sleep(waitMs);
        } else if (attempts < maxAttempts) {
          console.log(`Error on attempt ${attempts}/${maxAttempts}. Waiting 30s before retry...`);
          await sleep(30000);
        } else {
          console.log(`FAILED after ${maxAttempts} attempts. Skipping.`);
          failed++;
        }
      }
    }

    if (success && i < batch.length - 1) {
      console.log("Pausing 5s before next image...");
      await sleep(5000);
    }
  }

  console.log(`\n=== BATCH COMPLETE ===`);
  console.log(`Generated: ${completed}/${batch.length}`);
  if (failed > 0) console.log(`Failed: ${failed}`);

  // Sync latest.json to public
  const dataFile = path.join(DATA_DIR, "latest.json");
  const publicFile = path.join(ROOT, "public", "latest.json");
  if (fs.existsSync(dataFile)) {
    fs.copyFileSync(dataFile, publicFile);
    console.log("Website updated with new images.");
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err.message);
  process.exit(1);
});
