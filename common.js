/* ==========================================================================
   Shared by all pages: storage, helpers, and the nav header.
   Depends on data.js (and config.js, which says which storage mode to use).
   Exposes window.MP.

   Two storage modes (set in config.js):
   - "server": the laptop's local server keeps everything in its data folder.
   - "local":  the phone app; everything lives on this device (localStorage for
               recipes/settings/plan, IndexedDB for photos) and works offline.
   ========================================================================== */
(function () {
  "use strict";
  const MP = (window.MP = {});
  MP.mode = (window.MP_CONFIG && window.MP_CONFIG.mode) === "local" ? "local" : "server";
  MP.online = false; // server mode: is the local server reachable?
  MP.serverDown = false; // server mode only: true when it isn't

  /* ---------------------------------------------------------------------
     Helpers
  --------------------------------------------------------------------- */
  MP.escapeHtml = (str) =>
    String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  MP.slugify = (s) => (s || "recipe").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
  MP.round1 = (n) => Math.round(n * 10) / 10;
  MP.starRating = (n) => "★".repeat(n) + "☆".repeat(5 - n);
  MP.clone = (o) => JSON.parse(JSON.stringify(o));

  // "Have we made this?" Stored on each recipe as recipe.rating ("" = not made yet).
  MP.RATINGS = [
    ["", "Not made yet"],
    ["ok", "Made it — OK"],
    ["good", "Made it — good"],
    ["great", "Made it — great"],
  ];
  MP.ratingSelect = (recipeId, value) => {
    value = ["ok", "good", "great"].includes(value) ? value : "";
    return `<select class="rating-select${value ? " is-" + value : ""}" data-rating="${MP.escapeHtml(recipeId)}" aria-label="Have we made this?">` +
      MP.RATINGS.map(([v, label]) => `<option value="${v}"${v === value ? " selected" : ""}>${label}</option>`).join("") +
      "</select>";
  };
  // Sets a recipe's rating and saves the library. Returns the recipe, or null if not found.
  MP.setRating = (recipeId, value) => {
    const recipe = MP.recipes.find((r) => r.id === recipeId);
    if (!recipe) return null;
    recipe.rating = value || "";
    MP.saveRecipes();
    return recipe;
  };

  // Only http(s) links are ever rendered as links.
  MP.safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : null);

  MP.today = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  };
  MP.addDays = (date, n) => {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  };
  MP.toISODate = (d) =>
    d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  MP.fromISODate = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  MP.formatDateShort = (d) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  MP.formatDateLong = (d) => d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  /* ---------------------------------------------------------------------
     Header / nav
  --------------------------------------------------------------------- */
  MP.renderHeader = function (active) {
    const links = [
      ["week", "This Week", "index.html"],
      ["recipes", "Recipes", "recipes.html"],
      ["prefs", "Preferences", "preferences.html"],
    ];
    const header = document.getElementById("appHeader");
    header.className = "app-header";
    header.innerHTML = `
      <div class="app-header__inner">
        <a class="app-header__brand" href="index.html">
          <span class="app-header__mark" aria-hidden="true">🍽️</span>
          <span class="app-header__title">Weekly Meal Planner</span>
        </a>
        <nav class="app-nav" aria-label="Main">
          ${links
            .map(
              ([key, label, href]) =>
                `<a class="app-nav__link${key === active ? " is-active" : ""}" href="${href}"${key === active ? ' aria-current="page"' : ""}>${label}</a>`
            )
            .join("")}
        </nav>
      </div>`;
  };

  MP.showBanner = function (message) {
    const el = document.getElementById("offlineBanner");
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
  };

  /* ---------------------------------------------------------------------
     Photos
       server mode: files in the server's data/photos, recipe.photo = "<id>.jpg?v=<ts>"
       local mode:  Blobs in IndexedDB keyed by recipe id; recipe.photo is just a marker
  --------------------------------------------------------------------- */
  const photoUrls = new Map(); // local mode: recipe id -> object URL

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const rq = indexedDB.open("mealplanner", 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore("photos");
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
  }
  async function idbRun(mode, fn) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("photos", mode);
      let request;
      try {
        request = fn(tx.objectStore("photos"));
      } catch (e) {
        reject(e);
        return;
      }
      tx.oncomplete = () => resolve(request && "result" in request ? request.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  const idbPut = (key, blob) => idbRun("readwrite", (s) => s.put(blob, key));
  const idbDelete = (key) => idbRun("readwrite", (s) => s.delete(key));
  const idbGet = (key) => idbRun("readonly", (s) => s.get(key));
  async function idbAll() {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("photos", "readonly");
      const store = tx.objectStore("photos");
      const keys = store.getAllKeys();
      const vals = store.getAll();
      tx.oncomplete = () => resolve(keys.result.map((k, i) => [k, vals.result[i]]));
      tx.onerror = () => reject(tx.error);
    });
  }
  function setPhotoUrl(id, blob) {
    if (photoUrls.has(id)) URL.revokeObjectURL(photoUrls.get(id));
    photoUrls.set(id, URL.createObjectURL(blob));
  }
  async function loadLocalPhotos() {
    try {
      (await idbAll()).forEach(([id, blob]) => blob instanceof Blob && setPhotoUrl(id, blob));
    } catch (e) {
      /* no IndexedDB (private browsing?): recipes just show without photos */
    }
  }

  MP.photoSrc = (recipe) => {
    if (!recipe || !recipe.photo) return "";
    if (MP.mode === "local") return photoUrls.get(recipe.id) || "";
    return /^[a-z0-9][a-z0-9-]{0,99}\.(jpg|png|webp)(\?v=\d+)?$/.test(String(recipe.photo)) ? "/photos/" + recipe.photo : "";
  };

  // Scales an image file down (max 1000px) and re-encodes as JPEG so photos stay small.
  MP.shrinkImage = async (file, maxDim = 1000) => {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (e) {
      throw new Error("Couldn't read that image. Try a JPEG or PNG.");
    }
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't process that image."))), "image/jpeg", 0.85)
    );
  };

  async function photoRequest(recipe, url, options) {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error((await res.text()) || "HTTP " + res.status);
    const { file } = await res.json();
    recipe.photo = file + "?v=" + Date.now();
    return recipe;
  }
  // These change the recipe object in memory; callers then call MP.saveRecipes().
  MP.uploadPhoto = async (recipe, blob) => {
    if (MP.mode === "local") {
      await idbPut(recipe.id, blob);
      setPhotoUrl(recipe.id, blob);
      recipe.photo = recipe.id + ".jpg?v=" + Date.now();
      return recipe;
    }
    return photoRequest(recipe, "/api/photos/" + encodeURIComponent(recipe.id), { method: "PUT", headers: { "Content-Type": blob.type || "image/jpeg" }, body: blob });
  };
  MP.photoFromUrl = (recipe, imageUrl) =>
    MP.mode === "local"
      ? Promise.reject(new Error("Downloading photos from links needs the laptop version."))
      : photoRequest(recipe, "/api/photo-from-url?id=" + encodeURIComponent(recipe.id) + "&url=" + encodeURIComponent(imageUrl), { method: "PUT" });
  MP.removePhoto = async (recipe) => {
    try {
      if (MP.mode === "local") {
        await idbDelete(recipe.id);
        if (photoUrls.has(recipe.id)) URL.revokeObjectURL(photoUrls.get(recipe.id));
        photoUrls.delete(recipe.id);
      } else {
        await fetch("/api/photos/" + encodeURIComponent(recipe.id), { method: "DELETE" });
      }
    } catch (e) {
      /* the recipe stops pointing at it either way */
    }
    delete recipe.photo;
  };

  /* ---------------------------------------------------------------------
     Storage
  --------------------------------------------------------------------- */
  const OFFLINE_MSG =
    "Can't reach the local server, so your changes won't be saved. Start it with start.bat in the weekly-meal-planner folder and open http://localhost:8934/.";
  const SAVE_FAIL_MSG = "The last change couldn't be saved to the local server. Check that it's still running.";
  const LOCAL_FAIL_MSG = "This device couldn't store that change (storage may be full or blocked). Download a backup from Preferences.";

  function sessionGet(name, fallback) {
    try {
      const raw = sessionStorage.getItem("mealPlanner." + name);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function sessionSet(name, value) {
    try {
      sessionStorage.setItem("mealPlanner." + name, JSON.stringify(value));
    } catch (e) {
      /* storage unavailable */
    }
  }
  // Phone-app storage
  function lsGet(name, fallback) {
    try {
      const raw = localStorage.getItem("mealPlanner.local." + name);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function lsSet(name, value) {
    try {
      localStorage.setItem("mealPlanner.local." + name, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  async function apiGet(name) {
    try {
      const res = await fetch("/api/" + name, { cache: "no-store" });
      if (!res.ok) return { ok: false };
      return { ok: true, data: await res.json() };
    } catch (e) {
      return { ok: false };
    }
  }
  async function apiPut(name, data, keepalive) {
    try {
      const res = await fetch("/api/" + name, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        keepalive: !!keepalive,
      });
      return res.ok;
    } catch (e) {
      return false;
    }
  }

  MP.onSaved = null; // pages can set (ok:boolean) => void

  MP.defaultSettings = () => ({
    keptIds: [],
    dismissedIds: [],
    foodGroupTargets: Object.fromEntries(DEFAULT_FOOD_GROUP_TARGETS.map((t) => [t.key, t.value])),
    nutrientTargets: DEFAULT_NUTRIENT_TARGETS.map((t) => ({ ...t })),
    avoidText: "",
    storeByItem: {}, // shopping list split: ingredient name (lowercase) -> "costco" | "cub"
    maxPrepTime: 30,
    maxCookTime: 60,
  });

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (!(location.protocol === "https:" || location.hostname === "localhost")) return;
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  MP.load = async function () {
    let recipes, settings, plan;
    if (MP.mode === "local") {
      recipes = lsGet("recipes", null);
      settings = lsGet("settings", null);
      plan = lsGet("plan", null);
      await loadLocalPhotos();
      try {
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); // ask the browser not to evict our data
      } catch (e) {
        /* best effort */
      }
      registerServiceWorker();
    } else {
      const [r, s, p] = await Promise.all([apiGet("recipes"), apiGet("settings"), apiGet("plan")]);
      MP.online = r.ok && s.ok && p.ok;
      MP.serverDown = !MP.online;
      if (MP.online) {
        recipes = r.data;
        settings = s.data;
        plan = p.data;
      } else {
        recipes = sessionGet("recipes", null);
        settings = sessionGet("settings", null);
        plan = sessionGet("plan", null);
        MP.showBanner(OFFLINE_MSG);
      }
    }

    MP.settings = Object.assign(MP.defaultSettings(), settings && typeof settings === "object" ? settings : {});
    MP.settings.maxPrepTime = Number(MP.settings.maxPrepTime) || 30;
    MP.settings.maxCookTime = Number(MP.settings.maxCookTime) || 60;
    // plan = { weeks: { "<Friday ISO date>": { recipeIds, checks } }, history: [{ startDate, recipeIds }] }
    MP.plan = Object.assign({ weeks: {}, history: [] }, plan && typeof plan === "object" ? plan : {});

    if (Array.isArray(recipes)) {
      MP.recipes = recipes;
    } else {
      // First run: seed the library with the starter recipes (none in the phone app).
      MP.recipes = MP.clone(RECIPE_LIBRARY);
      await MP.saveRecipes();
    }

    // Older versions stored a per-ingredient "costco" flag; shopping stores are now chosen on the list.
    let stripped = false;
    MP.recipes.forEach((r) =>
      (r.ingredients || []).forEach((i) => {
        if ("costco" in i) {
          delete i.costco;
          stripped = true;
        }
      })
    );
    if (stripped) await MP.saveRecipes();
  };

  MP.saveRecipes = async function () {
    if (MP.mode === "local") {
      const ok = lsSet("recipes", MP.recipes);
      MP.showBanner(ok ? "" : LOCAL_FAIL_MSG);
      if (MP.onSaved) MP.onSaved(ok);
      return ok;
    }
    if (!MP.online) {
      sessionSet("recipes", MP.recipes);
      return true;
    }
    const ok = await apiPut("recipes", MP.recipes);
    MP.showBanner(ok ? "" : SAVE_FAIL_MSG);
    if (MP.onSaved) MP.onSaved(ok);
    return ok;
  };

  // Keyed-patch updater: applies the patch locally at once, then (server mode, debounced)
  // re-reads the file and writes it back with just the patched keys replaced,
  // so two open tabs don't overwrite each other's unrelated changes.
  const updaters = [];
  function makeUpdater(name, getObj) {
    let pending = {};
    let timer = null;

    async function flush() {
      const patch = pending;
      pending = {};
      const latest = await apiGet(name);
      const base = latest.ok && latest.data && typeof latest.data === "object" ? latest.data : getObj();
      const ok = await apiPut(name, Object.assign({}, base, patch));
      MP.showBanner(ok ? "" : SAVE_FAIL_MSG);
      if (MP.onSaved) MP.onSaved(ok);
    }
    function flushOnLeave() {
      if (MP.mode === "local" || !Object.keys(pending).length || !MP.online) return;
      clearTimeout(timer);
      pending = {};
      apiPut(name, getObj(), true);
    }
    updaters.push(flushOnLeave);

    return function update(patch) {
      Object.assign(getObj(), patch);
      if (MP.mode === "local") {
        const ok = lsSet(name, getObj());
        MP.showBanner(ok ? "" : LOCAL_FAIL_MSG);
        if (MP.onSaved) MP.onSaved(ok);
        return;
      }
      if (!MP.online) {
        sessionSet(name, getObj());
        return;
      }
      Object.assign(pending, patch);
      clearTimeout(timer);
      timer = setTimeout(flush, 300);
    };
  }
  MP.updateSettings = makeUpdater("settings", () => MP.settings);
  MP.updatePlan = makeUpdater("plan", () => MP.plan);
  window.addEventListener("pagehide", () => updaters.forEach((f) => f()));

  /* ---------------------------------------------------------------------
     Backup & restore (moves data between the laptop and the phone app)
  --------------------------------------------------------------------- */
  const BACKUP_FORMAT = "weekly-meal-planner-backup";
  const ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
  const str = (v, max = 300) => String(v == null ? "" : v).slice(0, max);
  const num = (v, d = 0) => (v !== "" && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
  const NUT_KEYS = ["calories", "proteinG", "fiberG", "calciumMg", "ironMg", "vitaminCMg", "sodiumMg", "addedSugarG"];
  const FG_KEYS = ["fruit", "vegetable", "grain", "protein", "dairy"];

  // Builds a clean recipe from untrusted data: known fields only, bounded sizes, valid types.
  MP.sanitizeRecipe = (r) => {
    if (!r || typeof r !== "object" || !ID_RE.test(String(r.id || "")) || !str(r.name).trim()) return null;
    const ingredients = (Array.isArray(r.ingredients) ? r.ingredients : [])
      .slice(0, 80)
      .map((i) => {
        if (!i || typeof i !== "object" || !str(i.name, 160).trim()) return null;
        const prep =
          i.prep && ["chop", "marinate", "thaw"].includes(i.prep.type)
            ? { type: i.prep.type, leadDays: Math.max(0, Math.min(7, Math.round(num(i.prep.leadDays)))) }
            : null;
        const qty = i.qty == null || i.qty === "" ? null : typeof i.qty === "number" ? i.qty : str(i.qty, 20);
        return { name: str(i.name, 160).trim(), qty, unit: str(i.unit, 40), prep };
      })
      .filter(Boolean);
    const nut = {};
    NUT_KEYS.forEach((k) => (nut[k] = num((r.nutritionPerServing || {})[k])));
    const fg = {};
    FG_KEYS.forEach((k) => (fg[k] = num((r.foodGroupsPerServing || {})[k])));
    const source =
      r.source && typeof r.source === "object"
        ? { label: str(r.source.label, 60), url: MP.safeUrl(r.source.url) ? str(r.source.url, 500) : null }
        : { label: "imported", url: null };
    const out = {
      id: r.id,
      name: str(r.name, 120).trim(),
      source,
      proteinTag: str(r.proteinTag, 20) || "other",
      cuisineTags: [],
      prepTimeMin: Math.max(0, num(r.prepTimeMin)),
      cookTimeMin: Math.max(0, num(r.cookTimeMin)),
      servings: Math.max(1, num(r.servings, 1)),
      toddlerAppeal: Math.min(5, Math.max(1, Math.round(num(r.toddlerAppeal, 3)))),
      rating: ["ok", "good", "great"].includes(r.rating) ? r.rating : "",
      nutritionEstimated: !!r.nutritionEstimated,
      nutritionPerServing: nut,
      foodGroupsPerServing: fg,
      ingredients: ingredients.length ? ingredients : [{ name: "(no ingredients listed)", qty: null, unit: "", prep: null }],
      instructions: (Array.isArray(r.instructions) ? r.instructions : []).slice(0, 60).map((s) => str(s, 1500).trim()).filter(Boolean),
    };
    if (!out.instructions.length) out.instructions = ["(no instructions listed)"];
    if (typeof r.notes === "string" && r.notes.trim()) out.notes = str(r.notes, 2000).trim();
    return out;
  };

  function sanitizeSettings(s) {
    const d = MP.defaultSettings();
    if (!s || typeof s !== "object") return d;
    const idList = (a) => (Array.isArray(a) ? a.filter((x) => ID_RE.test(String(x))).slice(0, 500) : []);
    const fg = {};
    FG_KEYS.forEach((k) => (fg[k] = num((s.foodGroupTargets || {})[k], d.foodGroupTargets[k])));
    const nutrients = (Array.isArray(s.nutrientTargets) ? s.nutrientTargets : [])
      .slice(0, 40)
      .map((n) =>
        n && typeof n === "object" && str(n.name).trim()
          ? { name: str(n.name, 60).trim(), amount: Math.max(0, num(n.amount)), unit: ["g", "mg", "mcg", "kcal", "IU"].includes(n.unit) ? n.unit : "g", period: n.period === "week" ? "week" : "day" }
          : null
      )
      .filter(Boolean);
    const stores = {};
    Object.entries(s.storeByItem && typeof s.storeByItem === "object" ? s.storeByItem : {})
      .slice(0, 2000)
      .forEach(([k, v]) => {
        if (v === "costco" || v === "cub") stores[str(k, 160).toLowerCase()] = v;
      });
    return {
      keptIds: idList(s.keptIds),
      dismissedIds: idList(s.dismissedIds),
      foodGroupTargets: fg,
      nutrientTargets: nutrients.length ? nutrients : d.nutrientTargets,
      avoidText: str(s.avoidText, 2000),
      storeByItem: stores,
      maxPrepTime: num(s.maxPrepTime, 30) || 30,
      maxCookTime: num(s.maxCookTime, 60) || 60,
    };
  }

  function sanitizePlan(p) {
    const out = { weeks: {}, history: [] };
    if (!p || typeof p !== "object") return out;
    const isoRe = /^\d{4}-\d{2}-\d{2}$/;
    const ids = (a) => (Array.isArray(a) ? a.slice(0, 3).map((x) => (ID_RE.test(String(x)) ? x : null)) : []);
    const ticks = (o) => {
      const t = {};
      Object.keys(o && typeof o === "object" ? o : {})
        .slice(0, 1000)
        .forEach((k) => (t[str(k, 300)] = true));
      return t;
    };
    Object.entries(p.weeks && typeof p.weeks === "object" ? p.weeks : {})
      .slice(0, 12)
      .forEach(([iso, w]) => {
        if (isoRe.test(iso) && w && typeof w === "object") {
          out.weeks[iso] = { recipeIds: ids(w.recipeIds), checks: { shop: ticks((w.checks || {}).shop), prep: ticks((w.checks || {}).prep) } };
        }
      });
    out.history = (Array.isArray(p.history) ? p.history : [])
      .slice(0, 8)
      .filter((h) => h && isoRe.test(String(h.startDate)))
      .map((h) => ({ startDate: h.startDate, recipeIds: ids(h.recipeIds) }));
    return out;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  function dataUrlToBlob(url) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(url || ""));
    if (!m) return null;
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  }
  async function photoBlob(recipe) {
    if (MP.mode === "local") return idbGet(recipe.id);
    const res = await fetch(MP.photoSrc(recipe));
    return res.ok ? res.blob() : null;
  }

  // Returns the backup as JSON text (recipes + photos + settings + plan).
  MP.exportBackup = async () => {
    const photos = {};
    for (const r of MP.recipes) {
      if (!r.photo) continue;
      try {
        const blob = await photoBlob(r);
        if (blob) photos[r.id] = await blobToDataUrl(blob);
      } catch (e) {
        /* a missing photo shouldn't stop the backup */
      }
    }
    return JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), source: MP.mode, recipes: MP.recipes, settings: MP.settings, plan: MP.plan, photos });
  };

  // mode "merge": add recipes this device doesn't have, keep everything else.
  // mode "replace": make this device match the backup (recipes, photos, settings, plan).
  MP.importBackup = async (text, mode) => {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error("That file isn't a valid backup.");
    }
    if (!data || data.format !== BACKUP_FORMAT || !Array.isArray(data.recipes)) throw new Error("That file isn't a Weekly Meal Planner backup.");
    const incoming = data.recipes.map(MP.sanitizeRecipe).filter(Boolean);
    // A device with nothing on it has nothing to lose, so bring over the preferences and plan too.
    if (mode === "merge" && MP.recipes.length === 0 && Object.keys(MP.plan.weeks).length === 0) mode = "replace";
    const photos = data.photos && typeof data.photos === "object" ? data.photos : {};
    let toAdd;
    let kept = 0;
    if (mode === "replace") {
      for (const r of MP.recipes) if (r.photo) await MP.removePhoto(r);
      MP.recipes = [];
      toAdd = incoming;
    } else {
      const have = new Set(MP.recipes.map((r) => r.id));
      toAdd = incoming.filter((r) => !have.has(r.id));
      kept = incoming.length - toAdd.length;
    }
    let photoCount = 0;
    for (const r of toAdd) {
      const blob = dataUrlToBlob(photos[r.id]);
      if (blob) {
        try {
          await MP.uploadPhoto(r, blob);
          photoCount++;
        } catch (e) {
          /* keep the recipe even if its photo couldn't be stored */
        }
      }
      MP.recipes.push(r);
    }
    await MP.saveRecipes();
    if (mode === "replace") {
      MP.updateSettings(sanitizeSettings(data.settings));
      MP.updatePlan(sanitizePlan(data.plan));
    }
    return { added: toAdd.length, kept, photos: photoCount, replaced: mode === "replace" };
  };

  /* ---------------------------------------------------------------------
     Recipe eligibility (preferences applied to the library)
  --------------------------------------------------------------------- */
  MP.parseAvoid = (text) =>
    String(text || "")
      .split(/\r?\n|,/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

  MP.containsAvoided = (recipe, avoidList) =>
    avoidList.length > 0 &&
    recipe.ingredients.some((ing) => avoidList.some((a) => ing.name.toLowerCase().includes(a)));

  // Returns { pool, notice }. Avoided ingredients and dismissed recipes are
  // always excluded; the prep/cook limits are relaxed only if too few fit.
  MP.eligibleRecipes = function () {
    const s = MP.settings;
    const avoid = MP.parseAvoid(s.avoidText);
    const dismissed = new Set(s.dismissedIds);
    const base = MP.recipes.filter((r) => !dismissed.has(r.id) && !MP.containsAvoided(r, avoid));
    const fits = base.filter((r) => r.prepTimeMin <= s.maxPrepTime && r.cookTimeMin <= s.maxCookTime);
    if (fits.length >= 3 || base.length === 0) return { pool: fits.length ? fits : base, notice: null };

    const extra = base
      .filter((r) => !fits.includes(r))
      .sort((a, b) => a.prepTimeMin + a.cookTimeMin - (b.prepTimeMin + b.cookTimeMin))
      .slice(0, 3 - fits.length);
    return {
      pool: [...fits, ...extra],
      notice: `Only ${fits.length} of your recipes fit your time limits, so I added the quickest others to fill the week.`,
    };
  };
})();
