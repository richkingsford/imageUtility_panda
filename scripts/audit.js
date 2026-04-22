const fs = require("fs");
const path = require("path");

const concepts = fs.readFileSync("concepts", "utf8").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
console.log("Concepts in file:", concepts.length);

const DATA_DIR = "data";
const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith("concept-brainstorms"));
const conceptToIdea = {};
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
  for (const item of d.items) {
    conceptToIdea[item.concept.toLowerCase()] = item.brainstorms[0].idea;
  }
}
console.log("Concepts in brainstorm JSONs:", Object.keys(conceptToIdea).length);

const latest = JSON.parse(fs.readFileSync("data/latest.json", "utf8"));
const images = latest.images || [];
console.log("Images in latest.json:", images.length);

const ideaDone = new Set();
for (const img of images) {
  const m = img.prompt.match(/single (.+?) object/i);
  if (m) ideaDone.add(m[1].toLowerCase());
}
console.log("Unique ideas with images:", ideaDone.size);

const missing = [];
const nobrainstorm = [];
for (const c of concepts) {
  const idea = conceptToIdea[c.toLowerCase()];
  if (!idea) { nobrainstorm.push(c); continue; }
  if (!ideaDone.has(idea.toLowerCase())) missing.push({ concept: c, idea });
}

const genDir = "public/generated";
const onDisk = new Set(fs.readdirSync(genDir).map(f => f.toLowerCase()));

const missingFiles = [];
for (const img of images) {
  const filename = img.imagePath.replace(/^\/generated\//, "").toLowerCase();
  if (!onDisk.has(filename)) missingFiles.push(img.imagePath);
}

console.log("\n--- RESULTS ---");
console.log("Concepts with NO brainstorm data:", nobrainstorm.length);
if (nobrainstorm.length) nobrainstorm.forEach(c => console.log("  -", c));
console.log("Concepts with brainstorm but NO image:", missing.length);
if (missing.length) missing.forEach(m => console.log("  - [" + m.concept + "] -> " + m.idea));
console.log("Images in JSON but MISSING from disk:", missingFiles.length);
if (missingFiles.length) missingFiles.forEach(f => console.log("  -", f));
console.log("Images on disk:", onDisk.size);
