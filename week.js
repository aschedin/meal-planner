/* ==========================================================================
   This Week page. A week runs Friday to Thursday on a fixed template:
     Fri  leftovers + go shopping        Mon  leftovers + prep for tomorrow
     Sat  chop everything for the week   Tue  cook
     Sun  cook                           Wed  leftovers + prep for tomorrow
                                         Thu  cook
   Three recipes per week; each batch covers its cook day plus the next day.
   Depends on data.js and common.js.
   ========================================================================== */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const { escapeHtml, starRating, addDays, toISODate, fromISODate, formatDateShort, formatDateLong } = MP;

  const MEALS_PER_RECIPE = 2; // cook-day meal + next-day leftovers
  const COOK_DAYS = [2, 4, 6]; // day index from Friday: Sun, Tue, Thu
  const CHOP_DAY = 1; // Saturday
  const DAY_PLAN = [
    { role: "Leftovers · shopping day" },
    { role: "Chop day", caption: "Chop everything for the week" },
    { role: "Cook day", caption: "Before you cook" },
    { role: "Leftovers · prep day", caption: "Prep for tomorrow", empty: "Nothing to prep for tomorrow" },
    { role: "Cook day", caption: "Before you cook" },
    { role: "Leftovers · prep day", caption: "Prep for tomorrow", empty: "Nothing to prep for tomorrow" },
    { role: "Cook day", caption: "Before you cook" },
  ];

  let viewWeek = null; // ISO date of the Friday being viewed

  /* ---------------------------------------------------------------------
     Weeks
  --------------------------------------------------------------------- */
  const fridayOnOrBefore = (d) => addDays(d, -((d.getDay() - 5 + 7) % 7));
  const thisWeekISO = () => toISODate(fridayOnOrBefore(MP.today()));
  const nextWeekISO = () => toISODate(addDays(fridayOnOrBefore(MP.today()), 7));
  const weekRange = (iso) => {
    const s = fromISODate(iso);
    return formatDateShort(s) + " – " + formatDateShort(addDays(s, 6));
  };
  const weeks = () => MP.plan.weeks || {};
  const currentWeek = () => weeks()[viewWeek] || null;
  const recipesFor = (week) => COOK_DAYS.map((_, i) => MP.recipes.find((r) => r.id === week.recipeIds[i]) || null);

  // Older versions stored one plan under `current`; keep it only if it fits the Friday template.
  function migrateLegacyPlan() {
    const legacy = MP.plan.current;
    if (!legacy) return;
    const w = Object.assign({}, weeks());
    const history = (MP.plan.history || []).slice();
    if (legacy.startDate && fromISODate(legacy.startDate).getDay() === 5 && !w[legacy.startDate]) {
      w[legacy.startDate] = { recipeIds: legacy.recipeIds, checks: legacy.checks || { shop: {}, prep: {} } };
    } else if (legacy.recipeIds) {
      history.unshift({ startDate: legacy.startDate, recipeIds: legacy.recipeIds });
    }
    MP.updatePlan({ weeks: w, history: history.slice(0, 8), current: null });
  }

  /* ---------------------------------------------------------------------
     Nutrition metrics (used for picking recipes and for the summary)
  --------------------------------------------------------------------- */
  const NUTRIENT_FIELD_MAP = [
    [/protein/i, "proteinG", "g"],
    [/fib(er|re)/i, "fiberG", "g"],
    [/calcium/i, "calciumMg", "mg"],
    [/iron/i, "ironMg", "mg"],
    [/vitamin\s*c/i, "vitaminCMg", "mg"],
    [/sugar/i, "addedSugarG", "g"],
    [/sodium/i, "sodiumMg", "mg"],
    [/calor/i, "calories", "kcal"],
  ];
  function matchNutrientField(name) {
    for (const [re, field, nativeUnit] of NUTRIENT_FIELD_MAP) if (re.test(name)) return { field, nativeUnit };
    return null;
  }
  function convertUnit(value, from, to) {
    if (from === to) return value;
    const scale = { mcg: 1, mg: 1000, g: 1000000 };
    return scale[from] && scale[to] ? (value * scale[from]) / scale[to] : null;
  }

  // value(recipe) = what one batch contributes over the week; target = weekly target, same unit.
  function buildMetrics() {
    const s = MP.settings;
    const metrics = [];
    const untracked = [];
    DEFAULT_FOOD_GROUP_TARGETS.forEach((fg) => {
      const target = Number(s.foodGroupTargets[fg.key]);
      if (!(target > 0)) return;
      metrics.push({
        label: fg.label,
        unit: fg.unit.split("/")[0].trim(),
        target,
        limit: false,
        perDay: false,
        value: (r) => ((r.foodGroupsPerServing || {})[fg.key] || 0) * MEALS_PER_RECIPE,
      });
    });
    (s.nutrientTargets || []).forEach((n) => {
      if (!n || !n.name || !(Number(n.amount) > 0)) return;
      const map = matchNutrientField(n.name);
      if (!map || convertUnit(1, map.nativeUnit, n.unit) == null) {
        untracked.push(n.name);
        return;
      }
      metrics.push({
        label: n.name,
        unit: n.unit,
        target: n.period === "week" ? Number(n.amount) : Number(n.amount) * 7,
        limit: /limit|max|under|less/i.test(n.name),
        perDay: true,
        value: (r) => convertUnit(((r.nutritionPerServing || {})[map.field] || 0) * MEALS_PER_RECIPE, map.nativeUnit, n.unit),
      });
    });
    return { metrics, untracked };
  }

  /* ---------------------------------------------------------------------
     Picking recipes
  --------------------------------------------------------------------- */
  // Recipe-id sets from other weeks (and earlier versions of this one), nearest first.
  function recentSets(targetISO) {
    const t = fromISODate(targetISO).getTime();
    const sets = [];
    Object.entries(weeks()).forEach(([iso, w]) => {
      if (iso !== targetISO) sets.push({ iso, ids: w.recipeIds });
    });
    (MP.plan.history || []).forEach((h) => sets.push({ iso: h.startDate, ids: h.recipeIds }));
    return sets
      .filter((s) => s.iso)
      .map((s) => ({ ids: (s.ids || []).filter(Boolean), dist: Math.abs(fromISODate(s.iso).getTime() - t) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 4)
      .map((s) => s.ids);
  }

  function chooseNext(pool, chosen, metrics, recent) {
    let cands = pool.filter((r) => !chosen.includes(r));
    if (!cands.length) cands = pool.slice(); // fewer than 3 eligible recipes: allow repeats
    const vague = new Set(["other", "unknown"]);
    const distinct = cands.filter((r) => vague.has(r.proteinTag) || !chosen.some((c) => c.proteinTag === r.proteinTag));
    if (distinct.length) cands = distinct;

    const acc = metrics.map((m) => chosen.reduce((sum, r) => sum + (m.value(r) || 0), 0));
    const raw = cands.map((r) => {
      let gain = 0, goals = 0, penalty = 0, limits = 0;
      metrics.forEach((m, i) => {
        const v = m.value(r) || 0;
        if (m.limit) {
          penalty += v / m.target;
          limits++;
        } else {
          gain += Math.min(1, (acc[i] + v) / m.target) - Math.min(1, acc[i] / m.target);
          goals++;
        }
      });
      return (goals ? gain / goals : 0) - 0.5 * (limits ? penalty / limits : 0);
    });
    const lo = Math.min(...raw), hi = Math.max(...raw);
    const norm = (x) => (hi > lo ? (x - lo) / (hi - lo) : 0.5);

    const scored = cands.map((r, i) => {
      let recency = 0;
      recent.forEach((ids, idx) => {
        if (ids.includes(r.id)) recency += 1 / (idx + 1);
      });
      const score =
        0.35 * norm(raw[i]) + // nutrition: closes gaps toward weekly targets
        0.2 * ((r.toddlerAppeal || 3) / 5) +
        ({ great: 0.3, good: 0.15 }[r.rating] || 0) + // recipes we've made and liked
        0.3 * Math.random() + // so regenerating gives a different week
        -0.8 * Math.min(1, recency); // variety between weeks (outweighs a good rating)
      return { r, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].r;
  }

  function setStatus(msg) {
    $("generateStatus").textContent = msg || "";
  }

  function generate() {
    const { pool, notice } = MP.eligibleRecipes();
    if (!pool.length) {
      setStatus("No recipes are eligible. Add recipes on the Recipes page, or loosen your avoid list in Preferences.");
      return;
    }
    const old = currentWeek();
    const history = (MP.plan.history || []).slice();
    if (old) history.unshift({ startDate: viewWeek, recipeIds: old.recipeIds.filter(Boolean) });
    MP.plan.history = history.slice(0, 8);

    const { metrics } = buildMetrics();
    const recent = recentSets(viewWeek);
    const chosen = [];
    COOK_DAYS.forEach(() => chosen.push(chooseNext(pool, chosen, metrics, recent)));

    // Drop weeks more than two weeks old.
    const cutoff = toISODate(addDays(fromISODate(thisWeekISO()), -14));
    const kept = {};
    Object.entries(weeks()).forEach(([iso, w]) => {
      if (iso >= cutoff) kept[iso] = w;
    });
    kept[viewWeek] = { recipeIds: chosen.map((r) => r.id), checks: { shop: {}, prep: {} } };

    MP.updatePlan({ weeks: kept, history: MP.plan.history });
    setStatus(notice || "New plan ready.");
    render();
  }

  function dismissAt(i) {
    const week = currentWeek();
    const gone = week && recipesFor(week)[i];
    if (!gone) return;
    const s = MP.settings;
    MP.updateSettings({ dismissedIds: [...new Set([...s.dismissedIds, gone.id])] });
    replaceSlot(viewWeek, i, "Replaced “" + gone.name + "”.");
    repairMissing(); // the same recipe may be in the other week's plan too
    render();
  }

  function replaceSlot(weekISO, i, message) {
    const week = weeks()[weekISO];
    if (!week) return;
    const { pool } = MP.eligibleRecipes();
    const others = recipesFor(week).filter((r, idx) => r && idx !== i);
    const candidates = pool.filter((r) => !others.includes(r));
    const ids = week.recipeIds.slice();
    if (candidates.length) {
      ids[i] = chooseNext(candidates, others, buildMetrics().metrics, recentSets(weekISO)).id;
      if (message) setStatus(message);
    } else {
      ids[i] = null;
      setStatus("No other eligible recipes to swap in. Add more on the Recipes page.");
    }
    MP.updatePlan({ weeks: Object.assign({}, weeks(), { [weekISO]: Object.assign({}, week, { recipeIds: ids }) }) });
  }

  // If a planned recipe was deleted or dismissed since, swap in a replacement.
  function repairMissing() {
    const dismissed = new Set(MP.settings.dismissedIds);
    Object.keys(weeks()).forEach((iso) => {
      COOK_DAYS.forEach((_, i) => {
        const r = recipesFor(weeks()[iso])[i];
        if ((!r || dismissed.has(r.id)) && MP.eligibleRecipes().pool.length) {
          replaceSlot(iso, i, iso === viewWeek ? "A recipe in this plan was removed, so I swapped in a replacement." : null);
        }
      });
    });
  }

  /* ---------------------------------------------------------------------
     Schedule, prep tasks, shopping
  --------------------------------------------------------------------- */
  const PREP_LABEL = { marinate: "Marinate", thaw: "Thaw", chop: "Chop" };

  // Which day (0 = Friday ... 6 = Thursday) a prep task belongs on.
  function prepDayFor(cookDay, prep) {
    const lead = prep.leadDays || 0;
    if (prep.type === "chop" && lead === 0) return CHOP_DAY; // Saturday chop day
    return cookDay - lead;
  }

  function buildPrepTasks(start, recipes) {
    const tasks = [];
    recipes.forEach((r, k) => {
      if (!r) return;
      const cookDay = COOK_DAYS[k];
      r.ingredients.forEach((ing) => {
        if (!ing.prep || ing.prep.type === "wash") return; // washing isn't scheduled (old data may still carry it)
        let dayIdx = prepDayFor(cookDay, ing.prep);
        const late = dayIdx < 0; // due before the week begins
        if (late) dayIdx = 0;
        const label = PREP_LABEL[ing.prep.type] || "Prep";
        const cookName = addDays(start, cookDay).toLocaleDateString(undefined, { weekday: "long" });
        tasks.push({
          key: [toISODate(addDays(start, cookDay)), r.id, ing.name, ing.prep.type].join("|"),
          dayIdx,
          date: addDays(start, dayIdx),
          late,
          label,
          type: ing.prep.type,
          ingredient: ing.name,
          recipeName: r.name,
          text: `${label} ${ing.name} for ${r.name}` + (dayIdx !== cookDay ? ` (cooking ${cookName})` : ""),
        });
      });
    });
    return tasks.sort((a, b) => a.dayIdx - b.dayIdx);
  }

  function parseQty(q) {
    if (q == null || q === "") return null;
    if (typeof q === "number") return q;
    let s = String(q).trim();
    const uni = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };
    Object.entries(uni).forEach(([k, v]) => (s = s.replace(k, " " + v + " ")));
    let total = 0;
    for (const t of s.trim().split(/\s+/)) {
      if (/^\d+(\.\d+)?$/.test(t)) total += parseFloat(t);
      else if (/^\d+\/\d+$/.test(t)) {
        const [a, b] = t.split("/").map(Number);
        if (!b) return null;
        total += a / b;
      } else return null;
    }
    return total;
  }
  const fmtQty = (n) => String(Math.round(n * 100) / 100);

  function buildShopping(recipes) {
    const aisles = new Map();
    recipes.forEach((r) => {
      if (!r) return;
      r.ingredients.forEach((ing) => {
        const aisle = categorizeIngredient(ing.name);
        const unit = (ing.unit || "").trim();
        const key = [aisle, ing.name.toLowerCase().trim(), unit.toLowerCase()].join("|");
        if (!aisles.has(aisle)) aisles.set(aisle, new Map());
        const group = aisles.get(aisle);
        if (!group.has(key)) group.set(key, { key, name: ing.name, unit, total: 0, hasNum: false, texts: [] });
        const item = group.get(key);
        const q = parseQty(ing.qty);
        if (q != null) {
          item.total += q;
          item.hasNum = true;
        } else if (ing.qty) item.texts.push(String(ing.qty));
      });
    });
    return aisles;
  }

  // The recipe cooked on the previous week's Thursday: this week's Friday leftovers.
  function previousBatch(startISO) {
    const prevISO = toISODate(addDays(fromISODate(startISO), -7));
    const ids = (weeks()[prevISO] && weeks()[prevISO].recipeIds) || ((MP.plan.history || []).find((h) => h.startDate === prevISO) || {}).recipeIds;
    const id = ids && ids[2];
    return id ? MP.recipes.find((r) => r.id === id) || null : null;
  }

  /* ---------------------------------------------------------------------
     Rendering
  --------------------------------------------------------------------- */
  function render() {
    const week = currentWeek();
    $("tabThis").innerHTML = `This week <span class="week-tab__range">${weekRange(thisWeekISO())}</span>`;
    $("tabNext").innerHTML = `Next week <span class="week-tab__range">${weekRange(nextWeekISO())}</span>`;
    $("tabThis").setAttribute("aria-pressed", String(viewWeek === thisWeekISO()));
    $("tabNext").setAttribute("aria-pressed", String(viewWeek === nextWeekISO()));
    $("tabThis").classList.toggle("is-active", viewWeek === thisWeekISO());
    $("tabNext").classList.toggle("is-active", viewWeek === nextWeekISO());

    $("emptyState").hidden = !!week;
    $("weekContent").hidden = !week;
    $("generateBtn").textContent = week ? "Pick different recipes" : "Generate plan";
    $("weekRange").textContent = formatDateLong(fromISODate(viewWeek)) + " – " + formatDateLong(addDays(fromISODate(viewWeek), 6));
    renderPrefsSummary();
    if (!week) return;

    const recipes = recipesFor(week);
    const start = fromISODate(viewWeek);
    const tasks = buildPrepTasks(start, recipes);
    renderDays(recipes, start, tasks);
    renderRecipes(recipes, start);
    renderShopping(recipes, week);
    renderPrep(tasks, week);
  }

  function renderPrefsSummary() {
    const s = MP.settings;
    const avoid = MP.parseAvoid(s.avoidText);
    const { pool } = MP.eligibleRecipes();
    $("prefsSummary").innerHTML =
      `Planning from ${pool.length} eligible recipe${pool.length === 1 ? "" : "s"} · up to ${s.maxPrepTime} min prep, ${s.maxCookTime} min cook` +
      (avoid.length ? ` · avoiding ${escapeHtml(avoid.join(", "))}` : "") +
      ` · <a href="preferences.html">Change preferences</a>`;
  }

  // Group a day's tasks into compact lines: "[Chop] broccoli, carrots — for Recipe".
  function taskLines(dayTasks) {
    const groups = new Map();
    dayTasks.forEach((t) => {
      const k = t.label + "|" + t.recipeName;
      if (!groups.has(k)) groups.set(k, { label: t.label, recipeName: t.recipeName, items: [] });
      groups.get(k).items.push(t.ingredient);
    });
    return [...groups.values()]
      .map((g) => `<li><span class="prep-chip">${escapeHtml(g.label)}</span> ${escapeHtml(g.items.join(", "))} <span class="muted">for ${escapeHtml(g.recipeName)}</span></li>`)
      .join("");
  }

  function renderDays(recipes, start, tasks) {
    const grid = $("dailyPlan");
    grid.innerHTML = "";
    const todayISO = toISODate(MP.today());

    const late = tasks.filter((t) => t.late);
    const before = $("beforeWeek");
    before.hidden = !late.length;
    if (late.length) {
      before.innerHTML =
        "<strong>Do these first</strong> — they were due before the week starts: " +
        late.map((t) => escapeHtml(t.label.toLowerCase() + " " + t.ingredient + " (" + t.recipeName + ")")).join("; ") + ".";
    }

    const prevBatch = previousBatch(viewWeek);
    DAY_PLAN.forEach((plan, i) => {
      const date = addDays(start, i);
      const iso = toISODate(date);
      const cookSlot = COOK_DAYS.indexOf(i);
      const leftoverSlot = COOK_DAYS.indexOf(i - 1);

      let meal;
      const link = (r) => `<a href="#recipe-card-${escapeHtml(r.id)}" data-scroll="${escapeHtml(r.id)}">${escapeHtml(r.name)}</a>`;
      if (cookSlot !== -1) {
        const r = recipes[cookSlot];
        meal = r
          ? `<span class="meal-row__name">${link(r)} <span class="tag tag--cook">Cook · ${r.prepTimeMin + r.cookTimeMin} min</span></span>`
          : '<span class="meal-row__name muted">No recipe</span>';
      } else if (leftoverSlot !== -1) {
        const r = recipes[leftoverSlot];
        meal = r
          ? `<span class="meal-row__name">${link(r)} <span class="tag tag--leftover">Leftovers</span></span>`
          : '<span class="meal-row__name muted">No recipe</span>';
      } else if (i === 0) {
        meal = `<span class="meal-row__name">${prevBatch ? escapeHtml(prevBatch.name) : "Last week's Thursday batch"} <span class="tag tag--leftover">Leftovers</span></span>`;
      } else {
        meal = '<span class="meal-row__name muted">Nothing planned — your call</span>';
      }

      const dayTasks = tasks.filter((t) => t.dayIdx === i);
      let extra = "";
      if (i === 0) {
        extra += `<p class="plan-day__caption">Go shopping for ingredients <a href="#shoppingHeading" data-jump="shoppingHeading">Open list</a></p>`;
      }
      if (dayTasks.length) {
        extra += (plan.caption ? `<p class="plan-day__caption">${escapeHtml(plan.caption)}</p>` : "") + `<ul class="plan-day__prep">${taskLines(dayTasks)}</ul>`;
      } else if (plan.empty) {
        extra += `<p class="plan-day__caption">${escapeHtml(plan.empty)}</p>`;
      }

      const card = document.createElement("div");
      card.className = "plan-day" + (iso === todayISO ? " is-today" : "");
      card.innerHTML = `
        <div class="plan-day__head">
          <span class="plan-day__dow">${date.toLocaleDateString(undefined, { weekday: "long" })}</span>
          <span class="plan-day__date">${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
          ${iso === todayISO ? '<span class="tag tag--today">Today</span>' : ""}
        </div>
        <div class="plan-day__role">${escapeHtml(plan.role)}</div>
        <div class="meal-row">${meal}</div>
        ${extra}`;
      grid.appendChild(card);
    });
  }

  function photoHtml(recipe) {
    const src = MP.photoSrc(recipe);
    return src
      ? `<img class="recipe-photo" src="${escapeHtml(src)}" alt="${escapeHtml(recipe.name)}" loading="lazy" />`
      : '<div class="recipe-photo recipe-photo--empty" aria-hidden="true">🍽️</div>';
  }

  // A link to the original page when the recipe has one; otherwise just the source label.
  function sourceHtml(recipe) {
    const url = MP.safeUrl(recipe.source && recipe.source.url);
    if (url) {
      const label = recipe.source.label ? " · " + escapeHtml(recipe.source.label) : "";
      return `<a class="source-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">View original recipe ↗${label}</a>`;
    }
    return `<span class="badge badge--tag">${escapeHtml(recipe.source ? recipe.source.label : "my library")}</span>`;
  }

  function renderRecipes(recipes, start) {
    const list = $("recipeDetailsList");
    list.innerHTML = "";
    recipes.forEach((recipe, i) => {
      if (!recipe) {
        list.insertAdjacentHTML("beforeend", '<div class="recipe-card"><p class="empty-state">No recipe for this slot — add more on the <a href="recipes.html">Recipes</a> page, then pick different recipes.</p></div>');
        return;
      }
      const cookDate = addDays(start, COOK_DAYS[i]);
      const n = recipe.nutritionPerServing || {};
      const card = document.createElement("div");
      card.className = "recipe-card";
      card.id = "recipe-card-" + recipe.id;
      card.innerHTML = `
        <div class="recipe-card__header">
          ${photoHtml(recipe)}
          <div class="recipe-card__info">
            <h3 class="recipe-card__title">${escapeHtml(recipe.name)}</h3>
            <div class="recipe-card__meta">
              <span>Cook ${formatDateShort(cookDate)} · leftovers ${formatDateShort(addDays(cookDate, 1))}</span>
              <span>Prep ${Number(recipe.prepTimeMin) || 0}m · Cook ${Number(recipe.cookTimeMin) || 0}m</span>
              <span>Serves ${Number(recipe.servings) || 1}</span>
              ${sourceHtml(recipe)}
              ${recipe.nutritionEstimated ? '<span class="badge badge--estimated">nutrition estimated</span>' : ""}
            </div>
            <div class="toddler-appeal" title="Toddler appeal">${starRating(recipe.toddlerAppeal || 3)} <span class="hint">toddler appeal</span></div>
          </div>
          <div class="recipe-card__actions">
            ${MP.ratingSelect(recipe.id, recipe.rating)}
            <button type="button" class="btn btn--icon dismiss-icon" data-dismiss="${i}" title="Dismiss — never plan this again and swap in another" aria-label="Dismiss this recipe">✕</button>
          </div>
        </div>
        <div class="recipe-card__cols">
          <div>
            <h4>Ingredients</h4>
            <ul>${recipe.ingredients.map((ing) => `<li>${ing.qty != null && ing.qty !== "" ? escapeHtml(String(ing.qty)) + " " : ""}${escapeHtml(ing.unit || "")} ${escapeHtml(ing.name)}</li>`).join("")}</ul>
          </div>
          <div>
            <h4>Instructions</h4>
            <ol>${recipe.instructions.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>
          </div>
        </div>
        ${recipe.notes ? `<div class="recipe-notes"><h4>Notes</h4><p>${escapeHtml(recipe.notes)}</p></div>` : ""}
        <div>
          <h4>Nutrition <span class="hint">per serving</span></h4>
          <div class="nutrition-grid">
            <div><span>Calories</span><span>${Number(n.calories) || 0}</span></div>
            <div><span>Protein</span><span>${Number(n.proteinG) || 0} g</span></div>
            <div><span>Fiber</span><span>${Number(n.fiberG) || 0} g</span></div>
            <div><span>Calcium</span><span>${Number(n.calciumMg) || 0} mg</span></div>
            <div><span>Iron</span><span>${Number(n.ironMg) || 0} mg</span></div>
            <div><span>Vitamin C</span><span>${Number(n.vitaminCMg) || 0} mg</span></div>
            <div><span>Sodium</span><span>${Number(n.sodiumMg) || 0} mg</span></div>
            <div><span>Added sugar</span><span>${Number(n.addedSugarG) || 0} g</span></div>
          </div>
        </div>`;
      list.appendChild(card);
    });
  }

  function setCheck(kind, key, value) {
    const week = currentWeek();
    if (!week) return;
    const checks = Object.assign({ shop: {}, prep: {} }, week.checks);
    checks[kind] = Object.assign({}, checks[kind]);
    if (value) checks[kind][key] = true;
    else delete checks[kind][key];
    MP.updatePlan({ weeks: Object.assign({}, weeks(), { [viewWeek]: Object.assign({}, week, { checks }) }) });
  }

  const STORES = [
    ["", "Not sorted yet"],
    ["costco", "Costco"],
    ["cub", "Cub"],
  ];
  const AISLE_ORDER = ["Produce", "Meat & Seafood", "Dairy & Eggs", "Bakery", "Frozen", "Pantry", "Other"];
  const storeKey = (name) => String(name).toLowerCase().trim();
  const storeOf = (name) => (MP.settings.storeByItem || {})[storeKey(name)] || "";

  // Every shopping item for the week, in aisle order, tagged with its chosen store ("" = not sorted).
  function flattenShopping(recipes) {
    const aisles = buildShopping(recipes);
    const all = [];
    AISLE_ORDER.filter((a) => aisles.has(a)).forEach((aisle) => {
      [...aisles.get(aisle).values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((item) => all.push({ aisle, item, store: storeOf(item.name) }));
    });
    return all;
  }

  // One line per item ("1.5 lb chicken breasts"), in aisle order, leaving out anything already ticked off.
  function storeListText(store, recipes, week) {
    const checks = (week.checks || {}).shop || {};
    return flattenShopping(recipes)
      .filter((x) => x.store === store && !checks[x.item.key])
      .map(({ item }) => {
        const qty = [item.hasNum ? fmtQty(item.total) : "", ...item.texts].filter(Boolean).join(" + ");
        return [qty, item.unit === "each" ? "" : item.unit, item.name].filter(Boolean).join(" ");
      })
      .join("\n");
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text); // needs a secure page (localhost or https)
      return true;
    } catch (e) {
      /* fall through to the older method */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.readOnly = true;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  function renderShopping(recipes, week) {
    const wrap = $("shoppingList");
    wrap.innerHTML = "";
    const checks = (week.checks || {}).shop || {};
    const all = flattenShopping(recipes);
    if (!all.length) {
      wrap.innerHTML = '<p class="empty-state">No ingredients to shop for yet.</p>';
      $("shoppingCount").textContent = "";
      return;
    }

    const rowHtml = ({ item, store }) => {
      const isDone = !!checks[item.key];
      const qty = [item.hasNum ? fmtQty(item.total) : "", ...item.texts].filter(Boolean).join(" + ");
      const name = escapeHtml(storeKey(item.name));
      const btn = (s, label) =>
        `<button type="button" class="store-btn is-${s}" data-store-btn="${s}" data-name="${name}" aria-pressed="${store === s}">${label}</button>`;
      return `<div class="shopping-item${isDone ? " is-checked" : ""}">
        <label class="shopping-item__main">
          <input type="checkbox" data-kind="shop" data-key="${escapeHtml(item.key)}"${isDone ? " checked" : ""} />
          <span class="shopping-item__label">${escapeHtml(item.name)}</span>
          <span class="shopping-item__qty">${escapeHtml(qty)} ${escapeHtml(item.unit)}</span>
        </label>
        <div class="store-btns" role="group" aria-label="Where to buy ${escapeHtml(item.name)}">${btn("costco", "Costco")}${btn("cub", "Cub")}</div>
      </div>`;
    };

    STORES.forEach(([store, label]) => {
      const rows = all.filter((x) => x.store === store);
      if (!rows.length) return;
      const section = document.createElement("div");
      section.className = "store-section" + (store ? " store-section--" + store : "");
      const bulk = store
        ? `<button type="button" class="btn btn--small btn--ghost" data-copy="${store}">Copy list</button>`
        : `<span class="store-section__bulk">Send all to <button type="button" class="btn--text" data-bulk="costco">Costco</button> <button type="button" class="btn--text" data-bulk="cub">Cub</button></span>`;
      const hint = store ? "" : '<p class="hint">Tap Costco or Cub on each item to split your list. Your choices are remembered for future weeks.</p>';
      const groups = AISLE_ORDER.filter((a) => rows.some((x) => x.aisle === a))
        .map(
          (aisle) =>
            `<div class="aisle-group"><h4 class="aisle-title">${escapeHtml(aisle)}</h4><div class="aisle-items">${rows
              .filter((x) => x.aisle === aisle)
              .map(rowHtml)
              .join("")}</div></div>`
        )
        .join("");
      section.innerHTML = `<div class="store-section__head"><h3>${label} <span class="muted">· ${rows.length} item${rows.length === 1 ? "" : "s"}</span></h3>${bulk}</div>${hint}${groups}`;
      wrap.appendChild(section);
    });

    const done = all.filter((x) => checks[x.item.key]).length;
    $("shoppingCount").textContent = `${done} of ${all.length} picked up`;
  }

  function renderPrep(tasks, week) {
    const wrap = $("prepList");
    wrap.innerHTML = "";
    const checks = (week.checks || {}).prep || {};
    if (!tasks.length) {
      wrap.innerHTML = '<p class="empty-state">No advance prep needed this week.</p>';
      $("prepCount").textContent = "";
      return;
    }
    const byDay = new Map();
    tasks.forEach((t) => {
      if (!byDay.has(t.dayIdx)) byDay.set(t.dayIdx, { date: t.date, dayIdx: t.dayIdx, tasks: [] });
      byDay.get(t.dayIdx).tasks.push(t);
    });
    let done = 0;
    [...byDay.values()].forEach((entry) => {
      const caption = DAY_PLAN[entry.dayIdx].caption;
      const card = document.createElement("div");
      card.className = "prep-day";
      card.innerHTML =
        `<div class="prep-day__date">${escapeHtml(formatDateLong(entry.date))}${caption ? ` <span class="hint">· ${escapeHtml(caption)}</span>` : ""}</div>` +
        entry.tasks
          .map((t) => {
            const isDone = !!checks[t.key];
            if (isDone) done++;
            return `<label class="prep-task${isDone ? " is-checked" : ""}">
              <input type="checkbox" data-kind="prep" data-key="${escapeHtml(t.key)}"${isDone ? " checked" : ""} />
              <span class="prep-chip">${escapeHtml(t.label)}</span>
              <span>${escapeHtml(t.text)}${t.late ? ' <span class="hint">— due before the week starts; do it as early as you can</span>' : ""}</span>
            </label>`;
          })
          .join("");
      wrap.appendChild(card);
    });
    $("prepCount").textContent = `${done} of ${tasks.length} done`;
  }

  /* ---------------------------------------------------------------------
     Init
  --------------------------------------------------------------------- */
  function showWeek(iso) {
    viewWeek = iso;
    setStatus("");
    render();
  }

  async function init() {
    MP.renderHeader("week");
    await MP.load();
    migrateLegacyPlan();

    const thisISO = thisWeekISO(), nextISO = nextWeekISO();
    viewWeek = weeks()[thisISO] ? thisISO : weeks()[nextISO] ? nextISO : MP.today().getDay() === 4 ? nextISO : thisISO;

    $("tabThis").addEventListener("click", () => showWeek(thisWeekISO()));
    $("tabNext").addEventListener("click", () => showWeek(nextWeekISO()));
    $("generateBtn").addEventListener("click", generate);

    $("recipeDetailsList").addEventListener("click", (e) => {
      const dismissBtn = e.target.closest("[data-dismiss]");
      if (dismissBtn) dismissAt(Number(dismissBtn.dataset.dismiss));
    });

    // Shopping list: assign items to a store (tap again to unassign), or send all unsorted items at once.
    $("shoppingList").addEventListener("click", async (e) => {
      const copyBtn = e.target.closest("[data-copy]");
      if (copyBtn && currentWeek()) {
        const text = storeListText(copyBtn.dataset.copy, recipesFor(currentWeek()), currentWeek());
        const label = copyBtn.textContent;
        if (!text) {
          copyBtn.textContent = "Nothing left to copy";
        } else if (await copyText(text)) {
          copyBtn.textContent = "Copied " + text.split("\n").length + " items ✓";
        } else {
          copyBtn.textContent = "Couldn't copy - select the text below";
          const box = document.createElement("textarea");
          box.className = "copy-fallback";
          box.readOnly = true;
          box.rows = Math.min(12, text.split("\n").length + 1);
          box.value = text;
          copyBtn.closest(".store-section").querySelector(".store-section__head").after(box);
          box.focus();
          box.select();
        }
        setTimeout(() => (copyBtn.textContent = label), 2500);
        return;
      }
      const btn = e.target.closest("[data-store-btn]");
      const bulk = e.target.closest("[data-bulk]");
      const week = currentWeek();
      if ((!btn && !bulk) || !week) return;
      const map = Object.assign({}, MP.settings.storeByItem);
      if (btn) {
        if (map[btn.dataset.name] === btn.dataset.storeBtn) delete map[btn.dataset.name];
        else map[btn.dataset.name] = btn.dataset.storeBtn;
      } else {
        flattenShopping(recipesFor(week))
          .filter((x) => !x.store)
          .forEach((x) => (map[storeKey(x.item.name)] = bulk.dataset.bulk));
      }
      MP.updateSettings({ storeByItem: map });
      renderShopping(recipesFor(week), week);
    });

    $("recipeDetailsList").addEventListener("change", (e) => {
      const sel = e.target.closest(".rating-select");
      if (!sel) return;
      MP.setRating(sel.dataset.rating, sel.value);
      sel.className = "rating-select" + (sel.value ? " is-" + sel.value : "");
    });

    $("dailyPlan").addEventListener("click", (e) => {
      const scroll = e.target.closest("[data-scroll]");
      const jump = e.target.closest("[data-jump]");
      const target = scroll
        ? document.getElementById("recipe-card-" + scroll.dataset.scroll)
        : jump
        ? document.getElementById(jump.dataset.jump)
        : null;
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      if (scroll) {
        target.classList.add("is-highlighted");
        setTimeout(() => target.classList.remove("is-highlighted"), 1400);
      }
    });

    document.querySelector("main").addEventListener("change", (e) => {
      const box = e.target.closest('input[type="checkbox"][data-kind]');
      if (!box) return;
      setCheck(box.dataset.kind, box.dataset.key, box.checked);
      box.closest(".shopping-item, .prep-task").classList.toggle("is-checked", box.checked);
      const sel = box.dataset.kind === "shop" ? "#shoppingList" : "#prepList";
      const all = document.querySelectorAll(sel + ' input[type="checkbox"]');
      const done = [...all].filter((b) => b.checked).length;
      $(box.dataset.kind === "shop" ? "shoppingCount" : "prepCount").textContent =
        box.dataset.kind === "shop" ? `${done} of ${all.length} picked up` : `${done} of ${all.length} done`;
    });

    repairMissing();
    render();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
