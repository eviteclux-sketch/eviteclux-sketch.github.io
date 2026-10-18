// Prix Net Réel — moteur de calcul (port fidèle de pricing.ts + construction.ts)
var PNR = (function(){
  function PnrError(msg, field){ this.message = msg; this.field = field; }
  var DISCLAIMER = "Simulation and management tool. Estimates based on your data, not tax, accounting, legal or financial advice. Check your obligations with a professional.";
  function invalid(field){ throw new PnrError("Invalid value: " + field + ". Enter a positive number or zero, within the limits shown.", field); }
  function number(i, key, fallback, positive){
    var v = i[key];
    if (v === undefined && fallback !== undefined) return fallback;
    if (typeof v !== "number" || !isFinite(v) || v < 0 || v > 1e12 || (positive && v <= 0)) invalid(key);
    return v;
  }
  function percent(i, key, fallback, allow100){
    var n = number(i, key, fallback === undefined ? 0 : fallback);
    if (n > 100 || (!allow100 && n >= 100)) invalid(key);
    return n / 100;
  }
  function items(i, key){
    if (i[key] === undefined) return [];
    if (!Array.isArray(i[key]) || i[key].length > 100) invalid(key);
    var list = i[key];
    if (list.some(function(v){ return !v || typeof v !== "object" || Array.isArray(v); })) invalid(key);
    return list;
  }
  function sumCosts(i, listKey, totalKey){
    var list = items(i, listKey);
    return list.length ? list.reduce(function(s,row){ return s + number(row, "cost"); }, 0) : number(i, totalKey, 0);
  }
  function priceHT(i, key){
    var p = number(i, key);
    var vat = number(i, "vat", 21);
    if (vat > 100) invalid("vat");
    if (i.priceMode !== undefined && i.priceMode !== "HT" && i.priceMode !== "TTC") invalid("priceMode");
    return i.priceMode === "TTC" ? p / (1 + vat / 100) : p;
  }
  function complete(i, revenue, cost, divisor, breakdown, details, warnings){
    var risk = percent(i, "riskPercent"), fee = percent(i, "feePercent"), taxRate = percent(i, "taxPercent"), marginRate = percent(i, "marginPercent");
    if (risk + fee >= 1) invalid("risks + fees (must stay below 100%)");
    var target = number(i, "targetNet", 0);
    var riskCost = revenue * risk, feeCost = revenue * fee;
    var result = revenue - cost - riskCost - feeCost;
    var tax = Math.max(0, result) * taxRate;
    var targetRevenue = (cost + target / (1 - taxRate)) / (1 - risk - fee);
    var minimumRevenue = cost / (1 - risk - fee);
    var recommendedRevenue = cost / (1 - marginRate);
    var netFor = function(ca){ var before = ca - cost - ca*risk - ca*fee; return before - Math.max(0,before)*taxRate; };
    var d = Object.assign({}, details, {
      beforeTax: result, targetNet: target, beforeFeesThreshold: cost / divisor, recommendedRevenue: recommendedRevenue,
      netAtMarginPrice: netFor(recommendedRevenue), netAtTargetPrice: netFor(targetRevenue),
      vat: number(i, "vat", 21), riskPercent: risk*100, feePercent: fee*100, taxPercent: taxRate*100, marginPercent: marginRate*100
    });
    var r = {
      revenue: revenue, cost: cost, margin: revenue - cost, net: result - tax, riskCost: riskCost, feeCost: feeCost, tax: tax,
      targetRevenue: targetRevenue, minimumRevenue: minimumRevenue, recommendedPrice: recommendedRevenue / divisor,
      currentPrice: revenue / divisor, minimumPrice: minimumRevenue / divisor, targetPrice: targetRevenue / divisor,
      breakdown: breakdown.concat([{label:"Risks", amount: riskCost},{label:"Fees on revenue", amount: feeCost},{label:"Estimated tax", amount: tax}]),
      details: d,
      warnings: (warnings || []).concat([DISCLAIMER, "VAT is an assumption you can change; it is not income. Your actual tax position depends on your situation."])
    };
    ["revenue","cost","margin","net","riskCost","feeCost","tax","targetRevenue","minimumRevenue","recommendedPrice","currentPrice","minimumPrice","targetPrice"].forEach(function(k){ if (!isFinite(r[k])) invalid("result out of range"); });
    if (r.net < 0) r.warnings.unshift("The current price makes a loss on the figures entered.");
    return r;
  }
  function directorMode(i){
    var mode = i.directorMode !== undefined ? i.directorMode : (i.directorAnnualCost !== undefined ? "direct" : "fraction");
    if (mode !== "direct" && mode !== "markup" && mode !== "fraction") invalid("directorMode");
    return mode;
  }
  function fabrication(i){
    var quantity = number(i, "quantity", undefined, true);
    var productiveHours = number(i, "productiveHours", 160, true);
    var hourly = number(i, "laborHourly") + number(i, "fixedMonthly", 0) / productiveHours;
    var loss = percent(i, "lossPercent", 0, true);
    var materialBase = sumCosts(i, "materials", "materialsTotal");
    var material = materialBase * (1 + loss);
    var labor = number(i, "minutes") / 60 * hourly;
    var cost = material + labor;
    if (i.targetScope !== undefined && i.targetScope !== "unit" && i.targetScope !== "lot") invalid("targetScope");
    var normalized = i.targetScope === "unit" ? Object.assign({}, i, {targetNet: number(i,"targetNet",0) * quantity}) : i;
    var r = complete(normalized, priceHT(i, "price") * quantity, cost, quantity,
      [{label:"Materials with waste", amount: material},{label:"Time and allocated fixed costs", amount: labor}],
      {quantity: quantity, hourly: hourly, materialBase: materialBase, material: material, labor: labor, costPerUnit: cost/quantity, unit: i.unit || "pièce", targetScope: i.targetScope || "lot"},
      ["The hourly cost includes labour and allocated fixed costs; these costs are not deducted a second time."]);
    r.details.netPerUnit = r.net / quantity;
    return r;
  }
  function services(i){
    var persons = number(i, "persons", 1, true);
    var weeks = number(i, "weeks", undefined, true); if (weeks > 53) invalid("weeks");
    var weeklyHours = number(i, "weeklyHours", undefined, true); if (weeklyHours > 168) invalid("weeklyHours");
    var billable = percent(i, "billablePercent", 62, true); if (billable === 0) invalid("billablePercent");
    var mode = directorMode(i);
    var contribution = percent(i, "contributionPercent", 0, mode === "markup");
    var director = mode === "direct" ? number(i, "directorAnnualCost") : mode === "markup" ? number(i, "directorNet", 0) * (1 + contribution) : number(i, "directorNet", 0) / (1 - contribution);
    var staff = number(i, "staffAnnual", 0);
    var structure = sumCosts(i, "structure", "structureTotal");
    var cost = director + staff + structure;
    var hours = persons * weeks * weeklyHours * billable;
    var rate = priceHT(i, "rate");
    var r = complete(i, rate * hours, cost, hours,
      [{label:"Owner's pay incl. social charges", amount: director},{label:"Staff incl. social charges", amount: staff},{label:"Running costs", amount: structure}],
      {hours: hours, capacityHours: hours, paidHours: persons*weeks*weeklyHours, director: director, directorMode: mode, staff: staff, structure: structure, thresholdRate: cost/hours},
      ["The owner's pay is already included in the costs. The net target comes on top.",
       "The social-charge base for the owner's pay is a management assumption, not an exact tax calculation. Unbilled time reduces capacity."]);
    r.details.requiredHours = rate > 0 ? r.targetRevenue / rate : null;
    r.details.netPerHour = r.net / hours;
    r.details.impossible = rate === 0 || r.targetRevenue / rate > hours;
    if (r.details.impossible) r.warnings.unshift("Target out of reach at the current rate within the available capacity.");
    return r;
  }
  function chantierCosts(p, yieldPerDay){
    var capacity = p.persons * yieldPerDay, duration = p.surface / capacity, days = Math.ceil(duration);
    var paidDuration = p.fullDays ? days : duration;
    var labor = p.laborDaily * paidDuration, travel = p.travelFixed + p.travelDaily * days;
    var expenses = p.daily * days + travel + p.other;
    var direct = labor + p.material + expenses, fixed = direct * p.fixedRate;
    var contingency = (direct + fixed) * p.contingencyRate;
    return {capacity: capacity, duration: duration, days: days, paidDuration: paidDuration, labor: labor, travel: travel, expenses: expenses, direct: direct, fixed: fixed, contingency: contingency, cost: direct + fixed + contingency};
  }
  function chantierEquilibrium(p, revenue, risk, fee, current, tax){
    var limit = 1e12;
    var profit = function(cost){ return revenue - cost - revenue*risk - revenue*fee; };
    var at = function(y){ return profit(chantierCosts(p, y).cost); };
    var minimumExpenses = p.daily + (p.travelFixed + p.travelDaily) + p.other;
    var minimumDirect = (p.fullDays ? p.laborDaily : 0) + p.material + minimumExpenses;
    var minimumFixed = minimumDirect * p.fixedRate;
    var minimumCost = minimumDirect + minimumFixed + (minimumDirect + minimumFixed) * p.contingencyRate;
    var base = {equilibriumLimit: limit, equilibriumPrice: revenue / p.surface, equilibriumYield: null, displayedEquilibriumYield: null, yieldSafetyPercent: null, equilibriumBeforeTax: null, displayedYieldBeforeTax: null, displayedYieldTax: null};
    if (profit(minimumCost) < 0 || (profit(minimumCost) === 0 && !p.fullDays && p.laborDaily > 0)) return Object.assign({}, base, {equilibriumStatus: "impossible"});
    if (p.laborDaily === 0 && p.daily === 0 && p.travelDaily === 0) return Object.assign({}, base, {equilibriumStatus: "any"});
    var hi = Math.max(current, 1e-6), lo = 0;
    while (at(hi) < 0 && hi < limit) { lo = hi; hi = Math.min(limit, hi * 2); }
    if (at(hi) < 0) return Object.assign({}, base, {equilibriumStatus: "limited"});
    for (var k = 0; k < 1100; k++) { var mid = (lo + hi) / 2; if (mid === lo || mid === hi) break; if (at(mid) >= 0) hi = mid; else lo = mid; }
    var displayed = Math.ceil(hi * 100) / 100;
    while (displayed <= limit && at(displayed) < 0) displayed += 0.01;
    if (displayed > limit) return Object.assign({}, base, {equilibriumStatus: "limited"});
    var dp = at(displayed);
    return Object.assign({}, base, {equilibriumStatus: "found", equilibriumYield: hi, displayedEquilibriumYield: displayed, yieldSafetyPercent: 100 * (current - displayed) / current, equilibriumBeforeTax: at(hi), displayedYieldBeforeTax: dp, displayedYieldTax: Math.max(0, dp) * tax});
  }
  function travaux(i){
    var surface = number(i, "surface", undefined, true), yieldPerDay = number(i, "yieldPerDay", undefined, true);
    var hoursPerDay = number(i, "hoursPerDay", 8, true); if (hoursPerDay > 24) invalid("hoursPerDay");
    var team = items(i, "team");
    var persons = team.reduce(function(s,row){ return s + number(row, "count", undefined, true); }, 0); if (persons <= 0) invalid("team");
    if (i.fullDays !== undefined && typeof i.fullDays !== "boolean") invalid("fullDays");
    var laborDaily = team.reduce(function(s,row){ return s + number(row,"count") * hoursPerDay * number(row,"hourlyCost"); }, 0);
    var materialsList = items(i, "materials");
    var perM2 = materialsList.length ? materialsList.reduce(function(s,row){ return s + number(row,"costPerM2"); }, 0) : number(i, "materialPerM2", 0);
    var material = perM2 * surface * (1 + percent(i, "lossPercent", 0, true));
    var daily = number(i,"fuelLitersPerDay",0)*number(i,"fuelPrice",0) + number(i,"consumablesPerDay",0) + number(i,"scaffoldingPerDay",0) + number(i,"machinePerDay",0);
    var tripsMode = i.tripsMode === undefined ? "fixed" : i.tripsMode;
    if (tripsMode !== "fixed" && tripsMode !== "daily") invalid("tripsMode");
    var tripCost = number(i,"distanceKm",0) * number(i,"costPerKm",0);
    var p = {surface: surface, persons: persons, laborDaily: laborDaily, fullDays: i.fullDays === true, material: material, daily: daily,
      travelFixed: tripsMode === "fixed" ? tripCost * number(i,"trips",0) : 0,
      travelDaily: tripsMode === "daily" ? tripCost * number(i,"tripsPerDay",1) : 0,
      other: number(i,"skipCost",0) + number(i,"otherCosts",0) + number(i,"financingCost",0),
      fixedRate: percent(i,"fixedPercent"), contingencyRate: percent(i,"contingencyPercent")};
    var c = chantierCosts(p, yieldPerDay);
    var price = priceHT(i, "pricePerM2");
    var retention = percent(i, "retentionPercent", 0, true);
    var r = complete(i, price * surface, c.cost, surface,
      [{label:"Labour", amount: c.labor},{label:"Materials with offcuts", amount: material},{label:"Job costs and financing", amount: c.expenses},{label:"Overheads", amount: c.fixed},{label:"Contingency on cost", amount: c.contingency}],
      {surface: surface, persons: persons, capacityPerDay: c.capacity, duration: c.duration, days: c.days, paidDuration: c.paidDuration, laborHours: persons*hoursPerDay*c.paidDuration, labor: c.labor, material: material, expenses: c.expenses, travel: c.travel, tripsMode: tripsMode, direct: c.direct, fixed: c.fixed, contingency: c.contingency, costPerM2: c.cost/surface, retentionAmount: price*surface*retention},
      ["Daily costs use rounded-up days; labour uses actual time unless the full-days option is on.",
       "Recoverable retentions are a cash-flow delay, not a loss. Financing cost must be entered separately.",
       "Keep an eye on output; the target price depends on capacity and job data."]);
    r.details.netPerM2 = r.net / surface;
    Object.assign(r.details, chantierEquilibrium(p, r.revenue, percent(i,"riskPercent"), percent(i,"feePercent"), yieldPerDay, percent(i,"taxPercent")));
    return r;
  }
  function calculate(type, i){
    if (type === "fabrication") return fabrication(i);
    if (type === "services") return services(i);
    if (type === "travaux") return travaux(i);
    throw new PnrError("Unknown calculation type.");
  }
  return {calculate: calculate, PnrError: PnrError, DISCLAIMER: DISCLAIMER};
})();


var GUIDES = [
  {cat: 'Production', type: 'fabrication', h1: 'Work out your cost price, piece by piece',
   answer: 'Your cost price is everything a piece costs you before you earn your first euro: materials with their waste, your time paid at its true cost, and your fixed costs spread across production. Below this price, you\'re paying to work.',
   formula: ['Real hourly cost = your hourly cost (wage + social charges) + monthly fixed costs ÷ productive hours per month', 'Cost price per piece = (materials × (1 + waste) + minutes ÷ 60 × real hourly cost) ÷ number of pieces', 'Floor price = cost price ÷ (1 − risks − fees)', 'Recommended price excl. VAT = cost price ÷ (1 − target margin on selling price)'],
   example: 'Batch of 20 loaves (simplified example). Flour 6 kg, including 3% waste = €4.57 excl. VAT. Time 90 min at €29.50/h incl. social charges = €44.25. Cost: €48.82 excl. VAT, i.e. €2.44 excl. VAT per loaf. With a 35% margin: €3.76 excl. VAT. Here flour is less than 10% of the cost: it\'s the time that sets the price.',
   errors: ['Not counting your time, or counting it without social charges.', 'Counting materials without waste (offcuts, failed bakes, unsold production).', 'Mixing up the two margins: cost × 1.35 gives a 35% margin on cost, but only 25.9% of the selling price. To keep 35% of the selling price (the margin on selling price), divide the cost by 0.65.'],
   faq: [['Is VAT part of the cost price?', 'If you reclaim it on your purchases, no: count your materials excl. VAT. If not (a small-business exemption scheme, for example), it\'s a cost: count incl. VAT. Your accountant will tell you which applies to you.']]},
  {cat: 'Production', type: 'fabrication', h1: 'Your cost price per kilo (or per litre)',
   answer: 'Work out the full cost of your batch, then divide it by the weight or volume you can actually sell. That gives your cost price per kilo; add your risks and fees and you have your floor price.',
   formula: ['Cost price per kilo = batch cost ÷ saleable kilos produced', 'Floor price per kilo = cost price per kilo ÷ (1 − risks − fees)', 'Recommended price per kilo excl. VAT = cost price per kilo ÷ (1 − target margin)'],
   example: '20 loaves of 700 g = 14 kg. Batch cost €48.82 excl. VAT: a cost price of €3.49 excl. VAT per kilo. With 2% risks and 1.2% fees, the floor price is €3.60 excl. VAT per kilo. With a 35% margin: €5.37 excl. VAT per kilo.',
   errors: ['Dividing by the weight of the dough or the full vat, instead of the finished, saleable weight or volume.', 'Forgetting packaging losses (vat leftovers, spoiled bottles, damaged packaging).', 'Selling by the kilo and by the piece without checking that both prices give the same margin.'],
   faq: [['Same for litres?', 'Yes: replace kilos with the litres actually bottled or jarred. In the full calculation, choose the “kg” or “litre” unit and enter the kilos or litres produced as the quantity.']]},
  {cat: 'Production', type: 'fabrication', h1: 'What does a loaf really cost you?',
   answer: 'In our example, a 700 g country loaf costs €2.44 excl. VAT to produce, i.e. €3.49 excl. VAT per kilo. The figure that matters is yours: it depends on your recipe, your time and your costs.',
   example: '20 loaves of 700 g = 14 kg. Flour 6 kg + 3% waste = €4.57 excl. VAT. 90 min (preparation, watching the bake, finishing, cleaning, packing) at €29.50/h = €44.25. Cost €48.82 excl. VAT → €2.44 excl. VAT per loaf → €3.49 excl. VAT per kilo. At a 35% margin: €3.76 excl. VAT per loaf. Sold at €3.72 excl. VAT, the margin drops to 34.4%: 3.6 cents per loaf below target, €0.71 per batch.',
   extra: 'Add to your calculation: sourdough or yeast, salt, water, oven energy, packaging, unsold goods.',
   faq: [['Which VAT rate?', 'The rate for bread in your country, often reduced for food but it varies: your accountant will confirm it.']]},
  {cat: 'Construction', type: 'travaux', h1: 'Your price per m², based on your real output',
   answer: 'Your price per m² is the full cost of the job divided by the area, plus your margin. It all starts from a figure only you know: how many m² your team lays per worker per day.',
   formula: ['Duration = area ÷ (output × number of workers)', 'Labour = team\'s daily cost × duration', 'Daily costs (scaffolding, plant, consumables, travel) = cost per day × days rounded up', 'Cost price = (labour + materials + job costs) + overheads + contingency', 'Price per m² excl. VAT = cost price ÷ area ÷ (1 − target margin)'],
   example: 'Interlocking tile roof of 180 m², team of 4, output 22 m²/worker/day → cost price €48.70 excl. VAT/m², €59.38 excl. VAT/m² with an 18% margin.',
   errors: ['Copying a competitor\'s price per m²: they don\'t have your team, your output or your costs.', 'Paying daily costs on the exact duration: 2.05 days on site means 3 days of scaffolding and 3 round trips.', 'Counting the retention as a loss: you get it back at handover, it\'s a cash-flow delay.'],
   faq: [['I don\'t know my output?', 'Measure it on your last three jobs: m² completed ÷ (workers × days). It\'s the most profitable figure you can know.']]},
  {cat: 'Construction', type: 'travaux', h1: 'Price per m² for a tiled roof: the full calculation',
   answer: 'In this example, the roof costs €48.70 excl. VAT per m² and sells for €59.38 excl. VAT per m² with an 18% margin. Below €48.70, the job costs you money.',
   example: '180 m². Team: 1 foreman (€42/h), 2 skilled workers (€36/h), 1 labourer (€26/h), 8 h per day. Output 22 m²/worker/day → 88 m²/day → 2.05 days, 3 days counted for daily costs. Labour €2,290.91. Materials €4,387.86 (tiles €17.55/m² + 8% offcuts, battens €3.04/m² + 10%, roofing underlay €1.98/m² + 5%). Job costs €635.30 (diesel 12 L/day at €1.65, consumables €15/day, scaffolding €45/day, skip €320, 3 round trips of 46 km at €0.55/km). Overheads 12%, contingency 7% → €8,765.18 excl. VAT, i.e. €48.70 excl. VAT/m². At an 18% margin: €59.38 excl. VAT/m². Minimum output (with no risks or fees on the price): 13.30 m²/worker/day.',
   faq: [['Why is the minimum output so far below 22?', 'Because materials don\'t change when the team slows down: only labour and daily costs go up.']]},
  {cat: 'Construction', type: 'travaux', h1: 'The output that makes (or breaks) your margin',
   answer: 'Output is the number of m² one worker completes per day. Every job has a minimum output: below it, your price no longer covers your costs.',
   formulaTitle: 'How it\'s calculated',
   formula: ['We recalculate the full cost of the job for every possible output (labour, scaffolding days, travel),', 'and look for the first output at which the cost drops below your price.', 'Not a simple proportion: materials don\'t depend on output.'],
   example: 'Roof of 180 m² at €59.38 excl. VAT/m², planned output 22. Minimum output 13.30 (with no risks or fees on the price). Your team can slow down by about 40% before losing money.',
   errors: ['Pricing with a good day\'s output, on an easy job.', 'Forgetting downtime: setting up, packing up, bad weather, waiting for deliveries.', 'Never measuring the real output after the job.']},
  {cat: 'Services', type: 'services', h1: 'Your floor hourly rate, and the one to charge',
   answer: 'Your real hourly cost is your total annual costs, including your own pay, divided by the hours you actually bill. Not by the hours you work. Add your unpaid invoices and fees: that\'s your floor rate.',
   formula: ['Billable hours = people × weeks × hours per week × share actually billed', 'Real hourly cost = total annual costs ÷ billable hours', 'Floor rate = real hourly cost ÷ (1 − unpaid invoices − fees)', 'Recommended rate excl. VAT = real hourly cost ÷ (1 − target margin)'],
   example: '2 people, 44 weeks, 40 h, 62% billed → 2,182 billable hours. Costs €144,100 (owner €69,600 incl. social charges, employee €38,000, running costs €36,500). Real hourly cost €66.03 excl. VAT. With 2% unpaid invoices and 1% fees, floor rate €68.07 excl. VAT/h. At a 20% margin: €82.54 excl. VAT/h.',
   errors: ['Dividing by all the hours worked: admin, prospecting and holidays aren\'t paid for by clients.', 'Leaving your own pay out of your costs.', 'Confusing what your pay costs you with what you take home net.'],
   faq: [['What social contribution rate on my pay?', 'The one for your status and your country: ask your accountant or your social security fund. The tool doesn\'t make it up.']]},
  {cat: 'Services', type: 'services', h1: 'Hourly rate for an accounting firm: the full example',
   answer: 'In this example, each billed hour costs the firm €66.03 excl. VAT, and €68.07 with its unpaid invoices and fees. It charges €75: it makes money, but less than it thinks.',
   example: 'At €75 excl. VAT/h: revenue €163,680. After costs: €19,580. After 2% unpaid invoices and 1% fees: €14,669.60. After 25% tax: €11,002.20 profit, on top of salaries. “Annual accounts” job: 30 h at the recommended rate of €82.54/h (rounded) = €2,476 excl. VAT + €66 travel. A fixed fee of €2,200 excl. VAT works out at €71.13/h: above the €68.07 floor, below target. For an extra €30,000 profit a year: €86.97 excl. VAT/h. At €75/h it would take 2,531 billed hours; the firm only has 2,182.'},
  {cat: 'Services', type: 'services', h1: 'How many of your hours are actually paid?',
   answer: 'Part of your time is paid by nobody: admin, prospecting, quotes, training. Your hourly rate has to fund those hours too.',
   example: '2 people × 44 weeks × 40 h = 3,520 paid hours. 62% billed = 2,182 h. 1,338 h a year are paid by no client. At €75/h, you need to bill 1,981 h to cover costs, unpaid invoices and fees, i.e. 56.3% of the time: the safety margin is only 5.7 points.',
   errors: ['Assuming 100% of your time is billable.', 'Not tracking your hours: without measuring, your billing rate is just a feeling.', 'Cutting your rate to fill your diary, when the real problem is unbilled time.']}
];

// Prix Net Réel — consignes et outils de l'assistant (partagés entre la page et le serveur)
var RULES = [
  'Tu es l’assistant de « Prix Net Réel », un outil qui aide les artisans, les entreprises du bâtiment et les indépendants à trouver leur vrai prix.',
  'Réponds en français, en tutoyant, avec des phrases courtes et le vocabulaire du métier de la personne.',
  'Règles absolues :',
  '1. Choisis le bon calcul : calcul_fabrication (produit, lot, prix au kilo, au litre ou à la pièce), calcul_chantier (travaux au m²), calcul_services (taux horaire, mission, cabinet).',
  '2. Pose UNE question à la fois. Une question peut regrouper deux ou trois chiffres de même nature (par exemple tous les frais de chantier à la journée).',
  '3. N’invente JAMAIS une donnée : prix d’achat, temps, rendement, coût horaire, charges sociales, taux d’impôt, TVA, marge viennent de la personne. Si elle ne connaît pas un taux d’impôt ou de charges, propose de laisser 0 et dis-le dans ta réponse (sauf la rémunération du dirigeant : demande toujours son coût annuel ou son net et ses charges, jamais 0). Si la personne est elle-même comptable, ne lui dis pas de demander à son comptable.',
  '4. Tu ne calcules aucun résultat : appelle l’outil et recopie exactement ses chiffres. Tu peux seulement convertir l’unité d’une donnée (heures en minutes, mois en année, rendement d’équipe divisé par le nombre d’hommes, salaire mensuel × 12) et tu annonces la conversion. Si la personne cherche son prix et n’en a pas encore, mets 0 comme prix : l’outil donne quand même le plancher, le prix conseillé et le prix pour l’objectif.',
  '5. Pourcentages en nombres : 25 pour 25 %, jamais 0.25. Prix TTC : envoie-le tel quel avec priceMode « TTC » et la TVA donnée, ne le convertis pas toi-même.',
  '6. Un champ que tu n’envoies pas vaut 0 ou sa valeur par défaut : après le calcul, cite les postes laissés à 0 (champ « laisses_a_zero » du résultat).',
  '7. Après le calcul, donne en quelques lignes : le prix plancher, le prix conseillé si une marge est donnée, le prix pour l’objectif si un net est donné, ce qu’il reste si un prix est donné, et l’hypothèse qui pèse le plus. Dis que le calcul peut s’ouvrir dans le calcul complet pour être modifié et enregistré.',
  '8. Refuse poliment tout ce qui n’est pas un calcul de prix, de coûts ou de rentabilité, et tout conseil fiscal, juridique ou comptable.',
  'Montants en euros hors taxes, sauf mention TTC.'
].join('\n');
var NUM = {type: 'number'};
var PCT = {type: 'number', description: 'en %, 25 pour 25 %'};
var TTC_FIELDS = {priceMode: {type: 'string', enum: ['HT','TTC']}, vat: {type: 'number', description: 'taux de TVA en %, obligatoire si TTC'}};
var TOOLS_DEF = {
  fabrication: {name: 'calcul_fabrication', description: 'Prix de revient, prix plancher, prix conseillé, prix pour un objectif et reste après impôt d’un LOT fabriqué. Toutes les quantités et tous les coûts portent sur le lot entier. Renvoie les résultats du moteur à recopier tels quels.',
    inputSchema: {type: 'object', properties: Object.assign({quantity: {type: 'number', description: 'pièces, kg ou L vendables du lot'}, unit: {type: 'string', enum: ['pièce','portion','kg','L','lot']}, price: {type: 'number', description: 'prix de vente d’UNE unité, 0 si inconnu'}, minutes: {type: 'number', description: 'temps total pour TOUT le lot'}, laborHourly: {type: 'number', description: 'salaire + charges d’une heure'}, materialsTotal: {type: 'number', description: 'matières pour TOUT le lot'}, fixedMonthly: {type: 'number', description: 'loyer, énergie… par mois'}, productiveHours: {type: 'number', description: 'heures de production par mois, toutes personnes'}, lossPercent: PCT, marginPercent: PCT, riskPercent: PCT, feePercent: PCT, taxPercent: PCT, targetNet: {type: 'number', description: 'net voulu après impôt'}, targetScope: {type: 'string', enum: ['lot','unit']}}, TTC_FIELDS), required: ['quantity','price','minutes','laborHourly','materialsTotal']}},
  travaux: {name: 'calcul_chantier', description: 'Coût de revient au m², prix plancher, prix conseillé, prix pour un objectif, reste après impôt et rendement minimum d’un chantier. Renvoie les résultats du moteur à recopier tels quels.',
    inputSchema: {type: 'object', properties: Object.assign({surface: NUM, pricePerM2: {type: 'number', description: 'prix de vente au m², 0 si inconnu'}, yieldPerDay: {type: 'number', description: 'm² par HOMME et par jour (divise un rendement d’équipe par le nombre d’hommes)'}, hoursPerDay: NUM, team: {type: 'array', items: {type: 'object', properties: {name: {type: 'string'}, count: NUM, hourlyCost: {type: 'number', description: 'coût horaire chargé d’UNE personne'}}, required: ['count','hourlyCost']}}, materialPerM2: NUM, lossPercent: PCT, fuelLitersPerDay: NUM, fuelPrice: NUM, consumablesPerDay: NUM, scaffoldingPerDay: {type: 'number', description: 'par jour (une location à la semaine se divise par 5)'}, machinePerDay: NUM, skipCost: NUM, distanceKm: {type: 'number', description: 'aller-retour'}, costPerKm: NUM, tripsMode: {type: 'string', enum: ['daily','fixed']}, tripsPerDay: NUM, trips: NUM, otherCosts: NUM, financingCost: NUM, fullDays: {type: 'boolean'}, fixedPercent: PCT, contingencyPercent: PCT, marginPercent: PCT, retentionPercent: PCT, riskPercent: PCT, feePercent: PCT, taxPercent: PCT, targetNet: NUM}, TTC_FIELDS), required: ['surface','pricePerM2','yieldPerDay','team','materialPerM2']}},
  services: {name: 'calcul_services', description: 'Taux horaire plancher, taux conseillé, taux pour un objectif annuel, bénéfice après impôt et heures à facturer d’un indépendant ou d’un cabinet. Rémunération du dirigeant : directorMode « direct » + directorAnnualCost (coût total chargé), ou « markup » + directorNet + contributionPercent (charges en % du net). targetNet = bénéfice EN PLUS de la rémunération. Renvoie les résultats du moteur à recopier tels quels.',
    inputSchema: {type: 'object', properties: Object.assign({persons: NUM, weeks: NUM, weeklyHours: NUM, billablePercent: PCT, rate: {type: 'number', description: 'tarif horaire actuel, 0 si inconnu'}, directorMode: {type: 'string', enum: ['direct','markup','fraction']}, directorAnnualCost: NUM, directorNet: {type: 'number', description: 'net annuel'}, contributionPercent: PCT, staffAnnual: {type: 'number', description: 'salariés, coût annuel chargé'}, structureTotal: {type: 'number', description: 'frais de structure annuels'}, marginPercent: PCT, riskPercent: PCT, feePercent: PCT, taxPercent: PCT, targetNet: {type: 'number', description: 'bénéfice annuel voulu en plus de la rémunération'}}, TTC_FIELDS), required: ['weeks','weeklyHours','billablePercent','rate']}}
};

(function(){
"use strict";
// ---------- utilitaires ----------
var $ = function(s, r){ return (r || document).querySelector(s); };
var $$ = function(s, r){ return [].slice.call((r || document).querySelectorAll(s)); };
function fmt(n, d){ if (d === undefined) d = 2; return Number(n).toLocaleString('en-GB', {minimumFractionDigits: d, maximumFractionDigits: d}); }
var CUR_PRE = window.PNR_CUR === 'pre';
// minuscules dans une phrase, sauf en allemand (les noms y gardent leur majuscule)
function lower(s){ return window.PNR_LOWER === 'no' ? s : s.toLowerCase(); }
function eur(n, d){ var s = fmt(n, d === undefined ? 2 : d); return CUR_PRE ? (s.charAt(0) === '-' ? '-€' + s.slice(1) : '€' + s) : s + ' €'; }
var DOT_THOUSANDS = /^-?[1-9]\d{0,2}(\.\d{3})+(,\d+)?$/;
// langues à point décimal (anglais, chinois) : la virgule sépare les milliers
var DEC = window.PNR_DEC === '.' ? '.' : ',';
var COMMA_THOUSANDS = /^-?[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/;
function clean(s){ return String(s).replace(/[\s  ]/g, ''); }
function dotThousands(s){ return s !== undefined && s !== null && (DEC === '.' ? COMMA_THOUSANDS : DOT_THOUSANDS).test(clean(s)); }
function parseNum(s){
  if (s === undefined || s === null) return undefined;
  var t = clean(s);
  if (t === '') return undefined;
  if (DEC === '.'){ if (COMMA_THOUSANDS.test(t)) t = t.replace(/,/g, ''); else t = t.replace(',', '.'); }
  else { if (DOT_THOUSANDS.test(t)) t = t.replace(/\./g, ''); t = t.replace(',', '.'); }
  var n = Number(t);
  return isFinite(n) ? n : NaN;
}
function toStr(v){ if (v === undefined || v === null) return ''; if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6).replace('.', DEC); return String(v); }
function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function clone(o){ return JSON.parse(JSON.stringify(o)); }
function blank(v){ return v === undefined || v === null || String(v).trim() === ''; }
var toastT;
function toast(msg){ var t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function(){ t.hidden = true; }, 3400); }
function lsGet(k){ try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch(e){ return null; } }
function lsSet(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch(e){ return false; } }
function cap(name){ try { return window.claude && typeof window.claude.use === 'function' ? window.claude.use(name).catch(function(){ return null; }) : Promise.resolve(null); } catch(e){ return Promise.resolve(null); } }
// bouton à double appui : le premier arme, le second agit
function armed(btn, label){ if (btn.dataset.armed === '1'){ btn.dataset.armed = ''; btn.textContent = btn.dataset.label; return true; } btn.dataset.label = btn.textContent; btn.dataset.armed = '1'; btn.textContent = label; setTimeout(function(){ if (btn.dataset.armed === '1'){ btn.dataset.armed = ''; btn.textContent = btn.dataset.label; } }, 4000); return false; }

// ---------- navigation ----------
var VIEWS = ['accueil', 'tests', 'calcul', 'assistant', 'calculs', 'guides'];
var current = 'accueil';
function show(v){
  var toChat = v === 'assistant';
  if (v === 'assistant' || v === 'tests') v = 'accueil';
  if (VIEWS.indexOf(v) < 0) v = 'accueil';
  current = v;
  $$('[data-view]').forEach(function(s){ s.hidden = s.getAttribute('data-view') !== v; });
  $$('[data-nav]').forEach(function(a){ if (a.getAttribute('data-nav') === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('#c-mini').hidden = v !== 'calcul';
  if (v === 'calculs') renderSaved();
  window.scrollTo(0, 0);
  if (toChat) focusChat();
}
function focusChat(){ var b = $('#a-box'), i = $('#a-input'); if (b) b.scrollIntoView({block: 'start'}); if (i && !i.closest('[hidden]')) setTimeout(function(){ try { i.focus({preventScroll: true}); } catch(e){} }, 60); }
window.addEventListener('hashchange', function(){ show(location.hash.slice(1)); });

// ---------- accueil ----------
(function(){
  var c = [['Selling price of the batch', 75.20, 'hsl(218 30% 55%)', 0], ['Materials (flour + waste)', 4.57, 'hsl(214 16% 62%)', 0], ['Your time, incl. social charges', 44.25, 'hsl(214 16% 62%)', 0], ['What you think you earn', 26.38, 'var(--hivis)', 0], ['Risks, fees and tax', 8.40, 'var(--loss)', 0], ['What you really keep', 17.98, 'var(--ok)', 1]];
  $('#home-cascade').innerHTML = c.map(function(x, i){
    return '<li class="' + (x[3] ? 'sum' : '') + '"><div class="lab"><span>' + x[0] + '</span><span class="num">' + eur(x[1]) + '</span></div><div class="track"><i style="width:' + (x[1] / 75.20 * 100).toFixed(1) + '%;background:' + x[2] + ';animation-delay:' + (200 + i * 120) + 'ms"></i></div></li>';
  }).join('');
  $$('[data-open]').forEach(function(b){ b.addEventListener('click', function(){ setType(b.getAttribute('data-open')); location.hash = 'calcul'; }); });
  document.addEventListener('click', function(e){
    var b = e.target.closest('[data-ask]'); if (!b) return;
    e.preventDefault(); prepAsk(b.getAttribute('data-ask'), true);
  });
})();

// ---------- tests rapides ----------
var Q = {};
(function(){
  var val = function(id){ return parseNum($('#' + id).value); };
  var okAll = function(arr){ return arr.every(function(n){ return n >= 0; }); };
  var line = function(l, v){ return '<li><span>' + l + '</span><i></i><span class="num">' + v + '</span></li>'; };
  var stop = '<p class="err">Fill in every box with a positive number.</p>';
  var cta = function(q){ return '<button class="btn btn-hivis" type="button" data-carry="' + q + '">Continue in the full calculation with these figures</button>'; };
  Q.taux = function(){
    var ch = val('ta-ch'), h = val('ta-h'), s = val('ta-s'), p = val('ta-p');
    if (!okAll([ch, h, s, p]) || h * s * p === 0 || p > 100 || s > 53 || h > 100) return stop;
    var paid = h * s, billed = paid * p / 100, rate = ch / billed;
    return '<p class="eyebrow">Each billed hour costs you</p><p class="big">' + eur(rate) + '<small>excl. VAT / hour</small></p><ul class="lines">' +
      line('Hours worked per year', fmt(paid, 0) + ' h') + line('Hours billed per year', fmt(billed, 0) + ' h') + line('Hours paid by no client', fmt(paid - billed, 0) + ' h') +
      '</ul>' + (ch > 0 ? '<p class="verdict">Below this rate, you don\'t cover your costs and your pay.</p>' : '') +
      '<p class="limit">This test doesn\'t count unpaid invoices, payment fees or tax. The full calculation does.</p>' + cta('taux');
  };
  Q.vehic = function(){
    var n = val('ve-n'), km = val('ve-km'), c = val('ve-c'), p = val('ve-p'), a = val('ve-a'), e = val('ve-e'), l = val('ve-l');
    if (!okAll([n, km, c, p, a, e, l]) || n === 0 || km === 0) return stop;
    var fuel = km * c / 100 * p, per = fuel + a + e + l, tot = per * n, perkm = per / km;
    return '<p class="eyebrow">Your vehicles cost you</p><p class="big">' + eur(tot, 0) + '<small>per year</small></p><ul class="lines">' +
      line('Per vehicle', eur(per, 0) + ' / year') + line('Per kilometre', eur(perkm, 3)) + line('Of which fuel', fmt(fuel / per * 100, 1) + ' %') +
      '</ul><p class="verdict">Every kilometre you don\'t bill costs you ' + eur(perkm) + '.</p><p class="limit">This cost per kilometre can be used as the “cost per km” when pricing a job.</p>' + cta('vehic');
  };
  Q.prod = function(){
    var pv = val('pr-pv'), m = val('pr-m'), mn = val('pr-min'), h = val('pr-h');
    if (!okAll([pv, m, mn, h]) || pv === 0) return stop;
    var cost = m + mn / 60 * h, mg = pv - cost;
    return '<p class="eyebrow">Your margin over materials and time</p><p class="big">' + eur(mg) + '<small>' + fmt(mg / pv * 100, 1) + ' % of the price</small></p><ul class="lines">' +
      line('Materials and time per piece', eur(cost)) + line('Of which materials', eur(m)) + line('Of which your time', eur(mn / 60 * h)) +
      '</ul>' + (mg < 0 ? '<p class="verdict">You\'re selling below what your materials and time cost you: ' + eur(-mg) + ' loss per piece.</p>' : '<p class="verdict good">You keep ' + eur(mg) + ' per piece to pay rent, energy, unpaid invoices and tax.</p>') +
      '<p class="limit">This test doesn\'t count your fixed costs (rent, energy), waste, risks or tax. The full calculation does.</p>' + cta('prod');
  };
  Q.m2 = function(){
    var mat = val('m2-mat'), eq = val('m2-eq'), r = val('m2-r'), f = val('m2-f');
    if (!okAll([mat, eq, r, f]) || r === 0) return stop;
    var floor = mat + (eq + f) / r;
    var isEx = mat === 24.38 && eq === 1120 && r === 88 && f === 105;
    return '<p class="eyebrow">Your direct cost per m²</p><p class="big">' + eur(floor) + '<small>excl. VAT / m²</small></p><ul class="lines">' +
      line('Materials', eur(mat) + ' / m²') + line('Team and daily costs', eur((eq + f) / r) + ' / m²') +
      '</ul><p class="verdict">Below this price, you\'re sure to lose money. Your real floor price is higher.</p>' +
      (isEx ? '<p class="gap">For this example, the full calculation gives a cost price of <b>€48.70 excl. VAT/m²</b>. The test misses <b>€10.40/m²</b>, i.e. <b>€1,872</b> over 180 m²: overheads, contingency, full days of scaffolding, skip.</p>' : '') +
      '<p class="limit">This test doesn\'t count overheads, contingency, full days, the skip, risks or tax. The full calculation does.</p>' + cta('m2');
  };
  $$('form[data-q]').forEach(function(form){
    var k = form.getAttribute('data-q'), out = $('#qr-' + k);
    var run = function(){ out.innerHTML = Q[k](); };
    form.addEventListener('input', run);
    form.addEventListener('submit', function(e){ e.preventDefault(); });
    run();
  });
  var tabs = $$('.qtab');
  function select(i){ tabs.forEach(function(t, j){ var on = i === j; t.setAttribute('aria-selected', on ? 'true' : 'false'); t.tabIndex = on ? 0 : -1; $('#' + t.getAttribute('aria-controls')).hidden = !on; }); }
  tabs.forEach(function(t, i){
    t.addEventListener('click', function(){ select(i); });
    t.addEventListener('keydown', function(e){ if (e.key === 'ArrowRight' || e.key === 'ArrowLeft'){ e.preventDefault(); var j = (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; select(j); tabs[j].focus(); } });
  });
})();
document.addEventListener('click', function(e){
  var a = e.target.closest('[data-goto]'); if (a) setType(a.getAttribute('data-goto'));
  var c = e.target.closest('[data-carry]'); if (c) carryQuick(c.getAttribute('data-carry'));
});
function qv(id){ return $('#' + id).value; }
function carryQuick(q){
  var st;
  if (q === 'taux'){
    st = freshState('services', true); st.name = 'My hourly rate';
    st.v.persons = '1'; st.v.weeklyHours = qv('ta-h'); st.v.weeks = qv('ta-s'); st.v.billablePercent = qv('ta-p');
    st.v.directorMode = 'direct'; st.v.directorAnnualCost = '0'; st.v.staffAnnual = '0'; st.v.structureTotal = qv('ta-ch');
    st.carryNote = 'Carried over from the test: your annual costs are in “Running costs”, including your pay. You can enter your pay separately. Your current rate is missing.';
  } else if (q === 'prod'){
    st = freshState('fabrication', true); st.name = 'My product';
    st.v.quantity = '1'; st.v.price = qv('pr-pv'); st.v.materialsTotal = qv('pr-m'); st.v.minutes = qv('pr-min'); st.v.laborHourly = qv('pr-h');
    st.carryNote = 'Carried over from the test, for one piece. Add your fixed costs, waste, risks and tax in the collapsed sections.';
  } else if (q === 'm2'){
    st = freshState('travaux', true); st.name = 'My job';
    var eq = parseNum(qv('m2-eq'));
    st.v.materialPerM2 = qv('m2-mat'); st.v.hoursPerDay = '8'; st.v.yieldPerDay = qv('m2-r'); st.v.pricePerM2 = '0'; st.v.consumablesPerDay = qv('m2-f');
    st.lists.team = [{name: 'Team (overall cost)', count: '1', hourlyCost: eq >= 0 ? toStr(eq / 8) : ''}];
    st.carryNote = 'Carried over from the test: your team is counted as a single line (daily cost ÷ 8 h) and its output is that of the whole team. Your daily costs are in “Consumables”. The area is missing; enter your price per m² if you have one. The full calculation charges daily costs by the full day: it may come out a little higher than the test.';
  } else if (q === 'vehic'){
    st = freshState('travaux'); st.name = 'Job with my cost per km (example)';
    var km = parseNum(qv('ve-km')), c = parseNum(qv('ve-c')), p = parseNum(qv('ve-p')), a = parseNum(qv('ve-a')), e = parseNum(qv('ve-e')), l = parseNum(qv('ve-l'));
    var per = km * c / 100 * p + a + e + l;
    st.v.costPerKm = km > 0 && isFinite(per) ? toStr(Math.round(per / km * 1000) / 1000) : st.v.costPerKm;
    st.carryNote = 'Your cost per kilometre (' + st.v.costPerKm + ' €/km) has been put into the example job. Replace the rest with your figures.';
  } else return;
  S = st; cache[st.type] = st; renderForm(); compute(); saveDraft(); location.hash = 'calcul';
}

// ---------- calcul complet : configuration ----------
var LABELS = {quantity:'Quantity produced', unit:'Selling unit', price:'Unit selling price', priceMode:'Your price is', vat:'VAT included in your price', minutes:'Total time for the batch', laborHourly:'Hourly cost of your labour', materialsTotal:'Materials, batch total', fixedMonthly:'Monthly fixed costs', productiveHours:'Productive hours per month', lossPercent:'Waste', marginPercent:'Target margin on selling price', riskPercent:'Risk (unpaid invoices, unsold goods)', feePercent:'Fees on revenue', taxPercent:'Tax on profit (average rate)', targetNet:'Net target', targetScope:'This net target is', persons:'People who bill', weeks:'Weeks worked per year', weeklyHours:'Hours per week', billablePercent:'Share billed', rate:'Current hourly rate', directorMode:'Owner\'s pay', directorAnnualCost:'Owner\'s annual cost', directorNet:'Owner\'s net pay', contributionPercent:'Owner\'s social charge rate', staffAnnual:'Employees, annual cost', structureTotal:'Running costs, annual total', surface:'Area', pricePerM2:'Price per m²', yieldPerDay:'Output per worker', hoursPerDay:'Hours per day', team:'Team', materialPerM2:'Materials per m²', fuelLitersPerDay:'Plant fuel', fuelPrice:'Fuel price', consumablesPerDay:'Consumables', scaffoldingPerDay:'Scaffolding', machinePerDay:'Machinery hire', skipCost:'Skip, waste disposal', distanceKm:'Round-trip distance', costPerKm:'Cost per km', tripsMode:'Trips', trips:'Number of trips', tripsPerDay:'Trips per day', otherCosts:'Other costs', financingCost:'Financing cost', fixedPercent:'Overheads', contingencyPercent:'Contingency (unforeseen)', retentionPercent:'Retention', fullDays:'Full days', materials:'Materials list', structure:'Running costs list', count:'Number', hourlyCost:'Hourly cost', cost:'Cost', costPerM2:'Cost per m²', country:'Country', unsoldPercent:'Unsold goods (% of production)', dayHours:'Hours billed per day', scaffoldingFixed:'Scaffolding, flat fee to erect and dismantle', weatherDays:'Expected bad-weather days'};
var UNIT_WORD = {'pièce': 'piece', 'portion': 'portion', 'kg': 'kg', 'L': 'litre', 'lot': 'batch'};
// Taux de TVA vérifiés le 8 octobre 2026 : BE (accountable.eu, maj 24/08/2026), LU (stripe.com, maj 24/02/2026), FR (economie.gouv.fr, 11/12/2025), CH (estv.admin.ch)
var VAT_RATES = {BE: ['21', '12', '6', '0'], LU: ['17', '14', '8', '3'], FR: ['20', '10', '5,5', '2,1'], CH: ['8,1', '3,8', '2,6'], autre: []};
if (DEC === '.') Object.keys(VAT_RATES).forEach(function(k){ VAT_RATES[k] = VAT_RATES[k].map(function(x){ return x.replace(',', '.'); }); });
var COUNTRY_OPTS = [['BE','Belgium'],['LU','Luxembourg'],['FR','France'],['CH','Switzerland'],['autre','Other country']];
var UNIT_PL = {'piece': 'pieces', 'portion': 'portions', 'batch': 'batches', 'litre': 'litres'};
var MAT_FACTOR = {kg: 1, g: 0.001, L: 1, cl: 0.01, ml: 0.001, 'pièce': 1};
var BREAK_LABEL = {'Risks': 'Risks (unpaid invoices, unsold goods)', 'Fees on revenue': 'Payment fees'};
function F(k, s, h, extra){ return Object.assign({k: k, s: s, h: h}, extra || {}); }
var PRICE_HINT = 'Enter 0 if you\'re working out your price: the floor price and recommended price are still shown.';
var CFG = {
  fabrication: {
    blocks: [
      {t: 'Your product', f: [F('unit', null, null, {kind: 'sel', o: [['pièce','piece'],['portion','portion'],['kg','kg'],['L','litre'],['lot','batch']]}), F('quantity', '@unit', 'Number of pieces in the batch, or saleable kg / litres produced.', {req: 1}), F('price', '€/@unit', PRICE_HINT, {req: 1}), F('priceMode', null, null, {kind: 'sel', o: [['HT','Excl. VAT'],['TTC','Incl. VAT']]}), F('country', null, null, {kind: 'sel', o: COUNTRY_OPTS}), F('vat', '%', 'To show your prices incl. VAT. Required if your price is incl. VAT. Check the rate for your product.', {kind: 'vatpick'}), F('unsoldPercent', '%', 'Share of production thrown away or given away. The cost is spread over what is sold.')]},
      {t: 'Materials', alt: {list: 'materials', lib: 1, out: 'cost', total: F('materialsTotal', '€', 'Material cost for the WHOLE batch, not per unit. Enter 0 if there is none. Oven energy and packaging can go here.'), cols: [{k: 'name', l: 'Material', text: 1}, {k: 'qty', l: 'Quantity for the batch'}, {k: 'u', l: 'Unit', sel: [['kg','kg'],['g','g'],['L','L'],['cl','cl'],['ml','ml'],['pièce','piece']]}, {k: 'price', l: 'Purchase price', s: '€/kg, L or piece'}], calc: function(r){ return r.qty * (MAT_FACTOR[r.u] || 1) * r.price; }}},
      {t: 'Your time', f: [F('minutes', 'min', 'Total time for the whole batch.', {req: 1}), F('laborHourly', '€/h', 'Wage + social charges for one hour of work. Rent and energy go further down.', {req: 1})]}
    ],
    details: [
      {t: 'Fixed costs and waste', f: [F('fixedMonthly', '€/month', 'Workshop rent, energy, insurance.'), F('productiveHours', 'h/month', 'Total production hours per month, everyone included. 160 if left blank.'), F('lossPercent', '%', 'Material lost or spoiled in production.')]},
      {t: 'Margin, risk, fees and tax', f: [F('marginPercent', '%', 'Share of the selling price excl. VAT you need to keep (margin on selling price).'), F('riskPercent', '%', 'Unsold goods, unpaid invoices, breakage, as a % of revenue.'), F('feePercent', '%', 'Payment or platform commissions.'), F('taxPercent', '%', 'Average rate: ask your accountant.'), F('targetNet', '€', 'What you want left after tax.'), F('targetScope', null, null, {kind: 'sel', o: [['lot','for the whole batch'],['unit','per unit']]})]}
    ],
    watch: ['fixedMonthly', 'lossPercent', 'riskPercent', 'feePercent', 'taxPercent']
  },
  travaux: {
    blocks: [
      {t: 'The job', f: [F('surface', 'm²', null, {req: 1}), F('pricePerM2', '€/m²', PRICE_HINT, {req: 1}), F('priceMode', null, null, {kind: 'sel', o: [['HT','Excl. VAT'],['TTC','Incl. VAT']]}), F('country', null, null, {kind: 'sel', o: COUNTRY_OPTS}), F('vat', '%', 'To show your prices incl. VAT. Required if your price is incl. VAT. The rate depends on the work (renovation, new build…).', {kind: 'vatpick'})]},
      {t: 'Your output', f: [F('yieldPerDay', 'm²/worker/day', 'What ONE worker completes per day, in YOUR conditions.', {req: 1}), F('hoursPerDay', 'h', '8 if left blank.')]},
      {t: 'Your team', list: {list: 'team', cols: [{k: 'name', l: 'Role', text: 1}, {k: 'count', l: 'Number'}, {k: 'hourlyCost', l: 'Hourly cost per person', s: '€/h'}]}},
      {t: 'Materials', alt: {list: 'materials', lib: 1, out: 'costPerM2', total: F('materialPerM2', '€/m²', 'Total materials for one m² of finished work.'), cols: [{k: 'name', l: 'Material', text: 1}, {k: 'qty', l: 'Quantity per m²'}, {k: 'u', l: 'Unit', text: 1}, {k: 'price', l: 'Unit purchase price', s: '€'}], calc: function(r){ return r.qty * r.price; }}, f: [F('lossPercent', '%', 'Offcuts, if not already in the cost per m².')]}
    ],
    details: [
      {t: 'Job costs', f: [F('fuelLitersPerDay', 'L/day'), F('fuelPrice', '€/L'), F('consumablesPerDay', '€/day'), F('scaffoldingPerDay', '€/day', 'Hired by the full day. Weekly hire: divide by 5.'), F('scaffoldingFixed', '€', 'Flat fee to erect and dismantle.'), F('weatherDays', 'days', 'Days when equipment stays on hire with no work: scaffolding and machinery counted on top.'), F('machinePerDay', '€/day'), F('skipCost', '€'), F('distanceKm', 'km'), F('costPerKm', '€/km', 'Your “vehicles” test gives you this figure.'), F('tripsMode', null, null, {kind: 'sel', o: [['daily','one round trip per day started'],['fixed','a fixed number for the job']]}), F('tripsPerDay', '/day', '“Per day” mode. 1 if left blank.', {only: 'daily'}), F('trips', 'trips', '“Fixed number” mode.', {only: 'fixed'}), F('otherCosts', '€'), F('financingCost', '€', 'If you borrow to fund the job upfront.'), F('fullDays', null, 'Labour paid in full days.', {kind: 'bool'})]},
      {t: 'Margin, risk, cash flow and tax', f: [F('fixedPercent', '%', 'Office, admin, insurance, as a % of direct cost.'), F('contingencyPercent', '%', 'Weather, rework, surprises.'), F('marginPercent', '%', 'Share of the selling price excl. VAT you need to keep (margin on selling price).'), F('retentionPercent', '%', 'Paid later: it\'s not a loss.'), F('riskPercent', '%', 'Unpaid invoices, credit notes, disputes, as a % of revenue.'), F('feePercent', '%', 'Payment fees.'), F('taxPercent', '%', 'Average rate: ask your accountant.'), F('targetNet', '€', 'What you want left from this job after tax.')]}
    ],
    watch: ['fixedPercent', 'contingencyPercent', 'riskPercent', 'feePercent', 'taxPercent']
  },
  services: {
    blocks: [
      {t: 'Your time', f: [F('persons', 'people', 'People billing at this rate. 1 if left blank.'), F('weeks', 'wks', 'Excluding holidays, bank holidays, sick leave.', {req: 1}), F('weeklyHours', 'h', null, {req: 1}), F('billablePercent', '%', 'Admin, quotes and prospecting aren\'t billed.', {req: 1})]},
      {t: 'Your rate', f: [F('rate', '€/h', PRICE_HINT, {req: 1}), F('dayHours', 'h', 'To see your prices per day. 8 if left blank.'), F('priceMode', null, null, {kind: 'sel', o: [['HT','Excl. VAT'],['TTC','Incl. VAT']]}), F('country', null, null, {kind: 'sel', o: COUNTRY_OPTS}), F('vat', '%', 'To show your prices incl. VAT. Required if your rate is incl. VAT.', {kind: 'vatpick'})]},
      {t: 'Owner\'s pay', dir: true},
      {t: 'Staff and running costs', f: [F('staffAnnual', '€/year', 'Annual cost of your employees, incl. social charges. 0 if none.')], alt: {list: 'structure', total: F('structureTotal', '€/year', 'Rent, insurance, software, vehicle, accountant… Enter 0 if none.'), cols: [{k: 'name', l: 'Item', text: 1}, {k: 'cost', l: 'Annual cost', s: '€/year'}]}}
    ],
    details: [
      {t: 'Margin, risk, fees and tax', f: [F('marginPercent', '%', 'Share of your rate excl. VAT you need to keep (margin on selling price).'), F('riskPercent', '%', 'Unpaid invoices, credit notes.'), F('feePercent', '%', 'Bank charges, payment fees.'), F('taxPercent', '%', 'Average rate of tax on profit: ask your accountant.'), F('targetNet', '€/year', 'Profit you want on top of your pay, which is already counted.')]}
    ],
    watch: ['riskPercent', 'feePercent', 'taxPercent']
  }
};
var DEF = {
  fabrication: {name: 'Batch of country loaves (example)', v: {quantity: '20', unit: 'pièce', price: '3,76', priceMode: 'HT', vat: '', materialsTotal: '4,57', minutes: '90', laborHourly: '29,50', fixedMonthly: '0', productiveHours: '160', lossPercent: '0', marginPercent: '35', riskPercent: '2', feePercent: '1,2', taxPercent: '25', targetNet: '20', targetScope: 'lot', country: 'BE', unsoldPercent: ''}, lists: {materials: [{name: 'T65 flour', qty: '6', u: 'kg', price: '0,7617'}]}, mode: {materials: 'total'}},
  travaux: {name: 'Tiled roof, 180 m² (example)', v: {surface: '180', pricePerM2: '59,38', priceMode: 'HT', vat: '', yieldPerDay: '22', hoursPerDay: '8', materialPerM2: '24,377', lossPercent: '0', fuelLitersPerDay: '12', fuelPrice: '1,65', consumablesPerDay: '15', scaffoldingPerDay: '45', machinePerDay: '0', skipCost: '320', distanceKm: '46', costPerKm: '0,55', tripsMode: 'daily', tripsPerDay: '1', trips: '', otherCosts: '0', financingCost: '0', fullDays: 'false', fixedPercent: '12', contingencyPercent: '7', marginPercent: '18', retentionPercent: '0', riskPercent: '3', feePercent: '1,5', taxPercent: '25', targetNet: '2000', country: 'BE', scaffoldingFixed: '', weatherDays: ''}, lists: {team: [{name: 'Foreman', count: '1', hourlyCost: '42'}, {name: 'Skilled workers', count: '2', hourlyCost: '36'}, {name: 'Labourer', count: '1', hourlyCost: '26'}], materials: [{name: 'Interlocking tile', qty: '13', u: 'pièce', price: '1,4581'}, {name: 'Batten 27×40', qty: '3,2', u: 'm', price: '1,045'}, {name: 'Roofing underlay', qty: '1,1', u: 'm²', price: '1,89'}]}, mode: {materials: 'total'}},
  services: {name: '2-person firm (example)', v: {persons: '2', weeks: '44', weeklyHours: '40', billablePercent: '62', rate: '75', priceMode: 'HT', vat: '', directorMode: 'direct', directorAnnualCost: '69600', directorNet: '48000', contributionPercent: '45', staffAnnual: '38000', structureTotal: '36500', marginPercent: '20', riskPercent: '2', feePercent: '1', taxPercent: '25', targetNet: '30000', country: 'BE', dayHours: ''}, lists: {structure: [{name: '', cost: ''}]}, mode: {structure: 'total'}}
};
var SELECTS = ['priceMode','unit','targetScope','tripsMode','directorMode','fullDays','country'];
function freshState(type, empty){
  var d = clone(DEF[type]);
  if (DEC === '.'){
    var dot = function(x){ return typeof x === 'string' && /^\d+,\d+$/.test(x) ? x.replace(',', '.') : x; };
    Object.keys(d.v).forEach(function(k){ d.v[k] = dot(d.v[k]); });
    Object.keys(d.lists).forEach(function(l){ d.lists[l].forEach(function(r){ Object.keys(r).forEach(function(c){ r[c] = dot(r[c]); }); }); });
  }
  if (empty){
    Object.keys(d.v).forEach(function(k){ if (SELECTS.indexOf(k) < 0) d.v[k] = ''; });
    Object.keys(d.lists).forEach(function(l){ var cols = Object.keys(d.lists[l][0]); d.lists[l] = [cols.reduce(function(o, c){ o[c] = ''; return o; }, {})]; });
    d.name = '';
  }
  return {type: type, name: d.name, client: '', v: d.v, lists: d.lists, mode: d.mode, example: !empty, savedId: null, savedName: null, carryNote: ''};
}
var S = lsGet('pnr-draft-v2-en');
if (!S || !CFG[S.type]) S = freshState('fabrication');
var cache = {};
cache[S.type] = S;
function saveDraft(){ lsSet('pnr-draft-v2-en', S); }
function unitWord(){ return UNIT_WORD[S.v.unit] || S.v.unit || 'piece'; }
function suffixOf(f){ return f.s ? f.s.replace('@unit', S.type === 'fabrication' ? unitWord() : '') : ''; }

// ---------- calcul complet : rendu du formulaire ----------
function fieldHTML(f, value){
  var id = 'f-' + f.k, label = LABELS[f.k] || f.k;
  if (f.kind === 'sel'){
    var opts = f.o.slice(); if (value && !opts.some(function(o){ return o[0] === value; })) opts.push([value, value]);
    return '<div class="field" data-field="' + f.k + '"><label for="' + id + '">' + label + '</label><div class="inp"><select id="' + id + '" data-k="' + f.k + '">' + opts.map(function(o){ return '<option value="' + esc(o[0]) + '"' + (o[0] === value ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></div></div>';
  }
  if (f.kind === 'vatpick'){
    var rates = VAT_RATES[S.v.country || 'BE'] || [], cur = clean(value || ''), inList = rates.some(function(x){ return clean(x) === cur; });
    var choice = S.v.vatChoice !== undefined ? S.v.vatChoice : (cur === '' ? '' : inList ? cur : 'autre');
    if (choice !== '' && choice !== 'autre' && !rates.some(function(x){ return clean(x) === choice; })) choice = cur === '' ? '' : 'autre';
    var sel = '<select id="f-vatChoice" data-vat="1"><option value="">Choose the rate</option>' + rates.map(function(x){ return '<option value="' + esc(clean(x)) + '"' + (choice === clean(x) ? ' selected' : '') + '>' + esc(x) + ' %</option>'; }).join('') + '<option value="autre"' + (choice === 'autre' ? ' selected' : '') + '>Other rate</option></select>';
    return '<div class="field" data-field="vat"><label for="f-vatChoice">' + label + ' <span class="mute" style="font-weight:400">(optional)</span></label><div class="inp">' + sel + '</div>' + (choice === 'autre' ? '<div class="inp" style="margin-top:6px"><input id="f-vat" inputmode="decimal" autocomplete="off" data-k="vat" value="' + esc(value || '') + '" aria-label="VAT rate"><em>%</em></div>' : '') + (f.h ? '<span class="hint">' + esc(f.h) + '</span>' : '') + '</div>';
  }
  if (f.kind === 'bool') return '<label class="check"><input type="checkbox" id="' + id + '" data-k="' + f.k + '"' + (value === 'true' ? ' checked' : '') + '><span><b>' + label + '</b><br><span class="mute small">' + esc(f.h || '') + '</span></span></label>';
  var s = suffixOf(f);
  return '<div class="field" data-field="' + f.k + '"><label for="' + id + '">' + label + (f.req ? '' : ' <span class="mute" style="font-weight:400">(optional)</span>') + '</label><div class="inp"><input id="' + id + '" inputmode="decimal" autocomplete="off" data-k="' + f.k + '" value="' + esc(value || '') + '">' + (s ? '<em>' + s + '</em>' : '') + '</div>' + (f.h ? '<span class="hint">' + esc(f.h) + '</span>' : '') + '</div>';
}
function listHTML(def, rows, isAlt){
  var cols = def.cols;
  return '<div class="rows" data-field="' + def.list + '" style="--cols:' + (cols.length - 1) + '">' + rows.map(function(r, i){
    return '<div class="row">' + cols.map(function(c){
      var id = 'r-' + def.list + '-' + i + '-' + c.k;
      var attrs = ' data-list="' + def.list + '" data-row="' + i + '" data-col="' + c.k + '"';
      var ctl = c.sel ? '<select id="' + id + '"' + attrs + '>' + c.sel.map(function(o){ return '<option value="' + o[0] + '"' + ((r[c.k] || c.sel[0][0]) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>'
        : '<input id="' + id + '" ' + (c.text ? 'class="txt"' : 'inputmode="decimal"') + (def.lib && c.k === 'name' ? ' list="lib-names"' : '') + ' autocomplete="off"' + attrs + ' value="' + esc(r[c.k] || '') + '">';
      return '<div class="field"><label for="' + id + '" class="small">' + c.l + (c.s ? ' <span class="mute">(' + c.s + ')</span>' : '') + '</label><div class="inp">' + ctl + '</div></div>';
    }).join('') + '<button type="button" class="x" data-del="' + def.list + ':' + i + '" aria-label="Delete line">×</button>' + (def.calc ? '<span class="row-cost num" data-rowcost="' + def.list + ':' + i + '"></span>' : '') + '</div>';
  }).join('') + '</div><div class="btn-row" style="margin-top:8px"><button type="button" class="btn btn-line btn-sm" data-add="' + def.list + '">+ Add a line</button>' + (def.lib ? '<button type="button" class="btn btn-ghost btn-sm" data-libsave="' + def.list + '">Save these prices to “My purchase prices”</button>' : '') + '</div>';
}
function dirHTML(){
  var m = S.v.directorMode || 'direct';
  var opts = [['direct','I know the total annual cost'],['markup','Net + charges as % of net'],['fraction','Charges as % of total cost']];
  var h = '<div class="seg" role="group" aria-label="Method">' + opts.map(function(o){ return '<button type="button" data-dir="' + o[0] + '" aria-pressed="' + (m === o[0]) + '">' + o[1] + '</button>'; }).join('') + '</div><div class="fields two" style="margin-top:12px">';
  if (m === 'direct') h += fieldHTML(F('directorAnnualCost', '€/year', 'What the owner costs the business, contributions included. Enter 0 only if you count it elsewhere.', {req: 1}), S.v.directorAnnualCost);
  else h += fieldHTML(F('directorNet', '€/year', 'After social contributions, before income tax.', {req: 1}), S.v.directorNet) + fieldHTML(F('contributionPercent', '%', m === 'markup' ? 'Cost = net × (1 + rate). Enter 0 if none.' : 'Cost = net ÷ (1 − rate), rate below 100%.', {req: 1}), S.v.contributionPercent);
  return h + '</div><p class="hint" style="margin-top:8px">Your social charge rate depends on your status and your country: ask your accountant or your social security fund.</p>';
}
function blockHTML(b, isDetail){
  var inner = '';
  if (b.dir) inner += dirHTML();
  if (b.alt){
    var mode = S.mode[b.alt.list] || 'total';
    inner += '<div class="seg" role="group" aria-label="Input mode" style="margin-bottom:10px"><button type="button" data-mode="' + b.alt.list + ':total" aria-pressed="' + (mode === 'total') + '">One total</button><button type="button" data-mode="' + b.alt.list + ':list" aria-pressed="' + (mode === 'list') + '">Line by line</button></div>';
    inner += mode === 'total' ? '<div class="fields">' + fieldHTML(Object.assign({req: 1}, b.alt.total), S.v[b.alt.total.k]) + '</div>' : listHTML(b.alt, S.lists[b.alt.list], true);
  }
  if (b.list) inner += listHTML(b.list, S.lists[b.list.list], false);
  if (b.f){
    var fs = b.f.filter(function(f){ return !f.only || (S.v.tripsMode || 'daily') === f.only; });
    inner += '<div class="fields two"' + (b.alt || b.list ? ' style="margin-top:12px"' : '') + '>' + fs.map(function(f){ return fieldHTML(f, S.v[f.k]); }).join('') + '</div>';
  }
  if (isDetail) return '<details class="block"><summary>' + b.t + '<span class="sum-vals" data-sum="' + esc(b.t) + '"></span></summary>' + inner + '</details>';
  return '<div class="block"><h3>' + b.t + '</h3>' + inner + '</div>';
}
function renderForm(){
  var c = CFG[S.type];
  var openState = renderForm.lastType === S.type ? $$('#c-form details').map(function(d){ return d.open; }) : [];
  renderForm.lastType = S.type;
  $('#c-form').innerHTML = c.blocks.map(function(b){ return blockHTML(b, false); }).join('') + c.details.map(function(b){ return blockHTML(b, true); }).join('');
  $$('#c-form details').forEach(function(d, i){ if (openState[i]) d.open = true; });
  $('#c-name').value = S.name || '';
  $('#c-client').value = S.client || '';
  var note = S.carryNote || (S.example ? 'Example loaded: replace every figure with yours, including in the collapsed sections.' : '');
  $('#c-example-note').textContent = note; $('#c-example-note').hidden = !note;
  $$('.type').forEach(function(b){ b.setAttribute('aria-pressed', String(b.getAttribute('data-type') === S.type)); });
  updateSummaries();
}
// résumé des sections repliées : on voit leurs valeurs sans les ouvrir
function updateSummaries(){
  CFG[S.type].details.forEach(function(b){
    var el = $('[data-sum="' + b.t.replace(/"/g, '\\"') + '"]'); if (!el) return;
    var parts = b.f.filter(function(f){ return f.kind !== 'sel' && f.kind !== 'bool' && /%/.test(f.s || ''); }).map(function(f){ var v = S.v[f.k]; return (LABELS[f.k] || f.k).split(' (')[0].split(' sur ')[0] + ' ' + (blank(v) ? '0' : v) + ' %'; });
    el.textContent = parts.length ? parts.join(' · ') : '';
  });
}
function setType(t){
  if (!CFG[t]) return;
  cache[S.type] = S;
  S = cache[t] || freshState(t);
  cache[t] = S;
  renderForm(); compute(); saveDraft(); renderDatalist();
}

// ---------- calcul complet : lecture des saisies ----------
function allFields(type){
  var c = CFG[type], out = [];
  c.blocks.concat(c.details).forEach(function(b){ (b.f || []).forEach(function(f){ out.push(f); }); });
  return out;
}
function buildInputs(st){
  var c = CFG[st.type], inputs = {}, err = null, notes = [];
  function setErr(field, msg){ if (!err) err = {field: field, msg: msg}; }
  function num(k, raw, label, req){
    if (blank(raw)){ if (req) setErr(k, '“' + label + '” is required.'); return undefined; }
    var n = parseNum(raw);
    if (isNaN(n)){ setErr(k, '“' + label + '” is not a valid number.'); return undefined; }
    if (n < 0){ setErr(k, '“' + label + '” cannot be negative.'); return undefined; }
    if (dotThousands(raw)) notes.push('“' + raw + '” is read as ' + fmt(n, n % 1 ? 2 : 0) + (DEC === '.' ? ' — the comma separates thousands. Use a point for decimals (3.1).' : ' — the point separates thousands. Use a comma for decimals (3,1).'));
    return n;
  }
  allFields(st.type).forEach(function(f){
    var raw = st.v[f.k];
    if (f.kind === 'sel'){ if (raw) inputs[f.k] = raw; return; }
    if (f.kind === 'bool'){ inputs[f.k] = raw === 'true'; return; }
    if (f.kind === 'vatpick'){ var vv = num('vat', raw, LABELS.vat, false); if (vv !== undefined){ if (vv > 100) setErr('vat', 'The VAT rate must stay below 100%.'); inputs.vat = vv; } return; }
    if (f.only && (st.v.tripsMode || 'daily') !== f.only) return;
    var n = num(f.k, raw, LABELS[f.k], f.req); if (n !== undefined) inputs[f.k] = n;
  });
  c.blocks.forEach(function(b){
    var lists = [];
    if (b.alt){
      if ((st.mode[b.alt.list] || 'total') === 'total'){ var n = num(b.alt.total.k, st.v[b.alt.total.k], LABELS[b.alt.total.k], true); if (n !== undefined) inputs[b.alt.total.k] = n; }
      else lists.push({def: b.alt, alt: true});
    }
    if (b.list) lists.push({def: b.list, alt: false});
    lists.forEach(function(x){
      var def = x.def;
      var rows = (st.lists[def.list] || []).filter(function(r){ return Object.keys(r).some(function(k){ return String(r[k] || '').trim(); }); });
      if (!rows.length) setErr(def.list, x.alt ? 'Add at least one line to the ' + LABELS[def.list] + ' section, or switch back to “One total”.' : 'Add at least one person to your team, with their number and hourly cost.');
      inputs[def.list] = rows.map(function(r, i){
        var o = {};
        var legacy = def.calc && blank(r.qty) && blank(r.price) && !blank(r[def.out]);
        if (legacy){ o.name = String(r.name || '').trim() || '—'; o[def.out] = num(def.list, r[def.out], 'Cost (line ' + (i + 1) + ')', true); return o; }
        def.cols.forEach(function(col){
          if (col.text){ o[col.k] = String(r[col.k] || '').trim() || (col.k === 'name' ? '—' : ''); return; }
          if (col.sel){ o[col.k] = r[col.k] || col.sel[0][0]; return; }
          var n = num(def.list, r[col.k], col.l + ' (line ' + (i + 1) + ')', true);
          if (def.list === 'team' && col.k === 'count' && n === 0) setErr(def.list, 'Line ' + (i + 1) + ' of the team: the number must be at least 1, or delete the line.');
          o[col.k] = n;
        });
        if (def.calc){ var c0 = def.calc(o); o[def.out] = isFinite(c0) ? c0 : undefined; }
        return o;
      });
    });
    if (b.dir){
      var m = st.v.directorMode || 'direct';
      inputs.directorMode = m;
      if (m === 'direct'){ var a = num('directorAnnualCost', st.v.directorAnnualCost, LABELS.directorAnnualCost, true); if (a !== undefined) inputs.directorAnnualCost = a; }
      else { var dn = num('directorNet', st.v.directorNet, LABELS.directorNet, true); if (dn !== undefined) inputs.directorNet = dn; var cp = num('contributionPercent', st.v.contributionPercent, LABELS.contributionPercent, true); if (cp !== undefined) inputs.contributionPercent = cp; }
    }
  });
  if (inputs.priceMode === 'TTC' && inputs.vat === undefined) setErr('vat', 'Your price is incl. VAT: choose the VAT rate it includes.');
  var extra = {};
  if (st.type === 'fabrication' && inputs.unsoldPercent !== undefined){
    var u = inputs.unsoldPercent; delete inputs.unsoldPercent;
    if (u >= 100) setErr('unsoldPercent', 'Unsold goods must stay below 100% of production.');
    else if (u > 0 && inputs.quantity > 0){ extra.produced = inputs.quantity; extra.unsold = u; inputs.quantity = inputs.quantity * (1 - u / 100); }
  }
  if (st.type === 'travaux'){
    var sf = inputs.scaffoldingFixed || 0, wd = inputs.weatherDays || 0; delete inputs.scaffoldingFixed; delete inputs.weatherDays;
    var wcost = wd * ((inputs.scaffoldingPerDay || 0) + (inputs.machinePerDay || 0));
    if (sf + wcost > 0){ extra.scaffoldFixed = sf; extra.weatherDays = wd; extra.weatherCost = wcost; inputs.otherCosts = (inputs.otherCosts || 0) + sf + wcost; }
  }
  if (st.type === 'services'){ extra.dayHours = inputs.dayHours > 0 ? inputs.dayHours : 8; delete inputs.dayHours; }
  if (inputs.vat !== undefined) extra.vat = inputs.vat;
  delete inputs.country;
  if (st.type === 'travaux' && (st.v.tripsMode || 'daily') === 'fixed' && inputs.distanceKm > 0 && inputs.trips === undefined) setErr('trips', '“Fixed number” mode: enter the number of trips for the job.');
  return {inputs: inputs, err: err, notes: notes, extra: extra};
}
function runEngine(st){
  var b = buildInputs(st);
  if (b.err) return {err: b.err, inputs: b.inputs, notes: b.notes, extra: b.extra};
  try { return {r: PNR.calculate(st.type, b.inputs), inputs: b.inputs, notes: b.notes, extra: b.extra}; }
  catch (e){
    if (e instanceof PNR.PnrError){
      var f = e.field || '', label = LABELS[f];
      return {err: {field: f, msg: label ? '“' + label + '”: value out of range.' : e.message}, inputs: b.inputs, notes: b.notes, extra: b.extra};
    }
    throw e;
  }
}

// ---------- calcul complet : résultat ----------
function L(label, value, cls){ return '<li class="' + (cls || '') + '"><span>' + label + '</span><i></i><span class="num">' + value + '</span></li>'; }
function unitOf(st, r){ return st.type === 'fabrication' ? (UNIT_WORD[r.details.unit] || r.details.unit || 'piece') : st.type === 'travaux' ? 'm²' : 'h'; }
function netLabel(st){ return st.type === 'services' ? 'Profit after tax, on top of your pay' : 'Real net after tax'; }
// avertissements du moteur à masquer selon le cas (mêmes textes que dans le moteur)
var W_TARGET = 'Target out of reach at the current rate within the available capacity.';
var W_NOPRICE = ['The current price makes a loss on the figures entered.', W_TARGET, 'Recoverable retentions are a cash-flow delay, not a loss. Financing cost must be entered separately.'];
function cleanWarnings(st, r){
  var hasPrice = r.revenue > 0;
  return r.warnings.filter(function(w){
    if (w === PNR.DISCLAIMER) return false;
    if (!hasPrice && W_NOPRICE.indexOf(w) >= 0) return false;
    if (w === W_TARGET && !(r.details.targetNet > 0)) return false;
    return true;
  });
}
var lastRun = null;
function resultHTML(st, run){
  if (run.err) return '<p class="eyebrow">A figure is missing</p><p class="err">' + esc(run.err.msg) + '</p><p class="limit">The calculation updates as soon as the box is corrected.</p>';
  var r = run.r, d = r.details, u = unitOf(st, r), per = ' / ' + u;
  var hasPrice = r.revenue > 0;
  var h = '';
  if (run.notes.length) h += '<p class="gap">' + run.notes.map(esc).join('<br>') + '</p>';
  var ex = run.extra || {};
  var uPl = UNIT_PL[u] || u;
  if (ex.unsold) h += '<p class="limit" style="border:0;padding:0">Calculated on ' + fmt(d.quantity, d.quantity % 1 ? 2 : 0) + ' ' + uPl + ' sold out of ' + fmt(ex.produced, ex.produced % 1 ? 2 : 0) + ' produced (' + fmt(ex.unsold, 1) + ' % unsold): the cost is spread over what is sold.</p>';
  h += '<p class="eyebrow">Your floor price</p><p class="big">' + eur(r.minimumPrice) + '<small>excl. VAT' + per + '</small></p>' +
    '<p class="small" style="color:var(--night-mute)">Below this price, you lose money: it pays all your costs, risks and fees, with no profit.</p><ul class="lines">';
  h += L('Cost price', eur(d.beforeFeesThreshold) + per);
  h += L('Floor price', eur(r.minimumPrice) + per, 'strong');
  if (d.marginPercent > 0) h += L('Recommended price (margin ' + fmt(d.marginPercent, d.marginPercent % 1 ? 1 : 0) + ' %)', eur(r.recommendedPrice) + per);
  var unitTarget = st.type === 'fabrication' && d.targetScope === 'unit';
  if (d.targetNet > 0) h += L('Price to keep ' + eur(unitTarget ? d.targetNet / d.quantity : d.targetNet, 0) + (unitTarget ? ' per ' + u : st.type === 'services' ? ' a year' : '') + ' net', eur(r.targetPrice) + per, 'strong');
  if (hasPrice) h += L('Your current price' + (st.v.priceMode === 'TTC' ? ' (converted to excl. VAT)' : ''), eur(r.currentPrice) + per);
  h += '</ul>';
  if (ex.vat !== undefined && ex.vat > 0){
    var tt = function(x){ return eur(x * (1 + ex.vat / 100)) + per; };
    h += '<p class="eyebrow" style="margin-top:2px">The same prices incl. VAT (VAT ' + fmt(ex.vat, ex.vat % 1 ? 1 : 0) + ' %)</p><ul class="lines">' + L('Floor price incl. VAT', tt(r.minimumPrice)) + (d.marginPercent > 0 ? L('Recommended price incl. VAT', tt(r.recommendedPrice)) : '') + (d.targetNet > 0 ? L('Price for your target incl. VAT', tt(r.targetPrice)) : '') + (hasPrice ? L('Your current price incl. VAT', tt(r.currentPrice)) : '') + '</ul>';
  }
  if (st.type === 'services'){
    var dh = ex.dayHours || 8, dd = function(x){ return eur(x * dh) + ' / day'; };
    h += '<p class="eyebrow" style="margin-top:2px">Per day (' + fmt(dh, dh % 1 ? 1 : 0) + ' h billed)</p><ul class="lines">' + L('Floor price', dd(r.minimumPrice)) + (d.marginPercent > 0 ? L('Recommended price', dd(r.recommendedPrice)) : '') + (d.targetNet > 0 ? L('Price for your target', dd(r.targetPrice)) : '') + (hasPrice ? L('Your current rate', dd(r.currentPrice)) : '') + '</ul>';
  }
  if (d.marginPercent > 0 && r.recommendedPrice < r.minimumPrice - 1e-9) h += '<p class="gap">Your target margin (' + fmt(d.marginPercent, 1) + ' %) is smaller than your risks and fees (' + fmt(d.riskPercent + d.feePercent, 1) + ' %): the recommended price falls below your floor price. Raise your margin.</p>';
  if (hasPrice){
    if (r.currentPrice < r.minimumPrice - 1e-9) h += '<p class="verdict">Your price is below your floor price: you\'re short by ' + eur(r.minimumPrice - r.currentPrice) + per + '.</p>';
    else if (d.targetNet > 0 && r.currentPrice < r.targetPrice - 1e-9) h += '<p class="verdict">Profitable, but below your target: you\'re short by ' + eur(r.targetPrice - r.currentPrice) + per + '.</p>';
    else h += '<p class="verdict good">Your price covers your costs' + (d.targetNet > 0 ? ' and meets your target' : '') + '.</p>';
    var rows = [['Revenue excl. VAT', r.revenue, 'hsl(218 30% 60%)']].concat(r.breakdown.map(function(b){ return [BREAK_LABEL[b.label] || b.label, b.amount, 'hsl(214 16% 62%)']; })).concat([['What you keep', r.net, r.net >= 0 ? 'var(--ok-night)' : 'var(--loss-night)']]);
    h += '<p class="eyebrow" style="margin-top:4px">Where your price goes</p><ul class="cascade-night">' + rows.filter(function(x){ return Math.abs(x[1]) > 0.004 || x[0] === 'What you keep'; }).map(function(x){
      var w = Math.min(100, Math.abs(x[1]) / r.revenue * 100);
      return '<li><div class="lab"><span>' + x[0] + '</span><span class="num">' + eur(x[1]) + '</span></div><div class="track"><i style="width:' + w.toFixed(1) + '%;background:' + x[2] + '"></i></div></li>';
    }).join('') + '</ul>';
    var div = st.type === 'fabrication' ? d.quantity : st.type === 'travaux' ? d.surface : d.hours;
    h += '<ul class="lines">' + L(netLabel(st), '<span class="' + (r.net >= 0 ? 'pos' : 'neg') + '">' + eur(r.net) + '</span>', 'strong') + L('Per ' + u, eur(r.net / div)) + L('That\'s', fmt(r.net / r.revenue * 100, 1) + ' % of the price excl. VAT') + '</ul>';
  } else {
    h += '<p class="gap">Enter your current price to see what you keep and what eats into it.</p>';
  }
  h += '<p class="eyebrow" style="margin-top:4px">Details</p><ul class="lines">';
  if (st.type === 'fabrication'){
    h += L('Hourly cost used (time + fixed costs)', eur(d.hourly) + ' / h') + L('Batch materials', eur(d.material)) + L('Batch time', eur(d.labor));
  } else if (st.type === 'services'){
    h += L('Hours worked per year', fmt(d.paidHours, 0) + ' h') + L('Hours billed per year', fmt(d.hours, 0) + ' h') + L('Annual costs', eur(r.cost, 0));
    if (d.targetNet > 0 && hasPrice && d.requiredHours !== null) h += L('Hours to bill for your target', fmt(d.requiredHours, 0) + ' h');
  } else {
    h += L('Job duration', fmt(d.duration, 2) + ' d (' + d.days + ' d counted)') + L('Labour', eur(d.labor)) + L('Materials', eur(d.material)) + L('Job costs', eur(d.expenses));
    if (hasPrice) h += L('Minimum output at this price', d.equilibriumStatus === 'found' ? fmt(d.displayedEquilibriumYield, 2) + ' m²/worker/d' : d.equilibriumStatus === 'any' ? 'no limit' : 'none', 'strong');
    if (d.retentionAmount > 0) h += L('Retention paid later', eur(d.retentionAmount));
    if (ex.scaffoldFixed > 0) h += L('Scaffolding, flat fee (in costs)', eur(ex.scaffoldFixed));
    if (ex.weatherCost > 0) h += L(fmt(ex.weatherDays, 0) + ' bad-weather days (in costs)', eur(ex.weatherCost));
  }
  h += '</ul>';
  if (st.type === 'services' && d.targetNet > 0 && hasPrice && d.impossible) h += '<p class="verdict">Your target is out of reach at this rate: it would take ' + fmt(d.requiredHours, 0) + ' billed hours, you have ' + fmt(d.hours, 0) + '. Raise your price.</p>';
  if (st.type === 'services') h += '<p class="limit">Sole trader: the tax on your own pay isn\'t counted here. The profit comes on top of your pay.</p>';
  if (st.type === 'travaux' && hasPrice){
    var planned = parseNum(st.v.yieldPerDay);
    if (d.equilibriumStatus === 'found'){
      if (planned < d.displayedEquilibriumYield) h += '<p class="verdict">Your planned output (' + fmt(planned, 2) + ') is already below the minimum (' + fmt(d.displayedEquilibriumYield, 2) + ' m²/worker/d): at this price, the job loses money.</p>';
      else h += '<p class="gap">If your team drops below <b>' + fmt(d.displayedEquilibriumYield, 2) + ' m² per worker per day</b>, this job costs you money. You\'re planning ' + fmt(planned, 2) + '.</p>';
    } else if (d.equilibriumStatus === 'impossible') h += '<p class="verdict">Even with an infinitely fast team, this price doesn\'t pay for the materials and fixed costs of the job.</p>';
  }
  var zero = CFG[st.type].watch.filter(function(k){ return !(parseNum(st.v[k]) > 0); }).map(function(k){ return lower((LABELS[k] || k).split(' (')[0]); });
  if (zero.length) h += '<p class="limit">Counted as 0 in this calculation: ' + zero.join(', ') + '. Check that\'s intended.</p>';
  var warns = cleanWarnings(st, r);
  if (warns.length) h += '<ul class="warns">' + warns.map(function(w){ return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>';
  return h;
}
function miniHTML(st, run){
  if (run.err) return '<span class="mini-err">' + esc(run.err.msg) + '</span>';
  var r = run.r, u = unitOf(st, r);
  return '<span>Floor <b class="num">' + eur(r.minimumPrice) + '/' + u + '</b></span>' + (r.revenue > 0 ? '<span>You keep <b class="num ' + (r.net >= 0 ? 'pos' : 'neg') + '">' + eur(r.net, 0) + '</b></span>' : '') + '<a href="#c-result" data-scroll="1">Details ↓</a>';
}
var computeT;
function compute(){
  clearTimeout(computeT);
  var run = runEngine(S);
  lastRun = run;
  $('#c-result').innerHTML = resultHTML(S, run);
  $('#c-mini-body').innerHTML = miniHTML(S, run);
  $$('#c-form .bad').forEach(function(f){ f.classList.remove('bad'); });
  $$('#c-form .field-err').forEach(function(x){ x.remove(); });
  if (run.err && run.err.field){
    var bad = $('#c-form [data-field="' + run.err.field + '"]');
    if (bad){ bad.classList.add('bad'); var p = document.createElement('p'); p.className = 'field-err'; p.textContent = run.err.msg; bad.appendChild(p); }
  }
  $('#c-save').disabled = !!run.err; $('#c-copy').disabled = !!run.err; $('#c-pdf').disabled = !!run.err;
  updateSummaries();
  $$('[data-rowcost]').forEach(function(el){
    var p = el.getAttribute('data-rowcost').split(':'), r = (S.lists[p[0]] || [])[+p[1]] || {};
    var q = parseNum(r.qty), pr = parseNum(r.price);
    var v = S.type === 'fabrication' ? q * (MAT_FACTOR[r.u || 'kg'] || 1) * pr : q * pr;
    el.textContent = q >= 0 && pr >= 0 && isFinite(v) ? '= ' + eur(v) + (S.type === 'travaux' ? ' / m²' : '') : '';
  });
}
function scheduleCompute(){ clearTimeout(computeT); computeT = setTimeout(function(){ compute(); saveDraft(); }, 150); }

$('#c-form').addEventListener('input', function(e){
  var t = e.target;
  if (t.tagName === 'SELECT' || t.type === 'checkbox') return;
  if (t.dataset.k){ S.v[t.dataset.k] = t.value; }
  else if (t.dataset.list){
    var row = S.lists[t.dataset.list][+t.dataset.row]; row[t.dataset.col] = t.value;
    if (t.dataset.col === 'name' && t.dataset.list === 'materials'){
      var it = Lib.find(t.value, S.type);
      if (it && blank(row.price)){ row.price = it.price; var pe = $('#r-materials-' + t.dataset.row + '-price'); if (pe) pe.value = it.price; if (it.u){ row.u = it.u; var ue = $('#r-materials-' + t.dataset.row + '-u'); if (ue) ue.value = it.u; } }
    }
  }
  S.example = false; S.carryNote = ''; $('#c-example-note').hidden = true;
  scheduleCompute();
});
$('#c-form').addEventListener('change', function(e){
  var t = e.target;
  if (t.dataset.vat){ var c = t.value; S.v.vatChoice = c; if (c === '') S.v.vat = ''; else if (c !== 'autre') S.v.vat = c; renderForm(); compute(); saveDraft(); return; }
  if (t.dataset.list && t.tagName === 'SELECT'){ S.lists[t.dataset.list][+t.dataset.row][t.dataset.col] = t.value; compute(); saveDraft(); return; }
  if (t.dataset.k === 'country'){ S.v.country = t.value; S.v.vatChoice = undefined; var rates = (VAT_RATES[t.value] || []).map(clean); if (!blank(S.v.vat) && rates.indexOf(clean(S.v.vat)) < 0) S.v.vatChoice = 'autre'; renderForm(); compute(); saveDraft(); return; }
  if (t.tagName === 'SELECT' || t.type === 'checkbox'){
    S.v[t.dataset.k] = t.type === 'checkbox' ? String(t.checked) : t.value;
    if (t.dataset.k === 'unit' || t.dataset.k === 'tripsMode') renderForm();
    compute(); saveDraft();
  }
});
$('#c-form').addEventListener('click', function(e){
  var b = e.target.closest('button'); if (!b) return;
  if (b.dataset.add){
    var blk = CFG[S.type].blocks.filter(function(x){ return (x.alt && x.alt.list === b.dataset.add) || (x.list && x.list.list === b.dataset.add); })[0];
    var def = blk.alt && blk.alt.list === b.dataset.add ? blk.alt : blk.list;
    S.lists[b.dataset.add].push(def.cols.reduce(function(o, c){ o[c.k] = ''; return o; }, {}));
  }
  else if (b.dataset.del){ var p = b.dataset.del.split(':'); S.lists[p[0]].splice(+p[1], 1); if (!S.lists[p[0]].length) S.lists[p[0]].push({}); }
  else if (b.dataset.mode){ var q = b.dataset.mode.split(':'); S.mode[q[0]] = q[1]; }
  else if (b.dataset.dir){ S.v.directorMode = b.dataset.dir; }
  else if (b.dataset.libsave){
    var n = 0;
    (S.lists[b.dataset.libsave] || []).forEach(function(r){ if (blank(r.name) || blank(r.price) || isNaN(parseNum(r.price))) return; Lib.upsert({name: String(r.name).trim(), u: r.u || '', price: r.price, kind: S.type}); n++; });
    if (!n){ toast('Nothing to save: give each line a name and a price.'); return; }
    Lib.save().then(function(){ toast(n + (n > 1 ? ' prices' : ' price') + ' saved to “My purchase prices”.'); renderDatalist(); }, function(){ toast('Can\'t save in this browser.'); });
    return;
  }
  else return;
  renderForm(); compute(); saveDraft();
});
$('#c-name').addEventListener('input', function(e){ S.name = e.target.value; saveDraft(); });
$('#c-client').addEventListener('input', function(e){ S.client = e.target.value; saveDraft(); });
$$('.type').forEach(function(b){ b.addEventListener('click', function(){ setType(b.getAttribute('data-type')); }); });
$('#c-example').addEventListener('click', function(e){ if (!armed(e.currentTarget, 'Clear your figures? Tap again')) return; S = freshState(S.type); cache[S.type] = S; renderForm(); compute(); saveDraft(); toast('Example reloaded.'); });
$('#c-clear').addEventListener('click', function(e){ if (!armed(e.currentTarget, 'Clear everything? Tap again')) return; S = freshState(S.type, true); cache[S.type] = S; renderForm(); compute(); saveDraft(); });
document.addEventListener('click', function(e){ var a = e.target.closest('[data-scroll]'); if (a){ e.preventDefault(); $('#c-result').scrollIntoView({behavior: 'smooth', block: 'start'}); } });

// ---------- résumé texte et PDF ----------
var TYPE_NAME = {fabrication: 'Production', travaux: 'Construction', services: 'Services'};
function fieldDef(type, k){ var all = allFields(type); var f = all.filter(function(x){ return x.k === k; })[0]; if (f) return f; var c = CFG[type]; var out = null; c.blocks.forEach(function(b){ if (b.alt && b.alt.total.k === k) out = b.alt.total; }); return out; }
function summaryLines(st, run){
  var r = run.r, d = r.details, u = unitOf(st, r), per = ' / ' + u, out = [];
  out.push(['Cost price', eur(d.beforeFeesThreshold) + per]);
  out.push(['Floor price (risks and fees included)', eur(r.minimumPrice) + per]);
  if (d.marginPercent > 0) out.push(['Recommended price (margin ' + fmt(d.marginPercent, d.marginPercent % 1 ? 1 : 0) + ' % of the price)', eur(r.recommendedPrice) + per]);
  if (d.targetNet > 0) out.push(['Price for your net target', eur(r.targetPrice) + per]);
  if (r.revenue > 0){ out.push(['Current price excl. VAT', eur(r.currentPrice) + per]); out.push(['Revenue excl. VAT', eur(r.revenue)]); r.breakdown.forEach(function(b){ if (Math.abs(b.amount) > 0.004) out.push(['  ' + b.label, eur(b.amount)]); }); out.push([netLabel(st), eur(r.net)]); }
  if (st.type === 'travaux' && r.revenue > 0 && d.equilibriumStatus === 'found') out.push(['Minimum output at this price', fmt(d.displayedEquilibriumYield, 2) + ' m²/worker/day']);
  if (st.type === 'services'){ out.push(['Hours billed per year', fmt(d.hours, 0) + ' h']); if (d.targetNet > 0 && r.revenue > 0 && d.requiredHours !== null) out.push(['Hours needed for the target', fmt(d.requiredHours, 0) + ' h']); }
  return out;
}
var DIR_LABEL = {direct: 'total annual cost', markup: 'net + charges as % of net', fraction: 'charges as % of total cost'};
function inputLines(st){
  var b = buildInputs(st).inputs, out = [];
  Object.keys(b).forEach(function(k){
    var v = b[k], f = fieldDef(st.type, k), label = LABELS[k] || k;
    if (Array.isArray(v)){
      var blk = CFG[st.type].blocks.filter(function(x){ return (x.alt && x.alt.list === k) || (x.list && x.list.list === k); })[0];
      var def = blk ? (blk.alt && blk.alt.list === k ? blk.alt : blk.list) : null;
      v.forEach(function(row){ out.push([label, (def ? def.cols : []).map(function(c){ var x = row[c.k]; return typeof x === 'number' ? fmt(x, x % 1 ? 2 : 0) + (c.s ? ' ' + c.s : '') : x; }).join(' · ')]); });
    }
    else if (k === 'directorMode') out.push([label, DIR_LABEL[v] || v]);
    else if (typeof v === 'number') out.push([label, fmt(v, v % 1 ? 2 : 0) + (f && f.s ? ' ' + suffixOf(f) : '')]);
    else if (typeof v === 'boolean') { if (v) out.push([label, 'yes']); }
    else if (f && f.o){ var o = f.o.filter(function(x){ return x[0] === v; })[0]; out.push([label, o ? o[1] : v]); }
    else out.push([label, v]);
  });
  return out;
}
function summaryText(st, run){
  var t = 'PRIX NET RÉEL — ' + TYPE_NAME[st.type] + '\n' + (st.name || 'Calculation') + (st.client ? ' — ' + st.client : '') + '\n' + new Date().toLocaleDateString('en-GB') + '\n\n';
  t += summaryLines(st, run).map(function(l){ return l[0] + ' : ' + l[1]; }).join('\n');
  t += '\n\nInputs entered:\n' + inputLines(st).map(function(l){ return '- ' + l[0] + ' : ' + l[1]; }).join('\n');
  return t + '\n\n' + PNR.DISCLAIMER;
}
$('#c-copy').addEventListener('click', function(){
  compute(); if (!lastRun || lastRun.err) return;
  var text = summaryText(S, lastRun);
  try { navigator.clipboard.writeText(text).then(function(){ toast('Summary copied.'); }, function(){ fallbackCopy(text); }); } catch(e){ fallbackCopy(text); }
});
function fallbackCopy(text){ var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('Summary copied.'); } catch(e){ toast('Can\'t copy here: select the result text.'); } ta.remove(); }
var SITE = window.PNR_EDITION === 'site';
var downloads = null;
if (SITE){
  // site web : le navigateur télécharge le fichier directement
  downloads = {save: function(o){ var u = URL.createObjectURL(o.data), a = document.createElement('a'); a.href = u; a.download = o.filename; a.hidden = true; document.body.appendChild(a); a.click(); setTimeout(function(){ a.remove(); URL.revokeObjectURL(u); }, 4000); return Promise.resolve(); }};
  $('#c-pdf').hidden = false;
} else cap('downloads').then(function(d){ downloads = d; $('#c-pdf').hidden = !(d && window.jspdf); });
function pdfText(s){ return String(s).replace(/[  ]/g, ' ').replace(/−/g, '-').replace(/[“”]/g, '"'); }
function buildPdf(st, run){
  var J = window.jspdf.jsPDF, doc = new J({unit: 'mm', format: 'a4'}), y = 18, W = 210, M = 16;
  function line(a, b, bold){ if (y > 280){ doc.addPage(); y = 18; } doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(10); var la = doc.splitTextToSize(pdfText(a), 110); doc.text(la, M, y); if (b) doc.text(pdfText(b), W - M, y, {align: 'right'}); y += 5.5 * la.length; }
  doc.setFillColor(15, 26, 46); doc.rect(0, 0, W, 12, 'F'); doc.setFillColor(255, 122, 0); doc.rect(0, 12, W, 2, 'F');
  doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text('PRIX NET RÉEL', M, 8);
  doc.setTextColor(20, 28, 45); y = 26; doc.setFontSize(16); doc.text(pdfText(st.name || 'Calculation'), M, y); y += 7;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.text(pdfText(TYPE_NAME[st.type] + (st.client ? ' · ' + st.client : '') + ' · ' + new Date().toLocaleDateString('en-GB')), M, y); y += 10;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Results', M, y); y += 7;
  summaryLines(st, run).forEach(function(l, i){ line(l[0], l[1], i === 1); });
  y += 5; doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Inputs entered', M, y); y += 7;
  inputLines(st).forEach(function(l){ line(l[0], l[1]); });
  var warns = cleanWarnings(st, run.r);
  if (warns.length){ y += 5; doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Good to know', M, y); y += 7; warns.forEach(function(w){ line('• ' + w); }); }
  y += 6; doc.setFontSize(8); doc.setTextColor(100, 108, 120); doc.text(doc.splitTextToSize(pdfText(PNR.DISCLAIMER), W - 2 * M), M, Math.min(y, 285));
  return doc;
}
// site web : PDF avec pdf-lib, hébergé sur le site et chargé au premier clic
var WIN = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
function winAnsi(s){ return String(s).replace(/[\u00a0\u202f\u2009]/g, ' ').replace(/[−‐‑]/g, '-').replace(/≈/g, '~').replace(/[^\x20-\x7e\xa0-\xff]/g, function(c){ return WIN.indexOf(c) >= 0 ? c : '?'; }); }
var pdfLibReady = null;
function loadPdfLib(){
  if (window.PDFLib) return Promise.resolve(window.PDFLib);
  if (!pdfLibReady) pdfLibReady = new Promise(function(res, rej){ var sc = document.createElement('script'); sc.src = '/assets/pdf-lib.min.js'; sc.onload = function(){ res(window.PDFLib); }; sc.onerror = function(){ pdfLibReady = null; rej(new Error('pdf')); }; document.head.appendChild(sc); });
  return pdfLibReady;
}
function buildPdfSite(st, run){
  return loadPdfLib().then(function(L){
    return L.PDFDocument.create().then(function(doc){
      return Promise.all([doc.embedFont(L.StandardFonts.Helvetica), doc.embedFont(L.StandardFonts.HelveticaBold)]).then(function(f){
        var W = 595.28, H = 841.89, M = 45, page = doc.addPage([W, H]), y = H - 70, ink = L.rgb(0.08, 0.11, 0.18), grey = L.rgb(0.4, 0.42, 0.47);
        function wrap(text, font, size, max){ var words = winAnsi(text).split(' '), lines = [], cur = ''; words.forEach(function(w){ var t = cur ? cur + ' ' + w : w; if (font.widthOfTextAtSize(t, size) > max && cur){ lines.push(cur); cur = w; } else cur = t; }); if (cur) lines.push(cur); return lines; }
        function need(h){ if (y - h < 50){ page = doc.addPage([W, H]); y = H - 50; } }
        function title(t){ y -= 8; need(24); page.drawText(winAnsi(t), {x: M, y: y, size: 12, font: f[1], color: ink}); y -= 20; }
        function line(a, b, bold){ var font = bold ? f[1] : f[0], la = wrap(a, font, 10, b ? 320 : W - 2 * M); need(15 * la.length); la.forEach(function(l, i){ page.drawText(l, {x: M, y: y - 15 * i, size: 10, font: font, color: ink}); }); if (b){ var bb = winAnsi(b); page.drawText(bb, {x: W - M - font.widthOfTextAtSize(bb, 10), y: y, size: 10, font: font, color: ink}); } y -= 15 * la.length; }
        page.drawRectangle({x: 0, y: H - 34, width: W, height: 34, color: L.rgb(15 / 255, 26 / 255, 46 / 255)});
        page.drawRectangle({x: 0, y: H - 40, width: W, height: 6, color: L.rgb(1, 122 / 255, 0)});
        page.drawText('PRIX NET RÉEL', {x: M, y: H - 23, size: 11, font: f[1], color: L.rgb(1, 1, 1)});
        page.drawText(winAnsi(st.name || 'Calculation'), {x: M, y: y, size: 16, font: f[1], color: ink}); y -= 20;
        page.drawText(winAnsi(TYPE_NAME[st.type] + (st.client ? ' · ' + st.client : '') + ' · ' + new Date().toLocaleDateString('en-GB')), {x: M, y: y, size: 10, font: f[0], color: grey}); y -= 22;
        title('Results'); summaryLines(st, run).forEach(function(l, i){ line(l[0], l[1], i === 1); });
        title('Inputs entered'); inputLines(st).forEach(function(l){ line(l[0], l[1]); });
        var warns = cleanWarnings(st, run.r);
        if (warns.length){ title('Good to know'); warns.forEach(function(w){ line('• ' + w); }); }
        y -= 10; wrap(PNR.DISCLAIMER, f[0], 8, W - 2 * M).forEach(function(l){ need(11); page.drawText(l, {x: M, y: y, size: 8, font: f[0], color: grey}); y -= 11; });
        return doc.save().then(function(bytes){ return new Blob([bytes], {type: 'application/pdf'}); });
      });
    });
  });
}
// chinois, russe : la police intégrée au PDF ne connaît que l'alphabet latin ; on passe par l'impression du navigateur (« Enregistrer au format PDF »)
var PDF_PRINT = window.PNR_PDF === 'print';
function printReport(st, run){
  var rows = function(list){ return list.map(function(l){ return '<tr><td>' + esc(l[0]) + '</td><td class="v">' + esc(l[1] || '') + '</td></tr>'; }).join(''); };
  var warns = cleanWarnings(st, run.r);
  var html = '<!doctype html><html lang="' + esc(document.documentElement.lang || 'fr') + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(pdfName().replace(/\.pdf$/, '')) + '</title>' +
    '<style>body{font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#141c2d;margin:0;padding:0 22px 22px}.bar{background:#0f1a2e;color:#fff;padding:10px 22px;margin:0 -22px 18px;font-weight:800;letter-spacing:.04em;border-bottom:5px solid #ff7a00}h1{font-size:21px;margin:0 0 4px}h2{font-size:15px;margin:20px 0 6px}table{border-collapse:collapse;width:100%}td{padding:4px 0;border-bottom:1px solid #dde1e6;vertical-align:top}td.v{text-align:right;white-space:nowrap;padding-left:12px}.mute{color:#5c6470;font-size:11px;margin-top:18px}@media print{.bar{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body>' +
    '<div class="bar">PRIX NET RÉEL</div><h1>' + esc(st.name || 'Calculation') + '</h1><p>' + esc(TYPE_NAME[st.type] + (st.client ? ' · ' + st.client : '') + ' · ' + new Date().toLocaleDateString('en-GB')) + '</p>' +
    '<h2>' + esc('Results') + '</h2><table>' + rows(summaryLines(st, run)) + '</table><h2>' + esc('Inputs entered') + '</h2><table>' + rows(inputLines(st)) + '</table>' +
    (warns.length ? '<h2>' + esc('Good to know') + '</h2><ul>' + warns.map(function(w){ return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' : '') + '<p class="mute">' + esc(PNR.DISCLAIMER) + '</p></body></html>';
  var w = null;
  try { w = window.open('', '_blank'); } catch(e){ w = null; }
  if (w && w.document){
    w.document.open(); w.document.write(html); w.document.close();
    setTimeout(function(){ try { w.focus(); w.print(); } catch(e){} }, 300);
  } else {
    var old = $('#print-frame'); if (old) old.remove();
    var f = document.createElement('iframe'); f.id = 'print-frame'; f.setAttribute('aria-hidden', 'true'); f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
    document.body.appendChild(f);
    var d = f.contentWindow.document; d.open(); d.write(html); d.close();
    setTimeout(function(){ try { f.contentWindow.focus(); f.contentWindow.print(); } catch(e){ toast('Can\'t print here.'); } }, 300);
  }
  toast('For the PDF: choose “Save as PDF” in the print window.');
}
function pdfName(){ return 'prix-net-reel-' + ((S.name || 'calcul').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'calcul') + '.pdf'; }
$('#c-pdf').addEventListener('click', function(){
  if (SITE && PDF_PRINT){ compute(); if (!lastRun || lastRun.err) return; printReport(S, lastRun); return; }
  if (SITE){
    compute(); if (!lastRun || lastRun.err) return;
    var b = this; b.disabled = true;
    buildPdfSite(S, lastRun).then(function(blob){ return downloads.save({filename: pdfName(), data: blob}); }).then(function(){ toast('PDF ready.'); }, function(){ toast('The PDF couldn\'t be created. Try again.'); }).then(function(){ b.disabled = false; });
    return;
  }
  compute(); if (!lastRun || lastRun.err || !downloads || !window.jspdf) return;
  var doc = buildPdf(S, lastRun);
  var name = (S.name || 'calcul').replace(/[^\wÀ-ÿ -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'calcul';
  downloads.save({filename: 'prix-net-reel-' + name + '.pdf', data: doc.output('blob')}).then(function(){ toast('PDF ready.'); }, function(e){ if (e && e.code === 'declined') return; toast('The PDF couldn\'t be saved here.'); });
});

// ---------- enregistrement ----------
var Store = {mode: 'local', db: null, uid: null, ready: null};
Store.ready = Promise.all([cap('db'), cap('user')]).then(function(res){
  var db = res[0], user = res[1];
  if (!db || !user) return;
  return user.id().then(function(id){ if (id){ Store.db = db; Store.uid = id; Store.mode = 'db'; } }).catch(function(){});
});
function localAll(){ return lsGet('pnr-saved-v1-en') || []; }
Store.list = function(){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.collection('data/users/' + Store.uid).get().then(function(s){ return s.docs.filter(function(d){ return d.id !== 'prix'; }).map(function(d){ return Object.assign({id: d.id}, d.data()); }).filter(function(x){ return !!x.type; }); }, function(){ Store.mode = 'local'; return localAll(); });
  return localAll();
}); };
Store.save = function(rec){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.collection('data/users/' + Store.uid).doc(rec.id).set(rec).catch(function(){ Store.mode = 'local'; return Store.save(rec); });
  var all = localAll().filter(function(x){ return x.id !== rec.id; }); all.push(rec); if (!lsSet('pnr-saved-v1-en', all)) throw new Error('local');
}); };
Store.remove = function(id){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.collection('data/users/' + Store.uid).doc(id).delete().catch(function(){});
  lsSet('pnr-saved-v1-en', localAll().filter(function(x){ return x.id !== id; }));
}); };
$('#c-save').addEventListener('click', function(){
  compute(); if (!lastRun || lastRun.err) return;
  var r = lastRun.r;
  var name = (S.name || '').trim() || ('Calculation – ' + lower(TYPE_NAME[S.type]));
  var update = S.savedId && S.savedName === name;
  if (!update) S.savedId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  var rec = {id: S.savedId, type: S.type, name: name, client: S.client || '', savedAt: new Date().toISOString(), v: S.v, lists: S.lists, mode: S.mode,
    summary: {unit: unitOf(S, r), minimumPrice: r.minimumPrice, recommendedPrice: r.recommendedPrice, targetPrice: r.targetPrice, net: r.net, revenue: r.revenue, margin: r.details.marginPercent, target: r.details.targetNet}};
  $('#c-save').disabled = true;
  Store.save(rec).then(function(){ S.savedName = name; S.name = name; $('#c-name').value = name; saveDraft(); toast(update ? 'Calculation: ' + name + ' — updated.' : 'Calculation: ' + name + ' — saved. Change the name to keep a separate copy.'); }, function(){ toast('Can\'t save in this browser.'); }).then(function(){ $('#c-save').disabled = false; });
});
// ---------- mes prix d'achat ----------
var Lib = {items: []};
function libKey(n){ return String(n || '').trim().toLowerCase(); }
Lib.find = function(name, kind){ var k = libKey(name); if (!k) return null; return Lib.items.filter(function(x){ return libKey(x.name) === k && (!kind || x.kind === kind); })[0] || null; };
Lib.upsert = function(it){ var old = Lib.find(it.name, it.kind); if (old){ old.price = it.price; old.u = it.u || old.u; } else Lib.items.push(it); };
Lib.load = function(){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.doc('data/users/' + Store.uid + '/prix').get().then(function(d){ Lib.items = d.exists ? clone((d.data() || {}).items || []) : []; }, function(){ Lib.items = lsGet('pnr-prix-v1-en') || []; });
  Lib.items = lsGet('pnr-prix-v1-en') || [];
}).then(renderDatalist); };
Lib.save = function(){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.doc('data/users/' + Store.uid + '/prix').set({items: Lib.items});
  if (!lsSet('pnr-prix-v1-en', Lib.items)) throw new Error('local');
}); };
function renderDatalist(){ var dl = $('#lib-names'); if (!dl) return; dl.innerHTML = Lib.items.filter(function(x){ return x.kind === S.type; }).map(function(x){ return '<option value="' + esc(x.name) + '"></option>'; }).join(''); }
function applyLibrary(st){
  var n = 0;
  if (st.type !== 'fabrication' && st.type !== 'travaux') return 0;
  (st.lists.materials || []).forEach(function(r){ var it = Lib.find(r.name, st.type); if (!it) return; if (clean(it.price) !== clean(r.price || '')){ r.price = it.price; n++; } if (st.type === 'fabrication' && it.u && r.u !== it.u){ r.u = it.u; } });
  return st.mode && st.mode.materials === 'list' ? n : 0;
}
Lib.load();

// ---------- mes calculs : comparaison ----------
function stateFromRecord(x){ return {type: x.type, name: x.name, client: x.client, v: clone(x.v), lists: clone(x.lists), mode: clone(x.mode), example: false, savedId: x.id, savedName: x.name, carryNote: ''}; }
function compareHTML(list){
  if (!list.length) return '';
  var rows = list.map(function(x){
    var st = stateFromRecord(x), upd = applyLibrary(st), run = runEngine(st);
    if (run.err) return {x: x, rank: 4, html: '<td>' + esc(x.name) + '</td><td>' + esc(TYPE_NAME[x.type] || '') + '</td><td colspan="5" class="mute">To complete: ' + esc(run.err.msg) + '</td><td><span class="chip warn">incomplete</span></td>'};
    var r = run.r, d = r.details, u = unitOf(st, r), hasPrice = r.revenue > 0, status, rank;
    if (!hasPrice){ status = '<span class="chip">no price</span>'; rank = 3; }
    else if (r.currentPrice < r.minimumPrice - 1e-9){ status = '<span class="chip bad">below floor</span>'; rank = 0; }
    else if (d.targetNet > 0 && r.currentPrice < r.targetPrice - 1e-9){ status = '<span class="chip warn">below target</span>'; rank = 1; }
    else { status = '<span class="chip ok">profitable</span>'; rank = 2; }
    return {x: x, rank: rank, html: '<td>' + esc(x.name) + (upd ? ' <span class="mute small">(' + upd + ' price(s) updated)</span>' : '') + '</td><td>' + esc(TYPE_NAME[x.type] || '') + '</td>' +
      '<td class="num">' + eur(r.minimumPrice) + ' / ' + u + '</td><td class="num">' + (d.marginPercent > 0 ? eur(r.recommendedPrice) : '—') + '</td><td class="num">' + (hasPrice ? eur(r.currentPrice) : '—') + '</td>' +
      '<td class="num ' + (hasPrice ? (r.currentPrice - r.minimumPrice >= 0 ? 'pos' : 'neg') : '') + '">' + (hasPrice ? (r.currentPrice - r.minimumPrice >= 0 ? '+' : '') + eur(r.currentPrice - r.minimumPrice) : '—') + '</td><td class="num">' + (hasPrice ? eur(r.net, 0) : '—') + '</td><td>' + status + '</td>'};
  }).sort(function(a, b){ return a.rank - b.rank; });
  return '<h3 style="font-size:1.3rem;margin-bottom:10px">All your calculations, recalculated with today\'s purchase prices</h3><div class="tablewrap"><table class="cmp"><thead><tr><th>Calculation</th><th>Trade</th><th>Floor excl. VAT</th><th>Recommended excl. VAT</th><th>Current price excl. VAT</th><th>Gap to floor</th><th>You keep</th><th>Status</th></tr></thead><tbody>' + rows.map(function(r){ return '<tr>' + r.html + '</tr>'; }).join('') + '</tbody></table></div>';
}
function libEditorHTML(){
  var rows = Lib.items.map(function(x, i){
    return '<div class="row lib-row" style="--cols:3"><div class="field"><label class="small" for="lb-' + i + '-name">Name</label><div class="inp"><input class="txt" id="lb-' + i + '-name" data-lib="' + i + '" data-libcol="name" value="' + esc(x.name) + '"></div></div><div class="field"><label class="small" for="lb-' + i + '-u">Unit used</label><div class="inp"><input class="txt" id="lb-' + i + '-u" data-lib="' + i + '" data-libcol="u" value="' + esc(x.u || '') + '"></div></div><div class="field"><label class="small" for="lb-' + i + '-price">Purchase price (€ per kg, L or unit)</label><div class="inp"><input inputmode="decimal" id="lb-' + i + '-price" data-lib="' + i + '" data-libcol="price" value="' + esc(x.price || '') + '"></div></div><div class="field"><label class="small" for="lb-' + i + '-kind">For</label><div class="inp"><select id="lb-' + i + '-kind" data-lib="' + i + '" data-libcol="kind"><option value="fabrication"' + (x.kind === 'fabrication' ? ' selected' : '') + '>Production</option><option value="travaux"' + (x.kind === 'travaux' ? ' selected' : '') + '>Construction</option></select></div></div><button type="button" class="x" data-libdel="' + i + '" aria-label="Delete">×</button></div>';
  }).join('');
  return '<h3 style="font-size:1.3rem;margin-bottom:6px">My purchase prices</h3><p class="mute small" style="margin-bottom:10px">Change a price here and save: every calculation that uses this material (in line-by-line entry) is recalculated.</p>' +
    (rows ? '<div class="rows" style="--cols:3">' + rows + '</div>' : '<p class="mute small">No prices saved yet. In a calculation, switch materials to “Line by line” and tap “Save these prices”.</p>') +
    '<div class="btn-row" style="margin-top:10px"><button type="button" class="btn btn-line btn-sm" id="lib-add">+ Add a price</button>' + (Lib.items.length ? '<button type="button" class="btn btn-hivis btn-sm" id="lib-save">Save my prices</button>' : '') + '</div>';
}
document.addEventListener('input', function(e){ var t = e.target; if (t.dataset && t.dataset.lib !== undefined){ Lib.items[+t.dataset.lib][t.dataset.libcol] = t.value; } });
document.addEventListener('change', function(e){ var t = e.target; if (t.dataset && t.dataset.lib !== undefined && t.tagName === 'SELECT'){ Lib.items[+t.dataset.lib][t.dataset.libcol] = t.value; } });
document.addEventListener('click', function(e){
  var b = e.target.closest('#lib-add,#lib-save,[data-libdel]'); if (!b) return;
  if (b.id === 'lib-add'){ Lib.items.push({name: '', u: '', price: '', kind: S.type === 'travaux' ? 'travaux' : 'fabrication'}); $('#s-lib').innerHTML = libEditorHTML(); return; }
  if (b.dataset.libdel !== undefined){ Lib.items.splice(+b.dataset.libdel, 1); $('#s-lib').innerHTML = libEditorHTML(); return; }
  Lib.items = Lib.items.filter(function(x){ return !blank(x.name); });
  Lib.save().then(function(){ toast('Purchase prices saved. Your calculations have been recalculated.'); renderDatalist(); renderSaved(); }, function(){ toast('Can\'t save in this browser.'); });
});

function renderSaved(){
  $('#s-where').textContent = 'Loading…';
  Store.list().then(function(list){
    $('#s-where').textContent = Store.mode === 'db' ? 'Saved in your Claude account: visible only to you, on all your devices.' : 'Saved in this browser, on this device.';
    list.sort(function(a, b){ return String(b.savedAt).localeCompare(String(a.savedAt)); });
    $('#s-compare').innerHTML = compareHTML(list);
    $('#s-lib').innerHTML = libEditorHTML();
    if (!list.length){ $('#s-list').innerHTML = '<div class="empty"><b style="font-family:var(--f-display);font-size:1.2rem">No saved calculations</b><span class="mute">Do a full calculation, then tap “Save”.</span><a class="btn btn-hivis" href="#calcul">Start a calculation</a></div>'; return; }
    $('#s-list').innerHTML = list.map(function(x){
      var s = x.summary || {};
      return '<div class="saved-item"><div><p class="eyebrow">' + esc(TYPE_NAME[x.type] || '') + '</p><h3>' + esc(x.name || 'Calculation') + '</h3><p class="meta">' + (x.client ? esc(x.client) + ' · ' : '') + new Date(x.savedAt).toLocaleDateString('en-GB') + ' · floor <span class="num">' + eur(s.minimumPrice || 0) + ' / ' + esc(s.unit || '') + '</span>' + (s.revenue > 0 ? ' · you keep <span class="num">' + eur(s.net || 0) + '</span>' : '') + '</p></div><div class="btn-row"><button class="btn btn-line btn-sm" data-open-saved="' + esc(x.id) + '">Open</button><button class="btn btn-ghost btn-sm" data-del-saved="' + esc(x.id) + '">Delete</button></div></div>';
    }).join('');
    $$('[data-open-saved]').forEach(function(b){ b.addEventListener('click', function(){ var x = list.filter(function(i){ return i.id === b.getAttribute('data-open-saved'); })[0]; if (!x) return; S = stateFromRecord(x); var nU = applyLibrary(S); if (nU) S.carryNote = nU + ' price(s) updated from “My purchase prices”.'; cache[x.type] = S; renderForm(); compute(); saveDraft(); location.hash = 'calcul'; }); });
    $$('[data-del-saved]').forEach(function(b){ b.addEventListener('click', function(e){ if (!armed(e.currentTarget, 'Confirm')) return; Store.remove(b.getAttribute('data-del-saved')).then(renderSaved); }); });
  });
}

// ---------- assistant ----------
var A = {sample: null, tools: false, turns: [], ctl: null, last: null};
// début de question et exemple proposés selon le métier choisi
var ASK_START = {fabrication: 'I make a product and I want to know my real cost price and my floor price. ', travaux: 'I need to price a job per m² and I want to know my floor price. ', services: 'I want to know my real hourly rate and the hours I need to bill. '};
var ASK_HINT = {fabrication: 'E.g. 40 jars of jam per batch, 2 h of work, €38 of fruit and sugar…', travaux: 'E.g. 180 m² tiled roof, team of 4, I charge €59 per m²…', services: 'E.g. freelance accountant at €70 an hour, 40 h a week…'};
function prepAsk(type, fill){
  var i = $('#a-input');
  if (i && ASK_HINT[type]) i.placeholder = ASK_HINT[type];
  if (i && fill && ASK_START[type] && !i.value.trim()) i.value = ASK_START[type];
  var h = location.hash.slice(1);
  if (h && h !== 'accueil' && h !== 'assistant') location.hash = 'assistant'; else focusChat();
}
function num_(v){ if (typeof v === 'number') return v; if (typeof v === 'string'){ var t = v.replace('%', '').trim(); var n = parseNum(t); return n === undefined || isNaN(n) ? v : n; } return v; }
function coerce(o){
  var out = {};
  Object.keys(o || {}).forEach(function(k){
    var v = o[k];
    if (v === null || v === undefined || v === '') return;
    if (Array.isArray(v)){ out[k] = v.map(function(r){ var x = {}; Object.keys(r || {}).forEach(function(c){ if (r[c] === null || r[c] === undefined) return; x[c] = c === 'name' ? String(r[c]) : num_(r[c]); }); return x; }); }
    else if (k === 'fullDays') out[k] = v === true || v === 'true';
    else if (SELECTS.indexOf(k) >= 0) out[k] = String(v);
    else out[k] = num_(v);
  });
  return out;
}
var PCT_STRICT = ['taxPercent', 'marginPercent', 'billablePercent', 'contributionPercent', 'vat', 'fixedPercent'];
function guard(type, i){
  PCT_STRICT.forEach(function(k){ if (typeof i[k] === 'number' && i[k] > 0 && i[k] < 1) throw new Error(k + ' = ' + i[k] + ' — percentages are written as numbers (25 for 25%). If it really is less than 1%, ask the person to confirm.'); });
  if (i.priceMode === 'TTC' && i.vat === undefined) throw new Error('Price incl. VAT with no VAT rate: ask for the VAT rate included in the price.');
  if (type === 'fabrication' && i.materialsTotal === undefined && !(Array.isArray(i.materials) && i.materials.length)) throw new Error('materialsTotal missing: ask for the materials cost for the whole batch (0 if none).');
  if (type === 'travaux'){
    if (i.materialPerM2 === undefined && !(Array.isArray(i.materials) && i.materials.length)) throw new Error('materialPerM2 missing: ask for the materials cost per m² (0 if supplied by the client).');
    if (i.distanceKm > 0 && i.tripsMode === undefined) throw new Error('distanceKm given without tripsMode: specify “daily” (one round trip per day) or “fixed” with trips.');
  }
  if (type === 'services'){
    if (i.directorNet !== undefined && i.directorMode === undefined) throw new Error('directorNet given without directorMode: use “markup” (charges as % of net) or “fraction” (charges as % of total cost).');
    if (i.directorAnnualCost === undefined && i.directorNet === undefined) throw new Error('Owner\'s pay missing: ask for the total annual cost, or the annual net pay and the charge rate.');
    if (i.directorMode === undefined && i.directorAnnualCost !== undefined) i.directorMode = 'direct';
  }
}
function r2(n){ return n === null || n === undefined ? null : Math.round(n * 100) / 100; }
var DEFAULTS = {fabrication: ['fixedMonthly','lossPercent','marginPercent','riskPercent','feePercent','taxPercent','targetNet'], travaux: ['fuelLitersPerDay','consumablesPerDay','scaffoldingPerDay','machinePerDay','skipCost','distanceKm','otherCosts','fixedPercent','contingencyPercent','marginPercent','riskPercent','feePercent','taxPercent','targetNet'], services: ['staffAnnual','structureTotal','marginPercent','riskPercent','feePercent','taxPercent','targetNet']};
function compact(type, r, inputs){
  var d = r.details, hasPrice = r.revenue > 0;
  var o = {montants: '€ excl. VAT', periode: type === 'fabrication' ? 'for the batch' : type === 'travaux' ? 'for the job' : 'per year', unite: type === 'fabrication' ? d.unit : type === 'travaux' ? 'm²' : 'hour',
    cout_de_revient_par_unite: r2(d.beforeFeesThreshold), prix_plancher_par_unite: r2(r.minimumPrice)};
  if (d.marginPercent > 0) o.prix_conseille_par_unite = r2(r.recommendedPrice);
  if (d.targetNet > 0) o.prix_pour_objectif_par_unite = r2(r.targetPrice);
  o.couts = r.breakdown.filter(function(b){ return ['Risks', 'Fees on revenue', 'Estimated tax'].indexOf(b.label) < 0 && Math.abs(b.amount) > 0.004; }).map(function(b){ return b.label + ' : ' + r2(b.amount); });
  if (hasPrice){ o.prix_actuel_par_unite = r2(r.currentPrice); o.chiffre_affaires = r2(r.revenue); o.risques = r2(r.riskCost); o.frais = r2(r.feeCost); o.impot = r2(r.tax); o.reste_apres_impot = r2(r.net); }
  if (type === 'travaux'){ o.jours = d.days; if (hasPrice) o.rendement_minimum = d.equilibriumStatus === 'found' ? r2(d.displayedEquilibriumYield) : d.equilibriumStatus; }
  if (type === 'services'){ o.heures_facturees_par_an = r2(d.hours); o.charges_annuelles = r2(r.cost); if (hasPrice && d.targetNet > 0 && d.requiredHours !== null){ o.heures_necessaires_objectif = r2(d.requiredHours); o.objectif_impossible = d.impossible; } }
  o.laisses_a_zero = DEFAULTS[type].filter(function(k){ return !(inputs[k] > 0); });
  o.avertissements = cleanWarnings({type: type}, r).slice(0, 3);
  return o;
}
function toolList(){
  return ['fabrication','travaux','services'].map(function(type){
    var t = TOOLS_DEF[type];
    return {name: t.name, description: t.description, inputSchema: t.inputSchema, execute: function(input){
      var inputs = coerce(input);
      guard(type, inputs);
      setStatus('The engine is calculating…');
      var r;
      try { r = PNR.calculate(type, inputs); } catch (e){ throw new Error(e && e.message ? e.message : 'Can\'t calculate with this data.'); }
      A.last = {type: type, inputs: inputs, r: r};
      addEngineCard(type, inputs, r);
      return compact(type, r, inputs);
    }};
  });
}
function setStatus(t){ $('#a-status').textContent = t || ''; }
function bubble(cls, text){ var p = document.createElement('p'); p.className = 'msg ' + cls; p.textContent = text; $('#a-thread').appendChild(p); $('#a-thread').scrollTop = 1e9; return p; }
function addEngineCard(type, inputs, r){
  var div = document.createElement('div'); div.className = 'devis engine-card';
  var u = type === 'fabrication' ? (UNIT_WORD[r.details.unit] || 'piece') : type === 'travaux' ? 'm²' : 'h';
  var h = '<p class="eyebrow">Engine result · ' + TYPE_NAME[type] + '</p><ul class="lines">' + L('Floor price', eur(r.minimumPrice) + ' / ' + u, 'strong');
  if (r.details.marginPercent > 0) h += L('Recommended price', eur(r.recommendedPrice) + ' / ' + u);
  if (r.details.targetNet > 0) h += L('Price for your target', eur(r.targetPrice) + ' / ' + u);
  if (r.revenue > 0) h += L('Left after tax', eur(r.net));
  if (type === 'travaux' && r.revenue > 0 && r.details.equilibriumStatus === 'found') h += L('Minimum output', fmt(r.details.displayedEquilibriumYield, 2) + ' m²/worker/d');
  h += '</ul><button class="btn btn-hivis btn-sm" type="button">Open in the full calculation</button>';
  div.innerHTML = h;
  div.querySelector('button').addEventListener('click', function(){ openFromInputs(type, inputs); });
  $('#a-thread').appendChild(div); $('#a-thread').scrollTop = 1e9;
}
function openFromInputs(type, inputs){
  var st = freshState(type, true); st.name = 'Assistant\'s calculation';
  st.v.priceMode = inputs.priceMode || 'HT';
  if (type === 'fabrication'){ st.v.unit = inputs.unit || 'pièce'; st.v.targetScope = inputs.targetScope || 'lot'; }
  if (type === 'travaux'){ st.v.tripsMode = inputs.tripsMode || 'fixed'; st.v.fullDays = String(inputs.fullDays === true); }
  if (type === 'services') st.v.directorMode = inputs.directorMode || (inputs.directorAnnualCost !== undefined ? 'direct' : 'fraction');
  Object.keys(inputs).forEach(function(k){
    var v = inputs[k];
    if (Array.isArray(v)){ if (!v.length) return; st.lists[k] = v.map(function(r){ var o = {}; Object.keys(r).forEach(function(c){ o[c] = toStr(r[c]); }); return o; }); if (st.mode[k] !== undefined) st.mode[k] = 'list'; }
    else if (typeof v === 'boolean') st.v[k] = String(v);
    else st.v[k] = toStr(v);
  });
  // champs que le moteur remplit par défaut : on les écrit pour retrouver le même calcul
  if (type === 'travaux' && st.v.tripsMode === 'fixed' && blank(st.v.trips)) st.v.trips = '0';
  if (type === 'fabrication' && blank(st.v.materialsTotal) && st.mode.materials !== 'list') st.v.materialsTotal = '0';
  if (type === 'travaux' && blank(st.v.materialPerM2) && st.mode.materials !== 'list') st.v.materialPerM2 = '0';
  if (type === 'services'){ if (blank(st.v.billablePercent)) st.v.billablePercent = '62'; if (blank(st.v.structureTotal) && st.mode.structure !== 'list') st.v.structureTotal = '0'; if (st.v.directorMode !== 'direct' && blank(st.v.contributionPercent)) st.v.contributionPercent = '0'; if (st.v.directorMode === 'direct' && blank(st.v.directorAnnualCost)) st.v.directorAnnualCost = '0'; if (st.v.directorMode !== 'direct' && blank(st.v.directorNet)) st.v.directorNet = '0'; }
  if (inputs.priceMode === 'TTC' && blank(st.v.vat)) st.v.vat = '21';
  st.carryNote = 'Calculation opened from the assistant: check every figure, then save.';
  S = st; cache[type] = st; renderForm(); compute(); saveDraft(); location.hash = 'calcul';
}
var ERR_COPY = {not_granted: 'The assistant wasn\'t authorised. Calculations are still available.', sampling_disabled: 'The assistant isn\'t available for this account.', rate_limited: 'Too many questions at once. Try again in a moment.', session_expired: 'Sign back in to Claude, then try again.', refused: 'The assistant can\'t answer this request. Rephrase it.', empty_completion: 'No answer. Ask your question more simply.', prompt_too_large: 'The conversation is too long. Reload the page to start a new one.', tools_unavailable: 'The assistant can\'t use the engine here.'};
function assistantOff(msg){ $('#a-form').hidden = true; $('#a-chips').hidden = true; setStatus(''); $('#a-thread').innerHTML = ''; bubble('sys', msg); }
if (!SITE) cap('sample').then(function(s){
  if (!s){ assistantOff(window.PNR_EDITION === 'test' ? 'Test version: the AI assistant is part of the full version. Here, the quick tests, the full calculation and the comparison of your calculations work without installing anything.' : 'The assistant works when this page is open in Claude, signed in to your account. The tests and the full calculation work everywhere.'); return; }
  A.sample = s;
  (s.limits ? s.limits() : Promise.reject()).then(function(l){ A.tools = !!(l && l.tools); }, function(){ A.tools = false; }).then(function(){
    if (!A.tools){ assistantOff('Your Claude app doesn\'t yet let the assistant use the engine. The tests and the full calculation work.'); return; }
    bubble('ai', 'Hi. Tell me what you want to price: a product, a job or your hourly rate. I\'ll ask you the questions one at a time, and the engine does the calculating.');
  });
});
function ask(text){
  if (SITE) return askSite(text);
  if (!A.sample || !A.tools || A.ctl) return;
  text = text.trim(); if (!text) return;
  $('#a-chips').hidden = true;
  bubble('me', text);
  var content = text + (A.last ? '\n\n[Page context: last calculation sent to the engine (' + A.last.type + ') : ' + JSON.stringify(A.last.inputs) + ']' : '');
  A.turns.push({role: 'user', content: content});
  if (A.turns.length > 30) A.turns = A.turns.slice(-30);
  var out = bubble('ai', 'Thinking…');
  A.ctl = new AbortController();
  $('#a-send').hidden = true; $('#a-stop').hidden = false; setStatus('The assistant is thinking. It can take up to a minute.');
  A.sample([{role: 'user', content: RULES}].concat(A.turns), {tools: toolList(), cache: false, signal: A.ctl.signal, onText: function(u){ out.textContent = u.text; $('#a-thread').scrollTop = 1e9; }})
    .then(function(res){ out.textContent = plainText(res.text); A.turns.push({role: 'assistant', content: res.text}); if (res.truncated) bubble('sys', 'Answer cut off: ask a shorter question.'); setStatus(''); })
    .catch(function(e){
      var code = e && e.code;
      if (e && e.text){ out.textContent = e.text; } else out.remove();
      if (code === 'cancelled'){ setStatus('Stopped.'); A.turns.pop(); return; }
      if (['not_granted','sampling_disabled','not_declared','capability_disabled','capability_removed','tools_unavailable'].indexOf(code) >= 0){ assistantOff(ERR_COPY[code] || 'The assistant isn\'t available here.'); return; }
      A.turns.pop();
      setStatus(ERR_COPY[code] || 'The answer was interrupted. Try again.');
    })
    .then(function(){ A.ctl = null; $('#a-send').hidden = false; $('#a-stop').hidden = true; });
}
// les réponses s'affichent en texte simple : on retire la mise en forme Markdown (gras, titres, puces en astérisque)
function plainText(s){ return String(s || '').replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/^(\s*)[*•]\s+/gm, '$1– ').trim(); }
// ---------- assistant sur le site web : abonnement, connexion, serveur ----------
var ACC = null;
var metierQ = new URLSearchParams(location.search).get('metier');
var VID = (function(){
  var v = lsGet('pnr-visiteur');
  if (typeof v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(v)) return v;
  var a = new Uint8Array(18);
  try { crypto.getRandomValues(a); } catch(e){ for (var i = 0; i < 18; i++) a[i] = Math.floor(Math.random() * 256); }
  v = btoa(String.fromCharCode.apply(null, a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  lsSet('pnr-visiteur', v); return v;
})();
// messages du serveur affichés dans la langue de la page (le serveur répond en français)
var SRV_MSG = {quota: 'You\'ve used your 2 free calculations.', auth: 'Enter your access code to use the assistant.', limit: 'Monthly usage limit reached. The counter resets on the 1st of the month.', busy: 'The assistant is in high demand. Try again in a moment.', upstream: 'The assistant isn\'t responding right now. Try again in a moment.', config: 'The assistant is unavailable right now.', rate: 'Too many attempts. Try again in a few minutes.', code: 'Invalid access code.', ia: 'The assistant is temporarily unavailable. No payment has been taken. Try again later.', deja: 'This payment has already unlocked access. On another device, enter your personal access code.', paiement: 'The payment couldn\'t be confirmed. Try again in a moment.', fini: 'Your subscription is no longer active. Resubscribe to use the assistant again.', pay: 'Payment unavailable right now.'};
var NEW_CODE = null;
function pageLang(){ return document.documentElement.lang || 'fr'; }
function srvMsg(e, d){ return (e && SRV_MSG[e.error]) || d || (e && e.message) || ''; }
function priceLabel(){ return ACC && ACC.price_eur ? eur(ACC.price_eur, 0) + ' a month' : (ACC && ACC.price) || ''; }
function quotaMsg(){ var R = (ACC && ACC.ready) || {}; return SRV_MSG.quota + ' ' + (R.pay ? 'Keep going with the subscription: ' + priceLabel() + ', no commitment.' : 'The subscription at ' + priceLabel() + ' opens very soon. Got an access code? Enter it below.'); }
function api(path, body, signal){
  var h = body === undefined ? {} : {'content-type': 'application/json'}, jt = lsGet('pnr-session');
  if (jt) h['x-pnr-session'] = jt;
  if (SITE) h['x-pnr-visiteur'] = VID;
  return fetch(path, {method: body === undefined ? 'GET' : 'POST', headers: h, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', signal: signal})
    .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ j.status_ = r.status; return j; }); });
}
function showPay(msg){ A.ready = false; $('#a-form').hidden = true; $('#a-chips').hidden = true; $('#a-thread').hidden = !$('#a-thread').children.length; $('#a-pay').hidden = false; $('#a-pay-msg').textContent = msg || ''; }
function accountLine(){
  var el = $('#a-account');
  if (ACC && ACC.visiteur){ el.hidden = false; el.innerHTML = '<b>Free calculations left, no sign-up: ' + ACC.cases_left + ' / ' + ACC.cases_max + '</b>'; return; }
  if (!ACC || !(ACC.email || ACC.nom)){ el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = 'Signed in: ' + esc(ACC.email || ACC.nom) +(ACC.free && ACC.active ? ' · free access' : '') + (ACC.active && ACC.limit ? ' · ' + ACC.used + ' / ' + ACC.limit + ' questions this month' : '') +
    (ACC.free ? '' : ' · <button class="linkbtn" type="button" data-acc="portal">Manage my subscription</button>') + ' · <button class="linkbtn" type="button" data-acc="logout">Log out</button>';
}
// site sans clé IA : l'assistant est annoncé, le reste du site marche normalement
function soon(){ A.ready = false; $('#a-pay').hidden = true; $('#a-form').hidden = true; $('#a-chips').hidden = true; $('#a-thread').innerHTML = ''; bubble('sys', 'The AI assistant is coming soon. In the meantime, the full calculation, the PDF and the comparison of your calculations are free.'); $('#a-note').textContent = 'The AI assistant will be offered as a monthly subscription.'; }
function siteStart(){
  var q = new URLSearchParams(location.search);
  // retour de Stripe après paiement : on ouvre l'accès, puis on recharge l'état
  var aboId = q.get('abo');
  if (aboId){
    q.delete('abo');
    try { history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q.toString() : '') + location.hash); } catch(e){}
    if (/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(aboId)){
      $('#a-form').hidden = true; $('#a-chips').hidden = true;
      api('/api/abo', {id: aboId}).then(function(r){
        if (r.ok && r.jeton){ lsSet('pnr-session', r.jeton); NEW_CODE = r.code || null; }
        else toast(srvMsg(r, 'The payment couldn\'t be confirmed. Try again in a moment.'));
        siteStart();
      }, function(){ toast('Can\'t sign in. Try again.'); siteStart(); });
      return;
    }
  }
  if (q.get('bienvenue')) toast('Subscription activated. Ask your first question.');
  else if (q.get('connecte')) toast('You\'re signed in.');
  else if (q.get('lien') === 'expire') toast('Link expired or already used: request a new one.');
  else if (q.get('paiement') === 'erreur') toast('The payment couldn\'t be confirmed. If you\'ve been charged, request your sign-in link with your email.');
  var had = false; ['bienvenue','connecte','lien','paiement'].forEach(function(k){ if (q.has(k)){ q.delete(k); had = true; } });
  if (had) try { history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q.toString() : '') + location.hash); } catch(e){}
  $('#a-form').hidden = true; $('#a-chips').hidden = true;
  api('/api/me').then(function(m){
    ACC = m;
    var R = m.ready || {ai: true, pay: true, email: true};
    if (priceLabel()) $('#a-price').textContent = priceLabel();
    if (m.visiteur) $('#a-note').textContent = 'Your questions are processed by Claude (Anthropic). Your saved calculations stay in your browser.';
    else if (m.limit) $('#a-note').textContent = (m.abonne ? 'Included in the subscription' : 'Invitation-only access') + ' — up to ' + m.limit + ' questions per month. Your questions are processed by Claude (Anthropic). Your saved calculations stay in your browser.';
    else if (R.code && !R.pay) $('#a-note').textContent = 'During the test, the assistant is reserved for invited people. Your questions are processed by Claude (Anthropic).';
    accountLine();
    $('#a-sub').hidden = !R.pay; $('#a-login').hidden = !R.email; $('#a-code').hidden = !R.code; $('#a-terms').hidden = !R.pay;
    var tp = $('#a-testpay');
    if (!tp){ tp = document.createElement('p'); tp.id = 'a-testpay'; tp.className = 'small mute'; $('#a-sub').insertAdjacentElement('afterend', tp); }
    tp.textContent = 'Payment in test mode: no real card is charged.'; tp.hidden = !(R.pay && R.pay_test);
    if (!R.pay) $('#a-pay-kicker').textContent = m.visiteur ? 'Abonnement' : 'Private test';
    if (!m.active && (!R.ai || (!R.pay && !R.email && !R.code))){ soon(); return; }
    if (m.active){
      $('#a-pay').hidden = true; $('#a-thread').hidden = false; $('#a-form').hidden = false; $('#a-chips').hidden = false; A.ready = true;
      bubble('ai', 'Hi. Tell me what you want to price: a product, a job or your hourly rate. I\'ll ask you the questions one at a time, and the engine does the calculating.');
      if (NEW_CODE){ bubble('sys', 'Subscription activated. Your personal access code: ' + NEW_CODE + '. Keep it: you\'ll need it to sign in on another device.'); NEW_CODE = null; }
      if (metierQ && ASK_HINT[metierQ]) prepAsk(metierQ, false);
    } else if (m.visiteur) showPay(quotaMsg());
    else if (!R.pay) showPay(R.code ? 'The assistant is in a private test, by invitation. Enter your access code to use it.' : 'The assistant is in a private test. If your address is invited, get your sign-in link by email.');
    else if (m.email) showPay('Your subscription is no longer active. Resubscribe to use the assistant again.');
    else showPay('Describe your job, your product or your assignment in your own words: the assistant asks you the right questions and the engine works out your real price.');
  }, function(){ showPay('The server isn\'t responding right now. The tests and the full calculation still work.'); });
}
if (SITE){
  siteStart();
  $('#a-sub').addEventListener('click', function(){
    var b = this, em = ($('#a-email').value || '').trim();
    b.disabled = true;
    api('/api/checkout', em ? {email: em, lang: pageLang()} : {lang: pageLang()}).then(function(r){ if (r.url) location.href = r.url; else if (r.deja) siteStart(); else { b.disabled = false; toast(srvMsg(r, 'Payment unavailable right now.')); } }, function(){ b.disabled = false; toast('Can\'t sign in. Try again.'); });
  });
  $('#a-login').addEventListener('submit', function(e){
    e.preventDefault();
    var em = $('#a-email').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)){ toast('Invalid email address.'); return; }
    api('/api/login', {email: em}).then(function(r){ toast(r.message || 'If a subscription exists for this address, the link is on its way.'); }, function(){ toast('Can\'t sign in. Try again.'); });
  });
  $('#a-code').addEventListener('submit', function(e){
    e.preventDefault();
    var b = this.querySelector('button'), c = $('#a-code-in').value.trim();
    if (c.replace(/[^0-9A-Za-z]/g, '').length < 8){ toast('Invalid access code.'); return; }
    b.disabled = true;
    api('/api/code', {code: c}).then(function(r){
      b.disabled = false;
      if (!r.ok){ toast(srvMsg(r, 'Invalid access code.')); return; }
      if (r.jeton) lsSet('pnr-session', r.jeton);
      $('#a-code-in').value = ''; $('#a-thread').innerHTML = ''; toast('Access granted. Ask your first question.'); siteStart();
    }, function(){ b.disabled = false; toast('Can\'t sign in. Try again.'); });
  });
  $('#a-account').addEventListener('click', function(e){
    var b = e.target.closest('[data-acc]'); if (!b) return;
    if (b.dataset.acc === 'logout') api('/api/logout', {}).then(function(){ lsSet('pnr-session', null); location.reload(); }, function(){ lsSet('pnr-session', null); location.reload(); });
    else api('/api/portal', {lang: pageLang()}).then(function(r){ if (r.url) location.href = r.url; else toast(srvMsg(r, 'Subscription area unavailable.')); });
  });
}
var TOOLMAP = null;
function toolByName(n){ if (!TOOLMAP){ TOOLMAP = {}; toolList().forEach(function(t){ TOOLMAP[t.name] = t; }); } return TOOLMAP[n]; }
function isQuestion(m){ return m && m.role === 'user' && typeof m.content === 'string'; }
function startsQuestion(m){ return m && m.role === 'user' && !(Array.isArray(m.content) && m.content.every(function(b){ return b.type === 'tool_result'; })); }
function trimTurns(){
  // on garde les échanges les plus récents, coupés au début d'une question : au plus 30 messages et 45 000 caractères
  function tooBig(){ return A.turns.length > 30 || JSON.stringify(A.turns).length > 45000; }
  while (tooBig()){
    var k = 1; while (k < A.turns.length && !startsQuestion(A.turns[k])) k++;
    if (k >= A.turns.length) break;
    A.turns = A.turns.slice(k);
  }
}
function askSite(text){
  if (!A.ready || A.ctl) return;
  text = text.trim(); if (!text) return;
  if (text.length > 3000){ toast('Question too long: 3,000 characters maximum.'); return; }
  $('#a-chips').hidden = true;
  bubble('me', text);
  var before = A.turns.slice();
  A.turns.push({role: 'user', content: text + (A.last ? '\n\n[Page context: last calculation sent to the engine (' + A.last.type + ') : ' + JSON.stringify(A.last.inputs) + ']' : '')});
  trimTurns();
  var out = bubble('ai', 'Thinking…'), rounds = 0;
  A.ctl = new AbortController();
  $('#a-send').hidden = true; $('#a-stop').hidden = false; setStatus('The assistant is thinking. It can take up to a minute.');
  function step(){
    return api('/api/chat', {messages: A.turns, lang: document.documentElement.lang || 'fr'}, A.ctl.signal).then(function(r){
      if (r.status_ !== 200 || !Array.isArray(r.content)) throw r;
      A.turns.push({role: 'assistant', content: r.content, sig: r.sig});
      var txt = r.content.filter(function(b){ return b.type === 'text'; }).map(function(b){ return b.text; }).join('\n').trim();
      txt = plainText(txt);
      if (txt){ if (out){ out.textContent = txt; out = null; } else bubble('ai', txt); }
      if (r.usage && ACC){ ACC.used = r.usage.used; ACC.limit = r.usage.limit; if (ACC.visiteur){ ACC.cases_used = r.usage.cases_used; ACC.cases_left = r.usage.cases_left; } accountLine(); }
      var hasTool = r.content.some(function(b){ return b.type === 'tool_use'; });
      if (hasTool && (r.stop_reason !== 'tool_use' || rounds >= 5)){
        // appel d'outil coupé ou trop d'étapes : on retire l'échange pour garder une conversation valide
        A.turns = before; if (out){ out.remove(); out = null; }
        bubble('sys', 'The calculation didn\'t go through. Rephrase your question with your figures.'); setStatus(''); return;
      }
      if (hasTool && rounds++ < 5){
        var results = r.content.filter(function(b){ return b.type === 'tool_use'; }).map(function(b){
          var t = toolByName(b.name);
          try { if (!t) throw new Error('Unknown tool: ' + b.name); return {type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(t.execute(b.input || {}))}; }
          catch(e){ return {type: 'tool_result', tool_use_id: b.id, content: String(e && e.message || e), is_error: true}; }
        });
        A.turns.push({role: 'user', content: results});
        if (!out) out = bubble('ai', 'Thinking…');
        return step();
      }
      if (out){ out.remove(); out = null; }
      if (r.stop_reason === 'max_tokens') bubble('sys', 'Answer cut off: ask a shorter question.');
      if (ACC && ACC.visiteur && ACC.cases_left === 0 && !A.lastFree){ A.lastFree = true; bubble('sys', 'That was your last free calculation: you can still refine it here. For a new calculation, you\'ll need the subscription.'); }
      setStatus('');
    });
  }
  step().catch(function(e){
    if (out) out.remove();
    A.turns = before;
    if (e && e.name === 'AbortError'){ setStatus('Stopped.'); return; }
    if (e && e.error === 'quota'){ setStatus(''); if (ACC){ ACC.cases_left = 0; ACC.active = false; accountLine(); } showPay(quotaMsg()); return; }
    if (e && (e.error === 'auth' || e.error === 'inactive')){ if (e.error === 'auth') lsSet('pnr-session', null); setStatus(''); showPay(srvMsg(e)); return; }
    if (e && e.error === 'bad_request'){ A.turns = []; A.last = null; bubble('sys', 'New conversation: the previous one was too long. Ask your question again.'); setStatus(''); return; }
    setStatus(srvMsg(e, 'The answer was interrupted. Try again.'));
  }).then(function(){ A.ctl = null; $('#a-send').hidden = false; $('#a-stop').hidden = true; $('#a-new').hidden = !A.turns.length || !A.ready; });
}
// nouveau calcul : nouvelle conversation (pour un visiteur, c'est un nouveau calcul offert)
$('#a-new').addEventListener('click', function(){
  if (A.ctl) return;
  A.turns = []; A.last = null; A.lastFree = false; $('#a-thread').innerHTML = ''; this.hidden = true;
  bubble('ai', 'Hi. Tell me what you want to price: a product, a job or your hourly rate. I\'ll ask you the questions one at a time, and the engine does the calculating.');
  $('#a-chips').hidden = false; focusChat();
});
$('#a-form').addEventListener('submit', function(e){ e.preventDefault(); var t = $('#a-input').value; $('#a-input').value = ''; ask(t); });
$('#a-input').addEventListener('keydown', function(e){ if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); var t = $('#a-input').value; $('#a-input').value = ''; ask(t); } });
$('#a-stop').addEventListener('click', function(){ if (A.ctl) A.ctl.abort(); });
$$('#a-chips .chip').forEach(function(c){ c.addEventListener('click', function(){ ask(c.textContent); }); });

// ---------- guides ----------
$('#g-list').innerHTML = GUIDES.map(function(g){
  return '<details class="guide"><summary><small>' + esc(g.cat) + '</small><b>' + esc(g.h1) + '</b></summary><div class="body"><p><b>' + esc(g.answer) + '</b></p>' +
    (g.formula ? '<h4>' + esc(g.formulaTitle || 'The formula') + '</h4><div class="formula">' + g.formula.map(esc).join('<br>') + '</div>' : '') +
    '<h4>Worked example</h4><p>' + esc(g.example) + '</p>' + (g.extra ? '<p class="mute">' + esc(g.extra) + '</p>' : '') +
    (g.errors ? '<h4>Mistakes that cost you</h4><ol>' + g.errors.map(function(e){ return '<li>' + esc(e) + '</li>'; }).join('') + '</ol>' : '') +
    (g.faq ? g.faq.map(function(f){ return '<h4>' + esc(f[0]) + '</h4><p>' + esc(f[1]) + '</p>'; }).join('') : '') +
    '<div class="btn-row"><a class="btn btn-hivis btn-sm" href="#accueil" data-ask="' + g.type + '">Do my calculation</a></div></div></details>';
}).join('');

// ---------- exposé pour les tests automatiques ----------
window.__PNR_TEST = {coerce: coerce, guard: guard, compact: compact, openFromInputs: openFromInputs, buildInputs: buildInputs, state: function(){ return S; }, trim: function(t){ A.turns = t; trimTurns(); return A.turns; }};

// ---------- démarrage ----------
renderForm(); compute();
if (metierQ && CFG[metierQ]) setType(metierQ);
show(location.hash.slice(1) || 'accueil');
})();
