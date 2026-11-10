/* ==========================================================================
   Recipes page: manage the library (add / edit / delete / keep / restore)
   and import recipes from URLs or PDF / DOCX files.
   Depends on data.js and common.js.
   ========================================================================== */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const { escapeHtml, starRating, slugify } = MP;

  /* ---------------------------------------------------------------------
     Library list
  --------------------------------------------------------------------- */
  function render() {
    const list = $("libraryList");
    const q = $("searchBox").value.trim().toLowerCase();
    const dismissed = new Set(MP.settings.dismissedIds);
    const n = MP.recipes.length;
    $("libraryStatus").textContent =
      n + (n === 1 ? " recipe" : " recipes") + " in your library — meal plans are built only from these.";

    const missing = RECIPE_LIBRARY.filter((s) => !MP.recipes.some((r) => r.id === s.id));
    const needPhotos = MP.recipes.filter((r) => !r.photo && MP.safeUrl(r.source && r.source.url)).length;
    $("findPhotosBtn").hidden = MP.mode !== "server" || !MP.online || !needPhotos;
    $("findPhotosBtn").disabled = false;
    $("findPhotosBtn").textContent = `Find photos for ${needPhotos} recipe${needPhotos === 1 ? "" : "s"}`;
    const btn = $("restoreStartersBtn");
    btn.hidden = !missing.length;
    btn.textContent = `Add back ${missing.length} starter recipe${missing.length === 1 ? "" : "s"}`;

    const ratingFilter = $("ratingFilter").value; // "all" | "" (not made) | ok | good | great
    const shown = MP.recipes
      .filter((r) => !q || r.name.toLowerCase().includes(q) || (r.proteinTag || "").toLowerCase().includes(q))
      .filter((r) => ratingFilter === "all" || (r.rating || "") === ratingFilter)
      .sort((a, b) => a.name.localeCompare(b.name));

    list.innerHTML = "";
    if (!shown.length) {
      const emptyText =
        n ? "No recipes match your search."
        : MP.mode === "local" ? "Your library is empty. On your laptop open Preferences, Back up & restore, download a backup and send it to this phone, then restore it here (Preferences on this phone). Or add a recipe by hand with the button above."
        : "No recipes yet. Add one or import some below.";
      list.innerHTML = `<p class="empty-state">${escapeHtml(emptyText)}</p>`;
      return;
    }
    shown.forEach((r) => {
      const isDismissed = dismissed.has(r.id);
      const row = document.createElement("div");
      row.className = "library-row" + (isDismissed ? " is-dismissed" : "");
      const srcUrl = MP.safeUrl(r.source && r.source.url);
      const srcLabel = r.source && r.source.label ? escapeHtml(r.source.label) : "";
      const photo = MP.photoSrc(r);
      row.innerHTML = `
        ${photo ? `<img class="library-row__thumb" src="${escapeHtml(photo)}" alt="" loading="lazy" />` : '<div class="library-row__thumb library-row__thumb--empty" aria-hidden="true">🍽️</div>'}
        <div class="library-row__main">
          <div class="library-row__name">${escapeHtml(r.name)}</div>
          <div class="library-row__meta">
            <span>Prep ${r.prepTimeMin}m · Cook ${r.cookTimeMin}m</span>
            <span>${escapeHtml(r.proteinTag || "")}</span>
            <span class="toddler-appeal">${starRating(r.toddlerAppeal || 3)}</span>
            ${srcUrl ? `<a class="source-link" href="${escapeHtml(srcUrl)}" target="_blank" rel="noopener noreferrer">${srcLabel || "Original recipe"} ↗</a>` : srcLabel ? `<span class="badge badge--tag">${srcLabel}</span>` : ""}
            ${r.nutritionEstimated ? '<span class="badge badge--estimated">nutrition estimated</span>' : ""}
            ${isDismissed ? '<span class="badge badge--dismissed">dismissed — excluded from plans</span>' : ""}
          </div>
        </div>
        <div class="library-row__actions">
          ${MP.ratingSelect(r.id, r.rating)}
          ${isDismissed ? '<button type="button" class="btn--text" data-action="restore">Restore</button>' : ""}
          <button type="button" class="btn--text" data-action="edit">Edit</button>
          <button type="button" class="btn--text is-danger" data-action="delete">Delete</button>
        </div>`;
      row.querySelectorAll("[data-action]").forEach((b) => b.addEventListener("click", () => handleAction(b.dataset.action, r.id)));
      row.querySelector(".rating-select").addEventListener("change", (e) => {
        MP.setRating(r.id, e.target.value);
        render();
      });
      list.appendChild(row);
    });
  }

  function handleAction(action, id) {
    const recipe = MP.recipes.find((r) => r.id === id);
    if (!recipe) return;
    const s = MP.settings;
    if (action === "edit") openDialog(recipe);
    else if (action === "restore") {
      MP.updateSettings({ dismissedIds: s.dismissedIds.filter((x) => x !== id) });
      render();
    } else if (action === "delete") {
      if (!confirm('Delete "' + recipe.name + '" from your library?')) return;
      MP.recipes = MP.recipes.filter((r) => r.id !== id);
      MP.updateSettings({ dismissedIds: s.dismissedIds.filter((x) => x !== id) });
      if (recipe.photo) MP.removePhoto(recipe); // don't leave the image file orphaned
      MP.saveRecipes();
      render();
    }
  }

  /* ---------------------------------------------------------------------
     Add / edit dialog
  --------------------------------------------------------------------- */
  const NUTRITION_FIELDS = [
    ["calories", "Calories", "kcal"],
    ["proteinG", "Protein", "g"],
    ["fiberG", "Fiber", "g"],
    ["calciumMg", "Calcium", "mg"],
    ["ironMg", "Iron", "mg"],
    ["vitaminCMg", "Vitamin C", "mg"],
    ["sodiumMg", "Sodium", "mg"],
    ["addedSugarG", "Added sugar", "g"],
  ];
  const FOOD_GROUP_FIELDS = [
    ["fruit", "Fruit"],
    ["vegetable", "Vegetable"],
    ["grain", "Grain"],
    ["protein", "Protein"],
    ["dairy", "Dairy"],
  ];
  const PREP_DEFAULT_DAYS = { marinate: 1, thaw: 1, chop: 0 };
  let editingId = null;
  let pendingPhoto; // undefined = unchanged, Blob = new photo to upload on save, null = remove it
  let previewUrl = null;

  function showPhotoPreview(src, owned) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = owned ? src : null;
    $("rfPhotoPreview").innerHTML = src ? `<img src="${escapeHtml(src)}" alt="Recipe photo" />` : "<span>No photo</span>";
    $("rfPhotoRemove").hidden = !src;
  }

  async function chooseDialogPhoto(file) {
    const hint = $("rfPhotoHint");
    if (!file) return;
    try {
      pendingPhoto = await MP.shrinkImage(file);
      showPhotoPreview(URL.createObjectURL(pendingPhoto), true);
      hint.textContent = "Saved when you save the recipe.";
    } catch (e) {
      hint.textContent = e.message;
    }
  }

  function buildDialogFields() {
    $("rfNutrition").innerHTML = NUTRITION_FIELDS.map(
      ([key, label, unit]) => `<label class="rf-field">${label} (${unit})<input type="number" min="0" step="any" data-nut="${key}" value="0" /></label>`
    ).join("");
    $("rfFoodGroups").innerHTML = FOOD_GROUP_FIELDS.map(
      ([key, label]) => `<label class="rf-field">${label}<input type="number" min="0" step="any" data-fg="${key}" value="0" /></label>`
    ).join("");
  }

  function addIngredientRow(ing) {
    ing = ing || { name: "", qty: "", unit: "", prep: null };
    const row = document.createElement("div");
    row.className = "ing-row";
    row.innerHTML = `
      <input type="text" class="ing-name" placeholder="e.g. chicken breast" aria-label="Ingredient" />
      <input type="text" class="ing-qty" placeholder="1.5" aria-label="Quantity" />
      <input type="text" class="ing-unit" placeholder="lb" aria-label="Unit" />
      <select class="ing-prep" aria-label="Prep type">
        <option value="none">None</option>
        <option value="chop">Chop</option>
        <option value="marinate">Marinate</option>
        <option value="thaw">Thaw</option>
      </select>
      <input type="number" class="ing-days" min="0" max="7" step="1" aria-label="Days ahead" />
      <button type="button" class="btn btn--icon" aria-label="Remove ingredient">✕</button>`;
    row.querySelector(".ing-name").value = ing.name || "";
    row.querySelector(".ing-qty").value = ing.qty == null ? "" : ing.qty;
    row.querySelector(".ing-unit").value = ing.unit || "";
    const prepSel = row.querySelector(".ing-prep");
    const days = row.querySelector(".ing-days");
    prepSel.value = ing.prep ? ing.prep.type : "none";
    days.value = ing.prep ? ing.prep.leadDays || 0 : 0;
    prepSel.addEventListener("change", () => (days.value = PREP_DEFAULT_DAYS[prepSel.value] || 0));
    row.querySelector("button").addEventListener("click", () => row.remove());
    $("rfIngredients").appendChild(row);
  }

  function openDialog(recipe) {
    editingId = recipe ? recipe.id : null;
    $("recipeDialogTitle").textContent = recipe ? "Edit recipe" : "Add recipe";
    $("rfName").value = recipe ? recipe.name : "";
    $("rfUrl").value = recipe && recipe.source && recipe.source.url ? recipe.source.url : "";
    const protein = $("rfProtein");
    const tag = recipe ? recipe.proteinTag : "other";
    protein.value = [...protein.options].some((o) => o.value === tag) ? tag : "other";
    $("rfToddler").value = String(recipe ? recipe.toddlerAppeal || 3 : 3);
    $("rfRating").value = recipe ? recipe.rating || "" : "";
    pendingPhoto = undefined;
    $("rfPhotoFile").value = "";
    $("rfPhotoHint").textContent = "";
    showPhotoPreview(recipe ? MP.photoSrc(recipe) : "");
    $("rfPrep").value = recipe ? recipe.prepTimeMin : 15;
    $("rfCook").value = recipe ? recipe.cookTimeMin : 30;
    $("rfServings").value = recipe ? recipe.servings : 6;
    $("rfInstructions").value = recipe ? recipe.instructions.join("\n") : "";
    $("rfNotes").value = recipe ? recipe.notes || "" : "";
    const nut = recipe ? recipe.nutritionPerServing || {} : {};
    document.querySelectorAll("[data-nut]").forEach((el) => (el.value = nut[el.dataset.nut] || 0));
    const fg = recipe ? recipe.foodGroupsPerServing || {} : {};
    document.querySelectorAll("[data-fg]").forEach((el) => (el.value = fg[el.dataset.fg] || 0));
    $("rfIngredients").innerHTML = "";
    (recipe ? recipe.ingredients : [null, null, null]).forEach(addIngredientRow);
    $("recipeDialog").showModal();
  }

  async function saveFromForm() {
    const name = $("rfName").value.trim();
    if (!name) return;
    const urlRaw = $("rfUrl").value.trim();
    let source = { label: "my library", url: null };
    if (/^https?:\/\//i.test(urlRaw)) {
      let host = "my library";
      try {
        host = new URL(urlRaw).hostname.replace(/^www\./, "");
      } catch (e) {
        /* keep default */
      }
      source = { label: host, url: urlRaw };
    }

    const ingredients = [...document.querySelectorAll("#rfIngredients .ing-row")]
      .map((row) => {
        const qtyRaw = row.querySelector(".ing-qty").value.trim();
        const prepType = row.querySelector(".ing-prep").value;
        return {
          name: row.querySelector(".ing-name").value.trim(),
          qty: qtyRaw === "" ? null : isNaN(Number(qtyRaw)) ? qtyRaw : Number(qtyRaw),
          unit: row.querySelector(".ing-unit").value.trim(),
          prep: prepType === "none" ? null : { type: prepType, leadDays: Number(row.querySelector(".ing-days").value) || 0 },
        };
      })
      .filter((i) => i.name);

    const nutritionPerServing = {};
    document.querySelectorAll("[data-nut]").forEach((el) => (nutritionPerServing[el.dataset.nut] = Number(el.value) || 0));
    const foodGroupsPerServing = {};
    document.querySelectorAll("[data-fg]").forEach((el) => (foodGroupsPerServing[el.dataset.fg] = Number(el.value) || 0));

    const existing = MP.recipes.find((r) => r.id === editingId);
    const recipe = Object.assign({ cuisineTags: [], nutritionEstimated: false }, existing, {
      id: existing ? existing.id : "my-" + slugify(name) + "-" + Math.random().toString(36).slice(2, 7),
      name,
      source,
      proteinTag: $("rfProtein").value,
      prepTimeMin: Number($("rfPrep").value) || 0,
      cookTimeMin: Number($("rfCook").value) || 0,
      servings: Number($("rfServings").value) || 1,
      toddlerAppeal: Number($("rfToddler").value) || 3,
      rating: $("rfRating").value,
      nutritionPerServing,
      foodGroupsPerServing,
      ingredients: ingredients.length ? ingredients : [{ name: "(no ingredients listed)", qty: null, unit: "", prep: null }],
      instructions: $("rfInstructions").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      notes: $("rfNotes").value.trim(),
    });
    if (!recipe.instructions.length) recipe.instructions = ["(no instructions listed)"];

    try {
      if (pendingPhoto instanceof Blob) await MP.uploadPhoto(recipe, pendingPhoto);
      else if (pendingPhoto === null && recipe.photo) await MP.removePhoto(recipe);
    } catch (e) {
      $("rfPhotoHint").textContent = "Couldn't save the photo: " + e.message;
      return; // keep the dialog open so nothing is lost
    }

    if (existing) MP.recipes = MP.recipes.map((r) => (r.id === existing.id ? recipe : r));
    else MP.recipes.push(recipe);
    MP.saveRecipes();
    render();
    $("recipeDialog").close();
  }

  /* ---------------------------------------------------------------------
     Import: URL (via the local server's fetch proxy) and PDF / DOCX
  --------------------------------------------------------------------- */
  const plain = (s) => new DOMParser().parseFromString(String(s == null ? "" : s), "text/html").body.textContent.replace(/\s+/g, " ").trim();
  const num = (v) => {
    const m = /\d+(?:\.\d+)?/.exec(String(v == null ? "" : v));
    return m ? parseFloat(m[0]) : null;
  };

  function parseISODuration(str) {
    const m = /^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(str || "");
    return m ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : null;
  }

  function parseIngredientLine(line) {
    const clean = plain(line).replace(/^[•\-*]\s*/, "");
    const m = /^((?:\d+\s+)?\d+\/\d+|\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?|\d*\s*[¼½¾⅓⅔])?\s*(cups?|tbsp|tablespoons?|tsp|teaspoons?|oz|ounces?|lbs?|pounds?|g|grams?|kg|ml|cloves?|slices?|cans?|stalks?|bunch(?:es)?|pinch(?:es)?|each)?\b\.?\s*(.*)$/i.exec(clean);
    if (!m || !m[3]) return { name: clean, qty: null, unit: "", prep: null };
    return { name: m[3].trim(), qty: m[1] ? m[1].trim() : null, unit: m[2] || "", prep: null };
  }
  function guessProtein(ingredients) {
    const t = ingredients.map((i) => i.name).join(" ").toLowerCase();
    for (const [tag, re] of [["chicken", /chicken/], ["beef", /beef|steak/], ["pork", /pork|bacon|\bham\b|sausage/], ["turkey", /turkey/], ["seafood", /salmon|shrimp|\bfish\b|tuna|\bcod\b|tilapia/]]) {
      if (re.test(t)) return tag;
    }
    return /tofu|lentil|chickpea|beans?\b|egg/.test(t) ? "vegetarian" : "other";
  }

  function buildImported({ name, url, label, ingredients, instructions, prepTimeMin, cookTimeMin, servings, nutrition }) {
    const defaults = { calories: 400, proteinG: 20, fiberG: 3, calciumMg: 100, ironMg: 2, vitaminCMg: 5, sodiumMg: 500, addedSugarG: 3 };
    const hasNutrition = nutrition && nutrition.calories != null && nutrition.proteinG != null;
    const nutritionPerServing = {};
    Object.keys(defaults).forEach((k) => (nutritionPerServing[k] = nutrition && nutrition[k] != null ? nutrition[k] : defaults[k]));
    return {
      id: "imp-" + slugify(name) + "-" + Math.random().toString(36).slice(2, 7),
      name,
      source: { label, url },
      proteinTag: guessProtein(ingredients),
      cuisineTags: [],
      prepTimeMin: prepTimeMin ?? 15,
      cookTimeMin: cookTimeMin ?? 30,
      servings: servings || 6,
      toddlerAppeal: 3,
      nutritionEstimated: !hasNutrition,
      nutritionPerServing,
      foodGroupsPerServing: { fruit: 0.25, vegetable: 0.75, grain: 0.5, protein: 1, dairy: 0.25 },
      ingredients: ingredients.length ? ingredients : [{ name: "(see original recipe)", qty: null, unit: "", prep: null }],
      instructions: instructions.length ? instructions : ["(see original recipe)"],
    };
  }

  function flattenInstructions(x) {
    if (!x) return [];
    if (typeof x === "string") return x.split(/\r?\n/).map(plain).filter(Boolean);
    if (Array.isArray(x)) return x.flatMap(flattenInstructions);
    if (x.itemListElement) return flattenInstructions(x.itemListElement);
    return x.text ? [plain(x.text)] : x.name ? [plain(x.name)] : [];
  }

  function recipeFromJsonLd(node, url) {
    const nu = node.nutrition || {};
    let prep = parseISODuration(node.prepTime);
    let cook = parseISODuration(node.cookTime);
    const total = parseISODuration(node.totalTime);
    if (prep == null && cook == null && total != null) {
      prep = Math.min(15, total);
      cook = total - prep;
    }
    const y = Array.isArray(node.recipeYield) ? node.recipeYield[0] : node.recipeYield;
    let host = "imported";
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch (e) {
      /* keep default */
    }
    return buildImported({
      name: plain(node.name) || "Imported recipe",
      url,
      label: host,
      ingredients: (node.recipeIngredient || []).map(parseIngredientLine),
      instructions: flattenInstructions(node.recipeInstructions),
      prepTimeMin: prep,
      cookTimeMin: cook,
      servings: num(y),
      nutrition: {
        calories: num(nu.calories), proteinG: num(nu.proteinContent), fiberG: num(nu.fiberContent),
        calciumMg: num(nu.calciumContent), ironMg: num(nu.ironContent), vitaminCMg: num(nu.vitaminCContent),
        sodiumMg: num(nu.sodiumContent), addedSugarG: num(nu.sugarContent),
      },
    });
  }

  function recipeFromText(text, title, label) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const ingIdx = lines.findIndex((l) => /^ingredients?\b/i.test(l));
    const insIdx = lines.findIndex((l) => /^(instructions?|directions?|method|steps)\b/i.test(l));
    let ing = [], ins = [];
    if (ingIdx !== -1) ing = lines.slice(ingIdx + 1, insIdx > ingIdx ? insIdx : ingIdx + 26);
    if (insIdx !== -1) ins = lines.slice(insIdx + 1, insIdx + 26);
    if (!ing.length && !ins.length) {
      lines.slice(0, 60).forEach((l) => {
        if (/^[\d¼½¾⅓⅔.\-•]/.test(l) && l.length < 80) ing.push(l);
        else if (l.length > 20) ins.push(l);
      });
    }
    return buildImported({ name: title, url: null, label, ingredients: ing.slice(0, 30).map(parseIngredientLine), instructions: ins.slice(0, 25), nutrition: null });
  }

  async function fetchHtml(url) {
    if (MP.online) {
      const res = await fetch("/api/fetch?url=" + encodeURIComponent(url));
      if (!res.ok) throw new Error((await res.text()) || "HTTP " + res.status);
      return res.text();
    }
    const res = await fetch(url, { mode: "cors" }); // offline fallback; usually blocked by CORS
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.text();
  }

  // The schema.org Recipe object a page publishes for search engines, if any.
  function jsonLdRecipeNode(doc) {
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        const items = Array.isArray(data) ? data : data["@graph"] || [data];
        const node = items.find((it) => it && (it["@type"] === "Recipe" || (Array.isArray(it["@type"]) && it["@type"].includes("Recipe"))));
        if (node) return node;
      } catch (e) {
        /* try the next block */
      }
    }
    return null;
  }

  // The page's main photo: the recipe's own image, else the social-share image.
  function extractImageUrl(doc, node, pageUrl) {
    const candidates = [];
    const img = node && node.image;
    const first = Array.isArray(img) ? img[0] : img;
    if (first) candidates.push(typeof first === "string" ? first : first.url);
    ["og:image", "twitter:image"].forEach((p) => {
      const m = doc.querySelector(`meta[property="${p}"], meta[name="${p}"]`);
      if (m) candidates.push(m.getAttribute("content"));
    });
    for (const c of candidates) {
      if (!c) continue;
      try {
        const abs = new URL(c, pageUrl).href;
        if (MP.safeUrl(abs)) return abs;
      } catch (e) {
        /* try the next candidate */
      }
    }
    return null;
  }

  async function importUrl(url) {
    if (!/^https?:\/\//i.test(url)) throw new Error("Enter a full link starting with http:// or https://");
    const doc = new DOMParser().parseFromString(await fetchHtml(url), "text/html");
    const node = jsonLdRecipeNode(doc);
    if (!node) throw new Error("No recipe data found on that page. Try “+ Add recipe” instead.");
    const recipe = recipeFromJsonLd(node, url);
    recipe._imageUrl = extractImageUrl(doc, node, url);
    return recipe;
  }

  // Downloads photos for recipes that have a source page but no picture yet.
  async function findMissingPhotos() {
    const targets = MP.recipes.filter((r) => !r.photo && MP.safeUrl(r.source && r.source.url));
    const status = $("photoStatus");
    $("findPhotosBtn").disabled = true;
    let ok = 0, failed = 0;
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i];
      status.textContent = `Finding photos… ${i + 1} of ${targets.length} (${r.name})`;
      try {
        const doc = new DOMParser().parseFromString(await fetchHtml(r.source.url), "text/html");
        const imageUrl = extractImageUrl(doc, jsonLdRecipeNode(doc), r.source.url);
        if (!imageUrl) throw new Error("no image on page");
        await MP.photoFromUrl(r, imageUrl);
        ok++;
      } catch (e) {
        failed++;
      }
    }
    await MP.saveRecipes();
    render();
    status.textContent = `Added ${ok} photo${ok === 1 ? "" : "s"}` + (failed ? `; ${failed} couldn't be found (add those by hand with Edit).` : ".");
  }

  // Third-party readers are pinned to an exact version AND file hash (Subresource Integrity),
  // so a tampered or swapped CDN file simply refuses to load.
  const CDN = "https://cdnjs.cloudflare.com/ajax/libs/";
  const LIBS = {
    pdf: { src: CDN + "pdf.js/3.11.174/pdf.min.js", integrity: "sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e" },
    pdfWorker: { src: CDN + "pdf.js/3.11.174/pdf.worker.min.js", integrity: "sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2" },
  };
  const scriptCache = {};
  function loadScript({ src, integrity }) {
    if (!scriptCache[src]) {
      scriptCache[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.integrity = integrity;
        s.crossOrigin = "anonymous";
        s.referrerPolicy = "no-referrer";
        s.onload = resolve;
        s.onerror = () => reject(new Error("Couldn't load the file reader (needs internet access)."));
        document.head.appendChild(s);
      });
    }
    return scriptCache[src];
  }

  async function importFile(file) {
    const ext = file.name.split(".").pop().toLowerCase();
    const title = file.name.replace(/\.[^.]+$/, "");
    if (ext === "pdf") {
      await loadScript(LIBS.pdf);
      await loadScript(LIBS.pdfWorker); // defines window.pdfjsWorker, so pdf.js runs it from this verified copy
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker.src;
      // isEvalSupported:false blocks the arbitrary-code-in-a-malicious-PDF bug (CVE-2024-4367) in this pdf.js version.
      const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false, disableFontFace: true }).promise;
      let text = "";
      for (let p = 1; p <= pdf.numPages; p++) {
        const content = await (await pdf.getPage(p)).getTextContent();
        // Rebuild line breaks from item positions so headings and lines survive.
        let lastY = null;
        content.items.forEach((it) => {
          const y = it.transform[5];
          text += (lastY !== null && Math.abs(y - lastY) > 2 ? "\n" : " ") + it.str;
          lastY = y;
        });
        text += "\n";
      }
      return recipeFromText(text, title, "your PDF");
    }
    throw new Error("Only PDF files can be read. Use “+ Add recipe” for photos.");
  }

  async function runImport() {
    const urls = $("importUrls").value.split(/\r?\n/).map((u) => u.trim()).filter(Boolean);
    const files = [...$("importFiles").files];
    const status = $("importStatus");
    const results = $("importResults");
    if (!urls.length && !files.length) {
      status.textContent = "Paste at least one link or choose a file first.";
      return;
    }
    $("importBtn").disabled = true;
    results.innerHTML = "";
    const log = (ok, text) => results.insertAdjacentHTML("beforeend", `<li class="${ok ? "is-ok" : "is-fail"}">${ok ? "✓" : "✗"} ${escapeHtml(text)}</li>`);

    let added = 0;
    const jobs = [...urls.map((u) => ({ label: u, run: () => importUrl(u), url: u })), ...files.map((f) => ({ label: f.name, run: () => importFile(f) }))];
    for (const job of jobs) {
      status.textContent = "Reading " + job.label + "…";
      try {
        if (job.url && MP.recipes.some((r) => r.source && r.source.url === job.url)) {
          log(false, job.label + " — already in your library.");
          continue;
        }
        const recipe = await job.run();
        let photoNote = "";
        if (recipe._imageUrl) {
          try {
            await MP.photoFromUrl(recipe, recipe._imageUrl);
            photoNote = ", photo saved";
          } catch (e) {
            photoNote = ", no photo";
          }
        }
        delete recipe._imageUrl;
        MP.recipes.push(recipe);
        added++;
        log(true, `Added “${recipe.name}” (${recipe.ingredients.length} ingredients, ${recipe.instructions.length} steps${photoNote}).`);
      } catch (e) {
        log(false, job.label + " — " + e.message);
      }
    }
    if (added) {
      await MP.saveRecipes();
      render();
      $("importUrls").value = "";
      $("importFiles").value = "";
    }
    status.textContent = added ? `Imported ${added} recipe${added === 1 ? "" : "s"}. Review each one and correct anything that looks off.` : "Nothing was imported.";
    $("importBtn").disabled = false;
  }

  /* ---------------------------------------------------------------------
     Init
  --------------------------------------------------------------------- */
  async function init() {
    MP.renderHeader("recipes");
    await MP.load();
    buildDialogFields();
    if (MP.mode === "local") {
      $("importUrlBox").hidden = true;
      $("importLocalNote").hidden = false;
    }
    render();

    $("searchBox").addEventListener("input", render);
    $("ratingFilter").addEventListener("change", render);
    $("addRecipeBtn").addEventListener("click", () => openDialog(null));
    $("rfAddIngredient").addEventListener("click", () => addIngredientRow());
    $("rfPhotoFile").addEventListener("change", (e) => chooseDialogPhoto(e.target.files[0]));
    $("rfPhotoRemove").addEventListener("click", () => {
      pendingPhoto = null;
      $("rfPhotoFile").value = "";
      $("rfPhotoHint").textContent = "Removed when you save the recipe.";
      showPhotoPreview("");
    });
    $("findPhotosBtn").addEventListener("click", findMissingPhotos);
    $("rfCancel").addEventListener("click", () => $("recipeDialog").close());
    $("recipeForm").addEventListener("submit", (e) => {
      e.preventDefault();
      saveFromForm();
    });
    $("restoreStartersBtn").addEventListener("click", () => {
      RECIPE_LIBRARY.filter((s) => !MP.recipes.some((r) => r.id === s.id)).forEach((s) => MP.recipes.push(MP.clone(s)));
      MP.saveRecipes();
      render();
    });
    $("importBtn").addEventListener("click", runImport);
  }
  document.addEventListener("DOMContentLoaded", init);
})();
