const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

// 1. Load all brainstorms
const brainstormFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith("concept-brainstorms"));
const concepts = [];
for (const f of brainstormFiles) {
  const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
  for (const item of data.items) concepts.push(item);
}

// 2. Load image data from latest.json, keep latest per idea
const latest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "latest.json"), "utf8"));
const images = latest.images || [];
const imageByIdea = new Map();
for (const img of images) {
  const m = img.prompt.match(/single (.+?) object/i);
  if (!m) continue;
  const key = m[1].toLowerCase();
  const existing = imageByIdea.get(key);
  if (!existing || new Date(img.generatedAt) > new Date(existing.generatedAt)) {
    imageByIdea.set(key, img);
  }
}

// 3. Build consolidated entries
const consolidated = concepts.map((c, i) => {
  const selectedIdea = c.brainstorms[0].idea;
  const img = imageByIdea.get(selectedIdea.toLowerCase());

  return {
    index: i + 1,
    concept: c.concept,
    brainstorms: c.brainstorms,
    selectedIdea,
    image: img
      ? {
          prompt: img.prompt,
          path: img.imagePath,
          generatedAt: img.generatedAt,
          provider: img.provider || "chatgpt",
        }
      : null,
  };
});

const withImage = consolidated.filter(c => c.image).length;
const withoutImage = consolidated.filter(c => !c.image).length;

const output = {
  generatedAt: new Date().toISOString(),
  totalConcepts: consolidated.length,
  withImage,
  withoutImage,
  concepts: consolidated,
};

const outPath = path.join(DATA_DIR, "concepts-complete.json");
fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");

console.log(`Consolidated ${consolidated.length} concepts -> ${outPath}`);
console.log(`  With image: ${withImage}`);
console.log(`  Without image: ${withoutImage}`);
