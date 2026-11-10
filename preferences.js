/* ==========================================================================
   Preferences page: nutrition targets, time limits, ingredients to avoid.
   Everything auto-saves. Depends on data.js and common.js.
   ========================================================================== */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  function setSaveState(text, isError) {
    const el = $("saveState");
    el.textContent = text;
    el.classList.toggle("is-error", !!isError);
  }

  /* ---------------------------------------------------------------------
     Rendering from settings
  --------------------------------------------------------------------- */
  function renderFoodGroups() {
    const wrap = $("foodGroupInputs");
    wrap.innerHTML = "";
    DEFAULT_FOOD_GROUP_TARGETS.forEach((fg) => {
      const label = document.createElement("label");
      label.className = "inline-field";
      label.innerHTML = `<span>${MP.escapeHtml(fg.label)} <span class="hint">(${MP.escapeHtml(fg.unit)})</span></span>`;
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "any";
      input.dataset.fg = fg.key;
      input.value = MP.settings.foodGroupTargets[fg.key];
      label.appendChild(input);
      wrap.appendChild(label);
    });
  }

  function addNutrientRow(n) {
    const row = $("nutrientRowTemplate").content.firstElementChild.cloneNode(true);
    row.querySelector(".nutrient-name").value = n.name || "";
    row.querySelector(".nutrient-amount").value = n.amount != null ? n.amount : "";
    row.querySelector(".nutrient-unit").value = n.unit || "g";
    row.querySelector(".nutrient-period").value = n.period || "day";
    row.querySelector(".remove-nutrient-btn").addEventListener("click", () => {
      row.remove();
      save();
    });
    $("nutrientInputs").appendChild(row);
    return row;
  }

  function renderAll() {
    renderFoodGroups();
    $("nutrientInputs").innerHTML = "";
    MP.settings.nutrientTargets.forEach(addNutrientRow);
    $("maxPrepTime").value = MP.settings.maxPrepTime;
    $("maxCookTime").value = MP.settings.maxCookTime;
    $("avoidIngredients").value = MP.settings.avoidText;
  }

  /* ---------------------------------------------------------------------
     Saving
  --------------------------------------------------------------------- */
  function save() {
    const foodGroupTargets = {};
    document.querySelectorAll("[data-fg]").forEach((el) => (foodGroupTargets[el.dataset.fg] = Number(el.value) || 0));
    const nutrientTargets = [...document.querySelectorAll("#nutrientInputs .repeatable-row")]
      .map((row) => ({
        name: row.querySelector(".nutrient-name").value.trim(),
        amount: Number(row.querySelector(".nutrient-amount").value) || 0,
        unit: row.querySelector(".nutrient-unit").value,
        period: row.querySelector(".nutrient-period").value,
      }))
      .filter((n) => n.name);

    setSaveState("Saving…");
    MP.updateSettings({
      foodGroupTargets,
      nutrientTargets,
      maxPrepTime: Number($("maxPrepTime").value) || 30,
      maxCookTime: Number($("maxCookTime").value) || 60,
      avoidText: $("avoidIngredients").value,
    });
    if (MP.serverDown) setSaveState("Not saved — server offline", true);
  }

  /* ---------------------------------------------------------------------
     Back up & restore (move data between the laptop and the phone app)
  --------------------------------------------------------------------- */
  function setBackupStatus(text, isError) {
    const el = $("backupStatus");
    el.textContent = text;
    el.classList.toggle("is-error", !!isError);
  }

  async function saveBackup() {
    const btn = $("exportBtn");
    btn.disabled = true;
    setBackupStatus("Preparing the backup…");
    try {
      const text = await MP.exportBackup();
      const name = "meal-planner-backup-" + MP.toISODate(MP.today()) + ".json";
      const file = new File([text], name, { type: "application/json" });
      // On a phone this opens the share sheet (Files, Messages, email, ...); elsewhere it downloads.
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: "Weekly Meal Planner backup" });
          setBackupStatus("Backup shared.");
          return;
        } catch (e) {
          if (e && e.name === "AbortError") {
            setBackupStatus("");
            return;
          }
        }
      }
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setBackupStatus(`Backup saved as ${name} (${MP.recipes.length} recipes, ${(text.length / 1048576).toFixed(1)} MB).`);
    } catch (e) {
      setBackupStatus("Couldn't create the backup: " + e.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function restoreBackup() {
    const file = $("restoreFile").files[0];
    if (!file) {
      setBackupStatus("Choose a backup file first.", true);
      return;
    }
    if (file.size > 60 * 1048576) {
      setBackupStatus("That file is too large to be a backup.", true);
      return;
    }
    const mode = document.querySelector('input[name="restoreMode"]:checked').value;
    if (mode === "replace" && !confirm("Replace ALL recipes, photos, preferences and the plan on this device with the backup? This can't be undone.")) return;
    $("restoreBtn").disabled = true;
    setBackupStatus("Restoring…");
    try {
      const r = await MP.importBackup(await file.text(), mode);
      setBackupStatus(
        `Restored: ${r.added} recipe${r.added === 1 ? "" : "s"} added (${r.photos} with photos)` +
          (r.kept ? `; ${r.kept} you already had were left as they are.` : r.replaced ? ", plus your preferences and plan." : ".") + " Reloading…"
      );
      setTimeout(() => location.reload(), 1500);
    } catch (e) {
      setBackupStatus(e.message, true);
      $("restoreBtn").disabled = false;
    }
  }

  function initBackup() {
    $("backupIntro").textContent =
      MP.mode === "local"
        ? "Your recipes, photos and plan are stored only on this phone. Download a backup now and then, and use Restore to bring in recipes from your laptop."
        : "Use this to move your recipes, photos and plan to the phone app, or to keep a safety copy. On the phone, open Preferences and use Restore.";
    $("exportBtn").addEventListener("click", saveBackup);
    $("restoreBtn").addEventListener("click", restoreBackup);
  }

  async function init() {
    MP.renderHeader("prefs");
    MP.onSaved = (ok) => setSaveState(ok ? "All changes saved ✓" : "Couldn't save — is the server running?", !ok);
    await MP.load();
    renderAll();
    if (MP.serverDown) setSaveState("Not saved — server offline", true);
    initBackup();

    document.querySelector("main").addEventListener("input", (e) => {
      if (e.target.closest("#foodGroupInputs, #nutrientInputs, #maxPrepTime, #maxCookTime, #avoidIngredients")) save();
    });
    document.querySelector("main").addEventListener("change", (e) => {
      if (e.target.closest("#nutrientInputs")) save();
    });
    $("addNutrientBtn").addEventListener("click", () => {
      addNutrientRow({ name: "", amount: "", unit: "g", period: "day" }).querySelector(".nutrient-name").focus();
    });
    $("resetBtn").addEventListener("click", () => {
      if (!confirm("Reset nutrition targets and time limits to the recommended defaults? Your avoid list is kept.")) return;
      const d = MP.defaultSettings();
      MP.updateSettings({
        foodGroupTargets: d.foodGroupTargets,
        nutrientTargets: d.nutrientTargets,
        maxPrepTime: d.maxPrepTime,
        maxCookTime: d.maxCookTime,
      });
      renderAll();
      setSaveState("Saving…");
    });
  }
  document.addEventListener("DOMContentLoaded", init);
})();
