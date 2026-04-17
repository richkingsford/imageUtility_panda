const PERSON_GENDER_VALUES = new Set(["male", "female", "random"]);

function buildImagePromptFromIdea(idea, options = {}) {
  const trimmedIdea = String(idea || "").trim();
  if (!trimmedIdea) {
    throw new Error("An idea is required to build an image prompt.");
  }

  const personGender = normalizePersonGender(options.personGender);
  const personPhrase = pickPersonPhrase(personGender);

  return [
    `attention-getter of a single ${trimmedIdea} object,`,
    `include ${personPhrase} somehow interacting with the object.`,
    "The object should be the main subject of the image and the person secondary.",
    "simple and clean background - not cluttered or messy or chaotic at all - but natural.",
    "Visually interesting, professional, and clean.",
  ].join(" ");
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

module.exports = {
  buildImagePromptFromIdea,
};
