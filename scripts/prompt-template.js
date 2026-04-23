const fs = require("fs");
const path = require("path");

const PERSON_GENDER_VALUES = new Set(["male", "female", "random"]);
const PROMPT_VARIANTS_PATH = path.join(__dirname, "..", "data", "prompt-variants.json");
const PROMPT_VARIANTS_DATA = JSON.parse(fs.readFileSync(PROMPT_VARIANTS_PATH, "utf8"));
const DEFAULT_VARIANT_ID = PROMPT_VARIANTS_DATA.defaultVariantId;
const PROMPT_VARIANTS = PROMPT_VARIANTS_DATA.variants;

function buildImagePromptFromIdea(idea, options = {}) {
  const trimmedIdea = String(idea || "").trim();
  if (!trimmedIdea) {
    throw new Error("An idea is required to build an image prompt.");
  }

  const personGender = normalizePersonGender(options.personGender);
  const personPhrase = pickPersonPhrase(personGender);
  const variant = resolveVariant(options.variantId);

  return variant.templateParts
    .map((part) =>
      String(part)
        .replaceAll("{IDEA}", trimmedIdea)
        .replaceAll("{PERSON}", personPhrase)
    )
    .join(" ");
}

function normalizePersonGender(value) {
  const normalized = String(value || "random").trim().toLowerCase();
  return PERSON_GENDER_VALUES.has(normalized) ? normalized : "random";
}

function pickPersonPhrase(personGender) {
  if (personGender === "male") {
    return "an attractive male";
  }

  if (personGender === "female") {
    return "an attractive female";
  }

  return Math.random() < 0.5 ? "an attractive male" : "an attractive female";
}

function resolveVariant(variantId) {
  const requested = String(variantId || DEFAULT_VARIANT_ID).trim();
  return (
    PROMPT_VARIANTS.find((variant) => variant.id === requested) ||
    PROMPT_VARIANTS.find((variant) => variant.id === DEFAULT_VARIANT_ID) ||
    PROMPT_VARIANTS[0]
  );
}

module.exports = {
  DEFAULT_VARIANT_ID,
  PROMPT_VARIANTS,
  buildImagePromptFromIdea,
};
