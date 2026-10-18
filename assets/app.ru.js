// Prix Net Réel — moteur de calcul (port fidèle de pricing.ts + construction.ts)
var PNR = (function(){
  function PnrError(msg, field){ this.message = msg; this.field = field; }
  var DISCLAIMER = "Инструмент для моделирования и управления. Оценки строятся на ваших данных и не являются налоговой, бухгалтерской, юридической или финансовой консультацией. Свои обязательства уточните у специалиста.";
  function invalid(field){ throw new PnrError("Недопустимое значение: " + field + ". Укажите положительное число или ноль в допустимых пределах.", field); }
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
    if (risk + fee >= 1) invalid("риски + комиссии (в сумме должны быть меньше 100 %)");
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
      breakdown: breakdown.concat([{label:"Риски", amount: riskCost},{label:"Комиссии с выручки", amount: feeCost},{label:"Налог (оценка)", amount: tax}]),
      details: d,
      warnings: (warnings || []).concat([DISCLAIMER, "НДС — это изменяемое допущение, а не доход. Реальное налогообложение зависит от вашей ситуации."])
    };
    ["revenue","cost","margin","net","riskCost","feeCost","tax","targetRevenue","minimumRevenue","recommendedPrice","currentPrice","minimumPrice","targetPrice"].forEach(function(k){ if (!isFinite(r[k])) invalid("результат вне допустимых пределов"); });
    if (r.net < 0) r.warnings.unshift("При введённых допущениях текущая цена даёт убыток.");
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
      [{label:"Материалы с учётом потерь", amount: material},{label:"Время и распределённые постоянные расходы", amount: labor}],
      {quantity: quantity, hourly: hourly, materialBase: materialBase, material: material, labor: labor, costPerUnit: cost/quantity, unit: i.unit || "pièce", targetScope: i.targetScope || "lot"},
      ["Стоимость часа включает оплату труда и распределённые постоянные расходы; повторно эти расходы не вычитаются."]);
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
      [{label:"Вознаграждение руководителя с взносами", amount: director},{label:"Персонал с взносами", amount: staff},{label:"Содержание бизнеса", amount: structure}],
      {hours: hours, capacityHours: hours, paidHours: persons*weeks*weeklyHours, director: director, directorMode: mode, staff: staff, structure: structure, thresholdRate: cost/hours},
      ["Вознаграждение руководителя уже включено в расходы. Целевой чистый доход — сверх него.",
       "Ставка взносов руководителя — управленческое допущение, а не точный налоговый расчёт. Невыставленное время уменьшает доступные часы."]);
    r.details.requiredHours = rate > 0 ? r.targetRevenue / rate : null;
    r.details.netPerHour = r.net / hours;
    r.details.impossible = rate === 0 || r.targetRevenue / rate > hours;
    if (r.details.impossible) r.warnings.unshift("При текущей ставке цель недостижима в пределах доступных часов.");
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
      [{label:"Оплата труда", amount: c.labor},{label:"Материалы с учётом обрезков", amount: material},{label:"Расходы на объекте и финансирование", amount: c.expenses},{label:"Накладные расходы", amount: c.fixed},{label:"Резерв на непредвиденное", amount: c.contingency}],
      {surface: surface, persons: persons, capacityPerDay: c.capacity, duration: c.duration, days: c.days, paidDuration: c.paidDuration, laborHours: persons*hoursPerDay*c.paidDuration, labor: c.labor, material: material, expenses: c.expenses, travel: c.travel, tripsMode: tripsMode, direct: c.direct, fixed: c.fixed, contingency: c.contingency, costPerM2: c.cost/surface, retentionAmount: price*surface*retention},
      ["Ежедневные расходы считаются по округлённым дням; оплата труда — по фактическому времени, если не выбран вариант «Полные дни».",
       "Возвращаемые удержания — это кассовый разрыв, а не убыток. Стоимость финансирования нужно указать отдельно.",
       "Следите за выработкой: целевая цена зависит от производительности и данных объекта."]);
    r.details.netPerM2 = r.net / surface;
    Object.assign(r.details, chantierEquilibrium(p, r.revenue, percent(i,"riskPercent"), percent(i,"feePercent"), yieldPerDay, percent(i,"taxPercent")));
    return r;
  }
  function calculate(type, i){
    if (type === "fabrication") return fabrication(i);
    if (type === "services") return services(i);
    if (type === "travaux") return travaux(i);
    throw new PnrError("Неизвестный тип расчёта.");
  }
  return {calculate: calculate, PnrError: PnrError, DISCLAIMER: DISCLAIMER};
})();


var GUIDES = [
  {cat: 'Производство', type: 'fabrication', h1: 'Рассчитайте себестоимость — штука за штукой',
   answer: 'Себестоимость — это всё, во что вам обходится одна штука до первого заработанного евро: материалы с потерями, ваше время по его реальной стоимости и распределённые постоянные расходы. Ниже этой цены вы платите за то, чтобы работать.',
   formula: ['Реальная стоимость часа = ваша стоимость часа (зарплата + взносы) + постоянные расходы за месяц ÷ производственные часы за месяц', 'Себестоимость штуки = (материалы × (1 + потери) + минуты ÷ 60 × реальная стоимость часа) ÷ количество штук', 'Минимальная цена = себестоимость ÷ (1 − риски − комиссии)', 'Рекомендуемая цена без НДС = себестоимость ÷ (1 − желаемая маржа от цены продажи)'],
   example: 'Выпечка из 20 буханок (упрощённый пример). Мука 6 kg с учётом 3 % потерь = 4,57 € без НДС. Время 90 min по 29,50 €/ч с учётом взносов = 44,25 €. Затраты: 48,82 € без НДС, то есть 2,44 € без НДС за буханку. С маржой 35 %: 3,76 € без НДС. Мука здесь — меньше 10 % затрат: цену определяет время.',
   errors: ['Не учитывать своё время или учитывать его без взносов.', 'Считать материалы без потерь (обрезки, брак, непроданная продукция).', 'Путать две маржи: затраты × 1,35 дают 35 % наценки на затраты, но лишь 25,9 % от цены продажи. Чтобы оставлять себе 35 % цены продажи (маржа от цены), делите затраты на 0,65.'],
   faq: [['Входит ли НДС в себестоимость?', 'Если вы возмещаете НДС по закупкам — нет: считайте материалы без НДС. Если нет (например, при освобождении от НДС), он становится затратой: считайте с НДС. Ваш случай подскажет бухгалтер.']]},
  {cat: 'Производство', type: 'fabrication', h1: 'Себестоимость килограмма (или литра)',
   answer: 'Рассчитайте полные затраты на партию и разделите их на вес или объём, который реально можно продать. Получится себестоимость килограмма; добавьте риски и комиссии — и вот ваша минимальная цена.',
   formula: ['Себестоимость kg = затраты на партию ÷ произведённые килограммы, годные к продаже', 'Минимальная цена за kg = себестоимость kg ÷ (1 − риски − комиссии)', 'Рекомендуемая цена за kg без НДС = себестоимость kg ÷ (1 − желаемая маржа)'],
   example: '20 буханок по 700 g = 14 kg. Затраты на партию 48,82 € без НДС: себестоимость 3,49 € без НДС за kg. С рисками 2 % и комиссиями 1,2 % минимальная цена — 3,60 € без НДС за kg. С маржой 35 %: 5,37 € без НДС за kg.',
   errors: ['Делить на вес теста или содержимого котла вместо веса или объёма готовой продукции, годной к продаже.', 'Забывать о потерях при фасовке (остатки на дне котла, бракованные флаконы, повреждённая упаковка).', 'Продавать и на вес, и поштучно, не проверив, что обе цены дают одинаковую маржу.'],
   faq: [['А в литрах так же?', 'Да: замените килограммы литрами, реально разлитыми по бутылкам или банкам. В полном расчёте выберите единицу «kg» или «литр» и укажите произведённые килограммы или литры как количество.']]},
  {cat: 'Производство', type: 'fabrication', h1: 'Во что вам реально обходится буханка хлеба?',
   answer: 'В нашем примере производство буханки деревенского хлеба весом 700 g стоит 2,44 € без НДС, то есть 3,49 € без НДС за kg. Важна ваша цифра: она зависит от вашего рецепта, вашего времени и ваших расходов.',
   example: '20 буханок по 700 g = 14 kg. Мука 6 kg + 3 % потерь = 4,57 € без НДС. 90 min (подготовка, выпечка под присмотром, отделка, уборка, упаковка) по 29,50 €/ч = 44,25 €. Затраты 48,82 € без НДС → 2,44 € без НДС за буханку → 3,49 € без НДС за kg. При марже 35 %: 3,76 € без НДС за буханку. При продаже по 3,72 € без НДС маржа падает до 34,4 %: на 3,6 цента меньше цели с каждой буханки, 0,71 € с каждой выпечки.',
   extra: 'Добавьте в расчёт: закваску или дрожжи, соль, воду, энергию печи, упаковку, непроданный товар.',
   faq: [['Какая ставка НДС?', 'Ставка для хлеба в вашей стране: для продуктов питания она часто пониженная, но бывает по-разному — уточните у бухгалтера.']]},
  {cat: 'Строительство', type: 'travaux', h1: 'Ваша цена за m² по вашей реальной выработке',
   answer: 'Цена за m² — это полные затраты на объект, делённые на площадь, плюс ваша маржа. Всё начинается с цифры, которую знаете только вы: сколько m² ваша бригада укладывает на человека в день.',
   formula: ['Срок = площадь ÷ (выработка × число рабочих)', 'Оплата труда = дневная стоимость бригады × срок', 'Ежедневные расходы (леса, техника, расходники, поездки) = стоимость в день × число дней с округлением вверх', 'Себестоимость = (оплата труда + материалы + расходы на объекте) + накладные расходы + резерв на непредвиденное', 'Цена за m² без НДС = себестоимость ÷ площадь ÷ (1 − желаемая маржа)'],
   example: 'Кровля из пазовой черепицы 180 m², бригада из 4 человек, выработка 22 m²/чел./день → себестоимость 48,70 €/m² без НДС, 59,38 €/m² без НДС при марже 18 %.',
   errors: ['Брать цену за m² у конкурента: у него не ваша бригада, не ваша выработка и не ваши расходы.', 'Считать посуточные расходы по точному сроку: 2,05 дня работ на объекте — это 3 дня аренды лесов и 3 поездки туда и обратно.', 'Считать гарантийное удержание убытком: оно вернётся к вам при приёмке работ, это кассовый разрыв.'],
   faq: [['Не знаете свою выработку?', 'Измерьте её на трёх последних объектах: выполненные m² ÷ (рабочие × дни). Это самая выгодная цифра, какую вы можете знать.']]},
  {cat: 'Строительство', type: 'travaux', h1: 'Цена за m² черепичной кровли: полный расчёт',
   answer: 'В этом примере кровля обходится в 48,70 € без НДС за m² и продаётся по 59,38 € без НДС за m² с маржой 18 %. Ниже 48,70 € объект приносит вам убыток.',
   example: '180 m². Бригада: 1 бригадир (42 €/ч), 2 квалифицированных рабочих (36 €/ч), 1 разнорабочий (26 €/ч), 8 ч в день. Выработка 22 m²/чел./день → 88 m²/день → 2,05 дня, для расходов учтено 3 дня. Оплата труда 2 290,91 €. Материалы 4 387,86 € (черепица 17,55 €/m² + 8 % обрезков, рейка обрешётки 3,04 €/m² + 10 %, подкровельная мембрана 1,98 €/m² + 5 %). Расходы на объекте 635,30 € (дизель 12 L/день по 1,65 €, расходники 15 €/день, леса 45 €/день, контейнер для мусора 320 €, 3 поездки туда и обратно по 46 km по 0,55 €/km). Накладные расходы 12 %, резерв на непредвиденное 7 % → 8 765,18 € без НДС, то есть 48,70 €/m² без НДС. При марже 18 %: 59,38 €/m² без НДС. Минимальная выработка (без рисков и комиссий в цене): 13,30 m²/чел./день.',
   faq: [['Почему минимальная выработка так далека от 22?', 'Потому что материалы не меняются, когда бригада работает медленнее: растут только оплата труда и посуточные расходы.']]},
  {cat: 'Строительство', type: 'travaux', h1: 'Выработка, которая создаёт (или съедает) вашу маржу',
   answer: 'Выработка — это сколько m² один человек выполняет за день. У каждого объекта есть минимальная выработка: ниже неё ваша цена уже не покрывает затраты.',
   formulaTitle: 'Как это считается',
   formula: ['Полные затраты на объект пересчитываются для каждой возможной выработки (оплата труда, дни аренды лесов, поездки),', 'и ищется первая выработка, при которой затраты становятся ниже вашей цены.', 'Простая пропорция здесь не работает: материалы от выработки не зависят.'],
   example: 'Кровля 180 m² по 59,38 €/m² без НДС, плановая выработка 22. Минимальная выработка 13,30 (без рисков и комиссий в цене). Ваша бригада может замедлиться примерно на 40 %, прежде чем начнёт терять деньги.',
   errors: ['Считать по выработке удачного дня на лёгком объекте.', 'Забывать о простоях: подготовка площадки, сворачивание работ, непогода, ожидание поставки.', 'Никогда не замерять реальную выработку после завершения объекта.']},
  {cat: 'Услуги', type: 'services', h1: 'Ваша минимальная почасовая ставка и ставка, которую нужно выставлять',
   answer: 'Реальная стоимость вашего часа — это все годовые расходы, включая ваше собственное вознаграждение, делённые на часы, которые вы реально выставляете клиентам. Не на часы, которые вы работаете. Добавьте неоплаты и комиссии — получите минимальную ставку.',
   formula: ['Оплачиваемые часы = люди × недели × часы в неделю × реально выставляемая доля', 'Реальная стоимость часа = все годовые расходы ÷ оплачиваемые часы', 'Минимальная ставка = реальная стоимость часа ÷ (1 − неоплаты − комиссии)', 'Рекомендуемая ставка без НДС = реальная стоимость часа ÷ (1 − желаемая маржа)'],
   example: '2 человека, 44 недели, 40 ч, выставляется 62 % → 2 182 оплачиваемых ч. Расходы 144 100 € (руководитель — 69 600 € с взносами, сотрудница — 38 000 €, содержание бизнеса — 36 500 €). Реальная стоимость часа 66,03 € без НДС. С неоплатами 2 % и комиссиями 1 % минимальная ставка — 68,07 €/ч без НДС. При марже 20 %: 82,54 €/ч без НДС.',
   errors: ['Делить на все отработанные часы: администрирование, поиск клиентов и отпуск клиенты не оплачивают.', 'Забывать включить в расходы собственное вознаграждение.', 'Путать, во что вам обходится ваше вознаграждение, и сколько вы получаете на руки.'],
   faq: [['Какая ставка социальных взносов на моё вознаграждение?', 'Та, что действует для вашего статуса и вашей страны: уточните у бухгалтера или в своём фонде социального страхования. Инструмент её не придумывает.']]},
  {cat: 'Услуги', type: 'services', h1: 'Почасовая ставка бухгалтерской фирмы: полный пример',
   answer: 'В этом примере каждый выставленный час обходится фирме в 66,03 € без НДС, а с неоплатами и комиссиями — в 68,07 €. Фирма выставляет 75 €: она зарабатывает, но меньше, чем думает.',
   example: 'При 75 €/ч без НДС: выручка 163 680 €. После расходов: 19 580 €. После 2 % неоплат и 1 % комиссий: 14 669,60 €. После 25 % налога: 11 002,20 € прибыли сверх вознаграждений. Заказ «годовая отчётность»: 30 ч по рекомендуемой ставке 82,54 €/ч (с округлением) = 2 476 € без НДС + 66 € на дорогу. Фиксированная цена 2 200 € без НДС даёт 71,13 €/ч: выше минимума 68,07 €, но ниже цели. Чтобы получать на 30 000 € прибыли больше в год: 86,97 €/ч без НДС. При 75 €/ч нужно было бы выставить 2 531 ч; у фирмы есть только 2 182.'},
  {cat: 'Услуги', type: 'services', h1: 'Сколько ваших часов реально оплачивается?',
   answer: 'Часть вашего времени не оплачивает никто: администрирование, поиск клиентов, сметы, обучение. Ваша почасовая ставка должна покрывать и эти часы.',
   example: '2 человека × 44 недели × 40 ч = 3 520 рабочих ч. Выставлено 62 % = 2 182 ч. 1 338 ч в год не оплачивает ни один клиент. При 75 €/ч нужно выставить 1 981 ч, чтобы покрыть расходы, неоплаты и комиссии, то есть 56,3 % времени: запас прочности — всего 5,7 п. п.',
   errors: ['Исходить из того, что оплачивается 100 % времени.', 'Не учитывать свои часы: без замеров доля выставленного времени — лишь впечатление.', 'Снижать ставку, чтобы заполнить график, хотя проблема — в невыставленном времени.']}
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
function fmt(n, d){ if (d === undefined) d = 2; return Number(n).toLocaleString('ru-RU', {minimumFractionDigits: d, maximumFractionDigits: d}); }
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
  var c = [['Цена продажи выпечки', 75.20, 'hsl(218 30% 55%)', 0], ['Материалы (мука + потери)', 4.57, 'hsl(214 16% 62%)', 0], ['Ваше время с учётом взносов', 44.25, 'hsl(214 16% 62%)', 0], ['Ваш кажущийся заработок', 26.38, 'var(--hivis)', 0], ['Риски, комиссии и налог', 8.40, 'var(--loss)', 0], ['Что у вас реально остаётся', 17.98, 'var(--ok)', 1]];
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
  var stop = '<p class="err">Заполните каждое поле положительным числом.</p>';
  var cta = function(q){ return '<button class="btn btn-hivis" type="button" data-carry="' + q + '">Продолжить в полном расчёте с этими цифрами</button>'; };
  Q.taux = function(){
    var ch = val('ta-ch'), h = val('ta-h'), s = val('ta-s'), p = val('ta-p');
    if (!okAll([ch, h, s, p]) || h * s * p === 0 || p > 100 || s > 53 || h > 100) return stop;
    var paid = h * s, billed = paid * p / 100, rate = ch / billed;
    return '<p class="eyebrow">Каждый выставленный час обходится вам в</p><p class="big">' + eur(rate) + '<small>без НДС / час</small></p><ul class="lines">' +
      line('Рабочих часов в год', fmt(paid, 0) + ' ч') + line('Выставленных часов в год', fmt(billed, 0) + ' ч') + line('Не оплачено ни одним клиентом', fmt(paid - billed, 0) + ' ч') +
      '</ul>' + (ch > 0 ? '<p class="verdict">Ниже этой ставки вы не покрываете свои расходы и вознаграждение.</p>' : '') +
      '<p class="limit">Этот тест не учитывает неоплаты, комиссии за приём оплаты и налог. Полный расчёт это учитывает.</p>' + cta('taux');
  };
  Q.vehic = function(){
    var n = val('ve-n'), km = val('ve-km'), c = val('ve-c'), p = val('ve-p'), a = val('ve-a'), e = val('ve-e'), l = val('ve-l');
    if (!okAll([n, km, c, p, a, e, l]) || n === 0 || km === 0) return stop;
    var fuel = km * c / 100 * p, per = fuel + a + e + l, tot = per * n, perkm = per / km;
    return '<p class="eyebrow">Ваш транспорт обходится вам в</p><p class="big">' + eur(tot, 0) + '<small>в год</small></p><ul class="lines">' +
      line('На один автомобиль', eur(per, 0) + ' / год') + line('За километр', eur(perkm, 3)) + line('Из них топливо', fmt(fuel / per * 100, 1) + ' %') +
      '</ul><p class="verdict">Каждый километр, который вы не выставляете клиенту, обходится вам в ' + eur(perkm) + '.</p><p class="limit">Эту стоимость километра можно использовать как «Стоимость за km» в расчёте объекта.</p>' + cta('vehic');
  };
  Q.prod = function(){
    var pv = val('pr-pv'), m = val('pr-m'), mn = val('pr-min'), h = val('pr-h');
    if (!okAll([pv, m, mn, h]) || pv === 0) return stop;
    var cost = m + mn / 60 * h, mg = pv - cost;
    return '<p class="eyebrow">Ваша маржа сверх материалов и времени</p><p class="big">' + eur(mg) + '<small>' + fmt(mg / pv * 100, 1) + ' % от цены</small></p><ul class="lines">' +
      line('Материалы и время на штуку', eur(cost)) + line('Из них материалы', eur(m)) + line('Из них ваше время', eur(mn / 60 * h)) +
      '</ul>' + (mg < 0 ? '<p class="verdict">Вы продаёте дешевле, чем вам обходятся материалы и время: ' + eur(-mg) + ' убытка на каждой штуке.</p>' : '<p class="verdict good">У вас остаётся ' + eur(mg) + ' с каждой штуки на аренду, энергию, неоплаты и налог.</p>') +
      '<p class="limit">Этот тест не учитывает постоянные расходы (аренда, энергия), потери, риски и налог. Полный расчёт это учитывает.</p>' + cta('prod');
  };
  Q.m2 = function(){
    var mat = val('m2-mat'), eq = val('m2-eq'), r = val('m2-r'), f = val('m2-f');
    if (!okAll([mat, eq, r, f]) || r === 0) return stop;
    var floor = mat + (eq + f) / r;
    var isEx = mat === 24.38 && eq === 1120 && r === 88 && f === 105;
    return '<p class="eyebrow">Ваши прямые затраты на m²</p><p class="big">' + eur(floor) + '<small>без НДС / m²</small></p><ul class="lines">' +
      line('Материалы', eur(mat) + ' / m²') + line('Бригада и дневные расходы', eur((eq + f) / r) + ' / m²') +
      '</ul><p class="verdict">Ниже этой цены вы гарантированно теряете деньги. Ваша реальная минимальная цена выше.</p>' +
      (isEx ? '<p class="gap">Для этого примера полный расчёт даёт себестоимость <b>48,70 €/m² без НДС</b>. Тест упускает <b>10,40 €/m²</b>, то есть <b>1&nbsp;872 €</b> на 180 m²: накладные расходы, резерв на непредвиденное, полные дни аренды лесов, контейнер для мусора.</p>' : '') +
      '<p class="limit">Этот тест не учитывает накладные расходы, резерв на непредвиденное, полные дни, контейнер для мусора, риски и налог. Полный расчёт это учитывает.</p>' + cta('m2');
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
    st = freshState('services', true); st.name = 'Моя почасовая ставка';
    st.v.persons = '1'; st.v.weeklyHours = qv('ta-h'); st.v.weeks = qv('ta-s'); st.v.billablePercent = qv('ta-p');
    st.v.directorMode = 'direct'; st.v.directorAnnualCost = '0'; st.v.staffAnnual = '0'; st.v.structureTotal = qv('ta-ch');
    st.carryNote = 'Перенесено из теста: ваши годовые расходы, вместе с вознаграждением, указаны в поле «Расходы на содержание бизнеса». Вознаграждение можно указать отдельно. Не хватает вашей текущей ставки.';
  } else if (q === 'prod'){
    st = freshState('fabrication', true); st.name = 'Мой продукт';
    st.v.quantity = '1'; st.v.price = qv('pr-pv'); st.v.materialsTotal = qv('pr-m'); st.v.minutes = qv('pr-min'); st.v.laborHourly = qv('pr-h');
    st.carryNote = 'Перенесено из теста, для одной штуки. Добавьте постоянные расходы, потери, риски и налог в свёрнутых разделах.';
  } else if (q === 'm2'){
    st = freshState('travaux', true); st.name = 'Мой объект';
    var eq = parseNum(qv('m2-eq'));
    st.v.materialPerM2 = qv('m2-mat'); st.v.hoursPerDay = '8'; st.v.yieldPerDay = qv('m2-r'); st.v.pricePerM2 = '0'; st.v.consumablesPerDay = qv('m2-f');
    st.lists.team = [{name: 'Бригада (общая стоимость)', count: '1', hourlyCost: eq >= 0 ? toStr(eq / 8) : ''}];
    st.carryNote = 'Перенесено из теста: бригада учтена одной строкой (стоимость дня ÷ 8 ч), а выработка указана для всей бригады. Ваши дневные расходы — в поле «Расходники». Не хватает площади; укажите цену за m², если она у вас есть. Полный расчёт считает посуточные расходы за полные дни, поэтому результат может быть немного выше, чем в тесте.';
  } else if (q === 'vehic'){
    st = freshState('travaux'); st.name = 'Объект с моей стоимостью за km (пример)';
    var km = parseNum(qv('ve-km')), c = parseNum(qv('ve-c')), p = parseNum(qv('ve-p')), a = parseNum(qv('ve-a')), e = parseNum(qv('ve-e')), l = parseNum(qv('ve-l'));
    var per = km * c / 100 * p + a + e + l;
    st.v.costPerKm = km > 0 && isFinite(per) ? toStr(Math.round(per / km * 1000) / 1000) : st.v.costPerKm;
    st.carryNote = 'Ваша стоимость километра (' + st.v.costPerKm + ' €/km) подставлена в пример объекта. Остальное замените своими цифрами.';
  } else return;
  S = st; cache[st.type] = st; renderForm(); compute(); saveDraft(); location.hash = 'calcul';
}

// ---------- calcul complet : configuration ----------
var LABELS = {quantity:'Произведённое количество', unit:'Единица продажи', price:'Цена продажи за единицу', priceMode:'Ваша цена указана', vat:'Ставка НДС в вашей цене', minutes:'Общее время на партию', laborHourly:'Стоимость часа труда', materialsTotal:'Материалы, всего на партию', fixedMonthly:'Постоянные расходы в месяц', productiveHours:'Производственные часы в месяц', lossPercent:'Потери', marginPercent:'Целевая маржа от цены продажи', riskPercent:'Риск (неоплаты, непроданный товар)', feePercent:'Комиссии с выручки', taxPercent:'Налог на прибыль (средняя ставка)', targetNet:'Целевой чистый доход', targetScope:'Целевой доход указан', persons:'Сотрудники, выставляющие часы', weeks:'Рабочих недель в год', weeklyHours:'Часов в неделю', billablePercent:'Доля выставленных часов', rate:'Текущая почасовая ставка', directorMode:'Вознаграждение руководителя', directorAnnualCost:'Годовые затраты на руководителя', directorNet:'Чистое вознаграждение руководителя', contributionPercent:'Ставка взносов руководителя', staffAnnual:'Сотрудники, годовые затраты', structureTotal:'Расходы на содержание бизнеса, всего за год', surface:'Площадь', pricePerM2:'Цена за m²', yieldPerDay:'Выработка на человека', hoursPerDay:'Часов в день', team:'Бригада', materialPerM2:'Материалы на m²', fuelLitersPerDay:'Топливо для техники', fuelPrice:'Цена топлива', consumablesPerDay:'Расходники', scaffoldingPerDay:'Леса', machinePerDay:'Техника, аренда', skipCost:'Контейнер, вывоз мусора', distanceKm:'Расстояние туда и обратно', costPerKm:'Стоимость за km', tripsMode:'Поездки', trips:'Число поездок', tripsPerDay:'Поездок в день', otherCosts:'Прочие затраты', financingCost:'Стоимость финансирования', fixedPercent:'Накладные расходы', contingencyPercent:'Резерв (на непредвиденное)', retentionPercent:'Гарантийное удержание', fullDays:'Полные дни', materials:'Список материалов', structure:'Список расходов на содержание бизнеса', count:'Количество', hourlyCost:'Стоимость часа', cost:'Стоимость', costPerM2:'Стоимость за m²', country:'Страна', unsoldPercent:'Непроданный товар (% от производства)', dayHours:'Выставляемых часов в день', scaffoldingFixed:'Леса, фиксированная плата за монтаж и демонтаж', weatherDays:'Ожидаемые дни непогоды'};
var UNIT_WORD = {'pièce': 'шт', 'portion': 'порция', 'kg': 'kg', 'L': 'литр', 'lot': 'партия'};
// Taux de TVA vérifiés le 8 octobre 2026 : BE (accountable.eu, maj 24/08/2026), LU (stripe.com, maj 24/02/2026), FR (economie.gouv.fr, 11/12/2025), CH (estv.admin.ch)
var VAT_RATES = {BE: ['21', '12', '6', '0'], LU: ['17', '14', '8', '3'], FR: ['20', '10', '5,5', '2,1'], CH: ['8,1', '3,8', '2,6'], autre: []};
if (DEC === '.') Object.keys(VAT_RATES).forEach(function(k){ VAT_RATES[k] = VAT_RATES[k].map(function(x){ return x.replace(',', '.'); }); });
var COUNTRY_OPTS = [['BE','Бельгия'],['LU','Люксембург'],['FR','Франция'],['CH','Швейцария'],['autre','Другая страна']];
var UNIT_PL = {'шт': 'шт', 'порция': 'порций', 'партия': 'партий', 'литр': 'литров'};
var MAT_FACTOR = {kg: 1, g: 0.001, L: 1, cl: 0.01, ml: 0.001, 'pièce': 1};
var BREAK_LABEL = {'Риски': 'Риски (неоплаты, непроданный товар)', 'Комиссии с выручки': 'Комиссии за приём оплаты'};
function F(k, s, h, extra){ return Object.assign({k: k, s: s, h: h}, extra || {}); }
var PRICE_HINT = 'Укажите 0, если вы ищете свою цену: минимальная и рекомендуемая цены всё равно будут показаны.';
var CFG = {
  fabrication: {
    blocks: [
      {t: 'Ваш продукт', f: [F('unit', null, null, {kind: 'sel', o: [['pièce','шт'],['portion','порция'],['kg','kg'],['L','литр'],['lot','партия']]}), F('quantity', '@unit', 'Количество штук в партии или произведённые kg / литры, годные к продаже.', {req: 1}), F('price', '€/@unit', PRICE_HINT, {req: 1}), F('priceMode', null, null, {kind: 'sel', o: [['HT','Без НДС'],['TTC','С НДС']]}), F('country', null, null, {kind: 'sel', o: COUNTRY_OPTS}), F('vat', '%', 'Чтобы показать цены с НДС. Обязательно, если ваша цена указана с НДС. Проверьте ставку для вашего продукта.', {kind: 'vatpick'}), F('unsoldPercent', '%', 'Доля продукции, которую выбросили или отдали. Затраты распределяются на проданное.')]},
      {t: 'Материалы', alt: {list: 'materials', lib: 1, out: 'cost', total: F('materialsTotal', '€', 'Стоимость материалов на ВСЮ партию, а не на единицу. Укажите 0, если их нет. Сюда можно включить энергию печи и упаковку.'), cols: [{k: 'name', l: 'Материал', text: 1}, {k: 'qty', l: 'Количество на партию'}, {k: 'u', l: 'Единица', sel: [['kg','kg'],['g','g'],['L','L'],['cl','cl'],['ml','ml'],['pièce','шт']]}, {k: 'price', l: 'Закупочная цена', s: '€/kg, L или шт'}], calc: function(r){ return r.qty * (MAT_FACTOR[r.u] || 1) * r.price; }}},
      {t: 'Ваше время', f: [F('minutes', 'min', 'Общее время на всю партию.', {req: 1}), F('laborHourly', '€/h', 'Зарплата + социальные взносы за час работы. Аренда и энергия указываются ниже.', {req: 1})]}
    ],
    details: [
      {t: 'Постоянные расходы и потери', f: [F('fixedMonthly', '€/мес.', 'Аренда, энергия, страховки мастерской.'), F('productiveHours', 'ч/мес.', 'Всего производственных часов в месяц по всем работникам. Если пусто — 160.'), F('lossPercent', '%', 'Материал, потерянный или испорченный в производстве.')]},
      {t: 'Маржа, риск, комиссии и налог', f: [F('marginPercent', '%', 'Доля цены продажи без НДС, которая должна оставаться у вас (маржа от цены).'), F('riskPercent', '%', 'Непроданный товар, неоплаты, бой и порча — в % от выручки.'), F('feePercent', '%', 'Комиссии платёжных систем или торговых площадок.'), F('taxPercent', '%', 'Среднюю ставку уточните у бухгалтера.'), F('targetNet', '€', 'Сколько должно оставаться у вас после налогов.'), F('targetScope', null, null, {kind: 'sel', o: [['lot','на всю партию'],['unit','на единицу']]})]}
    ],
    watch: ['fixedMonthly', 'lossPercent', 'riskPercent', 'feePercent', 'taxPercent']
  },
  travaux: {
    blocks: [
      {t: 'Объект', f: [F('surface', 'm²', null, {req: 1}), F('pricePerM2', '€/m²', PRICE_HINT, {req: 1}), F('priceMode', null, null, {kind: 'sel', o: [['HT','Без НДС'],['TTC','С НДС']]}), F('country', null, null, {kind: 'sel', o: COUNTRY_OPTS}), F('vat', '%', 'Чтобы показать цены с НДС. Обязательно, если ваша цена указана с НДС. Ставка зависит от вида работ (ремонт, новое строительство…).', {kind: 'vatpick'})]},
      {t: 'Ваша выработка', f: [F('yieldPerDay', 'm²/чел./день', 'Сколько выполняет ОДИН человек за день в ВАШИХ условиях.', {req: 1}), F('hoursPerDay', 'ч', 'Если пусто — 8.')]},
      {t: 'Ваша бригада', list: {list: 'team', cols: [{k: 'name', l: 'Должность', text: 1}, {k: 'count', l: 'Количество'}, {k: 'hourlyCost', l: 'Стоимость часа одного человека', s: '€/h'}]}},
      {t: 'Материалы', alt: {list: 'materials', lib: 1, out: 'costPerM2', total: F('materialPerM2', '€/m²', 'Все материалы на 1 m² готовой работы.'), cols: [{k: 'name', l: 'Материал', text: 1}, {k: 'qty', l: 'Количество на m²'}, {k: 'u', l: 'Единица', text: 1}, {k: 'price', l: 'Закупочная цена за единицу', s: '€'}], calc: function(r){ return r.qty * r.price; }}, f: [F('lossPercent', '%', 'Обрезки, если они ещё не учтены в стоимости за m².')]}
    ],
    details: [
      {t: 'Расходы на объекте', f: [F('fuelLitersPerDay', 'L/день'), F('fuelPrice', '€/L'), F('consumablesPerDay', '€/день'), F('scaffoldingPerDay', '€/день', 'Аренда за полный день. Если аренда понедельная — разделите на 5.'), F('scaffoldingFixed', '€', 'Фиксированная плата за монтаж и демонтаж.'), F('weatherDays', 'дн.', 'Дни, когда арендованное оборудование простаивает: леса и техника считаются дополнительно.'), F('machinePerDay', '€/день'), F('skipCost', '€'), F('distanceKm', 'km'), F('costPerKm', '€/km', 'Эту цифру даст ваш тест «Транспорт».'), F('tripsMode', null, null, {kind: 'sel', o: [['daily','одна поездка туда и обратно за каждый начатый день'],['fixed','фиксированное число на объект']]}), F('tripsPerDay', '/день', 'Режим «по дням». Если пусто — 1.', {only: 'daily'}), F('trips', 'поездок', 'Режим «фиксированное число».', {only: 'fixed'}), F('otherCosts', '€'), F('financingCost', '€', 'Если вы берёте кредит, чтобы профинансировать объект.'), F('fullDays', null, 'Оплата труда за полные дни.', {kind: 'bool'})]},
      {t: 'Маржа, риск, движение денег и налог', f: [F('fixedPercent', '%', 'Офис, администрирование, страховки — в % от прямых затрат.'), F('contingencyPercent', '%', 'Погода, переделки, сюрпризы.'), F('marginPercent', '%', 'Доля цены продажи без НДС, которая должна оставаться у вас (маржа от цены).'), F('retentionPercent', '%', 'Поступит позже: это не убыток.'), F('riskPercent', '%', 'Неоплаты, возвраты, споры — в % от выручки.'), F('feePercent', '%', 'Комиссии за приём оплаты.'), F('taxPercent', '%', 'Среднюю ставку уточните у бухгалтера.'), F('targetNet', '€', 'Сколько должно остаться у вас с этого объекта после налогов.')]}
    ],
    watch: ['fixedPercent', 'contingencyPercent', 'riskPercent', 'feePercent', 'taxPercent']
  },
  services: {
    blocks: [
      {t: 'Ваше время', f: [F('persons', 'чел.', 'Люди, чьи часы выставляются по этой ставке. Если пусто — 1.'), F('weeks', 'нед.', 'Без отпусков, праздников и больничных.', {req: 1}), F('weeklyHours', 'ч', null, {req: 1}), F('billablePercent', '%', 'Администрирование, сметы и поиск клиентов не оплачиваются.', {req: 1})]},
      {t: 'Ваша ставка', f: [F('rate', '€/h', PRICE_HINT, {req: 1}), F('dayHours', 'ч', 'Чтобы видеть цены за день. Если пусто — 8.'), F('priceMode', null, null, {kind: 'sel', o: [['HT','Без НДС'],['TTC','С НДС']]}), F('country', null, null, {kind: 'sel', o: COUNTRY_OPTS}), F('vat', '%', 'Чтобы показать цены с НДС. Обязательно, если ваша ставка указана с НДС.', {kind: 'vatpick'})]},
      {t: 'Вознаграждение руководителя', dir: true},
      {t: 'Персонал и содержание бизнеса', f: [F('staffAnnual', '€/год', 'Годовые затраты на ваших сотрудников с взносами. 0, если сотрудников нет.')], alt: {list: 'structure', total: F('structureTotal', '€/год', 'Аренда, страховки, программы, автомобиль, бухгалтер… Укажите 0, если ничего нет.'), cols: [{k: 'name', l: 'Статья', text: 1}, {k: 'cost', l: 'Годовые затраты', s: '€/год'}]}}
    ],
    details: [
      {t: 'Маржа, риск, комиссии и налог', f: [F('marginPercent', '%', 'Доля ставки без НДС, которая должна оставаться у вас (маржа от цены).'), F('riskPercent', '%', 'Неоплаты, возвраты.'), F('feePercent', '%', 'Банковские комиссии, приём оплаты.'), F('taxPercent', '%', 'Средняя ставка налога на прибыль — уточните у бухгалтера.'), F('targetNet', '€/год', 'Желаемая прибыль сверх вашего вознаграждения, которое уже учтено.')]}
    ],
    watch: ['riskPercent', 'feePercent', 'taxPercent']
  }
};
var DEF = {
  fabrication: {name: 'Выпечка деревенского хлеба (пример)', v: {quantity: '20', unit: 'pièce', price: '3,76', priceMode: 'HT', vat: '', materialsTotal: '4,57', minutes: '90', laborHourly: '29,50', fixedMonthly: '0', productiveHours: '160', lossPercent: '0', marginPercent: '35', riskPercent: '2', feePercent: '1,2', taxPercent: '25', targetNet: '20', targetScope: 'lot', country: 'BE', unsoldPercent: ''}, lists: {materials: [{name: 'Мука T65', qty: '6', u: 'kg', price: '0,7617'}]}, mode: {materials: 'total'}},
  travaux: {name: 'Черепичная кровля, 180 m² (пример)', v: {surface: '180', pricePerM2: '59,38', priceMode: 'HT', vat: '', yieldPerDay: '22', hoursPerDay: '8', materialPerM2: '24,377', lossPercent: '0', fuelLitersPerDay: '12', fuelPrice: '1,65', consumablesPerDay: '15', scaffoldingPerDay: '45', machinePerDay: '0', skipCost: '320', distanceKm: '46', costPerKm: '0,55', tripsMode: 'daily', tripsPerDay: '1', trips: '', otherCosts: '0', financingCost: '0', fullDays: 'false', fixedPercent: '12', contingencyPercent: '7', marginPercent: '18', retentionPercent: '0', riskPercent: '3', feePercent: '1,5', taxPercent: '25', targetNet: '2000', country: 'BE', scaffoldingFixed: '', weatherDays: ''}, lists: {team: [{name: 'Бригадир', count: '1', hourlyCost: '42'}, {name: 'Квалифицированные рабочие', count: '2', hourlyCost: '36'}, {name: 'Разнорабочий', count: '1', hourlyCost: '26'}], materials: [{name: 'Пазовая черепица', qty: '13', u: 'pièce', price: '1,4581'}, {name: 'Рейка обрешётки 27×40', qty: '3,2', u: 'm', price: '1,045'}, {name: 'Подкровельная мембрана', qty: '1,1', u: 'm²', price: '1,89'}]}, mode: {materials: 'total'}},
  services: {name: 'Фирма из 2 человек (пример)', v: {persons: '2', weeks: '44', weeklyHours: '40', billablePercent: '62', rate: '75', priceMode: 'HT', vat: '', directorMode: 'direct', directorAnnualCost: '69600', directorNet: '48000', contributionPercent: '45', staffAnnual: '38000', structureTotal: '36500', marginPercent: '20', riskPercent: '2', feePercent: '1', taxPercent: '25', targetNet: '30000', country: 'BE', dayHours: ''}, lists: {structure: [{name: '', cost: ''}]}, mode: {structure: 'total'}}
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
var S = lsGet('pnr-draft-v2-ru');
if (!S || !CFG[S.type]) S = freshState('fabrication');
var cache = {};
cache[S.type] = S;
function saveDraft(){ lsSet('pnr-draft-v2-ru', S); }
function unitWord(){ return UNIT_WORD[S.v.unit] || S.v.unit || 'шт'; }
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
    var sel = '<select id="f-vatChoice" data-vat="1"><option value="">Выберите ставку</option>' + rates.map(function(x){ return '<option value="' + esc(clean(x)) + '"' + (choice === clean(x) ? ' selected' : '') + '>' + esc(x) + ' %</option>'; }).join('') + '<option value="autre"' + (choice === 'autre' ? ' selected' : '') + '>Другая ставка</option></select>';
    return '<div class="field" data-field="vat"><label for="f-vatChoice">' + label + ' <span class="mute" style="font-weight:400">(необязательно)</span></label><div class="inp">' + sel + '</div>' + (choice === 'autre' ? '<div class="inp" style="margin-top:6px"><input id="f-vat" inputmode="decimal" autocomplete="off" data-k="vat" value="' + esc(value || '') + '" aria-label="Ставка НДС"><em>%</em></div>' : '') + (f.h ? '<span class="hint">' + esc(f.h) + '</span>' : '') + '</div>';
  }
  if (f.kind === 'bool') return '<label class="check"><input type="checkbox" id="' + id + '" data-k="' + f.k + '"' + (value === 'true' ? ' checked' : '') + '><span><b>' + label + '</b><br><span class="mute small">' + esc(f.h || '') + '</span></span></label>';
  var s = suffixOf(f);
  return '<div class="field" data-field="' + f.k + '"><label for="' + id + '">' + label + (f.req ? '' : ' <span class="mute" style="font-weight:400">(необязательно)</span>') + '</label><div class="inp"><input id="' + id + '" inputmode="decimal" autocomplete="off" data-k="' + f.k + '" value="' + esc(value || '') + '">' + (s ? '<em>' + s + '</em>' : '') + '</div>' + (f.h ? '<span class="hint">' + esc(f.h) + '</span>' : '') + '</div>';
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
    }).join('') + '<button type="button" class="x" data-del="' + def.list + ':' + i + '" aria-label="Удалить строку">×</button>' + (def.calc ? '<span class="row-cost num" data-rowcost="' + def.list + ':' + i + '"></span>' : '') + '</div>';
  }).join('') + '</div><div class="btn-row" style="margin-top:8px"><button type="button" class="btn btn-line btn-sm" data-add="' + def.list + '">+ Добавить строку</button>' + (def.lib ? '<button type="button" class="btn btn-ghost btn-sm" data-libsave="' + def.list + '">Сохранить эти цены в «Мои закупочные цены»</button>' : '') + '</div>';
}
function dirHTML(){
  var m = S.v.directorMode || 'direct';
  var opts = [['direct','Я знаю его полную годовую стоимость'],['markup','Чистыми + взносы в % от чистого'],['fraction','Взносы в % от полной стоимости']];
  var h = '<div class="seg" role="group" aria-label="Способ">' + opts.map(function(o){ return '<button type="button" data-dir="' + o[0] + '" aria-pressed="' + (m === o[0]) + '">' + o[1] + '</button>'; }).join('') + '</div><div class="fields two" style="margin-top:12px">';
  if (m === 'direct') h += fieldHTML(F('directorAnnualCost', '€/год', 'Во что он обходится бизнесу, включая взносы. Укажите 0, только если учитываете это в другом месте.', {req: 1}), S.v.directorAnnualCost);
  else h += fieldHTML(F('directorNet', '€/год', 'После взносов, до подоходного налога.', {req: 1}), S.v.directorNet) + fieldHTML(F('contributionPercent', '%', m === 'markup' ? 'Стоимость = чистыми × (1 + ставка). Укажите 0, если взносов нет.' : 'Стоимость = чистыми ÷ (1 − ставка), ставка ниже 100 %.', {req: 1}), S.v.contributionPercent);
  return h + '</div><p class="hint" style="margin-top:8px">Ваша ставка взносов зависит от статуса и страны: уточните её у бухгалтера или в своём фонде социального страхования.</p>';
}
function blockHTML(b, isDetail){
  var inner = '';
  if (b.dir) inner += dirHTML();
  if (b.alt){
    var mode = S.mode[b.alt.list] || 'total';
    inner += '<div class="seg" role="group" aria-label="Способ ввода" style="margin-bottom:10px"><button type="button" data-mode="' + b.alt.list + ':total" aria-pressed="' + (mode === 'total') + '">Одной суммой</button><button type="button" data-mode="' + b.alt.list + ':list" aria-pressed="' + (mode === 'list') + '">Построчно</button></div>';
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
  var note = S.carryNote || (S.example ? 'Загружен пример: замените каждую цифру своей, в том числе в свёрнутых разделах.' : '');
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
    if (blank(raw)){ if (req) setErr(k, '« ' + label + ' » — обязательное поле.'); return undefined; }
    var n = parseNum(raw);
    if (isNaN(n)){ setErr(k, '« ' + label + ' » — некорректное число.'); return undefined; }
    if (n < 0){ setErr(k, '« ' + label + ' » — значение не может быть отрицательным.'); return undefined; }
    if (dotThousands(raw)) notes.push('« ' + raw + ' » читается как ' + fmt(n, n % 1 ? 2 : 0) + (DEC === '.' ? ' — запятая здесь отделяет тысячи. Для десятичных используйте точку (3.1).' : ' — точка здесь отделяет тысячи. Для десятичных используйте запятую (3,1).'));
    return n;
  }
  allFields(st.type).forEach(function(f){
    var raw = st.v[f.k];
    if (f.kind === 'sel'){ if (raw) inputs[f.k] = raw; return; }
    if (f.kind === 'bool'){ inputs[f.k] = raw === 'true'; return; }
    if (f.kind === 'vatpick'){ var vv = num('vat', raw, LABELS.vat, false); if (vv !== undefined){ if (vv > 100) setErr('vat', 'Ставка НДС должна быть ниже 100 %.'); inputs.vat = vv; } return; }
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
      if (!rows.length) setErr(def.list, x.alt ? 'Добавьте хотя бы одну строку в « ' + LABELS[def.list] + ' » или вернитесь к режиму «Одной суммой».' : 'Добавьте в бригаду хотя бы одного человека, указав количество и стоимость часа.');
      inputs[def.list] = rows.map(function(r, i){
        var o = {};
        var legacy = def.calc && blank(r.qty) && blank(r.price) && !blank(r[def.out]);
        if (legacy){ o.name = String(r.name || '').trim() || '—'; o[def.out] = num(def.list, r[def.out], 'Стоимость (строка ' + (i + 1) + ')', true); return o; }
        def.cols.forEach(function(col){
          if (col.text){ o[col.k] = String(r[col.k] || '').trim() || (col.k === 'name' ? '—' : ''); return; }
          if (col.sel){ o[col.k] = r[col.k] || col.sel[0][0]; return; }
          var n = num(def.list, r[col.k], col.l + ' (строка ' + (i + 1) + ')', true);
          if (def.list === 'team' && col.k === 'count' && n === 0) setErr(def.list, 'Строка ' + (i + 1) + ' в бригаде: количество должно быть не меньше 1, или удалите строку.');
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
  if (inputs.priceMode === 'TTC' && inputs.vat === undefined) setErr('vat', 'Ваша цена указана с НДС: выберите ставку НДС, которая в неё входит.');
  var extra = {};
  if (st.type === 'fabrication' && inputs.unsoldPercent !== undefined){
    var u = inputs.unsoldPercent; delete inputs.unsoldPercent;
    if (u >= 100) setErr('unsoldPercent', 'Непроданный товар должен составлять меньше 100 % продукции.');
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
  if (st.type === 'travaux' && (st.v.tripsMode || 'daily') === 'fixed' && inputs.distanceKm > 0 && inputs.trips === undefined) setErr('trips', 'Режим «фиксированное число»: укажите число поездок на объект.');
  return {inputs: inputs, err: err, notes: notes, extra: extra};
}
function runEngine(st){
  var b = buildInputs(st);
  if (b.err) return {err: b.err, inputs: b.inputs, notes: b.notes, extra: b.extra};
  try { return {r: PNR.calculate(st.type, b.inputs), inputs: b.inputs, notes: b.notes, extra: b.extra}; }
  catch (e){
    if (e instanceof PNR.PnrError){
      var f = e.field || '', label = LABELS[f];
      return {err: {field: f, msg: label ? '« ' + label + ' » — значение вне допустимых пределов.' : e.message}, inputs: b.inputs, notes: b.notes, extra: b.extra};
    }
    throw e;
  }
}

// ---------- calcul complet : résultat ----------
function L(label, value, cls){ return '<li class="' + (cls || '') + '"><span>' + label + '</span><i></i><span class="num">' + value + '</span></li>'; }
function unitOf(st, r){ return st.type === 'fabrication' ? (UNIT_WORD[r.details.unit] || r.details.unit || 'шт') : st.type === 'travaux' ? 'm²' : 'ч'; }
function netLabel(st){ return st.type === 'services' ? 'Прибыль после налогов сверх вашего вознаграждения' : 'Реальный остаток после налогов'; }
// avertissements du moteur à masquer selon le cas (mêmes textes que dans le moteur)
var W_TARGET = 'При текущей ставке цель недостижима в пределах доступных часов.';
var W_NOPRICE = ['При введённых допущениях текущая цена даёт убыток.', W_TARGET, 'Возвращаемые удержания — это кассовый разрыв, а не убыток. Стоимость финансирования нужно указать отдельно.'];
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
  if (run.err) return '<p class="eyebrow">Не хватает данных</p><p class="err">' + esc(run.err.msg) + '</p><p class="limit">Расчёт обновится, как только поле будет исправлено.</p>';
  var r = run.r, d = r.details, u = unitOf(st, r), per = ' / ' + u;
  var hasPrice = r.revenue > 0;
  var h = '';
  if (run.notes.length) h += '<p class="gap">' + run.notes.map(esc).join('<br>') + '</p>';
  var ex = run.extra || {};
  var uPl = UNIT_PL[u] || u;
  if (ex.unsold) h += '<p class="limit" style="border:0;padding:0">Расчёт: продано ' + fmt(d.quantity, d.quantity % 1 ? 2 : 0) + ' ' + uPl + ' из ' + fmt(ex.produced, ex.produced % 1 ? 2 : 0) + ' произведённых (' + fmt(ex.unsold, 1) + ' % не продано): затраты распределены на проданное.</p>';
  h += '<p class="eyebrow">Ваша минимальная цена</p><p class="big">' + eur(r.minimumPrice) + '<small>без НДС' + per + '</small></p>' +
    '<p class="small" style="color:var(--night-mute)">Ниже этой цены вы теряете деньги: она покрывает все ваши затраты, риски и комиссии, но без прибыли.</p><ul class="lines">';
  h += L('Себестоимость', eur(d.beforeFeesThreshold) + per);
  h += L('Минимальная цена', eur(r.minimumPrice) + per, 'strong');
  if (d.marginPercent > 0) h += L('Рекомендуемая цена (маржа ' + fmt(d.marginPercent, d.marginPercent % 1 ? 1 : 0) + ' %)', eur(r.recommendedPrice) + per);
  var unitTarget = st.type === 'fabrication' && d.targetScope === 'unit';
  if (d.targetNet > 0) h += L('Цена, чтобы оставалось ' + eur(unitTarget ? d.targetNet / d.quantity : d.targetNet, 0) + (unitTarget ? ' / ' + u : st.type === 'services' ? ' в год' : '') + ' чистыми', eur(r.targetPrice) + per, 'strong');
  if (hasPrice) h += L('Ваша текущая цена' + (st.v.priceMode === 'TTC' ? ' (пересчитана без НДС)' : ''), eur(r.currentPrice) + per);
  h += '</ul>';
  if (ex.vat !== undefined && ex.vat > 0){
    var tt = function(x){ return eur(x * (1 + ex.vat / 100)) + per; };
    h += '<p class="eyebrow" style="margin-top:2px">Те же цены с НДС (НДС ' + fmt(ex.vat, ex.vat % 1 ? 1 : 0) + ' %)</p><ul class="lines">' + L('Минимальная цена с НДС', tt(r.minimumPrice)) + (d.marginPercent > 0 ? L('Рекомендуемая цена с НДС', tt(r.recommendedPrice)) : '') + (d.targetNet > 0 ? L('Цена для вашей цели с НДС', tt(r.targetPrice)) : '') + (hasPrice ? L('Ваша текущая цена с НДС', tt(r.currentPrice)) : '') + '</ul>';
  }
  if (st.type === 'services'){
    var dh = ex.dayHours || 8, dd = function(x){ return eur(x * dh) + ' / день'; };
    h += '<p class="eyebrow" style="margin-top:2px">За день (' + fmt(dh, dh % 1 ? 1 : 0) + ' ч к оплате)</p><ul class="lines">' + L('Минимальная цена', dd(r.minimumPrice)) + (d.marginPercent > 0 ? L('Рекомендуемая цена', dd(r.recommendedPrice)) : '') + (d.targetNet > 0 ? L('Цена для вашей цели', dd(r.targetPrice)) : '') + (hasPrice ? L('Ваша текущая ставка', dd(r.currentPrice)) : '') + '</ul>';
  }
  if (d.marginPercent > 0 && r.recommendedPrice < r.minimumPrice - 1e-9) h += '<p class="gap">Ваша целевая маржа (' + fmt(d.marginPercent, 1) + ' %) меньше ваших рисков и комиссий (' + fmt(d.riskPercent + d.feePercent, 1) + ' %): рекомендуемая цена оказывается ниже минимальной. Повысьте маржу.</p>';
  if (hasPrice){
    if (r.currentPrice < r.minimumPrice - 1e-9) h += '<p class="verdict">Ваша цена ниже минимальной: не хватает ' + eur(r.minimumPrice - r.currentPrice) + per + '.</p>';
    else if (d.targetNet > 0 && r.currentPrice < r.targetPrice - 1e-9) h += '<p class="verdict">Прибыльно, но ниже вашей цели: не хватает ' + eur(r.targetPrice - r.currentPrice) + per + '.</p>';
    else h += '<p class="verdict good">Ваша цена покрывает затраты' + (d.targetNet > 0 ? ' и достигает вашей цели' : '') + '.</p>';
    var rows = [['Выручка без НДС', r.revenue, 'hsl(218 30% 60%)']].concat(r.breakdown.map(function(b){ return [BREAK_LABEL[b.label] || b.label, b.amount, 'hsl(214 16% 62%)']; })).concat([['Что у вас остаётся', r.net, r.net >= 0 ? 'var(--ok-night)' : 'var(--loss-night)']]);
    h += '<p class="eyebrow" style="margin-top:4px">Куда уходит ваша цена</p><ul class="cascade-night">' + rows.filter(function(x){ return Math.abs(x[1]) > 0.004 || x[0] === 'Что у вас остаётся'; }).map(function(x){
      var w = Math.min(100, Math.abs(x[1]) / r.revenue * 100);
      return '<li><div class="lab"><span>' + x[0] + '</span><span class="num">' + eur(x[1]) + '</span></div><div class="track"><i style="width:' + w.toFixed(1) + '%;background:' + x[2] + '"></i></div></li>';
    }).join('') + '</ul>';
    var div = st.type === 'fabrication' ? d.quantity : st.type === 'travaux' ? d.surface : d.hours;
    h += '<ul class="lines">' + L(netLabel(st), '<span class="' + (r.net >= 0 ? 'pos' : 'neg') + '">' + eur(r.net) + '</span>', 'strong') + L('Остаток / ' + u, eur(r.net / div)) + L('То есть', fmt(r.net / r.revenue * 100, 1) + ' % от цены без НДС') + '</ul>';
  } else {
    h += '<p class="gap">Укажите текущую цену, чтобы увидеть, сколько у вас остаётся и что этот остаток съедает.</p>';
  }
  h += '<p class="eyebrow" style="margin-top:4px">Подробности</p><ul class="lines">';
  if (st.type === 'fabrication'){
    h += L('Стоимость часа в расчёте (время + постоянные расходы)', eur(d.hourly) + ' / ч') + L('Материалы на партию', eur(d.material)) + L('Время на партию', eur(d.labor));
  } else if (st.type === 'services'){
    h += L('Рабочих часов в год', fmt(d.paidHours, 0) + ' ч') + L('Выставленных часов в год', fmt(d.hours, 0) + ' ч') + L('Годовые расходы', eur(r.cost, 0));
    if (d.targetNet > 0 && hasPrice && d.requiredHours !== null) h += L('Часы, которые нужно выставить для вашей цели', fmt(d.requiredHours, 0) + ' ч');
  } else {
    h += L('Срок работ на объекте', fmt(d.duration, 2) + ' дн. (' + d.days + ' дн. в расчёте)') + L('Оплата труда', eur(d.labor)) + L('Материалы', eur(d.material)) + L('Расходы на объекте', eur(d.expenses));
    if (hasPrice) h += L('Минимальная выработка при этой цене', d.equilibriumStatus === 'found' ? fmt(d.displayedEquilibriumYield, 2) + ' m²/чел./дн.' : d.equilibriumStatus === 'any' ? 'без ограничений' : 'нет', 'strong');
    if (d.retentionAmount > 0) h += L('Удержание, которое поступит позже', eur(d.retentionAmount));
    if (ex.scaffoldFixed > 0) h += L('Леса, фиксированная плата (в расходах)', eur(ex.scaffoldFixed));
    if (ex.weatherCost > 0) h += L(fmt(ex.weatherDays, 0) + ' дн. непогоды (в расходах)', eur(ex.weatherCost));
  }
  h += '</ul>';
  if (st.type === 'services' && d.targetNet > 0 && hasPrice && d.impossible) h += '<p class="verdict">Ваша цель недостижима при этой ставке: нужно ' + fmt(d.requiredHours, 0) + ' ч к оплате, а у вас ' + fmt(d.hours, 0) + '. Повысьте цену.</p>';
  if (st.type === 'services') h += '<p class="limit">Индивидуальный предприниматель: налог на ваше собственное вознаграждение здесь не учитывается. Прибыль добавляется к вашему вознаграждению.</p>';
  if (st.type === 'travaux' && hasPrice){
    var planned = parseNum(st.v.yieldPerDay);
    if (d.equilibriumStatus === 'found'){
      if (planned < d.displayedEquilibriumYield) h += '<p class="verdict">Ваша плановая выработка (' + fmt(planned, 2) + ') уже ниже минимальной (' + fmt(d.displayedEquilibriumYield, 2) + ' m²/чел./дн.): при этой цене объект убыточен.</p>';
      else h += '<p class="gap">Если выработка бригады упадёт ниже <b>' + fmt(d.displayedEquilibriumYield, 2) + ' m² на человека в день</b>, этот объект станет для вас убыточным. Вы планируете ' + fmt(planned, 2) + '.</p>';
    } else if (d.equilibriumStatus === 'impossible') h += '<p class="verdict">Даже при бесконечно быстрой бригаде эта цена не покрывает материалы и постоянные расходы объекта.</p>';
  }
  var zero = CFG[st.type].watch.filter(function(k){ return !(parseNum(st.v[k]) > 0); }).map(function(k){ return lower((LABELS[k] || k).split(' (')[0]); });
  if (zero.length) h += '<p class="limit">В этом расчёте приняты равными 0: ' + zero.join(', ') + '. Проверьте, что так и задумано.</p>';
  var warns = cleanWarnings(st, r);
  if (warns.length) h += '<ul class="warns">' + warns.map(function(w){ return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>';
  return h;
}
function miniHTML(st, run){
  if (run.err) return '<span class="mini-err">' + esc(run.err.msg) + '</span>';
  var r = run.r, u = unitOf(st, r);
  return '<span>Минимум <b class="num">' + eur(r.minimumPrice) + '/' + u + '</b></span>' + (r.revenue > 0 ? '<span>Остаток <b class="num ' + (r.net >= 0 ? 'pos' : 'neg') + '">' + eur(r.net, 0) + '</b></span>' : '') + '<a href="#c-result" data-scroll="1">Подробно ↓</a>';
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
    if (!n){ toast('Нечего сохранять: укажите название и цену в каждой строке.'); return; }
    Lib.save().then(function(){ toast(n + (n > 1 ? ' поз. сохранено' : ' поз. сохранено') + ' в «Мои закупочные цены».'); renderDatalist(); }, function(){ toast('В этом браузере сохранить не удалось.'); });
    return;
  }
  else return;
  renderForm(); compute(); saveDraft();
});
$('#c-name').addEventListener('input', function(e){ S.name = e.target.value; saveDraft(); });
$('#c-client').addEventListener('input', function(e){ S.client = e.target.value; saveDraft(); });
$$('.type').forEach(function(b){ b.addEventListener('click', function(){ setType(b.getAttribute('data-type')); }); });
$('#c-example').addEventListener('click', function(e){ if (!armed(e.currentTarget, 'Стереть ваши цифры? Нажмите ещё раз')) return; S = freshState(S.type); cache[S.type] = S; renderForm(); compute(); saveDraft(); toast('Пример загружен заново.'); });
$('#c-clear').addEventListener('click', function(e){ if (!armed(e.currentTarget, 'Стереть всё? Нажмите ещё раз')) return; S = freshState(S.type, true); cache[S.type] = S; renderForm(); compute(); saveDraft(); });
document.addEventListener('click', function(e){ var a = e.target.closest('[data-scroll]'); if (a){ e.preventDefault(); $('#c-result').scrollIntoView({behavior: 'smooth', block: 'start'}); } });

// ---------- résumé texte et PDF ----------
var TYPE_NAME = {fabrication: 'Производство', travaux: 'Строительство', services: 'Услуги'};
function fieldDef(type, k){ var all = allFields(type); var f = all.filter(function(x){ return x.k === k; })[0]; if (f) return f; var c = CFG[type]; var out = null; c.blocks.forEach(function(b){ if (b.alt && b.alt.total.k === k) out = b.alt.total; }); return out; }
function summaryLines(st, run){
  var r = run.r, d = r.details, u = unitOf(st, r), per = ' / ' + u, out = [];
  out.push(['Себестоимость', eur(d.beforeFeesThreshold) + per]);
  out.push(['Минимальная цена (с рисками и комиссиями)', eur(r.minimumPrice) + per]);
  if (d.marginPercent > 0) out.push(['Рекомендуемая цена (маржа ' + fmt(d.marginPercent, d.marginPercent % 1 ? 1 : 0) + ' % от цены)', eur(r.recommendedPrice) + per]);
  if (d.targetNet > 0) out.push(['Цена для вашего целевого дохода', eur(r.targetPrice) + per]);
  if (r.revenue > 0){ out.push(['Текущая цена без НДС', eur(r.currentPrice) + per]); out.push(['Выручка без НДС', eur(r.revenue)]); r.breakdown.forEach(function(b){ if (Math.abs(b.amount) > 0.004) out.push(['  ' + b.label, eur(b.amount)]); }); out.push([netLabel(st), eur(r.net)]); }
  if (st.type === 'travaux' && r.revenue > 0 && d.equilibriumStatus === 'found') out.push(['Минимальная выработка при этой цене', fmt(d.displayedEquilibriumYield, 2) + ' m²/чел./день']);
  if (st.type === 'services'){ out.push(['Выставленных часов в год', fmt(d.hours, 0) + ' ч']); if (d.targetNet > 0 && r.revenue > 0 && d.requiredHours !== null) out.push(['Часы, необходимые для цели', fmt(d.requiredHours, 0) + ' ч']); }
  return out;
}
var DIR_LABEL = {direct: 'полная годовая стоимость', markup: 'чистыми + взносы в % от чистого', fraction: 'взносы в % от полной стоимости'};
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
    else if (typeof v === 'boolean') { if (v) out.push([label, 'да']); }
    else if (f && f.o){ var o = f.o.filter(function(x){ return x[0] === v; })[0]; out.push([label, o ? o[1] : v]); }
    else out.push([label, v]);
  });
  return out;
}
function summaryText(st, run){
  var t = 'PRIX NET RÉEL — ' + TYPE_NAME[st.type] + '\n' + (st.name || 'Расчёт') + (st.client ? ' — ' + st.client : '') + '\n' + new Date().toLocaleDateString('ru-RU') + '\n\n';
  t += summaryLines(st, run).map(function(l){ return l[0] + ' : ' + l[1]; }).join('\n');
  t += '\n\nИсходные данные:\n' + inputLines(st).map(function(l){ return '- ' + l[0] + ' : ' + l[1]; }).join('\n');
  return t + '\n\n' + PNR.DISCLAIMER;
}
$('#c-copy').addEventListener('click', function(){
  compute(); if (!lastRun || lastRun.err) return;
  var text = summaryText(S, lastRun);
  try { navigator.clipboard.writeText(text).then(function(){ toast('Сводка скопирована.'); }, function(){ fallbackCopy(text); }); } catch(e){ fallbackCopy(text); }
});
function fallbackCopy(text){ var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('Сводка скопирована.'); } catch(e){ toast('Здесь скопировать не получается: выделите текст результата вручную.'); } ta.remove(); }
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
  doc.setTextColor(20, 28, 45); y = 26; doc.setFontSize(16); doc.text(pdfText(st.name || 'Расчёт'), M, y); y += 7;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.text(pdfText(TYPE_NAME[st.type] + (st.client ? ' · ' + st.client : '') + ' · ' + new Date().toLocaleDateString('ru-RU')), M, y); y += 10;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Результаты', M, y); y += 7;
  summaryLines(st, run).forEach(function(l, i){ line(l[0], l[1], i === 1); });
  y += 5; doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Исходные данные', M, y); y += 7;
  inputLines(st).forEach(function(l){ line(l[0], l[1]); });
  var warns = cleanWarnings(st, run.r);
  if (warns.length){ y += 5; doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Важно знать', M, y); y += 7; warns.forEach(function(w){ line('• ' + w); }); }
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
        page.drawText(winAnsi(st.name || 'Расчёт'), {x: M, y: y, size: 16, font: f[1], color: ink}); y -= 20;
        page.drawText(winAnsi(TYPE_NAME[st.type] + (st.client ? ' · ' + st.client : '') + ' · ' + new Date().toLocaleDateString('ru-RU')), {x: M, y: y, size: 10, font: f[0], color: grey}); y -= 22;
        title('Результаты'); summaryLines(st, run).forEach(function(l, i){ line(l[0], l[1], i === 1); });
        title('Исходные данные'); inputLines(st).forEach(function(l){ line(l[0], l[1]); });
        var warns = cleanWarnings(st, run.r);
        if (warns.length){ title('Важно знать'); warns.forEach(function(w){ line('• ' + w); }); }
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
    '<div class="bar">PRIX NET RÉEL</div><h1>' + esc(st.name || 'Расчёт') + '</h1><p>' + esc(TYPE_NAME[st.type] + (st.client ? ' · ' + st.client : '') + ' · ' + new Date().toLocaleDateString('ru-RU')) + '</p>' +
    '<h2>' + esc('Результаты') + '</h2><table>' + rows(summaryLines(st, run)) + '</table><h2>' + esc('Исходные данные') + '</h2><table>' + rows(inputLines(st)) + '</table>' +
    (warns.length ? '<h2>' + esc('Важно знать') + '</h2><ul>' + warns.map(function(w){ return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' : '') + '<p class="mute">' + esc(PNR.DISCLAIMER) + '</p></body></html>';
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
    setTimeout(function(){ try { f.contentWindow.focus(); f.contentWindow.print(); } catch(e){ toast('Здесь печать недоступна.'); } }, 300);
  }
  toast('Для PDF выберите «Сохранить как PDF» в окне печати.');
}
function pdfName(){ return 'prix-net-reel-' + ((S.name || 'calcul').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'calcul') + '.pdf'; }
$('#c-pdf').addEventListener('click', function(){
  if (SITE && PDF_PRINT){ compute(); if (!lastRun || lastRun.err) return; printReport(S, lastRun); return; }
  if (SITE){
    compute(); if (!lastRun || lastRun.err) return;
    var b = this; b.disabled = true;
    buildPdfSite(S, lastRun).then(function(blob){ return downloads.save({filename: pdfName(), data: blob}); }).then(function(){ toast('PDF готов.'); }, function(){ toast('Не удалось создать PDF. Попробуйте ещё раз.'); }).then(function(){ b.disabled = false; });
    return;
  }
  compute(); if (!lastRun || lastRun.err || !downloads || !window.jspdf) return;
  var doc = buildPdf(S, lastRun);
  var name = (S.name || 'calcul').replace(/[^\wÀ-ÿ -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'calcul';
  downloads.save({filename: 'prix-net-reel-' + name + '.pdf', data: doc.output('blob')}).then(function(){ toast('PDF готов.'); }, function(e){ if (e && e.code === 'declined') return; toast('Здесь не удалось сохранить PDF.'); });
});

// ---------- enregistrement ----------
var Store = {mode: 'local', db: null, uid: null, ready: null};
Store.ready = Promise.all([cap('db'), cap('user')]).then(function(res){
  var db = res[0], user = res[1];
  if (!db || !user) return;
  return user.id().then(function(id){ if (id){ Store.db = db; Store.uid = id; Store.mode = 'db'; } }).catch(function(){});
});
function localAll(){ return lsGet('pnr-saved-v1-ru') || []; }
Store.list = function(){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.collection('data/users/' + Store.uid).get().then(function(s){ return s.docs.filter(function(d){ return d.id !== 'prix'; }).map(function(d){ return Object.assign({id: d.id}, d.data()); }).filter(function(x){ return !!x.type; }); }, function(){ Store.mode = 'local'; return localAll(); });
  return localAll();
}); };
Store.save = function(rec){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.collection('data/users/' + Store.uid).doc(rec.id).set(rec).catch(function(){ Store.mode = 'local'; return Store.save(rec); });
  var all = localAll().filter(function(x){ return x.id !== rec.id; }); all.push(rec); if (!lsSet('pnr-saved-v1-ru', all)) throw new Error('local');
}); };
Store.remove = function(id){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.collection('data/users/' + Store.uid).doc(id).delete().catch(function(){});
  lsSet('pnr-saved-v1-ru', localAll().filter(function(x){ return x.id !== id; }));
}); };
$('#c-save').addEventListener('click', function(){
  compute(); if (!lastRun || lastRun.err) return;
  var r = lastRun.r;
  var name = (S.name || '').trim() || ('Расчёт: ' + lower(TYPE_NAME[S.type]));
  var update = S.savedId && S.savedName === name;
  if (!update) S.savedId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  var rec = {id: S.savedId, type: S.type, name: name, client: S.client || '', savedAt: new Date().toISOString(), v: S.v, lists: S.lists, mode: S.mode,
    summary: {unit: unitOf(S, r), minimumPrice: r.minimumPrice, recommendedPrice: r.recommendedPrice, targetPrice: r.targetPrice, net: r.net, revenue: r.revenue, margin: r.details.marginPercent, target: r.details.targetNet}};
  $('#c-save').disabled = true;
  Store.save(rec).then(function(){ S.savedName = name; S.name = name; $('#c-name').value = name; saveDraft(); toast(update ? 'Расчёт « ' + name + ' » обновлён.' : 'Расчёт « ' + name + ' » сохранён. Измените название, чтобы сохранить ещё один.'); }, function(){ toast('В этом браузере сохранить не удалось.'); }).then(function(){ $('#c-save').disabled = false; });
});
// ---------- mes prix d'achat ----------
var Lib = {items: []};
function libKey(n){ return String(n || '').trim().toLowerCase(); }
Lib.find = function(name, kind){ var k = libKey(name); if (!k) return null; return Lib.items.filter(function(x){ return libKey(x.name) === k && (!kind || x.kind === kind); })[0] || null; };
Lib.upsert = function(it){ var old = Lib.find(it.name, it.kind); if (old){ old.price = it.price; old.u = it.u || old.u; } else Lib.items.push(it); };
Lib.load = function(){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.doc('data/users/' + Store.uid + '/prix').get().then(function(d){ Lib.items = d.exists ? clone((d.data() || {}).items || []) : []; }, function(){ Lib.items = lsGet('pnr-prix-v1-ru') || []; });
  Lib.items = lsGet('pnr-prix-v1-ru') || [];
}).then(renderDatalist); };
Lib.save = function(){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.doc('data/users/' + Store.uid + '/prix').set({items: Lib.items});
  if (!lsSet('pnr-prix-v1-ru', Lib.items)) throw new Error('local');
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
    if (run.err) return {x: x, rank: 4, html: '<td>' + esc(x.name) + '</td><td>' + esc(TYPE_NAME[x.type] || '') + '</td><td colspan="5" class="mute">Нужно дополнить: ' + esc(run.err.msg) + '</td><td><span class="chip warn">не заполнено</span></td>'};
    var r = run.r, d = r.details, u = unitOf(st, r), hasPrice = r.revenue > 0, status, rank;
    if (!hasPrice){ status = '<span class="chip">нет цены</span>'; rank = 3; }
    else if (r.currentPrice < r.minimumPrice - 1e-9){ status = '<span class="chip bad">ниже минимума</span>'; rank = 0; }
    else if (d.targetNet > 0 && r.currentPrice < r.targetPrice - 1e-9){ status = '<span class="chip warn">ниже цели</span>'; rank = 1; }
    else { status = '<span class="chip ok">прибыльно</span>'; rank = 2; }
    return {x: x, rank: rank, html: '<td>' + esc(x.name) + (upd ? ' <span class="mute small">(' + upd + ' поз. обновлено)</span>' : '') + '</td><td>' + esc(TYPE_NAME[x.type] || '') + '</td>' +
      '<td class="num">' + eur(r.minimumPrice) + ' / ' + u + '</td><td class="num">' + (d.marginPercent > 0 ? eur(r.recommendedPrice) : '—') + '</td><td class="num">' + (hasPrice ? eur(r.currentPrice) : '—') + '</td>' +
      '<td class="num ' + (hasPrice ? (r.currentPrice - r.minimumPrice >= 0 ? 'pos' : 'neg') : '') + '">' + (hasPrice ? (r.currentPrice - r.minimumPrice >= 0 ? '+' : '') + eur(r.currentPrice - r.minimumPrice) : '—') + '</td><td class="num">' + (hasPrice ? eur(r.net, 0) : '—') + '</td><td>' + status + '</td>'};
  }).sort(function(a, b){ return a.rank - b.rank; });
  return '<h3 style="font-size:1.3rem;margin-bottom:10px">Все ваши расчёты, пересчитанные по сегодняшним закупочным ценам</h3><div class="tablewrap"><table class="cmp"><thead><tr><th>Расчёт</th><th>Вид работ</th><th>Минимум без НДС</th><th>Рекомендуемая без НДС</th><th>Текущая цена без НДС</th><th>Отклонение от минимума</th><th>Остаток</th><th>Статус</th></tr></thead><tbody>' + rows.map(function(r){ return '<tr>' + r.html + '</tr>'; }).join('') + '</tbody></table></div>';
}
function libEditorHTML(){
  var rows = Lib.items.map(function(x, i){
    return '<div class="row lib-row" style="--cols:3"><div class="field"><label class="small" for="lb-' + i + '-name">Название</label><div class="inp"><input class="txt" id="lb-' + i + '-name" data-lib="' + i + '" data-libcol="name" value="' + esc(x.name) + '"></div></div><div class="field"><label class="small" for="lb-' + i + '-u">Используемая единица</label><div class="inp"><input class="txt" id="lb-' + i + '-u" data-lib="' + i + '" data-libcol="u" value="' + esc(x.u || '') + '"></div></div><div class="field"><label class="small" for="lb-' + i + '-price">Закупочная цена (€ за kg, L или единицу)</label><div class="inp"><input inputmode="decimal" id="lb-' + i + '-price" data-lib="' + i + '" data-libcol="price" value="' + esc(x.price || '') + '"></div></div><div class="field"><label class="small" for="lb-' + i + '-kind">Для</label><div class="inp"><select id="lb-' + i + '-kind" data-lib="' + i + '" data-libcol="kind"><option value="fabrication"' + (x.kind === 'fabrication' ? ' selected' : '') + '>Производство</option><option value="travaux"' + (x.kind === 'travaux' ? ' selected' : '') + '>Строительство</option></select></div></div><button type="button" class="x" data-libdel="' + i + '" aria-label="Удалить">×</button></div>';
  }).join('');
  return '<h3 style="font-size:1.3rem;margin-bottom:6px">Мои закупочные цены</h3><p class="mute small" style="margin-bottom:10px">Измените цену здесь и сохраните: все расчёты с этим материалом (при построчном вводе) пересчитаются.</p>' +
    (rows ? '<div class="rows" style="--cols:3">' + rows + '</div>' : '<p class="mute small">Сохранённых цен пока нет. В расчёте переключите материалы на «Построчно» и нажмите «Сохранить эти цены».</p>') +
    '<div class="btn-row" style="margin-top:10px"><button type="button" class="btn btn-line btn-sm" id="lib-add">+ Добавить цену</button>' + (Lib.items.length ? '<button type="button" class="btn btn-hivis btn-sm" id="lib-save">Сохранить мои цены</button>' : '') + '</div>';
}
document.addEventListener('input', function(e){ var t = e.target; if (t.dataset && t.dataset.lib !== undefined){ Lib.items[+t.dataset.lib][t.dataset.libcol] = t.value; } });
document.addEventListener('change', function(e){ var t = e.target; if (t.dataset && t.dataset.lib !== undefined && t.tagName === 'SELECT'){ Lib.items[+t.dataset.lib][t.dataset.libcol] = t.value; } });
document.addEventListener('click', function(e){
  var b = e.target.closest('#lib-add,#lib-save,[data-libdel]'); if (!b) return;
  if (b.id === 'lib-add'){ Lib.items.push({name: '', u: '', price: '', kind: S.type === 'travaux' ? 'travaux' : 'fabrication'}); $('#s-lib').innerHTML = libEditorHTML(); return; }
  if (b.dataset.libdel !== undefined){ Lib.items.splice(+b.dataset.libdel, 1); $('#s-lib').innerHTML = libEditorHTML(); return; }
  Lib.items = Lib.items.filter(function(x){ return !blank(x.name); });
  Lib.save().then(function(){ toast('Закупочные цены сохранены. Ваши расчёты пересчитаны.'); renderDatalist(); renderSaved(); }, function(){ toast('В этом браузере сохранить не удалось.'); });
});

function renderSaved(){
  $('#s-where').textContent = 'Загрузка…';
  Store.list().then(function(list){
    $('#s-where').textContent = Store.mode === 'db' ? 'Сохранены в вашем аккаунте Claude: видны только вам, на всех ваших устройствах.' : 'Сохранены в этом браузере, на этом устройстве.';
    list.sort(function(a, b){ return String(b.savedAt).localeCompare(String(a.savedAt)); });
    $('#s-compare').innerHTML = compareHTML(list);
    $('#s-lib').innerHTML = libEditorHTML();
    if (!list.length){ $('#s-list').innerHTML = '<div class="empty"><b style="font-family:var(--f-display);font-size:1.2rem">Сохранённых расчётов нет</b><span class="mute">Сделайте полный расчёт и нажмите «Сохранить».</span><a class="btn btn-hivis" href="#calcul">Сделать расчёт</a></div>'; return; }
    $('#s-list').innerHTML = list.map(function(x){
      var s = x.summary || {};
      return '<div class="saved-item"><div><p class="eyebrow">' + esc(TYPE_NAME[x.type] || '') + '</p><h3>' + esc(x.name || 'Расчёт') + '</h3><p class="meta">' + (x.client ? esc(x.client) + ' · ' : '') + new Date(x.savedAt).toLocaleDateString('ru-RU') + ' · минимум <span class="num">' + eur(s.minimumPrice || 0) + ' / ' + esc(s.unit || '') + '</span>' + (s.revenue > 0 ? ' · остаток <span class="num">' + eur(s.net || 0) + '</span>' : '') + '</p></div><div class="btn-row"><button class="btn btn-line btn-sm" data-open-saved="' + esc(x.id) + '">Открыть</button><button class="btn btn-ghost btn-sm" data-del-saved="' + esc(x.id) + '">Удалить</button></div></div>';
    }).join('');
    $$('[data-open-saved]').forEach(function(b){ b.addEventListener('click', function(){ var x = list.filter(function(i){ return i.id === b.getAttribute('data-open-saved'); })[0]; if (!x) return; S = stateFromRecord(x); var nU = applyLibrary(S); if (nU) S.carryNote = nU + ' поз. обновлено по данным «Мои закупочные цены».'; cache[x.type] = S; renderForm(); compute(); saveDraft(); location.hash = 'calcul'; }); });
    $$('[data-del-saved]').forEach(function(b){ b.addEventListener('click', function(e){ if (!armed(e.currentTarget, 'Подтвердить')) return; Store.remove(b.getAttribute('data-del-saved')).then(renderSaved); }); });
  });
}

// ---------- assistant ----------
var A = {sample: null, tools: false, turns: [], ctl: null, last: null};
// début de question et exemple proposés selon le métier choisi
var ASK_START = {fabrication: 'Я изготавливаю продукт и хочу узнать его реальную себестоимость и минимальную цену. ', travaux: 'Мне нужно рассчитать стоимость объекта за m², и я хочу узнать свою минимальную цену. ', services: 'Я хочу узнать свою реальную почасовую ставку и сколько часов мне нужно выставлять клиентам. '};
var ASK_HINT = {fabrication: 'Напр.: 40 банок варенья за одну варку, 2 ч работы, 38 € на фрукты и сахар…', travaux: 'Напр.: черепичная кровля 180 m², бригада из 4 человек, беру 59 € за m²…', services: 'Напр.: бухгалтер-фрилансер, 70 € в час, 40 ч в неделю…'};
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
  PCT_STRICT.forEach(function(k){ if (typeof i[k] === 'number' && i[k] > 0 && i[k] < 1) throw new Error(k + ' = ' + i[k] + ' — проценты указываются числами (25 означает 25 %). Если значение действительно меньше 1 %, попросите пользователя подтвердить его.'); });
  if (i.priceMode === 'TTC' && i.vat === undefined) throw new Error('Цена с НДС без ставки НДС: спросите ставку НДС, включённую в цену.');
  if (type === 'fabrication' && i.materialsTotal === undefined && !(Array.isArray(i.materials) && i.materials.length)) throw new Error('Нет materialsTotal: спросите стоимость материалов на всю партию (0, если материалов нет).');
  if (type === 'travaux'){
    if (i.materialPerM2 === undefined && !(Array.isArray(i.materials) && i.materials.length)) throw new Error('Нет materialPerM2: спросите стоимость материалов на m² (0, если материалы предоставляет клиент).');
    if (i.distanceKm > 0 && i.tripsMode === undefined) throw new Error('distanceKm указан без tripsMode: укажите «daily» (одна поездка туда и обратно в день) или «fixed» вместе с trips.');
  }
  if (type === 'services'){
    if (i.directorNet !== undefined && i.directorMode === undefined) throw new Error('directorNet указан без directorMode: используйте «markup» (взносы в % от чистого) или «fraction» (взносы в % от полной стоимости).');
    if (i.directorAnnualCost === undefined && i.directorNet === undefined) throw new Error('Нет данных о вознаграждении руководителя: спросите его полную годовую стоимость или чистый годовой доход и ставку взносов.');
    if (i.directorMode === undefined && i.directorAnnualCost !== undefined) i.directorMode = 'direct';
  }
}
function r2(n){ return n === null || n === undefined ? null : Math.round(n * 100) / 100; }
var DEFAULTS = {fabrication: ['fixedMonthly','lossPercent','marginPercent','riskPercent','feePercent','taxPercent','targetNet'], travaux: ['fuelLitersPerDay','consumablesPerDay','scaffoldingPerDay','machinePerDay','skipCost','distanceKm','otherCosts','fixedPercent','contingencyPercent','marginPercent','riskPercent','feePercent','taxPercent','targetNet'], services: ['staffAnnual','structureTotal','marginPercent','riskPercent','feePercent','taxPercent','targetNet']};
function compact(type, r, inputs){
  var d = r.details, hasPrice = r.revenue > 0;
  var o = {montants: '€ без НДС', periode: type === 'fabrication' ? 'на партию' : type === 'travaux' ? 'на объект' : 'в год', unite: type === 'fabrication' ? d.unit : type === 'travaux' ? 'm²' : 'час',
    cout_de_revient_par_unite: r2(d.beforeFeesThreshold), prix_plancher_par_unite: r2(r.minimumPrice)};
  if (d.marginPercent > 0) o.prix_conseille_par_unite = r2(r.recommendedPrice);
  if (d.targetNet > 0) o.prix_pour_objectif_par_unite = r2(r.targetPrice);
  o.couts = r.breakdown.filter(function(b){ return ['Риски', 'Комиссии с выручки', 'Налог (оценка)'].indexOf(b.label) < 0 && Math.abs(b.amount) > 0.004; }).map(function(b){ return b.label + ' : ' + r2(b.amount); });
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
      setStatus('Расчётный модуль считает…');
      var r;
      try { r = PNR.calculate(type, inputs); } catch (e){ throw new Error(e && e.message ? e.message : 'С этими данными расчёт невозможен.'); }
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
  var u = type === 'fabrication' ? (UNIT_WORD[r.details.unit] || 'шт') : type === 'travaux' ? 'm²' : 'ч';
  var h = '<p class="eyebrow">Результат расчётного модуля · ' + TYPE_NAME[type] + '</p><ul class="lines">' + L('Минимальная цена', eur(r.minimumPrice) + ' / ' + u, 'strong');
  if (r.details.marginPercent > 0) h += L('Рекомендуемая цена', eur(r.recommendedPrice) + ' / ' + u);
  if (r.details.targetNet > 0) h += L('Цена для вашей цели', eur(r.targetPrice) + ' / ' + u);
  if (r.revenue > 0) h += L('Остаток после налогов', eur(r.net));
  if (type === 'travaux' && r.revenue > 0 && r.details.equilibriumStatus === 'found') h += L('Минимальная выработка', fmt(r.details.displayedEquilibriumYield, 2) + ' m²/чел./дн.');
  h += '</ul><button class="btn btn-hivis btn-sm" type="button">Открыть в полном расчёте</button>';
  div.innerHTML = h;
  div.querySelector('button').addEventListener('click', function(){ openFromInputs(type, inputs); });
  $('#a-thread').appendChild(div); $('#a-thread').scrollTop = 1e9;
}
function openFromInputs(type, inputs){
  var st = freshState(type, true); st.name = 'Расчёт ассистента';
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
  st.carryNote = 'Расчёт открыт из ассистента: проверьте каждую цифру и сохраните.';
  S = st; cache[type] = st; renderForm(); compute(); saveDraft(); location.hash = 'calcul';
}
var ERR_COPY = {not_granted: 'Ассистенту не дали доступ. Расчёты по-прежнему доступны.', sampling_disabled: 'Ассистент недоступен для этого аккаунта.', rate_limited: 'Слишком много вопросов сразу. Попробуйте чуть позже.', session_expired: 'Войдите в Claude заново и попробуйте ещё раз.', refused: 'Ассистент не может ответить на этот запрос. Сформулируйте его иначе.', empty_completion: 'Ответа нет. Сформулируйте вопрос проще.', prompt_too_large: 'Разговор слишком длинный. Перезагрузите страницу, чтобы начать новый.', tools_unavailable: 'Здесь ассистент не может использовать расчётный модуль.'};
function assistantOff(msg){ $('#a-form').hidden = true; $('#a-chips').hidden = true; setStatus(''); $('#a-thread').innerHTML = ''; bubble('sys', msg); }
if (!SITE) cap('sample').then(function(s){
  if (!s){ assistantOff(window.PNR_EDITION === 'test' ? 'Тестовая версия: ИИ-ассистент входит в полную версию. Здесь быстрые тесты, полный расчёт и сравнение ваших расчётов работают без установки.' : 'Ассистент работает, когда эта страница открыта в Claude и вы вошли в свой аккаунт. Тесты и полный расчёт работают везде.'); return; }
  A.sample = s;
  (s.limits ? s.limits() : Promise.reject()).then(function(l){ A.tools = !!(l && l.tools); }, function(){ A.tools = false; }).then(function(){
    if (!A.tools){ assistantOff('Ваше приложение Claude пока не позволяет ассистенту использовать расчётный модуль. Тесты и полный расчёт работают.'); return; }
    bubble('ai', 'Здравствуйте. Скажите, что нужно рассчитать: продукт, объект или вашу почасовую ставку. Я задам вопросы по одному, а считать будет расчётный модуль.');
  });
});
function ask(text){
  if (SITE) return askSite(text);
  if (!A.sample || !A.tools || A.ctl) return;
  text = text.trim(); if (!text) return;
  $('#a-chips').hidden = true;
  bubble('me', text);
  var content = text + (A.last ? '\n\n[Контекст страницы: последний расчёт, отправленный в расчётный модуль (' + A.last.type + ') : ' + JSON.stringify(A.last.inputs) + ']' : '');
  A.turns.push({role: 'user', content: content});
  if (A.turns.length > 30) A.turns = A.turns.slice(-30);
  var out = bubble('ai', 'Думаю…');
  A.ctl = new AbortController();
  $('#a-send').hidden = true; $('#a-stop').hidden = false; setStatus('Ассистент думает. Это может занять до минуты.');
  A.sample([{role: 'user', content: RULES}].concat(A.turns), {tools: toolList(), cache: false, signal: A.ctl.signal, onText: function(u){ out.textContent = u.text; $('#a-thread').scrollTop = 1e9; }})
    .then(function(res){ out.textContent = plainText(res.text); A.turns.push({role: 'assistant', content: res.text}); if (res.truncated) bubble('sys', 'Ответ обрезан: задайте вопрос покороче.'); setStatus(''); })
    .catch(function(e){
      var code = e && e.code;
      if (e && e.text){ out.textContent = e.text; } else out.remove();
      if (code === 'cancelled'){ setStatus('Остановлено.'); A.turns.pop(); return; }
      if (['not_granted','sampling_disabled','not_declared','capability_disabled','capability_removed','tools_unavailable'].indexOf(code) >= 0){ assistantOff(ERR_COPY[code] || 'Здесь ассистент недоступен.'); return; }
      A.turns.pop();
      setStatus(ERR_COPY[code] || 'Ответ прервался. Попробуйте ещё раз.');
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
var SRV_MSG = {quota: 'Вы использовали 2 бесплатных расчёта.', auth: 'Введите код доступа, чтобы пользоваться ассистентом.', limit: 'Месячный лимит использования исчерпан. Счётчик обнуляется 1-го числа каждого месяца.', busy: 'Сейчас к ассистенту очень много обращений. Попробуйте ещё раз чуть позже.', upstream: 'Ассистент сейчас не отвечает. Попробуйте ещё раз чуть позже.', config: 'Ассистент сейчас недоступен.', rate: 'Слишком много попыток. Попробуйте снова через несколько минут.', code: 'Неверный код доступа.'};
function srvMsg(e, d){ return (e && SRV_MSG[e.error]) || d || (e && e.message) || ''; }
function priceLabel(){ return ACC && ACC.price_eur ? eur(ACC.price_eur, 0) + ' в месяц' : (ACC && ACC.price) || ''; }
function quotaMsg(){ var R = (ACC && ACC.ready) || {}; return SRV_MSG.quota + ' ' + (R.pay ? 'Продолжить можно по подписке: ' + priceLabel() + ', без обязательств.' : 'Подписка за ' + priceLabel() + ' откроется совсем скоро. Есть код доступа? Введите его ниже.'); }
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
  if (ACC && ACC.visiteur){ el.hidden = false; el.innerHTML = '<b>Бесплатные расчёты без регистрации: ' + ACC.cases_left + ' / ' + ACC.cases_max + '</b>'; return; }
  if (!ACC || !(ACC.email || ACC.nom)){ el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = 'Вы вошли: ' + esc(ACC.email || ACC.nom) +(ACC.free && ACC.active ? ' · бесплатный доступ' : '') + (ACC.active && ACC.limit ? ' · ' + ACC.used + ' / ' + ACC.limit + ' вопросов в этом месяце' : '') +
    (ACC.free ? '' : ' · <button class="linkbtn" type="button" data-acc="portal">Управлять подпиской</button>') + ' · <button class="linkbtn" type="button" data-acc="logout">Выйти</button>';
}
// site sans clé IA : l'assistant est annoncé, le reste du site marche normalement
function soon(){ A.ready = false; $('#a-pay').hidden = true; $('#a-form').hidden = true; $('#a-chips').hidden = true; $('#a-thread').innerHTML = ''; bubble('sys', 'ИИ-ассистент скоро появится. А пока полный расчёт, PDF и сравнение ваших расчётов — бесплатно.'); $('#a-note').textContent = 'ИИ-ассистент будет доступен по ежемесячной подписке.'; }
function siteStart(){
  var q = new URLSearchParams(location.search);
  if (q.get('bienvenue')) toast('Подписка активирована. Задайте первый вопрос.');
  else if (q.get('connecte')) toast('Вы вошли в систему.');
  else if (q.get('lien') === 'expire') toast('Ссылка устарела или уже использована: запросите новую.');
  else if (q.get('paiement') === 'erreur') toast('Не удалось подтвердить оплату. Если деньги списаны, запросите ссылку для входа на свой e-mail.');
  var had = false; ['bienvenue','connecte','lien','paiement'].forEach(function(k){ if (q.has(k)){ q.delete(k); had = true; } });
  if (had) try { history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q.toString() : '') + location.hash); } catch(e){}
  $('#a-form').hidden = true; $('#a-chips').hidden = true;
  api('/api/me').then(function(m){
    ACC = m;
    var R = m.ready || {ai: true, pay: true, email: true};
    if (priceLabel()) $('#a-price').textContent = priceLabel();
    if (m.visiteur) $('#a-note').textContent = 'Ваши вопросы обрабатывает Claude (Anthropic). Сохранённые расчёты остаются в вашем браузере.';
    else if (m.limit) $('#a-note').textContent = (R.pay ? 'Входит в подписку' : 'Доступ по приглашению') + ' — до ' + m.limit + ' вопросов в месяц. Ваши вопросы обрабатывает Claude (Anthropic). Сохранённые расчёты остаются в вашем браузере.';
    else if (R.code && !R.pay) $('#a-note').textContent = 'На время теста ассистент доступен только приглашённым. Ваши вопросы обрабатывает Claude (Anthropic).';
    accountLine();
    $('#a-sub').hidden = !R.pay; $('#a-login').hidden = !R.email; $('#a-code').hidden = !R.code; $('#a-terms').hidden = !R.pay;
    if (!R.pay) $('#a-pay-kicker').textContent = m.visiteur ? 'Abonnement' : 'Закрытый тест';
    if (!m.active && (!R.ai || (!R.pay && !R.email && !R.code))){ soon(); return; }
    if (m.active){
      $('#a-pay').hidden = true; $('#a-thread').hidden = false; $('#a-form').hidden = false; $('#a-chips').hidden = false; A.ready = true;
      bubble('ai', 'Здравствуйте. Скажите, что нужно рассчитать: продукт, объект или вашу почасовую ставку. Я задам вопросы по одному, а считать будет расчётный модуль.');
      if (metierQ && ASK_HINT[metierQ]) prepAsk(metierQ, false);
    } else if (m.visiteur) showPay(quotaMsg());
    else if (!R.pay) showPay(R.code ? 'Ассистент проходит закрытый тест по приглашениям. Чтобы им пользоваться, введите код доступа.' : 'Ассистент проходит закрытый тест. Если ваш адрес приглашён, получите ссылку для входа по e-mail.');
    else if (m.email) showPay('Ваша подписка больше не активна. Оформите её снова, чтобы вернуться к ассистенту.');
    else showPay('Опишите свой объект, продукт или заказ своими словами: ассистент задаст нужные вопросы, а расчётный модуль посчитает вашу реальную цену.');
  }, function(){ showPay('Сервер сейчас не отвечает. Тесты и полный расчёт всё равно работают.'); });
}
if (SITE){
  siteStart();
  $('#a-sub').addEventListener('click', function(){
    var b = this, em = ($('#a-email').value || '').trim();
    b.disabled = true;
    api('/api/checkout', em ? {email: em} : {}).then(function(r){ if (r.url) location.href = r.url; else { b.disabled = false; toast(r.message || 'Оплата сейчас недоступна.'); } }, function(){ b.disabled = false; toast('Не удалось войти. Попробуйте ещё раз.'); });
  });
  $('#a-login').addEventListener('submit', function(e){
    e.preventDefault();
    var em = $('#a-email').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)){ toast('Некорректный адрес e-mail.'); return; }
    api('/api/login', {email: em}).then(function(r){ toast(r.message || 'Если на этот адрес оформлена подписка, ссылка уже отправлена.'); }, function(){ toast('Не удалось войти. Попробуйте ещё раз.'); });
  });
  $('#a-code').addEventListener('submit', function(e){
    e.preventDefault();
    var b = this.querySelector('button'), c = $('#a-code-in').value.trim();
    if (c.replace(/[^0-9A-Za-z]/g, '').length < 8){ toast('Неверный код доступа.'); return; }
    b.disabled = true;
    api('/api/code', {code: c}).then(function(r){
      b.disabled = false;
      if (!r.ok){ toast(srvMsg(r, 'Неверный код доступа.')); return; }
      if (r.jeton) lsSet('pnr-session', r.jeton);
      $('#a-code-in').value = ''; $('#a-thread').innerHTML = ''; toast('Доступ открыт. Задайте первый вопрос.'); siteStart();
    }, function(){ b.disabled = false; toast('Не удалось войти. Попробуйте ещё раз.'); });
  });
  $('#a-account').addEventListener('click', function(e){
    var b = e.target.closest('[data-acc]'); if (!b) return;
    if (b.dataset.acc === 'logout') api('/api/logout', {}).then(function(){ lsSet('pnr-session', null); location.reload(); }, function(){ lsSet('pnr-session', null); location.reload(); });
    else api('/api/portal', {}).then(function(r){ if (r.url) location.href = r.url; else toast(r.message || 'Личный кабинет подписки недоступен.'); });
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
  if (text.length > 3000){ toast('Слишком длинный вопрос: не больше 3 000 символов.'); return; }
  $('#a-chips').hidden = true;
  bubble('me', text);
  var before = A.turns.slice();
  A.turns.push({role: 'user', content: text + (A.last ? '\n\n[Контекст страницы: последний расчёт, отправленный в расчётный модуль (' + A.last.type + ') : ' + JSON.stringify(A.last.inputs) + ']' : '')});
  trimTurns();
  var out = bubble('ai', 'Думаю…'), rounds = 0;
  A.ctl = new AbortController();
  $('#a-send').hidden = true; $('#a-stop').hidden = false; setStatus('Ассистент думает. Это может занять до минуты.');
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
        bubble('sys', 'Расчёт не удался. Переформулируйте вопрос и укажите свои цифры.'); setStatus(''); return;
      }
      if (hasTool && rounds++ < 5){
        var results = r.content.filter(function(b){ return b.type === 'tool_use'; }).map(function(b){
          var t = toolByName(b.name);
          try { if (!t) throw new Error('Неизвестный инструмент: ' + b.name); return {type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(t.execute(b.input || {}))}; }
          catch(e){ return {type: 'tool_result', tool_use_id: b.id, content: String(e && e.message || e), is_error: true}; }
        });
        A.turns.push({role: 'user', content: results});
        if (!out) out = bubble('ai', 'Думаю…');
        return step();
      }
      if (out){ out.remove(); out = null; }
      if (r.stop_reason === 'max_tokens') bubble('sys', 'Ответ обрезан: задайте вопрос покороче.');
      if (ACC && ACC.visiteur && ACC.cases_left === 0 && !A.lastFree){ A.lastFree = true; bubble('sys', 'Это был ваш последний бесплатный расчёт: его ещё можно уточнить здесь. Для нового расчёта понадобится подписка.'); }
      setStatus('');
    });
  }
  step().catch(function(e){
    if (out) out.remove();
    A.turns = before;
    if (e && e.name === 'AbortError'){ setStatus('Остановлено.'); return; }
    if (e && e.error === 'quota'){ setStatus(''); if (ACC){ ACC.cases_left = 0; ACC.active = false; accountLine(); } showPay(quotaMsg()); return; }
    if (e && (e.error === 'auth' || e.error === 'inactive')){ if (e.error === 'auth') lsSet('pnr-session', null); setStatus(''); showPay(srvMsg(e)); return; }
    if (e && e.error === 'bad_request'){ A.turns = []; A.last = null; bubble('sys', 'Новый разговор: предыдущий был слишком длинным. Задайте вопрос ещё раз.'); setStatus(''); return; }
    setStatus(srvMsg(e, 'Ответ прервался. Попробуйте ещё раз.'));
  }).then(function(){ A.ctl = null; $('#a-send').hidden = false; $('#a-stop').hidden = true; $('#a-new').hidden = !A.turns.length || !A.ready; });
}
// nouveau calcul : nouvelle conversation (pour un visiteur, c'est un nouveau calcul offert)
$('#a-new').addEventListener('click', function(){
  if (A.ctl) return;
  A.turns = []; A.last = null; A.lastFree = false; $('#a-thread').innerHTML = ''; this.hidden = true;
  bubble('ai', 'Здравствуйте. Скажите, что нужно рассчитать: продукт, объект или вашу почасовую ставку. Я задам вопросы по одному, а считать будет расчётный модуль.');
  $('#a-chips').hidden = false; focusChat();
});
$('#a-form').addEventListener('submit', function(e){ e.preventDefault(); var t = $('#a-input').value; $('#a-input').value = ''; ask(t); });
$('#a-input').addEventListener('keydown', function(e){ if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); var t = $('#a-input').value; $('#a-input').value = ''; ask(t); } });
$('#a-stop').addEventListener('click', function(){ if (A.ctl) A.ctl.abort(); });
$$('#a-chips .chip').forEach(function(c){ c.addEventListener('click', function(){ ask(c.textContent); }); });

// ---------- guides ----------
$('#g-list').innerHTML = GUIDES.map(function(g){
  return '<details class="guide"><summary><small>' + esc(g.cat) + '</small><b>' + esc(g.h1) + '</b></summary><div class="body"><p><b>' + esc(g.answer) + '</b></p>' +
    (g.formula ? '<h4>' + esc(g.formulaTitle || 'Формула') + '</h4><div class="formula">' + g.formula.map(esc).join('<br>') + '</div>' : '') +
    '<h4>Пример с цифрами</h4><p>' + esc(g.example) + '</p>' + (g.extra ? '<p class="mute">' + esc(g.extra) + '</p>' : '') +
    (g.errors ? '<h4>Дорогие ошибки</h4><ol>' + g.errors.map(function(e){ return '<li>' + esc(e) + '</li>'; }).join('') + '</ol>' : '') +
    (g.faq ? g.faq.map(function(f){ return '<h4>' + esc(f[0]) + '</h4><p>' + esc(f[1]) + '</p>'; }).join('') : '') +
    '<div class="btn-row"><a class="btn btn-hivis btn-sm" href="#accueil" data-ask="' + g.type + '">Сделать свой расчёт</a></div></div></details>';
}).join('');

// ---------- exposé pour les tests automatiques ----------
window.__PNR_TEST = {coerce: coerce, guard: guard, compact: compact, openFromInputs: openFromInputs, buildInputs: buildInputs, state: function(){ return S; }, trim: function(t){ A.turns = t; trimTurns(); return A.turns; }};

// ---------- démarrage ----------
renderForm(); compute();
if (metierQ && CFG[metierQ]) setType(metierQ);
show(location.hash.slice(1) || 'accueil');
})();
