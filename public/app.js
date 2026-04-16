const statusLine = document.querySelector("#status-line");
const gallery = document.querySelector("#gallery");
const emptyState = document.querySelector("#empty-state");

loadLatest();

async function loadLatest() {
  try {
    const response = await fetchLatestData();

    const data = await response.json();
    const images = normalizeImages(data);

    if (data.generatedAt) {
      const generatedAt = new Date(data.generatedAt).toLocaleString();
      statusLine.textContent = `Showing ${images.length} generated image${images.length === 1 ? "" : "s"}. Latest capture ${generatedAt}.`;
    } else {
      statusLine.textContent = "Waiting for the first generated image.";
    }

    if (images.length) {
      renderGallery(images);
      emptyState.hidden = true;
    } else {
      gallery.replaceChildren(emptyState);
      emptyState.hidden = false;
    }
  } catch (error) {
    statusLine.textContent = `Unable to load the latest image data: ${error.message}`;
    gallery.replaceChildren(emptyState);
    emptyState.hidden = false;
  }
}

async function fetchLatestData() {
  const sources = ["/latest.json", "/api/latest"];
  let lastError = null;

  for (const source of sources) {
    try {
      const response = await fetch(source, { cache: "no-store" });
      if (response.ok) {
        return response;
      }

      lastError = new Error(`Request failed with status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Unable to load latest image data.");
}

function normalizeImages(data) {
  if (Array.isArray(data.images)) {
    return data.images.filter((item) => item && item.imagePath);
  }

  if (!data.imagePath) {
    return [];
  }

  return [
    {
      prompt: data.prompt || "",
      imagePath: data.imagePath,
      generatedAt: data.generatedAt || null,
    },
  ];
}

function renderGallery(images) {
  const fragment = document.createDocumentFragment();

  for (const image of images) {
    const card = document.createElement("article");
    card.className = "panel image-card";

    const label = document.createElement("label");
    label.className = "prompt-label";
    label.textContent = "Prompt";

    const input = document.createElement("textarea");
    input.className = "prompt-input prompt-textarea";
    input.rows = 1;
    input.value = image.prompt || "";
    input.addEventListener("input", () => autoResizeTextarea(input));
    autoResizeTextarea(input);

    const meta = document.createElement("p");
    meta.className = "status-line";
    meta.textContent = image.generatedAt
      ? `Captured ${new Date(image.generatedAt).toLocaleString()}.`
      : "Capture time unavailable.";

    const preview = document.createElement("img");
    preview.className = "image-preview";
    preview.alt = image.prompt || "Generated artwork preview";
    preview.src = `${image.imagePath}?v=${encodeURIComponent(image.generatedAt || Date.now())}`;

    card.append(label, input, meta, preview);
    fragment.append(card);
  }

  gallery.replaceChildren(fragment);
  gallery.querySelectorAll(".prompt-textarea").forEach(autoResizeTextarea);
}

function autoResizeTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}
