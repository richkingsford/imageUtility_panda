const fs = require("fs");
const path = require("path");

const DATA_DIR = "data";
const GENERATED_DIR = path.join("public", "generated");

// Load all concepts with their idea0
const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith("concept-brainstorms"));
const allConcepts = [];
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
  for (const item of d.items) allConcepts.push({ concept: item.concept, idea: item.brainstorms[0].idea });
}

const onDisk = fs.readdirSync(GENERATED_DIR).map(f => ({ lower: f.toLowerCase(), original: f }));
const diskMap = {};
for (const f of onDisk) diskMap[f.lower] = f.original;

let copied = 0, alreadyExist = 0, needGen = [];

for (const c of allConcepts) {
  const conceptFile = c.concept.toLowerCase() + ".png";
  
  // Already exists?
  if (diskMap[conceptFile]) { alreadyExist++; continue; }

  // Try to find the idea-named file
  const ideaFile = c.idea.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim() + ".png";
  if (diskMap[ideaFile]) {
    const src = path.join(GENERATED_DIR, diskMap[ideaFile]);
    const dest = path.join(GENERATED_DIR, c.concept.toLowerCase() + ".png");
    fs.copyFileSync(src, dest);
    copied++;
  } else {
    needGen.push({ concept: c.concept, idea: c.idea });
  }
}

console.log(`Already existed: ${alreadyExist}`);
console.log(`Copied: ${copied}`);
console.log(`Still need generation: ${needGen.length}`);
if (needGen.length) {
  needGen.forEach(n => console.log(`  - [${n.concept}] -> ${n.idea}`));
}

// Write the list of what needs generation for run-four to pick up
fs.writeFileSync(path.join(DATA_DIR, "needs-generation.json"), JSON.stringify(needGen, null, 2) + "\n");
