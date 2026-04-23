const statusLine = document.querySelector("#status-line");
const gallery = document.querySelector("#gallery");
const emptyState = document.querySelector("#empty-state");

const BUILT_IN_PROMPT_VARIANTS = {
  single_object_v1: {
    id: "single_object_v1",
    templateParts: [
      "attention-getter of a single {IDEA} object,",
      "include {PERSON} interacting with the object in a natural, organic, realistic way",
      "(not just staring and smiling at it).",
      "The object should be the main subject of the image and the person secondary.",
      "Minimalist or natural/organic/realistic background - not cluttered or messy or chaotic.",
      "Visually interesting, professional, and clean.",
    ],
  },
  educator_scene_v2: {
    id: "educator_scene_v2",
    templateParts: [
      'attention-getter centered on "{IDEA}".',
      "Feature {PERSON} in a realistic, educator-relevant scene interacting naturally with the main subject",
      "(not just staring and smiling at it).",
      "Aim for a visually persuasive image that would make a teacher stop scrolling and read the post text.",
      "The main subject or scene concept should be primary, with the person clearly visible but secondary.",
      "Professional, realistic, aspirational, and emotionally intelligent.",
      "Clean composition, natural lighting, and a minimal or believable real-world background - not cluttered, chaotic, gimmicky, or overly staged.",
      "Avoid text overlays, collages, split screens, UI mockups, and generic stock-photo energy.",
      "Generate the image now without asking follow-up questions.",
    ],
  },
};

loadGallery();

async function loadGallery() {
  try {
    const postsData = await fetchJsonData(["/posts.json"]);
    const [conceptsData, metaBatchData, promptVariantData, badImageSignatureData] = await Promise.all([
      fetchOptionalJsonData(["/concepts-complete.json"]),
      fetchOptionalJsonData(["/meta-batch-results.json"]),
      fetchOptionalJsonData(["/prompt-variants.json"]),
      fetchOptionalJsonData(["/bad-image-signatures.json"]),
    ]);
    const items = normalizeGalleryItems(postsData, conceptsData, metaBatchData, promptVariantData);

    if (items.length) {
      const uniqueImageCount = countUniqueImages(items);
      statusLine.textContent = buildGalleryStatusText(items.length, uniqueImageCount);
      const renderState = renderGallery(items);
      void auditRenderedImages(renderState, badImageSignatureData);
      emptyState.hidden = true;
    } else {
      statusLine.textContent = "No gallery items are available yet.";
      gallery.replaceChildren(emptyState);
      emptyState.hidden = false;
    }
  } catch (error) {
    statusLine.textContent = `Unable to load the gallery data: ${error.message}`;
    gallery.replaceChildren(emptyState);
    emptyState.hidden = false;
  }
}

function buildGalleryStatusText(postCount, uniqueImageCount) {
  return `Showing ${postCount} posts across ${uniqueImageCount} unique images. Click a prompt or post field to expand it.`;
}

async function fetchJsonData(sources) {
  let lastError = null;

  for (const source of sources) {
    try {
      const response = await fetch(source, { cache: "no-store" });
      if (response.ok) {
        return response.json();
      }

      lastError = new Error(`Request failed with status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Unable to load gallery data.");
}

async function fetchOptionalJsonData(sources) {
  try {
    return await fetchJsonData(sources);
  } catch {
    return null;
  }
}

function normalizeGalleryItems(postsData, conceptsData, metaBatchData, promptVariantData) {
  const posts = Array.isArray(postsData?.posts) ? postsData.posts : [];
  const conceptEntries = Array.isArray(conceptsData?.concepts) ? conceptsData.concepts : [];
  const metaEntries = Array.isArray(metaBatchData) ? metaBatchData : [];
  const conceptsByKey = new Map(
    conceptEntries.map((entry) => [normalizeKey(entry.concept), entry])
  );
  const metaByIdea = new Map(
    metaEntries.map((entry) => [normalizeKey(entry.idea), entry])
  );

  return posts
    .filter((post) => Boolean(post))
    .map((post, index) => {
      const conceptEntry = conceptsByKey.get(normalizeKey(post.concept));
      const metaEntry = metaByIdea.get(normalizeKey(post.selectedIdea));
      const prompt = conceptEntry?.image?.prompt
        || buildPromptFallback(post.selectedIdea, metaEntry, promptVariantData);
      const imagePath = String(post.imagePath || "").trim();

      return {
        index: Number.isFinite(post.index) ? post.index : index + 1,
        concept: post.concept || "Untitled concept",
        selectedIdea: post.selectedIdea || "Untitled idea",
        imagePath,
        postText: post.post || "Post copy unavailable.",
        prompt,
        generatedAt: conceptEntry?.image?.generatedAt || null,
        provider: conceptEntry?.image?.provider || (metaEntry ? "meta" : null),
      };
    });
}

function renderGallery(items) {
  const fragment = document.createDocumentFragment();
  const cards = [];

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "panel image-card";
    if (!item.imagePath) {
      card.classList.add("is-missing-image");
    }
    card.dataset.imagePath = item.imagePath;

    const header = document.createElement("div");
    header.className = "card-header";

    const indexTag = document.createElement("p");
    indexTag.className = "card-index";
    indexTag.textContent = `Post ${item.index}`;

    const title = document.createElement("h2");
    title.className = "card-title";
    title.textContent = item.concept;

    const idea = document.createElement("p");
    idea.className = "card-idea";
    idea.textContent = item.selectedIdea;

    const flag = document.createElement("p");
    flag.className = "image-flag";
    flag.hidden = true;
    flag.textContent = "Placeholder detected";

    header.append(indexTag, title, idea, flag);

    const media = document.createElement("div");
    media.className = "card-media";

    const preview = createMediaPreview(item);
    media.append(preview);

    const meta = document.createElement("p");
    meta.className = "card-meta";
    meta.textContent = buildMetaText(item);

    const fields = document.createElement("div");
    fields.className = "field-stack";
    fields.append(
      createCopyField("Prompt", item.prompt, "Prompt unavailable."),
      createCopyField("Post", item.postText, "Post copy unavailable.")
    );

    card.append(header, media, meta, fields);
    fragment.append(card);
    cards.push({ card, flag, item });
  }

  gallery.replaceChildren(fragment);
  return {
    cards,
    postCount: items.length,
    uniqueImageCount: countUniqueImages(items),
  };
}

async function auditRenderedImages(renderState, badImageSignatureData) {
  const signatures = Array.isArray(badImageSignatureData?.signatures)
    ? badImageSignatureData.signatures
    : [];

  if (!signatures.length || !globalThis.crypto?.subtle) {
    return;
  }

  const signatureByHash = new Map(
    signatures.map((signature) => [normalizeHash(signature.sha256), signature])
  );
  const hashCache = new Map();

  await Promise.all(renderState.cards.map(async (cardState) => {
    if (!cardState.item.imagePath) {
      return;
    }

    let hashPromise = hashCache.get(cardState.item.imagePath);
    if (!hashPromise) {
      hashPromise = hashImageFile(cardState.item.imagePath).catch(() => null);
      hashCache.set(cardState.item.imagePath, hashPromise);
    }

    const hash = await hashPromise;
    const signature = signatureByHash.get(normalizeHash(hash));

    if (signature) {
      markCardAsFlagged(cardState, signature);
    }
  }));

  const flaggedCards = renderState.cards.filter((cardState) => cardState.card.classList.contains("is-flagged"));
  if (!flaggedCards.length) {
    return;
  }

  const flaggedImageCount = new Set(flaggedCards.map((cardState) => cardState.item.imagePath)).size;
  statusLine.textContent = `${buildGalleryStatusText(renderState.postCount, renderState.uniqueImageCount)} ${flaggedCards.length} post${flaggedCards.length === 1 ? "" : "s"} currently use ${flaggedImageCount} known placeholder image${flaggedImageCount === 1 ? "" : "s"}.`;
}

function markCardAsFlagged(cardState, signature) {
  cardState.card.classList.add("is-flagged");
  cardState.flag.hidden = false;
  cardState.flag.title = signature.reason || "Known placeholder image";
}

async function hashImageFile(imagePath) {
  const response = await fetch(stripQueryString(imagePath), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unable to audit image at ${imagePath}`);
  }

  const buffer = await response.arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function createMediaPreview(item) {
  if (!item.imagePath) {
    const placeholder = document.createElement("div");
    placeholder.className = "image-placeholder";
    placeholder.setAttribute("role", "img");
    placeholder.setAttribute("aria-label", `No image available for ${item.selectedIdea} in ${item.concept}`);
    placeholder.textContent = "NO IMAGE";
    return placeholder;
  }

  const preview = document.createElement("img");
  preview.className = "image-preview";
  preview.alt = `${item.selectedIdea} for ${item.concept}`;
  preview.src = `${item.imagePath}?v=${encodeURIComponent(item.generatedAt || item.index)}`;
  return preview;
}

function countUniqueImages(items) {
  return new Set(
    items
      .map((item) => item.imagePath)
      .filter(Boolean)
  ).size;
}

function normalizeHash(value) {
  return String(value || "").trim().toUpperCase();
}

function stripQueryString(value) {
  return String(value || "").split("?")[0];
}

function createCopyField(labelText, value, fallbackText) {
  const wrapper = document.createElement("section");
  wrapper.className = "field-group";

  const label = document.createElement("label");
  label.className = "prompt-label";
  label.textContent = labelText;

  const input = document.createElement("textarea");
  input.className = "prompt-input prompt-textarea copy-field";
  input.rows = 1;
  input.readOnly = true;
  input.spellcheck = false;
  input.value = String(value || "").trim() || fallbackText;
  input.addEventListener("focus", () => expandTextField(input));
  input.addEventListener("blur", () => collapseTextField(input));
  input.addEventListener("input", () => expandTextField(input));
  collapseTextField(input);

  wrapper.append(label, input);
  return wrapper;
}

function buildMetaText(item) {
  const parts = [`Idea: ${item.selectedIdea}`];

  if (!item.imagePath) {
    parts.push("No image yet");
  }

  if (item.generatedAt) {
    parts.push(`Captured ${new Date(item.generatedAt).toLocaleString()}`);
  }

  if (item.provider) {
    parts.push(`Source ${item.provider}`);
  }

  return parts.join(" · ");
}

function buildPromptFallback(idea, metaEntry, promptVariantData) {
  const preferredVariantId = metaEntry ? (promptVariantData?.defaultVariantId || "educator_scene_v2") : "single_object_v1";
  const variant = resolvePromptVariant(promptVariantData, preferredVariantId);
  const promptIdea = String(idea || "Untitled idea").trim() || "Untitled idea";
  const personPhrase = resolvePersonPhrase(metaEntry?.gender);

  return variant.templateParts
    .map((part) =>
      String(part)
        .replaceAll("{IDEA}", promptIdea)
        .replaceAll("{PERSON}", personPhrase)
    )
    .join(" ");
}

function resolvePromptVariant(promptVariantData, preferredVariantId) {
  const variants = Array.isArray(promptVariantData?.variants) ? promptVariantData.variants : [];
  const defaultVariantId = String(promptVariantData?.defaultVariantId || "educator_scene_v2");

  return (
    variants.find((variant) => variant.id === preferredVariantId)
    || variants.find((variant) => variant.id === defaultVariantId)
    || BUILT_IN_PROMPT_VARIANTS[preferredVariantId]
    || BUILT_IN_PROMPT_VARIANTS[defaultVariantId]
    || BUILT_IN_PROMPT_VARIANTS.educator_scene_v2
  );
}

function resolvePersonPhrase(gender) {
  const normalized = String(gender || "").trim().toLowerCase();

  if (normalized === "male") {
    return "an attractive male";
  }

  if (normalized === "female") {
    return "an attractive female";
  }

  return "an attractive person";
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function collapseTextField(textarea) {
  textarea.classList.remove("is-expanded");
  textarea.setAttribute("aria-expanded", "false");
  textarea.style.height = "";
}

function expandTextField(textarea) {
  textarea.classList.add("is-expanded");
  textarea.setAttribute("aria-expanded", "true");
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}
