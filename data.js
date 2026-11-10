/* ==========================================================================
   Weekly Meal Planner — static data
   - DEFAULT_FOOD_GROUP_TARGETS / DEFAULT_NUTRIENT_TARGETS: USDA / Dietary
     Guidelines for Americans 2020-2025 (MyPlate, ~2000 kcal reference) &
     FDA Daily Value style figures, used only as sensible starting points.
   - RECIPE_LIBRARY: built-in fallback recipes. Most are adapted from real,
     published family/kid-friendly recipes on superhealthykids.com (credited
     via `source`); a handful are original creations used to round out
     variety. Nutrition figures are sourced where the page published them;
     otherwise they are reasonable estimates (`nutritionEstimated: true`).
   ========================================================================== */

const DEFAULT_FOOD_GROUP_TARGETS = [
  { key: "fruit", label: "Fruits", unit: "cups / week / person", value: 14 },
  { key: "vegetable", label: "Vegetables", unit: "cups / week / person", value: 17 },
  { key: "grain", label: "Grains", unit: "oz-eq / week / person", value: 42 },
  { key: "protein", label: "Protein foods", unit: "oz-eq / week / person", value: 38 },
  { key: "dairy", label: "Dairy", unit: "cups / week / person", value: 21 },
];

const DEFAULT_NUTRIENT_TARGETS = [
  { name: "Protein", amount: 50, unit: "g", period: "day" },
  { name: "Fiber", amount: 28, unit: "g", period: "day" },
  { name: "Calcium", amount: 1300, unit: "mg", period: "day" },
  { name: "Iron", amount: 18, unit: "mg", period: "day" },
  { name: "Vitamin C", amount: 90, unit: "mg", period: "day" },
  { name: "Added sugar (limit)", amount: 50, unit: "g", period: "day" },
  { name: "Sodium (limit)", amount: 2300, unit: "mg", period: "day" },
];

/* Ingredient category lookup for shopping-list aisle grouping. Matched by
   keyword against ingredient name (case-insensitive, first match wins). */
const AISLE_KEYWORDS = [
  ["Produce", ["zucchini","broccoli","carrot","celery","onion","garlic","pepper","bell pepper","mushroom","spinach","kale","cilantro","lime","lemon","basil","parsley","dill","avocado","tomato","cabbage","bok choy","ginger","pear","pineapple","green onion","scallion","corn on the cob","potato","lettuce","romaine","green bean","shallot","fresh chili","vegetables","squash","rosemary"]],
  ["Meat & Seafood", ["chicken","beef","steak","pork","turkey","salmon","shrimp","sausage","kielbasa","bacon","ham"]],
  ["Dairy & Eggs", ["cheese","milk","yogurt","butter","cream","egg","parmesan","mozzarella","provolone","cottage cheese","sour cream","half and half","tofu"]],
  ["Bakery", ["bread","tortilla","pie crust","bun","taco shell","dough"]],
  ["Frozen", ["frozen","peas"]],
  ["Pantry", ["rice","quinoa","pasta","tortellini","flour","broth","stock","bean","tomatoes, canned","canned tomatoes","oil","vinegar","sauce","honey","sugar","cornstarch","spice","powder","cumin","paprika","oregano","thyme","seasoning","salt","pepper, black","bouillon","chili flakes","sriracha","salsa","dressing","stuffing","croutons","sesame","chili powder","fish sauce"]],
];

/* Checked before AISLE_KEYWORDS so "chicken broth", "black pepper", "canned
   tomatoes", "onion powder" etc. don't land in produce/meat. */
const AISLE_OVERRIDES = [
  ["Frozen", /frozen/],
  ["Dairy & Eggs", /refrigerated/],
  ["Pantry", /canned|broth|stock\b|bouillon|soup|sauce|dressing|vinegar|\boil\b|syrup|honey|sugar|flour|cornstarch|juice|powder|seasoning|dried|sun-dried|black pepper|pepper flakes|chili flakes|paprika|cumin|oregano|thyme|\bsalt\b|stuffing|croutons|sesame seeds|paste\b|vinaigrette|mayonnaise|couscous|gnocchi|puree|noodle|macaroni/],
];

function categorizeIngredient(name) {
  const n = name.toLowerCase();
  for (const [aisle, re] of AISLE_OVERRIDES) {
    if (re.test(n)) return aisle;
  }
  for (const [aisle, words] of AISLE_KEYWORDS) {
    if (words.some((w) => n.includes(w))) return aisle;
  }
  return "Other";
}

/* Helper to build an ingredient entry tersely. */
function ing(name, qty, unit, prep) {
  return { name, qty, unit, prep: prep || null };
}
/* prep shorthand: { type: 'marinate'|'thaw'|'chop'|'wash', leadDays } */
const MARINATE_1 = { type: "marinate", leadDays: 1 };
const THAW_1 = { type: "thaw", leadDays: 1 };
const CHOP = { type: "chop", leadDays: 0 };

const RECIPE_LIBRARY = []; // the phone app starts empty; restore a backup from the laptop app

