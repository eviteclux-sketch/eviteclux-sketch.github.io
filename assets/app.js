// Prix Net Réel — moteur de calcul (port fidèle de pricing.ts + construction.ts)
var PNR = (function(){
  function PnrError(msg, field){ this.message = msg; this.field = field; }
  var DISCLAIMER = "Outil de simulation et de gestion. Estimations fondées sur tes données, sans conseil fiscal, comptable, juridique ou financier. Vérifie tes obligations avec un professionnel.";
  function invalid(field){ throw new PnrError("Valeur invalide : " + field + ". Renseigne un nombre positif ou nul, dans les limites indiquées.", field); }
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
    if (risk + fee >= 1) invalid("risques + frais (doivent rester inférieurs à 100 %)");
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
      breakdown: breakdown.concat([{label:"Risques", amount: riskCost},{label:"Frais sur CA", amount: feeCost},{label:"Impôt estimé", amount: tax}]),
      details: d,
      warnings: (warnings || []).concat([DISCLAIMER, "La TVA est une hypothèse modifiable ; elle n’est pas un revenu. La fiscalité réelle dépend de ta situation."])
    };
    ["revenue","cost","margin","net","riskCost","feeCost","tax","targetRevenue","minimumRevenue","recommendedPrice","currentPrice","minimumPrice","targetPrice"].forEach(function(k){ if (!isFinite(r[k])) invalid("résultat hors limites"); });
    if (r.net < 0) r.warnings.unshift("Le prix actuel produit une perte dans les hypothèses saisies.");
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
      [{label:"Matières avec pertes", amount: material},{label:"Temps et charges fixes réparties", amount: labor}],
      {quantity: quantity, hourly: hourly, materialBase: materialBase, material: material, labor: labor, costPerUnit: cost/quantity, unit: i.unit || "pièce", targetScope: i.targetScope || "lot"},
      ["Le coût horaire inclut la main-d’œuvre et les charges fixes réparties ; ces charges ne sont pas déduites une seconde fois."]);
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
      [{label:"Rémunération dirigeant chargée", amount: director},{label:"Personnel chargé", amount: staff},{label:"Structure", amount: structure}],
      {hours: hours, capacityHours: hours, paidHours: persons*weeks*weeklyHours, director: director, directorMode: mode, staff: staff, structure: structure, thresholdRate: cost/hours},
      ["La rémunération du dirigeant est déjà comprise dans les charges. L’objectif net est supplémentaire.",
       "La base de charges du dirigeant est une hypothèse de gestion, pas un calcul fiscal exact. Le temps non facturé réduit la capacité."]);
    r.details.requiredHours = rate > 0 ? r.targetRevenue / rate : null;
    r.details.netPerHour = r.net / hours;
    r.details.impossible = rate === 0 || r.targetRevenue / rate > hours;
    if (r.details.impossible) r.warnings.unshift("Objectif impossible au taux actuel dans la capacité disponible.");
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
      [{label:"Main-d’œuvre", amount: c.labor},{label:"Matériaux avec chutes", amount: material},{label:"Frais de chantier et financement", amount: c.expenses},{label:"Frais généraux", amount: c.fixed},{label:"Aléas sur coût", amount: c.contingency}],
      {surface: surface, persons: persons, capacityPerDay: c.capacity, duration: c.duration, days: c.days, paidDuration: c.paidDuration, laborHours: persons*hoursPerDay*c.paidDuration, labor: c.labor, material: material, expenses: c.expenses, travel: c.travel, tripsMode: tripsMode, direct: c.direct, fixed: c.fixed, contingency: c.contingency, costPerM2: c.cost/surface, retentionAmount: price*surface*retention},
      ["Les frais journaliers utilisent les jours arrondis ; la main-d’œuvre utilise le temps réel sauf option journées complètes.",
       "Les retenues récupérables sont un décalage de trésorerie, pas une perte. Le coût de financement doit être renseigné séparément.",
       "Surveille le rendement ; le prix cible dépend de la capacité et des données de chantier."]);
    r.details.netPerM2 = r.net / surface;
    Object.assign(r.details, chantierEquilibrium(p, r.revenue, percent(i,"riskPercent"), percent(i,"feePercent"), yieldPerDay, percent(i,"taxPercent")));
    return r;
  }
  function calculate(type, i){
    if (type === "fabrication") return fabrication(i);
    if (type === "services") return services(i);
    if (type === "travaux") return travaux(i);
    throw new PnrError("Parcours inconnu.");
  }
  return {calculate: calculate, PnrError: PnrError, DISCLAIMER: DISCLAIMER};
})();


var GUIDES = [
  {cat: 'Fabrication', type: 'fabrication', h1: 'Calcule ton prix de revient, pièce par pièce',
   answer: 'Ton prix de revient, c’est tout ce que te coûte une pièce avant de gagner le premier euro : les matières avec leurs pertes, ton temps payé à son vrai coût, et tes charges fixes réparties. En dessous de ce prix, tu paies pour travailler.',
   formula: ['Coût horaire réel = ton coût horaire (salaire + charges) + charges fixes du mois ÷ heures productives du mois', 'Prix de revient par pièce = (matières × (1 + pertes) + minutes ÷ 60 × coût horaire réel) ÷ nombre de pièces', 'Prix plancher = prix de revient ÷ (1 − risques − frais)', 'Prix conseillé HT = prix de revient ÷ (1 − marge voulue sur le prix de vente)'],
   example: 'Fournée de 20 pains (exemple simplifié). Farine 6 kg, pertes de 3 % comprises = 4,57 € HT. Temps 90 min à 29,50 €/h charges comprises = 44,25 €. Coût : 48,82 € HT, soit 2,44 € HT par pain. Avec 35 % de marge : 3,76 € HT. Ici la farine pèse moins de 10 % du coût : c’est le temps qui fait le prix.',
   errors: ['Ne pas compter son temps, ou le compter sans les charges.', 'Compter les matières sans les pertes (chutes, ratés, invendus de production).', 'Confondre les deux marges : coût × 1,35 donne 35 % de marge sur le coût, mais seulement 25,9 % du prix de vente. Pour garder 35 % du prix de vente (le taux de marque), divise le coût par 0,65.'],
   faq: [['La TVA fait-elle partie du prix de revient ?', 'Si tu la récupères sur tes achats, non : compte tes matières hors TVA. Sinon (régime de franchise, par exemple), elle est un coût : compte en TTC. Ton comptable te dit ton cas.']]},
  {cat: 'Fabrication', type: 'fabrication', h1: 'Ton prix de revient au kilo (ou au litre)',
   answer: 'Calcule le coût complet de ton lot, puis divise-le par le poids ou le volume réellement vendable. Tu obtiens ton coût de revient au kilo ; ajoute tes risques et frais et tu as ton prix plancher.',
   formula: ['Coût de revient au kilo = coût du lot ÷ kilos vendables produits', 'Prix plancher au kilo = coût de revient au kilo ÷ (1 − risques − frais)', 'Prix conseillé au kilo HT = coût de revient au kilo ÷ (1 − marge voulue)'],
   example: '20 pains de 700 g = 14 kg. Coût du lot 48,82 € HT : 3,49 € HT le kilo de coût de revient. Avec 2 % de risques et 1,2 % de frais, le prix plancher est 3,60 € HT le kilo. Avec 35 % de marge : 5,37 € HT le kilo.',
   errors: ['Diviser par le poids de la pâte ou de la cuve, au lieu du poids ou du volume fini et vendable.', 'Oublier les pertes de conditionnement (fonds de cuve, flacons ratés, emballages abîmés).', 'Vendre au kilo et à la pièce sans vérifier que les deux prix donnent la même marge.'],
   faq: [['En litres, pareil ?', 'Oui : remplace les kilos par les litres réellement mis en bouteille ou en pot. Dans le calcul complet, choisis l’unité « kg » ou « litre » et mets les kilos ou litres produits comme quantité.']]},
  {cat: 'Fabrication', type: 'fabrication', h1: 'Combien te coûte vraiment un pain ?',
   answer: 'Dans notre exemple, un pain de campagne de 700 g coûte 2,44 € HT à produire, soit 3,49 € HT le kilo. Le chiffre qui compte, c’est le tien : il dépend de ta recette, de ton temps et de tes charges.',
   example: '20 pains de 700 g = 14 kg. Farine 6 kg + 3 % de perte = 4,57 € HT. 90 min (préparation, cuisson surveillée, finition, nettoyage, emballage) à 29,50 €/h = 44,25 €. Coût 48,82 € HT → 2,44 € HT par pain → 3,49 € HT le kilo. À 35 % de marge : 3,76 € HT le pain. Vendu 3,72 € HT, la marge tombe à 34,4 % : 3,6 centimes de moins par pain que l’objectif, 0,71 € par fournée.',
   extra: 'À ajouter dans ton calcul : levain ou levure, sel, eau, énergie du four, emballage, invendus.',
   faq: [['Quel taux de TVA ?', 'Celui du pain dans ton pays, souvent réduit pour l’alimentation mais variable : ton comptable le confirme.']]},
  {cat: 'Chantier', type: 'travaux', h1: 'Ton prix au m², calculé sur ton rendement réel',
   answer: 'Ton prix au m², c’est le coût complet du chantier divisé par la surface, plus ta marge. Tout part d’un chiffre que toi seul connais : combien de m² ton équipe pose par homme et par jour.',
   formula: ['Durée = surface ÷ (rendement × nombre d’hommes)', 'Main-d’œuvre = coût journalier de l’équipe × durée', 'Frais journaliers (échafaudage, engins, consommables, trajets) = coût par jour × jours arrondis au supérieur', 'Coût de revient = (main-d’œuvre + matériaux + frais de chantier) + frais généraux + aléa', 'Prix au m² HT = coût de revient ÷ surface ÷ (1 − marge voulue)'],
   example: 'Toiture en tuile mécanique de 180 m², équipe de 4, rendement 22 m²/homme/jour → 48,70 € HT/m² de coût de revient, 59,38 € HT/m² avec 18 % de marge.',
   errors: ['Reprendre le prix au m² d’un concurrent : il n’a ni ton équipe, ni ton rendement, ni tes frais.', 'Payer les frais à la journée sur la durée exacte : 2,05 jours de chantier, ce sont 3 jours d’échafaudage et 3 allers-retours.', 'Compter la retenue de garantie comme une perte : elle te revient à la réception, c’est un décalage de trésorerie.'],
   faq: [['Je ne connais pas mon rendement ?', 'Mesure-le sur tes trois derniers chantiers : m² réalisés ÷ (hommes × jours). C’est le chiffre le plus rentable que tu puisses connaître.']]},
  {cat: 'Chantier', type: 'travaux', h1: 'Prix au m² d’une couverture en tuiles : le calcul complet',
   answer: 'Dans cet exemple, la couverture revient à 48,70 € HT le m² et se vend 59,38 € HT le m² avec 18 % de marge. Sous 48,70 €, le chantier te coûte de l’argent.',
   example: '180 m². Équipe : 1 chef (42 €/h), 2 ouvriers qualifiés (36 €/h), 1 manœuvre (26 €/h), 8 h par jour. Rendement 22 m²/homme/jour → 88 m²/jour → 2,05 jours, 3 jours comptés pour les frais. Main-d’œuvre 2 290,91 €. Matériaux 4 387,86 € (tuile 17,55 €/m² + 8 % de chutes, liteau 3,04 €/m² + 10 %, écran sous-toiture 1,98 €/m² + 5 %). Frais de chantier 635,30 € (gasoil 12 L/jour à 1,65 €, consommables 15 €/jour, échafaudage 45 €/jour, benne 320 €, 3 allers-retours de 46 km à 0,55 €/km). Frais généraux 12 %, aléa 7 % → 8 765,18 € HT, soit 48,70 € HT/m². À 18 % de marge : 59,38 € HT/m². Rendement minimum (sans risque ni frais sur le prix) : 13,30 m²/homme/jour.',
   faq: [['Pourquoi le rendement minimum est-il si loin de 22 ?', 'Parce que les matériaux ne changent pas quand l’équipe ralentit : seuls la main-d’œuvre et les frais à la journée augmentent.']]},
  {cat: 'Chantier', type: 'travaux', h1: 'Le rendement qui fait (ou défait) ta marge',
   answer: 'Le rendement, c’est le nombre de m² qu’un homme réalise par jour. Chaque chantier a un rendement minimum : en dessous, ton prix ne couvre plus tes coûts.',
   formulaTitle: 'Comment on le calcule',
   formula: ['On recalcule le coût complet du chantier pour chaque rendement possible (main-d’œuvre, jours d’échafaudage, trajets),', 'et on cherche le premier rendement où le coût passe sous ton prix.', 'Pas de règle de trois : les matériaux ne dépendent pas du rendement.'],
   example: 'Toiture de 180 m² à 59,38 € HT/m², rendement prévu 22. Rendement minimum 13,30 (sans risque ni frais sur le prix). Ton équipe peut ralentir d’environ 40 % avant de perdre de l’argent.',
   errors: ['Chiffrer avec le rendement d’un bon jour, sur un chantier facile.', 'Oublier les temps morts : installation, repli, intempéries, attente de livraison.', 'Ne jamais mesurer le rendement réel après le chantier.']},
  {cat: 'Services', type: 'services', h1: 'Ton taux horaire plancher, et celui à facturer',
   answer: 'Ton coût horaire réel, c’est le total de tes charges annuelles, ta propre rémunération comprise, divisé par les heures que tu factures vraiment. Pas par les heures que tu travailles. Ajoute tes impayés et frais : tu as ton taux plancher.',
   formula: ['Heures facturables = personnes × semaines × heures par semaine × part réellement facturée', 'Coût horaire réel = charges annuelles totales ÷ heures facturables', 'Taux plancher = coût horaire réel ÷ (1 − impayés − frais)', 'Taux conseillé HT = coût horaire réel ÷ (1 − marge voulue)'],
   example: '2 personnes, 44 semaines, 40 h, 62 % facturé → 2 182 h facturables. Charges 144 100 € (dirigeant 69 600 € chargé, salariée 38 000 €, structure 36 500 €). Coût horaire réel 66,03 € HT. Avec 2 % d’impayés et 1 % de frais, taux plancher 68,07 € HT/h. À 20 % de marge : 82,54 € HT/h.',
   errors: ['Diviser par toutes les heures travaillées : administratif, prospection et congés ne sont pas payés par les clients.', 'Oublier sa propre rémunération dans les charges.', 'Confondre ce que te coûte ta rémunération et ce que tu touches en net.'],
   faq: [['Quel taux de charges sociales sur ma rémunération ?', 'Celui de ton statut et de ton pays : demande-le à ton comptable ou à ta caisse. L’outil ne l’invente pas.']]},
  {cat: 'Services', type: 'services', h1: 'Taux horaire d’un cabinet comptable : l’exemple complet',
   answer: 'Dans cet exemple, chaque heure facturée coûte 66,03 € HT au cabinet, et 68,07 € avec ses impayés et ses frais. Il facture 75 € : il gagne, mais moins qu’il ne le croit.',
   example: 'À 75 € HT/h : chiffre d’affaires 163 680 €. Après charges : 19 580 €. Après 2 % d’impayés et 1 % de frais : 14 669,60 €. Après 25 % d’impôt : 11 002,20 € de bénéfice, en plus des rémunérations. Mission « bilan annuel » : 30 h au taux conseillé de 82,54 €/h (arrondi) = 2 476 € HT + 66 € de déplacement. Un forfait de 2 200 € HT donne 71,13 €/h : au-dessus du plancher de 68,07 €, sous l’objectif. Pour 30 000 € de bénéfice en plus par an : 86,97 € HT/h. À 75 €/h il faudrait 2 531 h facturées ; le cabinet n’en a que 2 182.'},
  {cat: 'Services', type: 'services', h1: 'Combien de tes heures sont vraiment payées ?',
   answer: 'Une partie de ton temps n’est payée par personne : administratif, prospection, devis, formation. Ton taux horaire doit financer ces heures-là aussi.',
   example: '2 personnes × 44 semaines × 40 h = 3 520 h payées. 62 % facturées = 2 182 h. 1 338 h par an ne sont payées par aucun client. À 75 €/h, il faut facturer 1 981 h pour couvrir charges, impayés et frais, soit 56,3 % du temps : la marge de sécurité n’est que de 5,7 points.',
   errors: ['Supposer 100 % de temps facturable.', 'Ne pas suivre ses heures : sans mesure, le taux de facturation est une impression.', 'Baisser son taux pour remplir l’agenda, alors que le problème est le temps non facturé.']}
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
function fmt(n, d){ if (d === undefined) d = 2; return Number(n).toLocaleString('fr-FR', {minimumFractionDigits: d, maximumFractionDigits: d}); }
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
  var c = [['Prix de vente de la fournée', 75.20, 'hsl(218 30% 55%)', 0], ['Matières (farine + pertes)', 4.57, 'hsl(214 16% 62%)', 0], ['Ton temps, charges comprises', 44.25, 'hsl(214 16% 62%)', 0], ['Ce que tu crois gagner', 26.38, 'var(--hivis)', 0], ['Risques, frais et impôt', 8.40, 'var(--loss)', 0], ['Ce qu’il te reste vraiment', 17.98, 'var(--ok)', 1]];
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
  var stop = '<p class="err">Remplis chaque case avec un nombre positif.</p>';
  var cta = function(q){ return '<button class="btn btn-hivis" type="button" data-carry="' + q + '">Continuer dans le calcul complet avec ces chiffres</button>'; };
  Q.taux = function(){
    var ch = val('ta-ch'), h = val('ta-h'), s = val('ta-s'), p = val('ta-p');
    if (!okAll([ch, h, s, p]) || h * s * p === 0 || p > 100 || s > 53 || h > 100) return stop;
    var paid = h * s, billed = paid * p / 100, rate = ch / billed;
    return '<p class="eyebrow">Chaque heure facturée te coûte</p><p class="big">' + eur(rate) + '<small>HT / heure</small></p><ul class="lines">' +
      line('Heures travaillées par an', fmt(paid, 0) + ' h') + line('Heures facturées par an', fmt(billed, 0) + ' h') + line('Heures payées par aucun client', fmt(paid - billed, 0) + ' h') +
      '</ul>' + (ch > 0 ? '<p class="verdict">En dessous de ce taux, tu ne couvres pas tes charges et ta rémunération.</p>' : '') +
      '<p class="limit">Ce test ne compte pas les impayés, les frais d’encaissement ni l’impôt. Le calcul complet le fait.</p>' + cta('taux');
  };
  Q.vehic = function(){
    var n = val('ve-n'), km = val('ve-km'), c = val('ve-c'), p = val('ve-p'), a = val('ve-a'), e = val('ve-e'), l = val('ve-l');
    if (!okAll([n, km, c, p, a, e, l]) || n === 0 || km === 0) return stop;
    var fuel = km * c / 100 * p, per = fuel + a + e + l, tot = per * n, perkm = per / km;
    return '<p class="eyebrow">Tes véhicules te coûtent</p><p class="big">' + eur(tot, 0) + '<small>par an</small></p><ul class="lines">' +
      line('Par véhicule', eur(per, 0) + ' / an') + line('Au kilomètre', eur(perkm, 3)) + line('Dont carburant', fmt(fuel / per * 100, 1) + ' %') +
      '</ul><p class="verdict">Chaque kilomètre que tu ne factures pas te coûte ' + eur(perkm) + '.</p><p class="limit">Ce coût au kilomètre peut servir de « coût au km » dans le calcul d’un chantier.</p>' + cta('vehic');
  };
  Q.prod = function(){
    var pv = val('pr-pv'), m = val('pr-m'), mn = val('pr-min'), h = val('pr-h');
    if (!okAll([pv, m, mn, h]) || pv === 0) return stop;
    var cost = m + mn / 60 * h, mg = pv - cost;
    return '<p class="eyebrow">Ta marge sur matières et temps</p><p class="big">' + eur(mg) + '<small>' + fmt(mg / pv * 100, 1) + ' % du prix</small></p><ul class="lines">' +
      line('Matières et temps par pièce', eur(cost)) + line('Dont matières', eur(m)) + line('Dont ton temps', eur(mn / 60 * h)) +
      '</ul>' + (mg < 0 ? '<p class="verdict">Tu vends sous ce que te coûtent tes matières et ton temps : ' + eur(-mg) + ' de perte par pièce.</p>' : '<p class="verdict good">Il te reste ' + eur(mg) + ' par pièce pour payer loyer, énergie, impayés et impôt.</p>') +
      '<p class="limit">Ce test ne compte pas tes charges fixes (loyer, énergie), les pertes, les risques ni l’impôt. Le calcul complet le fait.</p>' + cta('prod');
  };
  Q.m2 = function(){
    var mat = val('m2-mat'), eq = val('m2-eq'), r = val('m2-r'), f = val('m2-f');
    if (!okAll([mat, eq, r, f]) || r === 0) return stop;
    var floor = mat + (eq + f) / r;
    var isEx = mat === 24.38 && eq === 1120 && r === 88 && f === 105;
    return '<p class="eyebrow">Ton coût direct au m²</p><p class="big">' + eur(floor) + '<small>HT / m²</small></p><ul class="lines">' +
      line('Matériaux', eur(mat) + ' / m²') + line('Équipe et frais du jour', eur((eq + f) / r) + ' / m²') +
      '</ul><p class="verdict">Sous ce prix, tu perds de l’argent à coup sûr. Ton vrai plancher est plus haut.</p>' +
      (isEx ? '<p class="gap">Pour cet exemple, le calcul complet donne un coût de revient de <b>48,70 € HT/m²</b>. Le test oublie <b>10,40 €/m²</b>, soit <b>1&nbsp;872 €</b> sur 180 m² : frais généraux, aléa, jours entiers d’échafaudage, benne.</p>' : '') +
      '<p class="limit">Ce test ne compte pas les frais généraux, l’aléa, les jours entiers, la benne, les risques ni l’impôt. Le calcul complet le fait.</p>' + cta('m2');
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
    st = freshState('services', true); st.name = 'Mon taux horaire';
    st.v.persons = '1'; st.v.weeklyHours = qv('ta-h'); st.v.weeks = qv('ta-s'); st.v.billablePercent = qv('ta-p');
    st.v.directorMode = 'direct'; st.v.directorAnnualCost = '0'; st.v.staffAnnual = '0'; st.v.structureTotal = qv('ta-ch');
    st.carryNote = 'Repris du test : tes charges annuelles sont dans « Frais de structure », rémunération comprise. Tu peux détailler ta rémunération à part. Il manque ton tarif actuel.';
  } else if (q === 'prod'){
    st = freshState('fabrication', true); st.name = 'Mon produit';
    st.v.quantity = '1'; st.v.price = qv('pr-pv'); st.v.materialsTotal = qv('pr-m'); st.v.minutes = qv('pr-min'); st.v.laborHourly = qv('pr-h');
    st.carryNote = 'Repris du test, pour une pièce. Ajoute tes charges fixes, pertes, risques et impôt dans les sections repliées.';
  } else if (q === 'm2'){
    st = freshState('travaux', true); st.name = 'Mon chantier';
    var eq = parseNum(qv('m2-eq'));
    st.v.materialPerM2 = qv('m2-mat'); st.v.hoursPerDay = '8'; st.v.yieldPerDay = qv('m2-r'); st.v.pricePerM2 = '0'; st.v.consumablesPerDay = qv('m2-f');
    st.lists.team = [{name: 'Équipe (coût global)', count: '1', hourlyCost: eq >= 0 ? toStr(eq / 8) : ''}];
    st.carryNote = 'Repris du test : ton équipe est comptée comme une seule ligne (coût du jour ÷ 8 h) et son rendement est celui de toute l’équipe. Tes frais du jour sont dans « Consommables ». Il manque la surface ; mets ton prix au m² si tu en as un. Le calcul complet compte les frais à la journée entière : il peut sortir un peu plus haut que le test.';
  } else if (q === 'vehic'){
    st = freshState('travaux'); st.name = 'Chantier avec mon coût au km (exemple)';
    var km = parseNum(qv('ve-km')), c = parseNum(qv('ve-c')), p = parseNum(qv('ve-p')), a = parseNum(qv('ve-a')), e = parseNum(qv('ve-e')), l = parseNum(qv('ve-l'));
    var per = km * c / 100 * p + a + e + l;
    st.v.costPerKm = km > 0 && isFinite(per) ? toStr(Math.round(per / km * 1000) / 1000) : st.v.costPerKm;
    st.carryNote = 'Ton coût au kilomètre (' + st.v.costPerKm + ' €/km) est placé dans l’exemple de chantier. Remplace le reste par tes chiffres.';
  } else return;
  S = st; cache[st.type] = st; renderForm(); compute(); saveDraft(); location.hash = 'calcul';
}

// ---------- calcul complet : configuration ----------
var LABELS = {quantity:'Quantité produite', unit:'Unité de vente', price:'Prix de vente unitaire', priceMode:'Ton prix est', vat:'TVA comprise dans ton prix', minutes:'Temps total du lot', laborHourly:'Coût horaire de ta main-d’œuvre', materialsTotal:'Matières, total du lot', fixedMonthly:'Charges fixes mensuelles', productiveHours:'Heures productives par mois', lossPercent:'Pertes', marginPercent:'Marge visée sur le prix de vente', riskPercent:'Risque (impayés, invendus)', feePercent:'Frais sur chiffre d’affaires', taxPercent:'Impôt sur le bénéfice (taux moyen)', targetNet:'Net visé', targetScope:'Ce net visé est', persons:'Personnes qui facturent', weeks:'Semaines travaillées par an', weeklyHours:'Heures par semaine', billablePercent:'Part facturée', rate:'Tarif horaire actuel', directorMode:'Rémunération du dirigeant', directorAnnualCost:'Coût annuel du dirigeant', directorNet:'Rémunération nette du dirigeant', contributionPercent:'Taux de charges du dirigeant', staffAnnual:'Salariés, coût annuel', structureTotal:'Frais de structure, total annuel', surface:'Surface', pricePerM2:'Prix au m²', yieldPerDay:'Rendement par homme', hoursPerDay:'Heures par jour', team:'Équipe', materialPerM2:'Matériaux au m²', fuelLitersPerDay:'Carburant des engins', fuelPrice:'Prix du carburant', consumablesPerDay:'Consommables', scaffoldingPerDay:'Échafaudage', machinePerDay:'Machines, location', skipCost:'Benne, déchets', distanceKm:'Distance aller-retour', costPerKm:'Coût au km', tripsMode:'Trajets', trips:'Nombre de trajets', tripsPerDay:'Trajets par jour', otherCosts:'Autres coûts', financingCost:'Coût de financement', fixedPercent:'Frais généraux', contingencyPercent:'Aléas (imprévus)', retentionPercent:'Retenue de garantie', fullDays:'Journées complètes', materials:'Liste des matières', structure:'Liste des frais de structure', count:'Nombre', hourlyCost:'Coût horaire', cost:'Coût', costPerM2:'Coût au m²', country:'Pays', unsoldPercent:'Invendus (% de la production)', dayHours:'Heures facturées par jour', scaffoldingFixed:'Échafaudage, forfait montage et démontage', weatherDays:'Jours d’intempéries prévus'};
var UNIT_WORD = {'pièce': 'pièce', 'portion': 'portion', 'kg': 'kg', 'L': 'litre', 'lot': 'lot'};
// Taux de TVA vérifiés le 8 octobre 2026 : BE (accountable.eu, maj 24/08/2026), LU (stripe.com, maj 24/02/2026), FR (economie.gouv.fr, 11/12/2025), CH (estv.admin.ch)
var VAT_RATES = {BE: ['21', '12', '6', '0'], LU: ['17', '14', '8', '3'], FR: ['20', '10', '5,5', '2,1'], CH: ['8,1', '3,8', '2,6'], autre: []};
if (DEC === '.') Object.keys(VAT_RATES).forEach(function(k){ VAT_RATES[k] = VAT_RATES[k].map(function(x){ return x.replace(',', '.'); }); });
var COUNTRY_OPTS = [['BE','Belgique'],['LU','Luxembourg'],['FR','France'],['CH','Suisse'],['autre','Autre pays']];
var UNIT_PL = {'pièce': 'pièces', 'portion': 'portions', 'lot': 'lots', 'litre': 'litres'};
var MAT_FACTOR = {kg: 1, g: 0.001, L: 1, cl: 0.01, ml: 0.001, 'pièce': 1};
var BREAK_LABEL = {'Risques': 'Risques (impayés, invendus)', 'Frais sur CA': 'Frais d’encaissement'};
function F(k, s, h, extra){ return Object.assign({k: k, s: s, h: h}, extra || {}); }
var PRICE_HINT = 'Mets 0 si tu cherches ton prix : le plancher et le prix conseillé s’affichent quand même.';
var CFG = {
  fabrication: {
    blocks: [
      {t: 'Ton produit', f: [F('unit', null, null, {kind: 'sel', o: [['pièce','pièce'],['portion','portion'],['kg','kg'],['L','litre'],['lot','lot']]}), F('quantity', '@unit', 'Nombre de pièces du lot, ou kg / litres vendables produits.', {req: 1}), F('price', '€/@unit', PRICE_HINT, {req: 1}), F('priceMode', null, null, {kind: 'sel', o: [['HT','Hors taxes (HT)'],['TTC','TVA comprise (TTC)']]}), F('country', null, null, {kind: 'sel', o: COUNTRY_OPTS}), F('vat', '%', 'Pour afficher tes prix TTC. Obligatoire si ton prix est TTC. Vérifie le taux de ton produit.', {kind: 'vatpick'}), F('unsoldPercent', '%', 'Part de la production jetée ou donnée. Le coût est réparti sur ce qui est vendu.')]},
      {t: 'Matières', alt: {list: 'materials', lib: 1, out: 'cost', total: F('materialsTotal', '€', 'Coût matière de TOUT le lot, pas par unité. Mets 0 s’il n’y en a pas. Énergie du four et emballage peuvent aller ici.'), cols: [{k: 'name', l: 'Matière', text: 1}, {k: 'qty', l: 'Quantité pour le lot'}, {k: 'u', l: 'Unité', sel: [['kg','kg'],['g','g'],['L','L'],['cl','cl'],['ml','ml'],['pièce','pièce']]}, {k: 'price', l: 'Prix d’achat', s: '€/kg, L ou pièce'}], calc: function(r){ return r.qty * (MAT_FACTOR[r.u] || 1) * r.price; }}},
      {t: 'Ton temps', f: [F('minutes', 'min', 'Temps total pour tout le lot.', {req: 1}), F('laborHourly', '€/h', 'Salaire + charges sociales d’une heure de travail. Le loyer et l’énergie vont plus bas.', {req: 1})]}
    ],
    details: [
      {t: 'Charges fixes et pertes', f: [F('fixedMonthly', '€/mois', 'Loyer, énergie, assurances de l’atelier.'), F('productiveHours', 'h/mois', 'Total des heures de production par mois, toutes personnes comprises. 160 si vide.'), F('lossPercent', '%', 'Matière perdue ou ratée en production.')]},
      {t: 'Marge, risque, frais et impôt', f: [F('marginPercent', '%', 'Part du prix de vente HT qui doit te rester (taux de marque).'), F('riskPercent', '%', 'Invendus, impayés, casse, en % du chiffre d’affaires.'), F('feePercent', '%', 'Commissions de paiement ou de plateforme.'), F('taxPercent', '%', 'Taux moyen à demander à ton comptable.'), F('targetNet', '€', 'Ce que tu veux qu’il te reste après impôt.'), F('targetScope', null, null, {kind: 'sel', o: [['lot','pour tout le lot'],['unit','par unité']]})]}
    ],
    watch: ['fixedMonthly', 'lossPercent', 'riskPercent', 'feePercent', 'taxPercent']
  },
  travaux: {
    blocks: [
      {t: 'Le chantier', f: [F('surface', 'm²', null, {req: 1}), F('pricePerM2', '€/m²', PRICE_HINT, {req: 1}), F('priceMode', null, null, {kind: 'sel', o: [['HT','Hors taxes (HT)'],['TTC','TVA comprise (TTC)']]}), F('country', null, null, {kind: 'sel', o: COUNTRY_OPTS}), F('vat', '%', 'Pour afficher tes prix TTC. Obligatoire si ton prix est TTC. Le taux dépend des travaux (rénovation, neuf…).', {kind: 'vatpick'})]},
      {t: 'Ton rendement', f: [F('yieldPerDay', 'm²/homme/jour', 'Ce que réalise UN homme par jour, dans TES conditions.', {req: 1}), F('hoursPerDay', 'h', '8 si vide.')]},
      {t: 'Ton équipe', list: {list: 'team', cols: [{k: 'name', l: 'Rôle', text: 1}, {k: 'count', l: 'Nombre'}, {k: 'hourlyCost', l: 'Coût horaire d’une personne', s: '€/h'}]}},
      {t: 'Matériaux', alt: {list: 'materials', lib: 1, out: 'costPerM2', total: F('materialPerM2', '€/m²', 'Total des matériaux pour un m² d’ouvrage fini.'), cols: [{k: 'name', l: 'Matériau', text: 1}, {k: 'qty', l: 'Quantité par m²'}, {k: 'u', l: 'Unité', text: 1}, {k: 'price', l: 'Prix d’achat unitaire', s: '€'}], calc: function(r){ return r.qty * r.price; }}, f: [F('lossPercent', '%', 'Chutes, si elles ne sont pas déjà dans le coût au m².')]}
    ],
    details: [
      {t: 'Frais de chantier', f: [F('fuelLitersPerDay', 'L/jour'), F('fuelPrice', '€/L'), F('consumablesPerDay', '€/jour'), F('scaffoldingPerDay', '€/jour', 'Location à la journée entière. À la semaine : divise par 5.'), F('scaffoldingFixed', '€', 'Forfait de montage et démontage.'), F('weatherDays', 'jours', 'Jours où le matériel reste loué sans travail : échafaudage et machines comptés en plus.'), F('machinePerDay', '€/jour'), F('skipCost', '€'), F('distanceKm', 'km'), F('costPerKm', '€/km', 'Ton test « véhicules » te donne ce chiffre.'), F('tripsMode', null, null, {kind: 'sel', o: [['daily','un aller-retour par journée commencée'],['fixed','un nombre fixe pour le chantier']]}), F('tripsPerDay', '/jour', 'Mode « par journée ». 1 si vide.', {only: 'daily'}), F('trips', 'trajets', 'Mode « nombre fixe ».', {only: 'fixed'}), F('otherCosts', '€'), F('financingCost', '€', 'Si tu empruntes pour avancer le chantier.'), F('fullDays', null, 'Main-d’œuvre payée en journées entières.', {kind: 'bool'})]},
      {t: 'Marge, risque, trésorerie et impôt', f: [F('fixedPercent', '%', 'Bureau, administratif, assurances, en % du coût direct.'), F('contingencyPercent', '%', 'Météo, reprises, surprises.'), F('marginPercent', '%', 'Part du prix de vente HT qui doit te rester (taux de marque).'), F('retentionPercent', '%', 'Encaissée plus tard : ce n’est pas une perte.'), F('riskPercent', '%', 'Impayés, avoirs, litiges, en % du chiffre d’affaires.'), F('feePercent', '%', 'Frais d’encaissement.'), F('taxPercent', '%', 'Taux moyen à demander à ton comptable.'), F('targetNet', '€', 'Ce que tu veux qu’il te reste sur ce chantier après impôt.')]}
    ],
    watch: ['fixedPercent', 'contingencyPercent', 'riskPercent', 'feePercent', 'taxPercent']
  },
  services: {
    blocks: [
      {t: 'Ton temps', f: [F('persons', 'pers.', 'Personnes qui facturent à ce tarif. 1 si vide.'), F('weeks', 'sem.', 'Sans congés, fériés, maladie.', {req: 1}), F('weeklyHours', 'h', null, {req: 1}), F('billablePercent', '%', 'Administratif, devis et prospection ne se facturent pas.', {req: 1})]},
      {t: 'Ton tarif', f: [F('rate', '€/h', PRICE_HINT, {req: 1}), F('dayHours', 'h', 'Pour voir tes prix à la journée. 8 si vide.'), F('priceMode', null, null, {kind: 'sel', o: [['HT','Hors taxes (HT)'],['TTC','TVA comprise (TTC)']]}), F('country', null, null, {kind: 'sel', o: COUNTRY_OPTS}), F('vat', '%', 'Pour afficher tes prix TTC. Obligatoire si ton tarif est TTC.', {kind: 'vatpick'})]},
      {t: 'Rémunération du dirigeant', dir: true},
      {t: 'Personnel et structure', f: [F('staffAnnual', '€/an', 'Coût annuel chargé de tes salariés. 0 si aucun.')], alt: {list: 'structure', total: F('structureTotal', '€/an', 'Loyer, assurances, logiciels, véhicule, comptable… Mets 0 si aucun.'), cols: [{k: 'name', l: 'Poste', text: 1}, {k: 'cost', l: 'Coût annuel', s: '€/an'}]}}
    ],
    details: [
      {t: 'Marge, risque, frais et impôt', f: [F('marginPercent', '%', 'Part du tarif HT qui doit te rester (taux de marque).'), F('riskPercent', '%', 'Impayés, avoirs.'), F('feePercent', '%', 'Frais bancaires, encaissement.'), F('taxPercent', '%', 'Taux moyen de l’impôt sur le bénéfice, à demander à ton comptable.'), F('targetNet', '€/an', 'Bénéfice voulu en plus de ta rémunération, déjà comptée.')]}
    ],
    watch: ['riskPercent', 'feePercent', 'taxPercent']
  }
};
var DEF = {
  fabrication: {name: 'Fournée de pain de campagne (exemple)', v: {quantity: '20', unit: 'pièce', price: '3,76', priceMode: 'HT', vat: '', materialsTotal: '4,57', minutes: '90', laborHourly: '29,50', fixedMonthly: '0', productiveHours: '160', lossPercent: '0', marginPercent: '35', riskPercent: '2', feePercent: '1,2', taxPercent: '25', targetNet: '20', targetScope: 'lot', country: 'BE', unsoldPercent: ''}, lists: {materials: [{name: 'Farine T65', qty: '6', u: 'kg', price: '0,7617'}]}, mode: {materials: 'total'}},
  travaux: {name: 'Toiture en tuiles, 180 m² (exemple)', v: {surface: '180', pricePerM2: '59,38', priceMode: 'HT', vat: '', yieldPerDay: '22', hoursPerDay: '8', materialPerM2: '24,377', lossPercent: '0', fuelLitersPerDay: '12', fuelPrice: '1,65', consumablesPerDay: '15', scaffoldingPerDay: '45', machinePerDay: '0', skipCost: '320', distanceKm: '46', costPerKm: '0,55', tripsMode: 'daily', tripsPerDay: '1', trips: '', otherCosts: '0', financingCost: '0', fullDays: 'false', fixedPercent: '12', contingencyPercent: '7', marginPercent: '18', retentionPercent: '0', riskPercent: '3', feePercent: '1,5', taxPercent: '25', targetNet: '2000', country: 'BE', scaffoldingFixed: '', weatherDays: ''}, lists: {team: [{name: 'Chef d’équipe', count: '1', hourlyCost: '42'}, {name: 'Ouvriers qualifiés', count: '2', hourlyCost: '36'}, {name: 'Manœuvre', count: '1', hourlyCost: '26'}], materials: [{name: 'Tuile mécanique', qty: '13', u: 'pièce', price: '1,4581'}, {name: 'Liteau 27×40', qty: '3,2', u: 'm', price: '1,045'}, {name: 'Écran sous-toiture', qty: '1,1', u: 'm²', price: '1,89'}]}, mode: {materials: 'total'}},
  services: {name: 'Cabinet de 2 personnes (exemple)', v: {persons: '2', weeks: '44', weeklyHours: '40', billablePercent: '62', rate: '75', priceMode: 'HT', vat: '', directorMode: 'direct', directorAnnualCost: '69600', directorNet: '48000', contributionPercent: '45', staffAnnual: '38000', structureTotal: '36500', marginPercent: '20', riskPercent: '2', feePercent: '1', taxPercent: '25', targetNet: '30000', country: 'BE', dayHours: ''}, lists: {structure: [{name: '', cost: ''}]}, mode: {structure: 'total'}}
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
var S = lsGet('pnr-draft-v2');
if (!S || !CFG[S.type]) S = freshState('fabrication');
var cache = {};
cache[S.type] = S;
function saveDraft(){ lsSet('pnr-draft-v2', S); }
function unitWord(){ return UNIT_WORD[S.v.unit] || S.v.unit || 'pièce'; }
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
    var sel = '<select id="f-vatChoice" data-vat="1"><option value="">Choisis le taux</option>' + rates.map(function(x){ return '<option value="' + esc(clean(x)) + '"' + (choice === clean(x) ? ' selected' : '') + '>' + esc(x) + ' %</option>'; }).join('') + '<option value="autre"' + (choice === 'autre' ? ' selected' : '') + '>Autre taux</option></select>';
    return '<div class="field" data-field="vat"><label for="f-vatChoice">' + label + ' <span class="mute" style="font-weight:400">(facultatif)</span></label><div class="inp">' + sel + '</div>' + (choice === 'autre' ? '<div class="inp" style="margin-top:6px"><input id="f-vat" inputmode="decimal" autocomplete="off" data-k="vat" value="' + esc(value || '') + '" aria-label="Taux de TVA"><em>%</em></div>' : '') + (f.h ? '<span class="hint">' + esc(f.h) + '</span>' : '') + '</div>';
  }
  if (f.kind === 'bool') return '<label class="check"><input type="checkbox" id="' + id + '" data-k="' + f.k + '"' + (value === 'true' ? ' checked' : '') + '><span><b>' + label + '</b><br><span class="mute small">' + esc(f.h || '') + '</span></span></label>';
  var s = suffixOf(f);
  return '<div class="field" data-field="' + f.k + '"><label for="' + id + '">' + label + (f.req ? '' : ' <span class="mute" style="font-weight:400">(facultatif)</span>') + '</label><div class="inp"><input id="' + id + '" inputmode="decimal" autocomplete="off" data-k="' + f.k + '" value="' + esc(value || '') + '">' + (s ? '<em>' + s + '</em>' : '') + '</div>' + (f.h ? '<span class="hint">' + esc(f.h) + '</span>' : '') + '</div>';
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
    }).join('') + '<button type="button" class="x" data-del="' + def.list + ':' + i + '" aria-label="Supprimer la ligne">×</button>' + (def.calc ? '<span class="row-cost num" data-rowcost="' + def.list + ':' + i + '"></span>' : '') + '</div>';
  }).join('') + '</div><div class="btn-row" style="margin-top:8px"><button type="button" class="btn btn-line btn-sm" data-add="' + def.list + '">+ Ajouter une ligne</button>' + (def.lib ? '<button type="button" class="btn btn-ghost btn-sm" data-libsave="' + def.list + '">Enregistrer ces prix dans « Mes prix d’achat »</button>' : '') + '</div>';
}
function dirHTML(){
  var m = S.v.directorMode || 'direct';
  var opts = [['direct','Je connais son coût total annuel'],['markup','Net + charges en % du net'],['fraction','Charges en % du coût total']];
  var h = '<div class="seg" role="group" aria-label="Méthode">' + opts.map(function(o){ return '<button type="button" data-dir="' + o[0] + '" aria-pressed="' + (m === o[0]) + '">' + o[1] + '</button>'; }).join('') + '</div><div class="fields two" style="margin-top:12px">';
  if (m === 'direct') h += fieldHTML(F('directorAnnualCost', '€/an', 'Ce qu’il coûte à la structure, cotisations comprises. Mets 0 seulement si tu le comptes ailleurs.', {req: 1}), S.v.directorAnnualCost);
  else h += fieldHTML(F('directorNet', '€/an', 'Après cotisations, avant impôt sur le revenu.', {req: 1}), S.v.directorNet) + fieldHTML(F('contributionPercent', '%', m === 'markup' ? 'Coût = net × (1 + taux). Mets 0 si aucune.' : 'Coût = net ÷ (1 − taux), taux sous 100 %.', {req: 1}), S.v.contributionPercent);
  return h + '</div><p class="hint" style="margin-top:8px">Ton taux de charges dépend de ton statut et de ton pays : demande-le à ton comptable ou à ta caisse.</p>';
}
function blockHTML(b, isDetail){
  var inner = '';
  if (b.dir) inner += dirHTML();
  if (b.alt){
    var mode = S.mode[b.alt.list] || 'total';
    inner += '<div class="seg" role="group" aria-label="Saisie" style="margin-bottom:10px"><button type="button" data-mode="' + b.alt.list + ':total" aria-pressed="' + (mode === 'total') + '">Un total</button><button type="button" data-mode="' + b.alt.list + ':list" aria-pressed="' + (mode === 'list') + '">Ligne par ligne</button></div>';
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
  var note = S.carryNote || (S.example ? 'Exemple chargé : remplace chaque chiffre par le tien, y compris dans les sections repliées.' : '');
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
    if (blank(raw)){ if (req) setErr(k, '« ' + label + ' » est nécessaire.'); return undefined; }
    var n = parseNum(raw);
    if (isNaN(n)){ setErr(k, '« ' + label + ' » n’est pas un nombre valide.'); return undefined; }
    if (n < 0){ setErr(k, '« ' + label + ' » ne peut pas être négatif.'); return undefined; }
    if (dotThousands(raw)) notes.push('« ' + raw + ' » est lu ' + fmt(n, n % 1 ? 2 : 0) + (DEC === '.' ? ' : la virgule sépare les milliers. Écris le point pour les décimales (3.1).' : ' : le point sépare les milliers. Écris la virgule pour les décimales (3,1).'));
    return n;
  }
  allFields(st.type).forEach(function(f){
    var raw = st.v[f.k];
    if (f.kind === 'sel'){ if (raw) inputs[f.k] = raw; return; }
    if (f.kind === 'bool'){ inputs[f.k] = raw === 'true'; return; }
    if (f.kind === 'vatpick'){ var vv = num('vat', raw, LABELS.vat, false); if (vv !== undefined){ if (vv > 100) setErr('vat', 'Le taux de TVA doit rester sous 100 %.'); inputs.vat = vv; } return; }
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
      if (!rows.length) setErr(def.list, x.alt ? 'Ajoute au moins une ligne dans « ' + LABELS[def.list] + ' », ou repasse en « Un total ».' : 'Ajoute au moins une personne dans ton équipe, avec son nombre et son coût horaire.');
      inputs[def.list] = rows.map(function(r, i){
        var o = {};
        var legacy = def.calc && blank(r.qty) && blank(r.price) && !blank(r[def.out]);
        if (legacy){ o.name = String(r.name || '').trim() || '—'; o[def.out] = num(def.list, r[def.out], 'Coût (ligne ' + (i + 1) + ')', true); return o; }
        def.cols.forEach(function(col){
          if (col.text){ o[col.k] = String(r[col.k] || '').trim() || (col.k === 'name' ? '—' : ''); return; }
          if (col.sel){ o[col.k] = r[col.k] || col.sel[0][0]; return; }
          var n = num(def.list, r[col.k], col.l + ' (ligne ' + (i + 1) + ')', true);
          if (def.list === 'team' && col.k === 'count' && n === 0) setErr(def.list, 'Ligne ' + (i + 1) + ' de l’équipe : le nombre doit être au moins 1, ou supprime la ligne.');
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
  if (inputs.priceMode === 'TTC' && inputs.vat === undefined) setErr('vat', 'Ton prix est TTC : choisis le taux de TVA qu’il contient.');
  var extra = {};
  if (st.type === 'fabrication' && inputs.unsoldPercent !== undefined){
    var u = inputs.unsoldPercent; delete inputs.unsoldPercent;
    if (u >= 100) setErr('unsoldPercent', 'Les invendus doivent rester sous 100 % de la production.');
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
  if (st.type === 'travaux' && (st.v.tripsMode || 'daily') === 'fixed' && inputs.distanceKm > 0 && inputs.trips === undefined) setErr('trips', 'Mode « nombre fixe » : indique le nombre de trajets du chantier.');
  return {inputs: inputs, err: err, notes: notes, extra: extra};
}
function runEngine(st){
  var b = buildInputs(st);
  if (b.err) return {err: b.err, inputs: b.inputs, notes: b.notes, extra: b.extra};
  try { return {r: PNR.calculate(st.type, b.inputs), inputs: b.inputs, notes: b.notes, extra: b.extra}; }
  catch (e){
    if (e instanceof PNR.PnrError){
      var f = e.field || '', label = LABELS[f];
      return {err: {field: f, msg: label ? '« ' + label + ' » : valeur hors limites.' : e.message}, inputs: b.inputs, notes: b.notes, extra: b.extra};
    }
    throw e;
  }
}

// ---------- calcul complet : résultat ----------
function L(label, value, cls){ return '<li class="' + (cls || '') + '"><span>' + label + '</span><i></i><span class="num">' + value + '</span></li>'; }
function unitOf(st, r){ return st.type === 'fabrication' ? (UNIT_WORD[r.details.unit] || r.details.unit || 'pièce') : st.type === 'travaux' ? 'm²' : 'h'; }
function netLabel(st){ return st.type === 'services' ? 'Bénéfice après impôt, en plus de ta rémunération' : 'Net réel après impôt'; }
// avertissements du moteur à masquer selon le cas (mêmes textes que dans le moteur)
var W_TARGET = 'Objectif impossible au taux actuel dans la capacité disponible.';
var W_NOPRICE = ['Le prix actuel produit une perte dans les hypothèses saisies.', W_TARGET, 'Les retenues récupérables sont un décalage de trésorerie, pas une perte. Le coût de financement doit être renseigné séparément.'];
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
  if (run.err) return '<p class="eyebrow">Il manque une donnée</p><p class="err">' + esc(run.err.msg) + '</p><p class="limit">Le calcul se met à jour dès que la case est corrigée.</p>';
  var r = run.r, d = r.details, u = unitOf(st, r), per = ' / ' + u;
  var hasPrice = r.revenue > 0;
  var h = '';
  if (run.notes.length) h += '<p class="gap">' + run.notes.map(esc).join('<br>') + '</p>';
  var ex = run.extra || {};
  var uPl = UNIT_PL[u] || u;
  if (ex.unsold) h += '<p class="limit" style="border:0;padding:0">Calcul sur ' + fmt(d.quantity, d.quantity % 1 ? 2 : 0) + ' ' + uPl + ' vendus sur ' + fmt(ex.produced, ex.produced % 1 ? 2 : 0) + ' produits (' + fmt(ex.unsold, 1) + ' % d’invendus) : le coût est réparti sur ce qui est vendu.</p>';
  h += '<p class="eyebrow">Ton prix plancher</p><p class="big">' + eur(r.minimumPrice) + '<small>HT' + per + '</small></p>' +
    '<p class="small" style="color:var(--night-mute)">Sous ce prix, tu perds de l’argent : il paie tous tes coûts, tes risques et tes frais, sans bénéfice.</p><ul class="lines">';
  h += L('Coût de revient', eur(d.beforeFeesThreshold) + per);
  h += L('Prix plancher', eur(r.minimumPrice) + per, 'strong');
  if (d.marginPercent > 0) h += L('Prix conseillé (marge ' + fmt(d.marginPercent, d.marginPercent % 1 ? 1 : 0) + ' %)', eur(r.recommendedPrice) + per);
  var unitTarget = st.type === 'fabrication' && d.targetScope === 'unit';
  if (d.targetNet > 0) h += L('Prix pour garder ' + eur(unitTarget ? d.targetNet / d.quantity : d.targetNet, 0) + (unitTarget ? ' par ' + u : st.type === 'services' ? ' par an' : '') + ' net', eur(r.targetPrice) + per, 'strong');
  if (hasPrice) h += L('Ton prix actuel' + (st.v.priceMode === 'TTC' ? ' (ramené en HT)' : ''), eur(r.currentPrice) + per);
  h += '</ul>';
  if (ex.vat !== undefined && ex.vat > 0){
    var tt = function(x){ return eur(x * (1 + ex.vat / 100)) + per; };
    h += '<p class="eyebrow" style="margin-top:2px">Les mêmes prix TTC (TVA ' + fmt(ex.vat, ex.vat % 1 ? 1 : 0) + ' %)</p><ul class="lines">' + L('Prix plancher TTC', tt(r.minimumPrice)) + (d.marginPercent > 0 ? L('Prix conseillé TTC', tt(r.recommendedPrice)) : '') + (d.targetNet > 0 ? L('Prix pour ton objectif TTC', tt(r.targetPrice)) : '') + (hasPrice ? L('Ton prix actuel TTC', tt(r.currentPrice)) : '') + '</ul>';
  }
  if (st.type === 'services'){
    var dh = ex.dayHours || 8, dd = function(x){ return eur(x * dh) + ' / jour'; };
    h += '<p class="eyebrow" style="margin-top:2px">À la journée (' + fmt(dh, dh % 1 ? 1 : 0) + ' h facturées)</p><ul class="lines">' + L('Prix plancher', dd(r.minimumPrice)) + (d.marginPercent > 0 ? L('Prix conseillé', dd(r.recommendedPrice)) : '') + (d.targetNet > 0 ? L('Prix pour ton objectif', dd(r.targetPrice)) : '') + (hasPrice ? L('Ton tarif actuel', dd(r.currentPrice)) : '') + '</ul>';
  }
  if (d.marginPercent > 0 && r.recommendedPrice < r.minimumPrice - 1e-9) h += '<p class="gap">Ta marge visée (' + fmt(d.marginPercent, 1) + ' %) est plus petite que tes risques et frais (' + fmt(d.riskPercent + d.feePercent, 1) + ' %) : le prix conseillé tombe sous ton plancher. Monte ta marge.</p>';
  if (hasPrice){
    if (r.currentPrice < r.minimumPrice - 1e-9) h += '<p class="verdict">Ton prix est sous ton plancher : il te manque ' + eur(r.minimumPrice - r.currentPrice) + per + '.</p>';
    else if (d.targetNet > 0 && r.currentPrice < r.targetPrice - 1e-9) h += '<p class="verdict">Rentable, mais sous ton objectif : il manque ' + eur(r.targetPrice - r.currentPrice) + per + '.</p>';
    else h += '<p class="verdict good">Ton prix couvre tes coûts' + (d.targetNet > 0 ? ' et atteint ton objectif' : '') + '.</p>';
    var rows = [['Chiffre d’affaires HT', r.revenue, 'hsl(218 30% 60%)']].concat(r.breakdown.map(function(b){ return [BREAK_LABEL[b.label] || b.label, b.amount, 'hsl(214 16% 62%)']; })).concat([['Ce qu’il te reste', r.net, r.net >= 0 ? 'var(--ok-night)' : 'var(--loss-night)']]);
    h += '<p class="eyebrow" style="margin-top:4px">Où part ton prix</p><ul class="cascade-night">' + rows.filter(function(x){ return Math.abs(x[1]) > 0.004 || x[0] === 'Ce qu’il te reste'; }).map(function(x){
      var w = Math.min(100, Math.abs(x[1]) / r.revenue * 100);
      return '<li><div class="lab"><span>' + x[0] + '</span><span class="num">' + eur(x[1]) + '</span></div><div class="track"><i style="width:' + w.toFixed(1) + '%;background:' + x[2] + '"></i></div></li>';
    }).join('') + '</ul>';
    var div = st.type === 'fabrication' ? d.quantity : st.type === 'travaux' ? d.surface : d.hours;
    h += '<ul class="lines">' + L(netLabel(st), '<span class="' + (r.net >= 0 ? 'pos' : 'neg') + '">' + eur(r.net) + '</span>', 'strong') + L('Par ' + u, eur(r.net / div)) + L('Soit', fmt(r.net / r.revenue * 100, 1) + ' % du prix HT') + '</ul>';
  } else {
    h += '<p class="gap">Mets ton prix actuel pour voir ce qu’il te reste et ce qui le grignote.</p>';
  }
  h += '<p class="eyebrow" style="margin-top:4px">Détails</p><ul class="lines">';
  if (st.type === 'fabrication'){
    h += L('Coût horaire retenu (temps + charges fixes)', eur(d.hourly) + ' / h') + L('Matières du lot', eur(d.material)) + L('Temps du lot', eur(d.labor));
  } else if (st.type === 'services'){
    h += L('Heures travaillées par an', fmt(d.paidHours, 0) + ' h') + L('Heures facturées par an', fmt(d.hours, 0) + ' h') + L('Charges annuelles', eur(r.cost, 0));
    if (d.targetNet > 0 && hasPrice && d.requiredHours !== null) h += L('Heures à facturer pour ton objectif', fmt(d.requiredHours, 0) + ' h');
  } else {
    h += L('Durée du chantier', fmt(d.duration, 2) + ' j (' + d.days + ' j comptés)') + L('Main-d’œuvre', eur(d.labor)) + L('Matériaux', eur(d.material)) + L('Frais de chantier', eur(d.expenses));
    if (hasPrice) h += L('Rendement minimum à ce prix', d.equilibriumStatus === 'found' ? fmt(d.displayedEquilibriumYield, 2) + ' m²/homme/j' : d.equilibriumStatus === 'any' ? 'sans limite' : 'aucun', 'strong');
    if (d.retentionAmount > 0) h += L('Retenue encaissée plus tard', eur(d.retentionAmount));
    if (ex.scaffoldFixed > 0) h += L('Échafaudage, forfait (dans les frais)', eur(ex.scaffoldFixed));
    if (ex.weatherCost > 0) h += L(fmt(ex.weatherDays, 0) + ' jours d’intempéries (dans les frais)', eur(ex.weatherCost));
  }
  h += '</ul>';
  if (st.type === 'services' && d.targetNet > 0 && hasPrice && d.impossible) h += '<p class="verdict">Ton objectif est impossible à ce tarif : il faudrait ' + fmt(d.requiredHours, 0) + ' h facturées, tu en as ' + fmt(d.hours, 0) + '. Augmente ton prix.</p>';
  if (st.type === 'services') h += '<p class="limit">Entreprise individuelle : l’impôt sur ta propre rémunération n’est pas compté ici. Le bénéfice s’ajoute à ta rémunération.</p>';
  if (st.type === 'travaux' && hasPrice){
    var planned = parseNum(st.v.yieldPerDay);
    if (d.equilibriumStatus === 'found'){
      if (planned < d.displayedEquilibriumYield) h += '<p class="verdict">Ton rendement prévu (' + fmt(planned, 2) + ') est déjà sous le minimum (' + fmt(d.displayedEquilibriumYield, 2) + ' m²/homme/j) : à ce prix, le chantier perd de l’argent.</p>';
      else h += '<p class="gap">Si ton équipe descend sous <b>' + fmt(d.displayedEquilibriumYield, 2) + ' m² par homme et par jour</b>, ce chantier te coûte de l’argent. Tu prévois ' + fmt(planned, 2) + '.</p>';
    } else if (d.equilibriumStatus === 'impossible') h += '<p class="verdict">Même avec une équipe infiniment rapide, ce prix ne paie pas les matériaux et les frais fixes du chantier.</p>';
  }
  var zero = CFG[st.type].watch.filter(function(k){ return !(parseNum(st.v[k]) > 0); }).map(function(k){ return lower((LABELS[k] || k).split(' (')[0]); });
  if (zero.length) h += '<p class="limit">Comptés à 0 dans ce calcul : ' + zero.join(', ') + '. Vérifie que c’est voulu.</p>';
  var warns = cleanWarnings(st, r);
  if (warns.length) h += '<ul class="warns">' + warns.map(function(w){ return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>';
  return h;
}
function miniHTML(st, run){
  if (run.err) return '<span class="mini-err">' + esc(run.err.msg) + '</span>';
  var r = run.r, u = unitOf(st, r);
  return '<span>Plancher <b class="num">' + eur(r.minimumPrice) + '/' + u + '</b></span>' + (r.revenue > 0 ? '<span>Reste <b class="num ' + (r.net >= 0 ? 'pos' : 'neg') + '">' + eur(r.net, 0) + '</b></span>' : '') + '<a href="#c-result" data-scroll="1">Détail ↓</a>';
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
    if (!n){ toast('Rien à enregistrer : donne un nom et un prix à chaque ligne.'); return; }
    Lib.save().then(function(){ toast(n + (n > 1 ? ' prix enregistrés' : ' prix enregistré') + ' dans « Mes prix d’achat ».'); renderDatalist(); }, function(){ toast('Enregistrement impossible dans ce navigateur.'); });
    return;
  }
  else return;
  renderForm(); compute(); saveDraft();
});
$('#c-name').addEventListener('input', function(e){ S.name = e.target.value; saveDraft(); });
$('#c-client').addEventListener('input', function(e){ S.client = e.target.value; saveDraft(); });
$$('.type').forEach(function(b){ b.addEventListener('click', function(){ setType(b.getAttribute('data-type')); }); });
$('#c-example').addEventListener('click', function(e){ if (!armed(e.currentTarget, 'Effacer tes chiffres ? Appuie encore')) return; S = freshState(S.type); cache[S.type] = S; renderForm(); compute(); saveDraft(); toast('Exemple rechargé.'); });
$('#c-clear').addEventListener('click', function(e){ if (!armed(e.currentTarget, 'Tout effacer ? Appuie encore')) return; S = freshState(S.type, true); cache[S.type] = S; renderForm(); compute(); saveDraft(); });
document.addEventListener('click', function(e){ var a = e.target.closest('[data-scroll]'); if (a){ e.preventDefault(); $('#c-result').scrollIntoView({behavior: 'smooth', block: 'start'}); } });

// ---------- résumé texte et PDF ----------
var TYPE_NAME = {fabrication: 'Fabrication', travaux: 'Chantier', services: 'Services'};
function fieldDef(type, k){ var all = allFields(type); var f = all.filter(function(x){ return x.k === k; })[0]; if (f) return f; var c = CFG[type]; var out = null; c.blocks.forEach(function(b){ if (b.alt && b.alt.total.k === k) out = b.alt.total; }); return out; }
function summaryLines(st, run){
  var r = run.r, d = r.details, u = unitOf(st, r), per = ' / ' + u, out = [];
  out.push(['Coût de revient', eur(d.beforeFeesThreshold) + per]);
  out.push(['Prix plancher (risques et frais compris)', eur(r.minimumPrice) + per]);
  if (d.marginPercent > 0) out.push(['Prix conseillé (marge ' + fmt(d.marginPercent, d.marginPercent % 1 ? 1 : 0) + ' % du prix)', eur(r.recommendedPrice) + per]);
  if (d.targetNet > 0) out.push(['Prix pour ton net visé', eur(r.targetPrice) + per]);
  if (r.revenue > 0){ out.push(['Prix actuel HT', eur(r.currentPrice) + per]); out.push(['Chiffre d’affaires HT', eur(r.revenue)]); r.breakdown.forEach(function(b){ if (Math.abs(b.amount) > 0.004) out.push(['  ' + b.label, eur(b.amount)]); }); out.push([netLabel(st), eur(r.net)]); }
  if (st.type === 'travaux' && r.revenue > 0 && d.equilibriumStatus === 'found') out.push(['Rendement minimum à ce prix', fmt(d.displayedEquilibriumYield, 2) + ' m²/homme/jour']);
  if (st.type === 'services'){ out.push(['Heures facturées par an', fmt(d.hours, 0) + ' h']); if (d.targetNet > 0 && r.revenue > 0 && d.requiredHours !== null) out.push(['Heures nécessaires pour l’objectif', fmt(d.requiredHours, 0) + ' h']); }
  return out;
}
var DIR_LABEL = {direct: 'coût total annuel', markup: 'net + charges en % du net', fraction: 'charges en % du coût total'};
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
    else if (typeof v === 'boolean') { if (v) out.push([label, 'oui']); }
    else if (f && f.o){ var o = f.o.filter(function(x){ return x[0] === v; })[0]; out.push([label, o ? o[1] : v]); }
    else out.push([label, v]);
  });
  return out;
}
function summaryText(st, run){
  var t = 'PRIX NET RÉEL — ' + TYPE_NAME[st.type] + '\n' + (st.name || 'Calcul') + (st.client ? ' — ' + st.client : '') + '\n' + new Date().toLocaleDateString('fr-FR') + '\n\n';
  t += summaryLines(st, run).map(function(l){ return l[0] + ' : ' + l[1]; }).join('\n');
  t += '\n\nHypothèses saisies :\n' + inputLines(st).map(function(l){ return '- ' + l[0] + ' : ' + l[1]; }).join('\n');
  return t + '\n\n' + PNR.DISCLAIMER;
}
$('#c-copy').addEventListener('click', function(){
  compute(); if (!lastRun || lastRun.err) return;
  var text = summaryText(S, lastRun);
  try { navigator.clipboard.writeText(text).then(function(){ toast('Résumé copié.'); }, function(){ fallbackCopy(text); }); } catch(e){ fallbackCopy(text); }
});
function fallbackCopy(text){ var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('Résumé copié.'); } catch(e){ toast('Copie impossible ici : sélectionne le texte du résultat.'); } ta.remove(); }
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
  doc.setTextColor(20, 28, 45); y = 26; doc.setFontSize(16); doc.text(pdfText(st.name || 'Calcul'), M, y); y += 7;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.text(pdfText(TYPE_NAME[st.type] + (st.client ? ' · ' + st.client : '') + ' · ' + new Date().toLocaleDateString('fr-FR')), M, y); y += 10;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Résultats', M, y); y += 7;
  summaryLines(st, run).forEach(function(l, i){ line(l[0], l[1], i === 1); });
  y += 5; doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Hypothèses saisies', M, y); y += 7;
  inputLines(st).forEach(function(l){ line(l[0], l[1]); });
  var warns = cleanWarnings(st, run.r);
  if (warns.length){ y += 5; doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('À savoir', M, y); y += 7; warns.forEach(function(w){ line('• ' + w); }); }
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
        page.drawText(winAnsi(st.name || 'Calcul'), {x: M, y: y, size: 16, font: f[1], color: ink}); y -= 20;
        page.drawText(winAnsi(TYPE_NAME[st.type] + (st.client ? ' · ' + st.client : '') + ' · ' + new Date().toLocaleDateString('fr-FR')), {x: M, y: y, size: 10, font: f[0], color: grey}); y -= 22;
        title('Résultats'); summaryLines(st, run).forEach(function(l, i){ line(l[0], l[1], i === 1); });
        title('Hypothèses saisies'); inputLines(st).forEach(function(l){ line(l[0], l[1]); });
        var warns = cleanWarnings(st, run.r);
        if (warns.length){ title('À savoir'); warns.forEach(function(w){ line('• ' + w); }); }
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
    '<div class="bar">PRIX NET RÉEL</div><h1>' + esc(st.name || 'Calcul') + '</h1><p>' + esc(TYPE_NAME[st.type] + (st.client ? ' · ' + st.client : '') + ' · ' + new Date().toLocaleDateString('fr-FR')) + '</p>' +
    '<h2>' + esc('Résultats') + '</h2><table>' + rows(summaryLines(st, run)) + '</table><h2>' + esc('Hypothèses saisies') + '</h2><table>' + rows(inputLines(st)) + '</table>' +
    (warns.length ? '<h2>' + esc('À savoir') + '</h2><ul>' + warns.map(function(w){ return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' : '') + '<p class="mute">' + esc(PNR.DISCLAIMER) + '</p></body></html>';
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
    setTimeout(function(){ try { f.contentWindow.focus(); f.contentWindow.print(); } catch(e){ toast('Impression impossible ici.'); } }, 300);
  }
  toast('Pour le PDF : choisis « Enregistrer au format PDF » dans la fenêtre d’impression.');
}
function pdfName(){ return 'prix-net-reel-' + ((S.name || 'calcul').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'calcul') + '.pdf'; }
$('#c-pdf').addEventListener('click', function(){
  if (SITE && PDF_PRINT){ compute(); if (!lastRun || lastRun.err) return; printReport(S, lastRun); return; }
  if (SITE){
    compute(); if (!lastRun || lastRun.err) return;
    var b = this; b.disabled = true;
    buildPdfSite(S, lastRun).then(function(blob){ return downloads.save({filename: pdfName(), data: blob}); }).then(function(){ toast('PDF prêt.'); }, function(){ toast('Le PDF n’a pas pu être créé. Réessaie.'); }).then(function(){ b.disabled = false; });
    return;
  }
  compute(); if (!lastRun || lastRun.err || !downloads || !window.jspdf) return;
  var doc = buildPdf(S, lastRun);
  var name = (S.name || 'calcul').replace(/[^\wÀ-ÿ -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'calcul';
  downloads.save({filename: 'prix-net-reel-' + name + '.pdf', data: doc.output('blob')}).then(function(){ toast('PDF prêt.'); }, function(e){ if (e && e.code === 'declined') return; toast('Le PDF n’a pas pu être enregistré ici.'); });
});

// ---------- enregistrement ----------
var Store = {mode: 'local', db: null, uid: null, ready: null};
Store.ready = Promise.all([cap('db'), cap('user')]).then(function(res){
  var db = res[0], user = res[1];
  if (!db || !user) return;
  return user.id().then(function(id){ if (id){ Store.db = db; Store.uid = id; Store.mode = 'db'; } }).catch(function(){});
});
function localAll(){ return lsGet('pnr-saved-v1') || []; }
Store.list = function(){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.collection('data/users/' + Store.uid).get().then(function(s){ return s.docs.filter(function(d){ return d.id !== 'prix'; }).map(function(d){ return Object.assign({id: d.id}, d.data()); }).filter(function(x){ return !!x.type; }); }, function(){ Store.mode = 'local'; return localAll(); });
  return localAll();
}); };
Store.save = function(rec){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.collection('data/users/' + Store.uid).doc(rec.id).set(rec).catch(function(){ Store.mode = 'local'; return Store.save(rec); });
  var all = localAll().filter(function(x){ return x.id !== rec.id; }); all.push(rec); if (!lsSet('pnr-saved-v1', all)) throw new Error('local');
}); };
Store.remove = function(id){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.collection('data/users/' + Store.uid).doc(id).delete().catch(function(){});
  lsSet('pnr-saved-v1', localAll().filter(function(x){ return x.id !== id; }));
}); };
$('#c-save').addEventListener('click', function(){
  compute(); if (!lastRun || lastRun.err) return;
  var r = lastRun.r;
  var name = (S.name || '').trim() || ('Calcul ' + lower(TYPE_NAME[S.type]));
  var update = S.savedId && S.savedName === name;
  if (!update) S.savedId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  var rec = {id: S.savedId, type: S.type, name: name, client: S.client || '', savedAt: new Date().toISOString(), v: S.v, lists: S.lists, mode: S.mode,
    summary: {unit: unitOf(S, r), minimumPrice: r.minimumPrice, recommendedPrice: r.recommendedPrice, targetPrice: r.targetPrice, net: r.net, revenue: r.revenue, margin: r.details.marginPercent, target: r.details.targetNet}};
  $('#c-save').disabled = true;
  Store.save(rec).then(function(){ S.savedName = name; S.name = name; $('#c-name').value = name; saveDraft(); toast(update ? 'Calcul « ' + name + ' » mis à jour.' : 'Calcul « ' + name + ' » enregistré. Change le nom pour en garder un autre.'); }, function(){ toast('Enregistrement impossible dans ce navigateur.'); }).then(function(){ $('#c-save').disabled = false; });
});
// ---------- mes prix d'achat ----------
var Lib = {items: []};
function libKey(n){ return String(n || '').trim().toLowerCase(); }
Lib.find = function(name, kind){ var k = libKey(name); if (!k) return null; return Lib.items.filter(function(x){ return libKey(x.name) === k && (!kind || x.kind === kind); })[0] || null; };
Lib.upsert = function(it){ var old = Lib.find(it.name, it.kind); if (old){ old.price = it.price; old.u = it.u || old.u; } else Lib.items.push(it); };
Lib.load = function(){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.doc('data/users/' + Store.uid + '/prix').get().then(function(d){ Lib.items = d.exists ? clone((d.data() || {}).items || []) : []; }, function(){ Lib.items = lsGet('pnr-prix-v1') || []; });
  Lib.items = lsGet('pnr-prix-v1') || [];
}).then(renderDatalist); };
Lib.save = function(){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.doc('data/users/' + Store.uid + '/prix').set({items: Lib.items});
  if (!lsSet('pnr-prix-v1', Lib.items)) throw new Error('local');
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
    if (run.err) return {x: x, rank: 4, html: '<td>' + esc(x.name) + '</td><td>' + esc(TYPE_NAME[x.type] || '') + '</td><td colspan="5" class="mute">À compléter : ' + esc(run.err.msg) + '</td><td><span class="chip warn">à compléter</span></td>'};
    var r = run.r, d = r.details, u = unitOf(st, r), hasPrice = r.revenue > 0, status, rank;
    if (!hasPrice){ status = '<span class="chip">pas de prix</span>'; rank = 3; }
    else if (r.currentPrice < r.minimumPrice - 1e-9){ status = '<span class="chip bad">sous le plancher</span>'; rank = 0; }
    else if (d.targetNet > 0 && r.currentPrice < r.targetPrice - 1e-9){ status = '<span class="chip warn">sous l’objectif</span>'; rank = 1; }
    else { status = '<span class="chip ok">rentable</span>'; rank = 2; }
    return {x: x, rank: rank, html: '<td>' + esc(x.name) + (upd ? ' <span class="mute small">(' + upd + ' prix mis à jour)</span>' : '') + '</td><td>' + esc(TYPE_NAME[x.type] || '') + '</td>' +
      '<td class="num">' + eur(r.minimumPrice) + ' / ' + u + '</td><td class="num">' + (d.marginPercent > 0 ? eur(r.recommendedPrice) : '—') + '</td><td class="num">' + (hasPrice ? eur(r.currentPrice) : '—') + '</td>' +
      '<td class="num ' + (hasPrice ? (r.currentPrice - r.minimumPrice >= 0 ? 'pos' : 'neg') : '') + '">' + (hasPrice ? (r.currentPrice - r.minimumPrice >= 0 ? '+' : '') + eur(r.currentPrice - r.minimumPrice) : '—') + '</td><td class="num">' + (hasPrice ? eur(r.net, 0) : '—') + '</td><td>' + status + '</td>'};
  }).sort(function(a, b){ return a.rank - b.rank; });
  return '<h3 style="font-size:1.3rem;margin-bottom:10px">Tous tes calculs, recalculés avec tes prix d’achat du jour</h3><div class="tablewrap"><table class="cmp"><thead><tr><th>Calcul</th><th>Métier</th><th>Plancher HT</th><th>Conseillé HT</th><th>Prix actuel HT</th><th>Écart / plancher</th><th>Reste</th><th>État</th></tr></thead><tbody>' + rows.map(function(r){ return '<tr>' + r.html + '</tr>'; }).join('') + '</tbody></table></div>';
}
function libEditorHTML(){
  var rows = Lib.items.map(function(x, i){
    return '<div class="row lib-row" style="--cols:3"><div class="field"><label class="small" for="lb-' + i + '-name">Nom</label><div class="inp"><input class="txt" id="lb-' + i + '-name" data-lib="' + i + '" data-libcol="name" value="' + esc(x.name) + '"></div></div><div class="field"><label class="small" for="lb-' + i + '-u">Unité utilisée</label><div class="inp"><input class="txt" id="lb-' + i + '-u" data-lib="' + i + '" data-libcol="u" value="' + esc(x.u || '') + '"></div></div><div class="field"><label class="small" for="lb-' + i + '-price">Prix d’achat (€ par kg, L ou unité)</label><div class="inp"><input inputmode="decimal" id="lb-' + i + '-price" data-lib="' + i + '" data-libcol="price" value="' + esc(x.price || '') + '"></div></div><div class="field"><label class="small" for="lb-' + i + '-kind">Pour</label><div class="inp"><select id="lb-' + i + '-kind" data-lib="' + i + '" data-libcol="kind"><option value="fabrication"' + (x.kind === 'fabrication' ? ' selected' : '') + '>Fabrication</option><option value="travaux"' + (x.kind === 'travaux' ? ' selected' : '') + '>Chantier</option></select></div></div><button type="button" class="x" data-libdel="' + i + '" aria-label="Supprimer">×</button></div>';
  }).join('');
  return '<h3 style="font-size:1.3rem;margin-bottom:6px">Mes prix d’achat</h3><p class="mute small" style="margin-bottom:10px">Change un prix ici, enregistre : tous les calculs qui utilisent cette matière (en saisie ligne par ligne) se recalculent.</p>' +
    (rows ? '<div class="rows" style="--cols:3">' + rows + '</div>' : '<p class="mute small">Aucun prix enregistré. Dans un calcul, passe les matières en « Ligne par ligne » et touche « Enregistrer ces prix ».</p>') +
    '<div class="btn-row" style="margin-top:10px"><button type="button" class="btn btn-line btn-sm" id="lib-add">+ Ajouter un prix</button>' + (Lib.items.length ? '<button type="button" class="btn btn-hivis btn-sm" id="lib-save">Enregistrer mes prix</button>' : '') + '</div>';
}
document.addEventListener('input', function(e){ var t = e.target; if (t.dataset && t.dataset.lib !== undefined){ Lib.items[+t.dataset.lib][t.dataset.libcol] = t.value; } });
document.addEventListener('change', function(e){ var t = e.target; if (t.dataset && t.dataset.lib !== undefined && t.tagName === 'SELECT'){ Lib.items[+t.dataset.lib][t.dataset.libcol] = t.value; } });
document.addEventListener('click', function(e){
  var b = e.target.closest('#lib-add,#lib-save,[data-libdel]'); if (!b) return;
  if (b.id === 'lib-add'){ Lib.items.push({name: '', u: '', price: '', kind: S.type === 'travaux' ? 'travaux' : 'fabrication'}); $('#s-lib').innerHTML = libEditorHTML(); return; }
  if (b.dataset.libdel !== undefined){ Lib.items.splice(+b.dataset.libdel, 1); $('#s-lib').innerHTML = libEditorHTML(); return; }
  Lib.items = Lib.items.filter(function(x){ return !blank(x.name); });
  Lib.save().then(function(){ toast('Prix d’achat enregistrés. Tes calculs sont recalculés.'); renderDatalist(); renderSaved(); }, function(){ toast('Enregistrement impossible dans ce navigateur.'); });
});

function renderSaved(){
  $('#s-where').textContent = 'Chargement…';
  Store.list().then(function(list){
    $('#s-where').textContent = Store.mode === 'db' ? 'Enregistrés dans ton compte Claude : visibles par toi seul, sur tous tes appareils.' : 'Enregistrés dans ce navigateur, sur cet appareil.';
    list.sort(function(a, b){ return String(b.savedAt).localeCompare(String(a.savedAt)); });
    $('#s-compare').innerHTML = compareHTML(list);
    $('#s-lib').innerHTML = libEditorHTML();
    if (!list.length){ $('#s-list').innerHTML = '<div class="empty"><b style="font-family:var(--f-display);font-size:1.2rem">Aucun calcul enregistré</b><span class="mute">Fais un calcul complet, puis touche « Enregistrer ».</span><a class="btn btn-hivis" href="#calcul">Faire un calcul</a></div>'; return; }
    $('#s-list').innerHTML = list.map(function(x){
      var s = x.summary || {};
      return '<div class="saved-item"><div><p class="eyebrow">' + esc(TYPE_NAME[x.type] || '') + '</p><h3>' + esc(x.name || 'Calcul') + '</h3><p class="meta">' + (x.client ? esc(x.client) + ' · ' : '') + new Date(x.savedAt).toLocaleDateString('fr-FR') + ' · plancher <span class="num">' + eur(s.minimumPrice || 0) + ' / ' + esc(s.unit || '') + '</span>' + (s.revenue > 0 ? ' · reste <span class="num">' + eur(s.net || 0) + '</span>' : '') + '</p></div><div class="btn-row"><button class="btn btn-line btn-sm" data-open-saved="' + esc(x.id) + '">Ouvrir</button><button class="btn btn-ghost btn-sm" data-del-saved="' + esc(x.id) + '">Supprimer</button></div></div>';
    }).join('');
    $$('[data-open-saved]').forEach(function(b){ b.addEventListener('click', function(){ var x = list.filter(function(i){ return i.id === b.getAttribute('data-open-saved'); })[0]; if (!x) return; S = stateFromRecord(x); var nU = applyLibrary(S); if (nU) S.carryNote = nU + ' prix mis à jour depuis « Mes prix d’achat ».'; cache[x.type] = S; renderForm(); compute(); saveDraft(); location.hash = 'calcul'; }); });
    $$('[data-del-saved]').forEach(function(b){ b.addEventListener('click', function(e){ if (!armed(e.currentTarget, 'Confirmer')) return; Store.remove(b.getAttribute('data-del-saved')).then(renderSaved); }); });
  });
}

// ---------- assistant ----------
var A = {sample: null, tools: false, turns: [], ctl: null, last: null};
// début de question et exemple proposés selon le métier choisi
var ASK_START = {fabrication: 'Je fabrique un produit et je veux connaître mon vrai prix de revient et mon prix plancher. ', travaux: 'Je dois chiffrer un chantier au m² et je veux connaître mon prix plancher. ', services: 'Je veux connaître mon vrai taux horaire et les heures que je dois facturer. '};
var ASK_HINT = {fabrication: 'Ex. : 40 pots de confiture par fournée, 2 h de travail, 38 € de fruits et de sucre…', travaux: 'Ex. : toiture en tuiles de 180 m², équipe de 4, je facture 59 € le m²…', services: 'Ex. : comptable indépendant à 70 € de l’heure, 40 h par semaine…'};
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
  PCT_STRICT.forEach(function(k){ if (typeof i[k] === 'number' && i[k] > 0 && i[k] < 1) throw new Error(k + ' = ' + i[k] + ' : les pourcentages s’écrivent en nombres (25 pour 25 %). Si c’est vraiment moins de 1 %, demande confirmation à la personne.'); });
  if (i.priceMode === 'TTC' && i.vat === undefined) throw new Error('Prix TTC sans taux de TVA : demande le taux de TVA compris dans le prix.');
  if (type === 'fabrication' && i.materialsTotal === undefined && !(Array.isArray(i.materials) && i.materials.length)) throw new Error('materialsTotal manquant : demande le coût des matières pour tout le lot (0 si aucune).');
  if (type === 'travaux'){
    if (i.materialPerM2 === undefined && !(Array.isArray(i.materials) && i.materials.length)) throw new Error('materialPerM2 manquant : demande le coût des matériaux au m² (0 si fournis par le client).');
    if (i.distanceKm > 0 && i.tripsMode === undefined) throw new Error('distanceKm donné sans tripsMode : précise « daily » (un aller-retour par jour) ou « fixed » avec trips.');
  }
  if (type === 'services'){
    if (i.directorNet !== undefined && i.directorMode === undefined) throw new Error('directorNet donné sans directorMode : utilise « markup » (charges en % du net) ou « fraction » (charges en % du coût total).');
    if (i.directorAnnualCost === undefined && i.directorNet === undefined) throw new Error('Rémunération du dirigeant manquante : demande son coût annuel total, ou son net annuel et le taux de charges.');
    if (i.directorMode === undefined && i.directorAnnualCost !== undefined) i.directorMode = 'direct';
  }
}
function r2(n){ return n === null || n === undefined ? null : Math.round(n * 100) / 100; }
var DEFAULTS = {fabrication: ['fixedMonthly','lossPercent','marginPercent','riskPercent','feePercent','taxPercent','targetNet'], travaux: ['fuelLitersPerDay','consumablesPerDay','scaffoldingPerDay','machinePerDay','skipCost','distanceKm','otherCosts','fixedPercent','contingencyPercent','marginPercent','riskPercent','feePercent','taxPercent','targetNet'], services: ['staffAnnual','structureTotal','marginPercent','riskPercent','feePercent','taxPercent','targetNet']};
function compact(type, r, inputs){
  var d = r.details, hasPrice = r.revenue > 0;
  var o = {montants: '€ HT', periode: type === 'fabrication' ? 'pour le lot' : type === 'travaux' ? 'pour le chantier' : 'par an', unite: type === 'fabrication' ? d.unit : type === 'travaux' ? 'm²' : 'heure',
    cout_de_revient_par_unite: r2(d.beforeFeesThreshold), prix_plancher_par_unite: r2(r.minimumPrice)};
  if (d.marginPercent > 0) o.prix_conseille_par_unite = r2(r.recommendedPrice);
  if (d.targetNet > 0) o.prix_pour_objectif_par_unite = r2(r.targetPrice);
  o.couts = r.breakdown.filter(function(b){ return ['Risques', 'Frais sur CA', 'Impôt estimé'].indexOf(b.label) < 0 && Math.abs(b.amount) > 0.004; }).map(function(b){ return b.label + ' : ' + r2(b.amount); });
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
      setStatus('Le moteur calcule…');
      var r;
      try { r = PNR.calculate(type, inputs); } catch (e){ throw new Error(e && e.message ? e.message : 'Calcul impossible avec ces données.'); }
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
  var u = type === 'fabrication' ? (UNIT_WORD[r.details.unit] || 'pièce') : type === 'travaux' ? 'm²' : 'h';
  var h = '<p class="eyebrow">Résultat du moteur · ' + TYPE_NAME[type] + '</p><ul class="lines">' + L('Prix plancher', eur(r.minimumPrice) + ' / ' + u, 'strong');
  if (r.details.marginPercent > 0) h += L('Prix conseillé', eur(r.recommendedPrice) + ' / ' + u);
  if (r.details.targetNet > 0) h += L('Prix pour ton objectif', eur(r.targetPrice) + ' / ' + u);
  if (r.revenue > 0) h += L('Reste après impôt', eur(r.net));
  if (type === 'travaux' && r.revenue > 0 && r.details.equilibriumStatus === 'found') h += L('Rendement minimum', fmt(r.details.displayedEquilibriumYield, 2) + ' m²/homme/j');
  h += '</ul><button class="btn btn-hivis btn-sm" type="button">Ouvrir dans le calcul complet</button>';
  div.innerHTML = h;
  div.querySelector('button').addEventListener('click', function(){ openFromInputs(type, inputs); });
  $('#a-thread').appendChild(div); $('#a-thread').scrollTop = 1e9;
}
function openFromInputs(type, inputs){
  var st = freshState(type, true); st.name = 'Calcul de l’assistant';
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
  st.carryNote = 'Calcul ouvert depuis l’assistant : vérifie chaque chiffre, puis enregistre.';
  S = st; cache[type] = st; renderForm(); compute(); saveDraft(); location.hash = 'calcul';
}
var ERR_COPY = {not_granted: 'L’assistant n’a pas été autorisé. Les calculs restent disponibles.', sampling_disabled: 'L’assistant n’est pas disponible pour ce compte.', rate_limited: 'Trop de questions d’un coup. Réessaie dans un moment.', session_expired: 'Reconnecte-toi à Claude, puis réessaie.', refused: 'L’assistant ne peut pas répondre à cette demande. Reformule-la.', empty_completion: 'Pas de réponse. Reformule ta question plus simplement.', prompt_too_large: 'La conversation est trop longue. Recharge la page pour en commencer une nouvelle.', tools_unavailable: 'L’assistant ne peut pas utiliser le moteur ici.'};
function assistantOff(msg){ $('#a-form').hidden = true; $('#a-chips').hidden = true; setStatus(''); $('#a-thread').innerHTML = ''; bubble('sys', msg); }
if (!SITE) cap('sample').then(function(s){
  if (!s){ assistantOff(window.PNR_EDITION === 'test' ? 'Version de test : l’assistant IA fait partie de la version complète. Ici, les tests rapides, le calcul complet et la comparaison de tes calculs marchent sans rien installer.' : 'L’assistant fonctionne quand cette page est ouverte dans Claude, connecté à ton compte. Les tests et le calcul complet marchent partout.'); return; }
  A.sample = s;
  (s.limits ? s.limits() : Promise.reject()).then(function(l){ A.tools = !!(l && l.tools); }, function(){ A.tools = false; }).then(function(){
    if (!A.tools){ assistantOff('Ton application Claude ne permet pas encore à l’assistant d’utiliser le moteur. Les tests et le calcul complet marchent.'); return; }
    bubble('ai', 'Salut. Dis-moi ce que tu veux chiffrer : un produit, un chantier ou ton taux horaire. Je te pose les questions une par une, et c’est le moteur qui calcule.');
  });
});
function ask(text){
  if (SITE) return askSite(text);
  if (!A.sample || !A.tools || A.ctl) return;
  text = text.trim(); if (!text) return;
  $('#a-chips').hidden = true;
  bubble('me', text);
  var content = text + (A.last ? '\n\n[Contexte de la page : dernier calcul envoyé au moteur (' + A.last.type + ') : ' + JSON.stringify(A.last.inputs) + ']' : '');
  A.turns.push({role: 'user', content: content});
  if (A.turns.length > 30) A.turns = A.turns.slice(-30);
  var out = bubble('ai', 'Je réfléchis…');
  A.ctl = new AbortController();
  $('#a-send').hidden = true; $('#a-stop').hidden = false; setStatus('L’assistant réfléchit. Ça peut prendre jusqu’à une minute.');
  A.sample([{role: 'user', content: RULES}].concat(A.turns), {tools: toolList(), cache: false, signal: A.ctl.signal, onText: function(u){ out.textContent = u.text; $('#a-thread').scrollTop = 1e9; }})
    .then(function(res){ out.textContent = plainText(res.text); A.turns.push({role: 'assistant', content: res.text}); if (res.truncated) bubble('sys', 'Réponse coupée : pose une question plus courte.'); setStatus(''); })
    .catch(function(e){
      var code = e && e.code;
      if (e && e.text){ out.textContent = e.text; } else out.remove();
      if (code === 'cancelled'){ setStatus('Arrêté.'); A.turns.pop(); return; }
      if (['not_granted','sampling_disabled','not_declared','capability_disabled','capability_removed','tools_unavailable'].indexOf(code) >= 0){ assistantOff(ERR_COPY[code] || 'L’assistant n’est pas disponible ici.'); return; }
      A.turns.pop();
      setStatus(ERR_COPY[code] || 'La réponse a été interrompue. Réessaie.');
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
var SRV_MSG = {quota: 'Tes 2 calculs offerts sont utilisés.', auth: 'Entre ton code d’accès pour utiliser l’assistant.', limit: 'Limite d’utilisation du mois atteinte. Le compteur repart le 1er du mois.', busy: 'L’assistant est très demandé. Réessaie dans un instant.', upstream: 'L’assistant ne répond pas pour le moment. Réessaie dans un instant.', config: 'L’assistant est indisponible pour le moment.', rate: 'Trop d’essais. Réessaie dans quelques minutes.', code: 'Code d’accès invalide.', ia: 'L’assistant est momentanément indisponible. Aucun paiement n’a été pris. Réessaie plus tard.', deja: 'Ce paiement a déjà ouvert un accès. Sur un autre appareil, entre ton code d’accès personnel.', paiement: 'Le paiement n’a pas pu être confirmé. Réessaie dans un instant.', fini: 'Ton abonnement n’est plus actif. Réabonne-toi pour reprendre l’assistant.', pay: 'Paiement indisponible pour le moment.'};
var NEW_CODE = null;
function pageLang(){ return document.documentElement.lang || 'fr'; }
function srvMsg(e, d){ return (e && SRV_MSG[e.error]) || d || (e && e.message) || ''; }
function priceLabel(){ return ACC && ACC.price_eur ? eur(ACC.price_eur, 0) + ' par mois' : (ACC && ACC.price) || ''; }
function quotaMsg(){ var R = (ACC && ACC.ready) || {}; return SRV_MSG.quota + ' ' + (R.pay ? 'Continue avec l’abonnement : ' + priceLabel() + ', sans engagement.' : 'L’abonnement à ' + priceLabel() + ' ouvre très bientôt. Tu as un code d’accès ? Entre-le ci-dessous.'); }
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
  if (ACC && ACC.visiteur){ el.hidden = false; el.innerHTML = '<b>Calculs offerts, sans inscription : ' + ACC.cases_left + ' / ' + ACC.cases_max + '</b>'; return; }
  if (!ACC || !(ACC.email || ACC.nom)){ el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = 'Connecté : ' + esc(ACC.email || ACC.nom) +(ACC.free && ACC.active ? ' · accès offert' : '') + (ACC.active && ACC.limit ? ' · ' + ACC.used + ' / ' + ACC.limit + ' questions ce mois' : '') +
    (ACC.free ? '' : ' · <button class="linkbtn" type="button" data-acc="portal">Gérer mon abonnement</button>') + ' · <button class="linkbtn" type="button" data-acc="logout">Me déconnecter</button>';
}
// site sans clé IA : l'assistant est annoncé, le reste du site marche normalement
function soon(){ A.ready = false; $('#a-pay').hidden = true; $('#a-form').hidden = true; $('#a-chips').hidden = true; $('#a-thread').innerHTML = ''; bubble('sys', 'L’assistant IA arrive bientôt. En attendant, le calcul complet, le PDF et la comparaison de tes calculs sont gratuits.'); $('#a-note').textContent = 'L’assistant IA sera proposé sur abonnement mensuel.'; }
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
        else toast(srvMsg(r, 'Le paiement n’a pas pu être confirmé. Réessaie dans un instant.'));
        siteStart();
      }, function(){ toast('Connexion impossible. Réessaie.'); siteStart(); });
      return;
    }
  }
  if (q.get('bienvenue')) toast('Abonnement activé. Pose ta première question.');
  else if (q.get('connecte')) toast('Tu es connecté.');
  else if (q.get('lien') === 'expire') toast('Lien expiré ou déjà utilisé : demandes-en un nouveau.');
  else if (q.get('paiement') === 'erreur') toast('Le paiement n’a pas pu être confirmé. Si tu as été débité, demande ton lien de connexion avec ton e-mail.');
  var had = false; ['bienvenue','connecte','lien','paiement'].forEach(function(k){ if (q.has(k)){ q.delete(k); had = true; } });
  if (had) try { history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q.toString() : '') + location.hash); } catch(e){}
  $('#a-form').hidden = true; $('#a-chips').hidden = true;
  api('/api/me').then(function(m){
    ACC = m;
    var R = m.ready || {ai: true, pay: true, email: true};
    if (priceLabel()) $('#a-price').textContent = priceLabel();
    if (m.visiteur) $('#a-note').textContent = 'Tes questions sont traitées par Claude (Anthropic). Tes calculs enregistrés restent dans ton navigateur.';
    else if (m.limit) $('#a-note').textContent = (m.abonne ? 'Inclus dans l’abonnement' : 'Accès sur invitation') + ' : jusqu’à ' + m.limit + ' questions par mois. Tes questions sont traitées par Claude (Anthropic). Tes calculs enregistrés restent dans ton navigateur.';
    else if (R.code && !R.pay) $('#a-note').textContent = 'Pendant le test, l’assistant est réservé aux personnes invitées. Tes questions sont traitées par Claude (Anthropic).';
    accountLine();
    $('#a-sub').hidden = !R.pay; $('#a-login').hidden = !R.email; $('#a-code').hidden = !R.code; $('#a-terms').hidden = !R.pay;
    var tp = $('#a-testpay');
    if (!tp){ tp = document.createElement('p'); tp.id = 'a-testpay'; tp.className = 'small mute'; $('#a-sub').insertAdjacentElement('afterend', tp); }
    tp.textContent = 'Paiement en mode test : aucune carte réelle n’est débitée.'; tp.hidden = !(R.pay && R.pay_test);
    if (!R.pay) $('#a-pay-kicker').textContent = m.visiteur ? 'Abonnement' : 'Test privé';
    if (!m.active && (!R.ai || (!R.pay && !R.email && !R.code))){ soon(); return; }
    if (m.active){
      $('#a-pay').hidden = true; $('#a-thread').hidden = false; $('#a-form').hidden = false; $('#a-chips').hidden = false; A.ready = true;
      bubble('ai', 'Salut. Dis-moi ce que tu veux chiffrer : un produit, un chantier ou ton taux horaire. Je te pose les questions une par une, et c’est le moteur qui calcule.');
      if (NEW_CODE){ bubble('sys', 'Abonnement activé. Ton code d’accès personnel : ' + NEW_CODE + '. Garde-le : il sert à te connecter sur un autre appareil.'); NEW_CODE = null; }
      if (metierQ && ASK_HINT[metierQ]) prepAsk(metierQ, false);
    } else if (m.visiteur) showPay(quotaMsg());
    else if (!R.pay) showPay(R.code ? 'L’assistant est en test privé, sur invitation. Entre ton code d’accès pour l’utiliser.' : 'L’assistant est en test privé. Si ton adresse est invitée, reçois ton lien de connexion par e-mail.');
    else if (m.email) showPay('Ton abonnement n’est plus actif. Réabonne-toi pour reprendre l’assistant.');
    else showPay('Décris ton chantier, ton produit ou ta mission avec tes mots : l’assistant te pose les bonnes questions et le moteur calcule ton vrai prix.');
  }, function(){ showPay('Le serveur ne répond pas pour le moment. Les tests et le calcul complet marchent quand même.'); });
}
if (SITE){
  siteStart();
  $('#a-sub').addEventListener('click', function(){
    var b = this, em = ($('#a-email').value || '').trim();
    b.disabled = true;
    api('/api/checkout', em ? {email: em, lang: pageLang()} : {lang: pageLang()}).then(function(r){ if (r.url) location.href = r.url; else if (r.deja) siteStart(); else { b.disabled = false; toast(srvMsg(r, 'Paiement indisponible pour le moment.')); } }, function(){ b.disabled = false; toast('Connexion impossible. Réessaie.'); });
  });
  $('#a-login').addEventListener('submit', function(e){
    e.preventDefault();
    var em = $('#a-email').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)){ toast('Adresse e-mail invalide.'); return; }
    api('/api/login', {email: em}).then(function(r){ toast(r.message || 'Si un abonnement existe pour cette adresse, le lien vient de partir.'); }, function(){ toast('Connexion impossible. Réessaie.'); });
  });
  $('#a-code').addEventListener('submit', function(e){
    e.preventDefault();
    var b = this.querySelector('button'), c = $('#a-code-in').value.trim();
    if (c.replace(/[^0-9A-Za-z]/g, '').length < 8){ toast('Code d’accès invalide.'); return; }
    b.disabled = true;
    api('/api/code', {code: c}).then(function(r){
      b.disabled = false;
      if (!r.ok){ toast(srvMsg(r, 'Code d’accès invalide.')); return; }
      if (r.jeton) lsSet('pnr-session', r.jeton);
      $('#a-code-in').value = ''; $('#a-thread').innerHTML = ''; toast('Accès ouvert. Pose ta première question.'); siteStart();
    }, function(){ b.disabled = false; toast('Connexion impossible. Réessaie.'); });
  });
  $('#a-account').addEventListener('click', function(e){
    var b = e.target.closest('[data-acc]'); if (!b) return;
    if (b.dataset.acc === 'logout') api('/api/logout', {}).then(function(){ lsSet('pnr-session', null); location.reload(); }, function(){ lsSet('pnr-session', null); location.reload(); });
    else api('/api/portal', {lang: pageLang()}).then(function(r){ if (r.url) location.href = r.url; else toast(srvMsg(r, 'Espace d’abonnement indisponible.')); });
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
  if (text.length > 3000){ toast('Question trop longue : 3 000 caractères au plus.'); return; }
  $('#a-chips').hidden = true;
  bubble('me', text);
  var before = A.turns.slice();
  A.turns.push({role: 'user', content: text + (A.last ? '\n\n[Contexte de la page : dernier calcul envoyé au moteur (' + A.last.type + ') : ' + JSON.stringify(A.last.inputs) + ']' : '')});
  trimTurns();
  var out = bubble('ai', 'Je réfléchis…'), rounds = 0;
  A.ctl = new AbortController();
  $('#a-send').hidden = true; $('#a-stop').hidden = false; setStatus('L’assistant réfléchit. Ça peut prendre jusqu’à une minute.');
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
        bubble('sys', 'Le calcul n’a pas abouti. Reformule ta question en donnant tes chiffres.'); setStatus(''); return;
      }
      if (hasTool && rounds++ < 5){
        var results = r.content.filter(function(b){ return b.type === 'tool_use'; }).map(function(b){
          var t = toolByName(b.name);
          try { if (!t) throw new Error('Outil inconnu : ' + b.name); return {type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(t.execute(b.input || {}))}; }
          catch(e){ return {type: 'tool_result', tool_use_id: b.id, content: String(e && e.message || e), is_error: true}; }
        });
        A.turns.push({role: 'user', content: results});
        if (!out) out = bubble('ai', 'Je réfléchis…');
        return step();
      }
      if (out){ out.remove(); out = null; }
      if (r.stop_reason === 'max_tokens') bubble('sys', 'Réponse coupée : pose une question plus courte.');
      if (ACC && ACC.visiteur && ACC.cases_left === 0 && !A.lastFree){ A.lastFree = true; bubble('sys', 'C’était ton dernier calcul offert : tu peux encore le préciser ici. Pour un nouveau calcul, il faudra l’abonnement.'); }
      setStatus('');
    });
  }
  step().catch(function(e){
    if (out) out.remove();
    A.turns = before;
    if (e && e.name === 'AbortError'){ setStatus('Arrêté.'); return; }
    if (e && e.error === 'quota'){ setStatus(''); if (ACC){ ACC.cases_left = 0; ACC.active = false; accountLine(); } showPay(quotaMsg()); return; }
    if (e && (e.error === 'auth' || e.error === 'inactive')){ if (e.error === 'auth') lsSet('pnr-session', null); setStatus(''); showPay(srvMsg(e)); return; }
    if (e && e.error === 'bad_request'){ A.turns = []; A.last = null; bubble('sys', 'Nouvelle conversation : la précédente était trop longue. Repose ta question.'); setStatus(''); return; }
    setStatus(srvMsg(e, 'La réponse a été interrompue. Réessaie.'));
  }).then(function(){ A.ctl = null; $('#a-send').hidden = false; $('#a-stop').hidden = true; $('#a-new').hidden = !A.turns.length || !A.ready; });
}
// nouveau calcul : nouvelle conversation (pour un visiteur, c'est un nouveau calcul offert)
$('#a-new').addEventListener('click', function(){
  if (A.ctl) return;
  A.turns = []; A.last = null; A.lastFree = false; $('#a-thread').innerHTML = ''; this.hidden = true;
  bubble('ai', 'Salut. Dis-moi ce que tu veux chiffrer : un produit, un chantier ou ton taux horaire. Je te pose les questions une par une, et c’est le moteur qui calcule.');
  $('#a-chips').hidden = false; focusChat();
});
$('#a-form').addEventListener('submit', function(e){ e.preventDefault(); var t = $('#a-input').value; $('#a-input').value = ''; ask(t); });
$('#a-input').addEventListener('keydown', function(e){ if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); var t = $('#a-input').value; $('#a-input').value = ''; ask(t); } });
$('#a-stop').addEventListener('click', function(){ if (A.ctl) A.ctl.abort(); });
$$('#a-chips .chip').forEach(function(c){ c.addEventListener('click', function(){ ask(c.textContent); }); });

// ---------- guides ----------
$('#g-list').innerHTML = GUIDES.map(function(g){
  return '<details class="guide"><summary><small>' + esc(g.cat) + '</small><b>' + esc(g.h1) + '</b></summary><div class="body"><p><b>' + esc(g.answer) + '</b></p>' +
    (g.formula ? '<h4>' + esc(g.formulaTitle || 'La formule') + '</h4><div class="formula">' + g.formula.map(esc).join('<br>') + '</div>' : '') +
    '<h4>Exemple chiffré</h4><p>' + esc(g.example) + '</p>' + (g.extra ? '<p class="mute">' + esc(g.extra) + '</p>' : '') +
    (g.errors ? '<h4>Les erreurs qui coûtent</h4><ol>' + g.errors.map(function(e){ return '<li>' + esc(e) + '</li>'; }).join('') + '</ol>' : '') +
    (g.faq ? g.faq.map(function(f){ return '<h4>' + esc(f[0]) + '</h4><p>' + esc(f[1]) + '</p>'; }).join('') : '') +
    '<div class="btn-row"><a class="btn btn-hivis btn-sm" href="#accueil" data-ask="' + g.type + '">Faire mon calcul</a></div></div></details>';
}).join('');

// ---------- exposé pour les tests automatiques ----------
window.__PNR_TEST = {coerce: coerce, guard: guard, compact: compact, openFromInputs: openFromInputs, buildInputs: buildInputs, state: function(){ return S; }, trim: function(t){ A.turns = t; trimTurns(); return A.turns; }};

// ---------- démarrage ----------
renderForm(); compute();
if (metierQ && CFG[metierQ]) setType(metierQ);
show(location.hash.slice(1) || 'accueil');
})();
