// Prix Net Réel — moteur de calcul (port fidèle de pricing.ts + construction.ts)
var PNR = (function(){
  function PnrError(msg, field){ this.message = msg; this.field = field; }
  var DISCLAIMER = "Herramienta de simulación y gestión. Estimaciones basadas en tus datos, sin asesoramiento fiscal, contable, jurídico ni financiero. Comprueba tus obligaciones con un profesional.";
  function invalid(field){ throw new PnrError("Valor no válido: " + field + ". Introduce un número positivo o cero, dentro de los límites indicados.", field); }
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
    if (risk + fee >= 1) invalid("riesgos + gastos (deben ser inferiores al 100 %)");
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
      breakdown: breakdown.concat([{label:"Riesgos", amount: riskCost},{label:"Gastos sobre facturación", amount: feeCost},{label:"Impuesto estimado", amount: tax}]),
      details: d,
      warnings: (warnings || []).concat([DISCLAIMER, "El IVA es una hipótesis modificable; no es un ingreso. La fiscalidad real depende de tu situación."])
    };
    ["revenue","cost","margin","net","riskCost","feeCost","tax","targetRevenue","minimumRevenue","recommendedPrice","currentPrice","minimumPrice","targetPrice"].forEach(function(k){ if (!isFinite(r[k])) invalid("resultado fuera de límites"); });
    if (r.net < 0) r.warnings.unshift("El precio actual produce una pérdida con los supuestos introducidos.");
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
      [{label:"Materias primas con mermas", amount: material},{label:"Tiempo y costes fijos repartidos", amount: labor}],
      {quantity: quantity, hourly: hourly, materialBase: materialBase, material: material, labor: labor, costPerUnit: cost/quantity, unit: i.unit || "pièce", targetScope: i.targetScope || "lot"},
      ["El coste horario incluye la mano de obra y los costes fijos repartidos; estos costes no se descuentan una segunda vez."]);
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
      [{label:"Remuneración del gerente con cargas", amount: director},{label:"Personal con cargas", amount: staff},{label:"Estructura", amount: structure}],
      {hours: hours, capacityHours: hours, paidHours: persons*weeks*weeklyHours, director: director, directorMode: mode, staff: staff, structure: structure, thresholdRate: cost/hours},
      ["La remuneración del gerente ya está incluida en los costes. El objetivo neto es adicional.",
       "La base de cargas sociales del gerente es una hipótesis de gestión, no un cálculo fiscal exacto. El tiempo no facturado reduce la capacidad."]);
    r.details.requiredHours = rate > 0 ? r.targetRevenue / rate : null;
    r.details.netPerHour = r.net / hours;
    r.details.impossible = rate === 0 || r.targetRevenue / rate > hours;
    if (r.details.impossible) r.warnings.unshift("Objetivo imposible con la tarifa actual dentro de la capacidad disponible.");
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
      [{label:"Mano de obra", amount: c.labor},{label:"Materiales con recortes", amount: material},{label:"Gastos de obra y financiación", amount: c.expenses},{label:"Gastos generales", amount: c.fixed},{label:"Imprevistos sobre el coste", amount: c.contingency}],
      {surface: surface, persons: persons, capacityPerDay: c.capacity, duration: c.duration, days: c.days, paidDuration: c.paidDuration, laborHours: persons*hoursPerDay*c.paidDuration, labor: c.labor, material: material, expenses: c.expenses, travel: c.travel, tripsMode: tripsMode, direct: c.direct, fixed: c.fixed, contingency: c.contingency, costPerM2: c.cost/surface, retentionAmount: price*surface*retention},
      ["Los gastos diarios usan los días redondeados; la mano de obra usa el tiempo real, salvo con la opción de jornadas completas.",
       "Las retenciones recuperables son un desfase de tesorería, no una pérdida. El coste de financiación debe introducirse por separado.",
       "Vigila el rendimiento; el precio objetivo depende de la capacidad y de los datos de la obra."]);
    r.details.netPerM2 = r.net / surface;
    Object.assign(r.details, chantierEquilibrium(p, r.revenue, percent(i,"riskPercent"), percent(i,"feePercent"), yieldPerDay, percent(i,"taxPercent")));
    return r;
  }
  function calculate(type, i){
    if (type === "fabrication") return fabrication(i);
    if (type === "services") return services(i);
    if (type === "travaux") return travaux(i);
    throw new PnrError("Recorrido desconocido.");
  }
  return {calculate: calculate, PnrError: PnrError, DISCLAIMER: DISCLAIMER};
})();


var GUIDES = [
  {cat: 'Fabricación', type: 'fabrication', h1: 'Calcula tu coste de producción, pieza a pieza',
   answer: 'Tu coste de producción es todo lo que te cuesta una pieza antes de ganar el primer euro: las materias primas con sus mermas, tu tiempo pagado a su coste real y tus costes fijos repartidos. Por debajo de ese precio, pagas por trabajar.',
   formula: ['Coste horario real = tu coste horario (salario + cargas) + costes fijos del mes ÷ horas productivas del mes', 'Coste de producción por pieza = (materias primas × (1 + mermas) + minutos ÷ 60 × coste horario real) ÷ número de piezas', 'Precio mínimo = coste de producción ÷ (1 − riesgos − gastos)', 'Precio recomendado sin IVA = coste de producción ÷ (1 − margen deseado sobre el precio de venta)'],
   example: 'Hornada de 20 panes (ejemplo simplificado). Harina 6 kg, con un 3 % de mermas incluido = 4,57 € sin IVA. Tiempo 90 min a 29,50 €/h con cargas incluidas = 44,25 €. Coste: 48,82 € sin IVA, es decir, 2,44 € sin IVA por pan. Con un 35 % de margen: 3,76 € sin IVA. Aquí la harina pesa menos del 10 % del coste: lo que hace el precio es el tiempo.',
   errors: ['No contar el propio tiempo, o contarlo sin las cargas.', 'Contar las materias primas sin las mermas (recortes, piezas fallidas, producto no vendido).', 'Confundir los dos márgenes: coste × 1,35 da un 35 % de margen sobre el coste, pero solo un 25,9 % del precio de venta. Para quedarte con el 35 % del precio de venta (el margen comercial), divide el coste entre 0,65.'],
   faq: [['¿El IVA forma parte del coste de producción?', 'Si lo recuperas en tus compras, no: cuenta tus materias primas sin IVA. Si no (régimen de franquicia, por ejemplo), es un coste: cuenta con IVA incluido. Tu asesor te dirá cuál es tu caso.']]},
  {cat: 'Fabricación', type: 'fabrication', h1: 'Tu coste de producción por kilo (o por litro)',
   answer: 'Calcula el coste completo de tu lote y divídelo entre el peso o el volumen realmente vendible. Obtienes tu coste de producción por kilo; añade tus riesgos y gastos y tendrás tu precio mínimo.',
   formula: ['Coste de producción por kilo = coste del lote ÷ kilos vendibles producidos', 'Precio mínimo por kilo = coste de producción por kilo ÷ (1 − riesgos − gastos)', 'Precio recomendado por kilo sin IVA = coste de producción por kilo ÷ (1 − margen deseado)'],
   example: '20 panes de 700 g = 14 kg. Coste del lote 48,82 € sin IVA: 3,49 € sin IVA de coste de producción por kilo. Con un 2 % de riesgos y un 1,2 % de gastos, el precio mínimo es de 3,60 € sin IVA el kilo. Con un 35 % de margen: 5,37 € sin IVA el kilo.',
   errors: ['Dividir entre el peso de la masa o de la cuba, en lugar del peso o el volumen acabado y vendible.', 'Olvidar las mermas de envasado (fondos de cuba, frascos fallidos, envases dañados).', 'Vender por kilo y por pieza sin comprobar que los dos precios dan el mismo margen.'],
   faq: [['¿Y en litros, igual?', 'Sí: sustituye los kilos por los litros realmente embotellados o envasados. En el cálculo completo, elige la unidad «kg» o «litro» y pon como cantidad los kilos o litros producidos.']]},
  {cat: 'Fabricación', type: 'fabrication', h1: '¿Cuánto te cuesta realmente un pan?',
   answer: 'En nuestro ejemplo, una hogaza de 700 g cuesta 2,44 € sin IVA de producir, es decir, 3,49 € sin IVA el kilo. La cifra que cuenta es la tuya: depende de tu receta, de tu tiempo y de tus costes.',
   example: '20 panes de 700 g = 14 kg. Harina 6 kg + 3 % de merma = 4,57 € sin IVA. 90 min (preparación, horneado vigilado, acabado, limpieza, embalaje) a 29,50 €/h = 44,25 €. Coste 48,82 € sin IVA → 2,44 € sin IVA por pan → 3,49 € sin IVA el kilo. Con un 35 % de margen: 3,76 € sin IVA el pan. Vendido a 3,72 € sin IVA, el margen baja al 34,4 %: 3,6 céntimos menos por pan que el objetivo, 0,71 € por hornada.',
   extra: 'Añade a tu cálculo: masa madre o levadura, sal, agua, energía del horno, embalaje, producto no vendido.',
   faq: [['¿Qué tipo de IVA?', 'El del pan en tu país, a menudo reducido para la alimentación pero variable: tu asesor te lo confirmará.']]},
  {cat: 'Obras', type: 'travaux', h1: 'Tu precio por m², calculado con tu rendimiento real',
   answer: 'Tu precio por m² es el coste completo de la obra dividido entre la superficie, más tu margen. Todo parte de una cifra que solo tú conoces: cuántos m² coloca tu equipo por operario y día.',
   formula: ['Duración = superficie ÷ (rendimiento × número de operarios)', 'Mano de obra = coste diario del equipo × duración', 'Gastos diarios (andamio, maquinaria, consumibles, desplazamientos) = coste por día × días redondeados al alza', 'Coste de producción = (mano de obra + materiales + gastos de obra) + gastos generales + imprevistos', 'Precio por m² sin IVA = coste de producción ÷ superficie ÷ (1 − margen deseado)'],
   example: 'Tejado de teja mecánica de 180 m², equipo de 4, rendimiento de 22 m²/operario/día → 48,70 €/m² sin IVA de coste de producción, 59,38 €/m² sin IVA con un 18 % de margen.',
   errors: ['Copiar el precio por m² de un competidor: no tiene ni tu equipo, ni tu rendimiento, ni tus gastos.', 'Calcular los gastos por día sobre la duración exacta: 2,05 días de obra son 3 días de andamio y 3 viajes de ida y vuelta.', 'Contar la retención de garantía como una pérdida: la recuperas en la recepción de la obra, es un desfase de tesorería.'],
   faq: [['¿Y si no conozco mi rendimiento?', 'Mídelo en tus tres últimas obras: m² realizados ÷ (operarios × días). Es la cifra más rentable que puedes conocer.']]},
  {cat: 'Obras', type: 'travaux', h1: 'Precio por m² de una cubierta de tejas: el cálculo completo',
   answer: 'En este ejemplo, la cubierta sale a 48,70 € sin IVA el m² y se vende a 59,38 € sin IVA el m² con un 18 % de margen. Por debajo de 48,70 €, la obra te cuesta dinero.',
   example: '180 m². Equipo: 1 jefe de equipo (42 €/h), 2 oficiales (36 €/h), 1 peón (26 €/h), 8 h al día. Rendimiento 22 m²/operario/día → 88 m²/día → 2,05 días, 3 días contados para los gastos. Mano de obra 2290,91 €. Materiales 4387,86 € (teja 17,55 €/m² + 8 % de recortes, rastrel 3,04 €/m² + 10 %, lámina bajo teja 1,98 €/m² + 5 %). Gastos de obra 635,30 € (gasóleo 12 L/día a 1,65 €, consumibles 15 €/día, andamio 45 €/día, contenedor 320 €, 3 viajes de ida y vuelta de 46 km a 0,55 €/km). Gastos generales 12 %, imprevistos 7 % → 8765,18 € sin IVA, es decir, 48,70 €/m² sin IVA. Con un 18 % de margen: 59,38 €/m² sin IVA. Rendimiento mínimo (sin riesgos ni gastos sobre el precio): 13,30 m²/operario/día.',
   faq: [['¿Por qué el rendimiento mínimo está tan lejos de 22?', 'Porque los materiales no cambian cuando el equipo va más lento: solo aumentan la mano de obra y los gastos por día.']]},
  {cat: 'Obras', type: 'travaux', h1: 'El rendimiento que hace (o deshace) tu margen',
   answer: 'El rendimiento es el número de m² que un operario realiza al día. Cada obra tiene un rendimiento mínimo: por debajo, tu precio ya no cubre tus costes.',
   formulaTitle: 'Cómo se calcula',
   formula: ['Se recalcula el coste completo de la obra para cada rendimiento posible (mano de obra, días de andamio, desplazamientos),', 'y se busca el primer rendimiento en el que el coste queda por debajo de tu precio.', 'Nada de regla de tres: los materiales no dependen del rendimiento.'],
   example: 'Tejado de 180 m² a 59,38 €/m² sin IVA, rendimiento previsto 22. Rendimiento mínimo 13,30 (sin riesgos ni gastos sobre el precio). Tu equipo puede ir alrededor de un 40 % más lento antes de perder dinero.',
   errors: ['Presupuestar con el rendimiento de un buen día, en una obra fácil.', 'Olvidar los tiempos muertos: montaje, recogida, mal tiempo, espera de entregas.', 'No medir nunca el rendimiento real después de la obra.']},
  {cat: 'Servicios', type: 'services', h1: 'Tu tarifa por hora mínima, y la que debes facturar',
   answer: 'Tu coste horario real es el total de tus costes anuales, incluida tu propia remuneración, dividido entre las horas que realmente facturas. No entre las horas que trabajas. Añade tus impagos y gastos: tienes tu tarifa mínima.',
   formula: ['Horas facturables = personas × semanas × horas por semana × parte realmente facturada', 'Coste horario real = costes anuales totales ÷ horas facturables', 'Tarifa mínima = coste horario real ÷ (1 − impagos − gastos)', 'Tarifa recomendada sin IVA = coste horario real ÷ (1 − margen deseado)'],
   example: '2 personas, 44 semanas, 40 h, 62 % facturado → 2182 h facturables. Costes 144.100 € (gerente 69.600 € con cargas, empleada 38.000 €, estructura 36.500 €). Coste horario real 66,03 € sin IVA. Con un 2 % de impagos y un 1 % de gastos, tarifa mínima de 68,07 €/h sin IVA. Con un 20 % de margen: 82,54 €/h sin IVA.',
   errors: ['Dividir entre todas las horas trabajadas: la administración, la prospección y las vacaciones no las pagan los clientes.', 'Olvidar la propia remuneración en los costes.', 'Confundir lo que te cuesta tu remuneración con lo que cobras en neto.'],
   faq: [['¿Qué porcentaje de cargas sociales se aplica a mi remuneración?', 'El de tu régimen y tu país: pregúntaselo a tu asesor o a tu organismo de previsión social. La herramienta no se lo inventa.']]},
  {cat: 'Servicios', type: 'services', h1: 'Tarifa por hora de un despacho contable: el ejemplo completo',
   answer: 'En este ejemplo, cada hora facturada le cuesta al despacho 66,03 € sin IVA, y 68,07 € con sus impagos y sus gastos. Factura a 75 €: gana dinero, pero menos de lo que cree.',
   example: 'A 75 €/h sin IVA: facturación de 163.680 €. Tras los costes: 19.580 €. Tras un 2 % de impagos y un 1 % de gastos: 14.669,60 €. Tras un 25 % de impuestos: 11.002,20 € de beneficio, además de las remuneraciones. Encargo «cierre anual»: 30 h a la tarifa recomendada de 82,54 €/h (redondeada) = 2476 € sin IVA + 66 € de desplazamiento. Un precio cerrado de 2200 € sin IVA da 71,13 €/h: por encima del mínimo de 68,07 €, por debajo del objetivo. Para 30.000 € más de beneficio al año: 86,97 €/h sin IVA. A 75 €/h harían falta 2531 h facturadas; el despacho solo tiene 2182.'},
  {cat: 'Servicios', type: 'services', h1: '¿Cuántas de tus horas se pagan realmente?',
   answer: 'Una parte de tu tiempo no te la paga nadie: administración, prospección, presupuestos, formación. Tu tarifa por hora también tiene que financiar esas horas.',
   example: '2 personas × 44 semanas × 40 h = 3520 h pagadas. 62 % facturadas = 2182 h. 1338 h al año no las paga ningún cliente. A 75 €/h, hay que facturar 1981 h para cubrir costes, impagos y gastos, es decir, el 56,3 % del tiempo: el margen de seguridad es de solo 5,7 puntos.',
   errors: ['Suponer un 100 % de tiempo facturable.', 'No controlar las horas: sin medirlas, el porcentaje facturado es solo una impresión.', 'Bajar la tarifa para llenar la agenda, cuando el problema es el tiempo no facturado.']}
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
function fmt(n, d){ if (d === undefined) d = 2; return Number(n).toLocaleString('es-ES', {minimumFractionDigits: d, maximumFractionDigits: d}); }
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
  var c = [['Precio de venta de la hornada', 75.20, 'hsl(218 30% 55%)', 0], ['Materias primas (harina + mermas)', 4.57, 'hsl(214 16% 62%)', 0], ['Tu tiempo, cargas incluidas', 44.25, 'hsl(214 16% 62%)', 0], ['Lo que crees que ganas', 26.38, 'var(--hivis)', 0], ['Riesgos, gastos e impuestos', 8.40, 'var(--loss)', 0], ['Lo que realmente te queda', 17.98, 'var(--ok)', 1]];
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
  var stop = '<p class="err">Rellena cada casilla con un número positivo.</p>';
  var cta = function(q){ return '<button class="btn btn-hivis" type="button" data-carry="' + q + '">Seguir en el cálculo completo con estas cifras</button>'; };
  Q.taux = function(){
    var ch = val('ta-ch'), h = val('ta-h'), s = val('ta-s'), p = val('ta-p');
    if (!okAll([ch, h, s, p]) || h * s * p === 0 || p > 100 || s > 53 || h > 100) return stop;
    var paid = h * s, billed = paid * p / 100, rate = ch / billed;
    return '<p class="eyebrow">Cada hora facturada te cuesta</p><p class="big">' + eur(rate) + '<small>sin IVA / hora</small></p><ul class="lines">' +
      line('Horas trabajadas al año', fmt(paid, 0) + ' h') + line('Horas facturadas al año', fmt(billed, 0) + ' h') + line('Horas que no paga ningún cliente', fmt(paid - billed, 0) + ' h') +
      '</ul>' + (ch > 0 ? '<p class="verdict">Por debajo de esta tarifa, no cubres tus costes ni tu remuneración.</p>' : '') +
      '<p class="limit">Esta prueba no tiene en cuenta los impagos, los gastos de cobro ni los impuestos. El cálculo completo sí.</p>' + cta('taux');
  };
  Q.vehic = function(){
    var n = val('ve-n'), km = val('ve-km'), c = val('ve-c'), p = val('ve-p'), a = val('ve-a'), e = val('ve-e'), l = val('ve-l');
    if (!okAll([n, km, c, p, a, e, l]) || n === 0 || km === 0) return stop;
    var fuel = km * c / 100 * p, per = fuel + a + e + l, tot = per * n, perkm = per / km;
    return '<p class="eyebrow">Tus vehículos te cuestan</p><p class="big">' + eur(tot, 0) + '<small>al año</small></p><ul class="lines">' +
      line('Por vehículo', eur(per, 0) + ' / año') + line('Por kilómetro', eur(perkm, 3)) + line('De ello, combustible', fmt(fuel / per * 100, 1) + ' %') +
      '</ul><p class="verdict">Cada kilómetro que no facturas te cuesta ' + eur(perkm) + '.</p><p class="limit">Este coste por kilómetro puede servir como «coste por km» en el cálculo de una obra.</p>' + cta('vehic');
  };
  Q.prod = function(){
    var pv = val('pr-pv'), m = val('pr-m'), mn = val('pr-min'), h = val('pr-h');
    if (!okAll([pv, m, mn, h]) || pv === 0) return stop;
    var cost = m + mn / 60 * h, mg = pv - cost;
    return '<p class="eyebrow">Tu margen sobre materias primas y tiempo</p><p class="big">' + eur(mg) + '<small>' + fmt(mg / pv * 100, 1) + ' % del precio</small></p><ul class="lines">' +
      line('Materias primas y tiempo por pieza', eur(cost)) + line('De ello, materias primas', eur(m)) + line('De ello, tu tiempo', eur(mn / 60 * h)) +
      '</ul>' + (mg < 0 ? '<p class="verdict">Vendes por debajo de lo que te cuestan tus materias primas y tu tiempo: ' + eur(-mg) + ' de pérdida por pieza.</p>' : '<p class="verdict good">Te quedan ' + eur(mg) + ' por pieza para pagar alquiler, energía, impagos e impuestos.</p>') +
      '<p class="limit">Esta prueba no tiene en cuenta tus costes fijos (alquiler, energía), las mermas, los riesgos ni los impuestos. El cálculo completo sí.</p>' + cta('prod');
  };
  Q.m2 = function(){
    var mat = val('m2-mat'), eq = val('m2-eq'), r = val('m2-r'), f = val('m2-f');
    if (!okAll([mat, eq, r, f]) || r === 0) return stop;
    var floor = mat + (eq + f) / r;
    var isEx = mat === 24.38 && eq === 1120 && r === 88 && f === 105;
    return '<p class="eyebrow">Tu coste directo por m²</p><p class="big">' + eur(floor) + '<small>sin IVA / m²</small></p><ul class="lines">' +
      line('Materiales', eur(mat) + ' / m²') + line('Equipo y gastos del día', eur((eq + f) / r) + ' / m²') +
      '</ul><p class="verdict">Por debajo de este precio, pierdes dinero seguro. Tu verdadero mínimo es más alto.</p>' +
      (isEx ? '<p class="gap">Para este ejemplo, el cálculo completo da un coste de producción de <b>48,70 €/m² sin IVA</b>. La prueba olvida <b>10,40 €/m²</b>, es decir, <b>1872&nbsp;€</b> en 180 m²: gastos generales, imprevistos, días completos de andamio, contenedor.</p>' : '') +
      '<p class="limit">Esta prueba no tiene en cuenta los gastos generales, los imprevistos, los días completos, el contenedor, los riesgos ni los impuestos. El cálculo completo sí.</p>' + cta('m2');
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
    st = freshState('services', true); st.name = 'Mi tarifa por hora';
    st.v.persons = '1'; st.v.weeklyHours = qv('ta-h'); st.v.weeks = qv('ta-s'); st.v.billablePercent = qv('ta-p');
    st.v.directorMode = 'direct'; st.v.directorAnnualCost = '0'; st.v.staffAnnual = '0'; st.v.structureTotal = qv('ta-ch');
    st.carryNote = 'Datos tomados de la prueba: tus costes anuales están en «Gastos de estructura», remuneración incluida. Puedes detallar tu remuneración aparte. Falta tu tarifa actual.';
  } else if (q === 'prod'){
    st = freshState('fabrication', true); st.name = 'Mi producto';
    st.v.quantity = '1'; st.v.price = qv('pr-pv'); st.v.materialsTotal = qv('pr-m'); st.v.minutes = qv('pr-min'); st.v.laborHourly = qv('pr-h');
    st.carryNote = 'Datos tomados de la prueba, para una pieza. Añade tus costes fijos, mermas, riesgos e impuestos en las secciones plegadas.';
  } else if (q === 'm2'){
    st = freshState('travaux', true); st.name = 'Mi obra';
    var eq = parseNum(qv('m2-eq'));
    st.v.materialPerM2 = qv('m2-mat'); st.v.hoursPerDay = '8'; st.v.yieldPerDay = qv('m2-r'); st.v.pricePerM2 = '0'; st.v.consumablesPerDay = qv('m2-f');
    st.lists.team = [{name: 'Equipo (coste global)', count: '1', hourlyCost: eq >= 0 ? toStr(eq / 8) : ''}];
    st.carryNote = 'Datos tomados de la prueba: tu equipo cuenta como una sola línea (coste del día ÷ 8 h) y su rendimiento es el de todo el equipo. Tus gastos del día están en «Consumibles». Falta la superficie; pon tu precio por m² si tienes uno. El cálculo completo cuenta los gastos por jornada completa: puede salir algo más alto que la prueba.';
  } else if (q === 'vehic'){
    st = freshState('travaux'); st.name = 'Obra con mi coste por km (ejemplo)';
    var km = parseNum(qv('ve-km')), c = parseNum(qv('ve-c')), p = parseNum(qv('ve-p')), a = parseNum(qv('ve-a')), e = parseNum(qv('ve-e')), l = parseNum(qv('ve-l'));
    var per = km * c / 100 * p + a + e + l;
    st.v.costPerKm = km > 0 && isFinite(per) ? toStr(Math.round(per / km * 1000) / 1000) : st.v.costPerKm;
    st.carryNote = 'Tu coste por kilómetro (' + st.v.costPerKm + ' €/km) se ha puesto en el ejemplo de obra. Sustituye el resto por tus cifras.';
  } else return;
  S = st; cache[st.type] = st; renderForm(); compute(); saveDraft(); location.hash = 'calcul';
}

// ---------- calcul complet : configuration ----------
var LABELS = {quantity:'Cantidad producida', unit:'Unidad de venta', price:'Precio de venta unitario', priceMode:'Tu precio es', vat:'IVA incluido en tu precio', minutes:'Tiempo total del lote', laborHourly:'Coste horario de tu mano de obra', materialsTotal:'Materias primas, total del lote', fixedMonthly:'Costes fijos mensuales', productiveHours:'Horas productivas al mes', lossPercent:'Mermas', marginPercent:'Margen deseado sobre el precio de venta', riskPercent:'Riesgo (impagos, producto no vendido)', feePercent:'Gastos sobre la facturación', taxPercent:'Impuesto sobre el beneficio (tipo medio)', targetNet:'Neto deseado', targetScope:'Este neto deseado es', persons:'Personas que facturan', weeks:'Semanas trabajadas al año', weeklyHours:'Horas por semana', billablePercent:'Parte facturada', rate:'Tarifa por hora actual', directorMode:'Remuneración del gerente', directorAnnualCost:'Coste anual del gerente', directorNet:'Remuneración neta del gerente', contributionPercent:'Porcentaje de cargas del gerente', staffAnnual:'Asalariados, coste anual', structureTotal:'Gastos de estructura, total anual', surface:'Superficie', pricePerM2:'Precio por m²', yieldPerDay:'Rendimiento por operario', hoursPerDay:'Horas por día', team:'Equipo', materialPerM2:'Materiales por m²', fuelLitersPerDay:'Combustible de la maquinaria', fuelPrice:'Precio del combustible', consumablesPerDay:'Consumibles', scaffoldingPerDay:'Andamio', machinePerDay:'Maquinaria, alquiler', skipCost:'Contenedor, residuos', distanceKm:'Distancia de ida y vuelta', costPerKm:'Coste por km', tripsMode:'Viajes', trips:'Número de viajes', tripsPerDay:'Viajes por día', otherCosts:'Otros costes', financingCost:'Coste de financiación', fixedPercent:'Gastos generales', contingencyPercent:'Imprevistos (contingencias)', retentionPercent:'Retención de garantía', fullDays:'Jornadas completas', materials:'Lista de materias primas', structure:'Lista de gastos de estructura', count:'Número', hourlyCost:'Coste horario', cost:'Coste', costPerM2:'Coste por m²', country:'País', unsoldPercent:'Producto no vendido (% de la producción)', dayHours:'Horas facturadas por día', scaffoldingFixed:'Andamio, precio cerrado de montaje y desmontaje', weatherDays:'Días de mal tiempo previstos'};
var UNIT_WORD = {'pièce': 'pieza', 'portion': 'porción', 'kg': 'kg', 'L': 'litro', 'lot': 'lote'};
// Taux de TVA vérifiés le 8 octobre 2026 : BE (accountable.eu, maj 24/08/2026), LU (stripe.com, maj 24/02/2026), FR (economie.gouv.fr, 11/12/2025), CH (estv.admin.ch)
var VAT_RATES = {BE: ['21', '12', '6', '0'], LU: ['17', '14', '8', '3'], FR: ['20', '10', '5,5', '2,1'], CH: ['8,1', '3,8', '2,6'], autre: []};
if (DEC === '.') Object.keys(VAT_RATES).forEach(function(k){ VAT_RATES[k] = VAT_RATES[k].map(function(x){ return x.replace(',', '.'); }); });
var COUNTRY_OPTS = [['BE','Bélgica'],['LU','Luxemburgo'],['FR','Francia'],['CH','Suiza'],['autre','Otro país']];
var UNIT_PL = {'pieza': 'piezas', 'porción': 'porciones', 'lote': 'lotes', 'litro': 'litros'};
var MAT_FACTOR = {kg: 1, g: 0.001, L: 1, cl: 0.01, ml: 0.001, 'pièce': 1};
var BREAK_LABEL = {'Riesgos': 'Riesgos (impagos, producto no vendido)', 'Gastos sobre facturación': 'Gastos de cobro'};
function F(k, s, h, extra){ return Object.assign({k: k, s: s, h: h}, extra || {}); }
var PRICE_HINT = 'Pon 0 si buscas tu precio: el precio mínimo y el precio recomendado se muestran igualmente.';
var CFG = {
  fabrication: {
    blocks: [
      {t: 'Tu producto', f: [F('unit', null, null, {kind: 'sel', o: [['pièce','pieza'],['portion','porción'],['kg','kg'],['L','litro'],['lot','lote']]}), F('quantity', '@unit', 'Número de piezas del lote, o kg / litros vendibles producidos.', {req: 1}), F('price', '€/@unit', PRICE_HINT, {req: 1}), F('priceMode', null, null, {kind: 'sel', o: [['HT','Sin IVA'],['TTC','IVA incluido']]}), F('country', null, null, {kind: 'sel', o: COUNTRY_OPTS}), F('vat', '%', 'Para mostrar tus precios con IVA incluido. Obligatorio si tu precio incluye IVA. Comprueba el tipo de tu producto.', {kind: 'vatpick'}), F('unsoldPercent', '%', 'Parte de la producción que se tira o se regala. El coste se reparte sobre lo que se vende.')]},
      {t: 'Materias primas', alt: {list: 'materials', lib: 1, out: 'cost', total: F('materialsTotal', '€', 'Coste de materias primas de TODO el lote, no por unidad. Pon 0 si no hay. La energía del horno y el embalaje pueden ir aquí.'), cols: [{k: 'name', l: 'Materia prima', text: 1}, {k: 'qty', l: 'Cantidad para el lote'}, {k: 'u', l: 'Unidad', sel: [['kg','kg'],['g','g'],['L','L'],['cl','cl'],['ml','ml'],['pièce','pieza']]}, {k: 'price', l: 'Precio de compra', s: '€/kg, L o pieza'}], calc: function(r){ return r.qty * (MAT_FACTOR[r.u] || 1) * r.price; }}},
      {t: 'Tu tiempo', f: [F('minutes', 'min', 'Tiempo total para todo el lote.', {req: 1}), F('laborHourly', '€/h', 'Salario + cargas sociales de una hora de trabajo. El alquiler y la energía van más abajo.', {req: 1})]}
    ],
    details: [
      {t: 'Costes fijos y mermas', f: [F('fixedMonthly', '€/mes', 'Alquiler, energía, seguros del taller.'), F('productiveHours', 'h/mes', 'Total de horas de producción al mes, contando a todas las personas. 160 si se deja vacío.'), F('lossPercent', '%', 'Materia prima perdida o desperdiciada en producción.')]},
      {t: 'Margen, riesgo, gastos e impuestos', f: [F('marginPercent', '%', 'Parte del precio de venta sin IVA que te tiene que quedar (margen comercial).'), F('riskPercent', '%', 'Producto no vendido, impagos, roturas, en % de la facturación.'), F('feePercent', '%', 'Comisiones de pago o de plataforma.'), F('taxPercent', '%', 'Tipo medio que debes pedir a tu asesor.'), F('targetNet', '€', 'Lo que quieres que te quede tras impuestos.'), F('targetScope', null, null, {kind: 'sel', o: [['lot','para todo el lote'],['unit','por unidad']]})]}
    ],
    watch: ['fixedMonthly', 'lossPercent', 'riskPercent', 'feePercent', 'taxPercent']
  },
  travaux: {
    blocks: [
      {t: 'La obra', f: [F('surface', 'm²', null, {req: 1}), F('pricePerM2', '€/m²', PRICE_HINT, {req: 1}), F('priceMode', null, null, {kind: 'sel', o: [['HT','Sin IVA'],['TTC','IVA incluido']]}), F('country', null, null, {kind: 'sel', o: COUNTRY_OPTS}), F('vat', '%', 'Para mostrar tus precios con IVA incluido. Obligatorio si tu precio incluye IVA. El tipo depende de los trabajos (reforma, obra nueva…).', {kind: 'vatpick'})]},
      {t: 'Tu rendimiento', f: [F('yieldPerDay', 'm²/operario/día', 'Lo que realiza UN operario al día, en TUS condiciones.', {req: 1}), F('hoursPerDay', 'h', '8 si se deja vacío.')]},
      {t: 'Tu equipo', list: {list: 'team', cols: [{k: 'name', l: 'Puesto', text: 1}, {k: 'count', l: 'Número'}, {k: 'hourlyCost', l: 'Coste horario de una persona', s: '€/h'}]}},
      {t: 'Materiales', alt: {list: 'materials', lib: 1, out: 'costPerM2', total: F('materialPerM2', '€/m²', 'Total de materiales para un m² de obra terminada.'), cols: [{k: 'name', l: 'Material', text: 1}, {k: 'qty', l: 'Cantidad por m²'}, {k: 'u', l: 'Unidad', text: 1}, {k: 'price', l: 'Precio de compra unitario', s: '€'}], calc: function(r){ return r.qty * r.price; }}, f: [F('lossPercent', '%', 'Recortes, si no están ya incluidos en el coste por m².')]}
    ],
    details: [
      {t: 'Gastos de obra', f: [F('fuelLitersPerDay', 'L/día'), F('fuelPrice', '€/L'), F('consumablesPerDay', '€/día'), F('scaffoldingPerDay', '€/día', 'Alquiler por jornada completa. Si es por semanas: divide entre 5.'), F('scaffoldingFixed', '€', 'Precio cerrado de montaje y desmontaje.'), F('weatherDays', 'días', 'Días en los que el material sigue alquilado sin trabajar: el andamio y la maquinaria se suman al cálculo.'), F('machinePerDay', '€/día'), F('skipCost', '€'), F('distanceKm', 'km'), F('costPerKm', '€/km', 'Tu prueba «vehículos» te da esta cifra.'), F('tripsMode', null, null, {kind: 'sel', o: [['daily','un viaje de ida y vuelta por jornada empezada'],['fixed','un número fijo para la obra']]}), F('tripsPerDay', '/día', 'Modo «por jornada». 1 si se deja vacío.', {only: 'daily'}), F('trips', 'viajes', 'Modo «número fijo».', {only: 'fixed'}), F('otherCosts', '€'), F('financingCost', '€', 'Si pides un préstamo para adelantar los gastos de la obra.'), F('fullDays', null, 'Mano de obra pagada por jornadas completas.', {kind: 'bool'})]},
      {t: 'Margen, riesgo, tesorería e impuestos', f: [F('fixedPercent', '%', 'Oficina, administración, seguros, en % del coste directo.'), F('contingencyPercent', '%', 'Mal tiempo, repasos, sorpresas.'), F('marginPercent', '%', 'Parte del precio de venta sin IVA que te tiene que quedar (margen comercial).'), F('retentionPercent', '%', 'Se cobra más tarde: no es una pérdida.'), F('riskPercent', '%', 'Impagos, abonos, litigios, en % de la facturación.'), F('feePercent', '%', 'Gastos de cobro.'), F('taxPercent', '%', 'Tipo medio que debes pedir a tu asesor.'), F('targetNet', '€', 'Lo que quieres que te quede en esta obra tras impuestos.')]}
    ],
    watch: ['fixedPercent', 'contingencyPercent', 'riskPercent', 'feePercent', 'taxPercent']
  },
  services: {
    blocks: [
      {t: 'Tu tiempo', f: [F('persons', 'pers.', 'Personas que facturan a esta tarifa. 1 si se deja vacío.'), F('weeks', 'sem.', 'Sin vacaciones, festivos ni bajas por enfermedad.', {req: 1}), F('weeklyHours', 'h', null, {req: 1}), F('billablePercent', '%', 'La administración, los presupuestos y la prospección no se facturan.', {req: 1})]},
      {t: 'Tu tarifa', f: [F('rate', '€/h', PRICE_HINT, {req: 1}), F('dayHours', 'h', 'Para ver tus precios por día. 8 si se deja vacío.'), F('priceMode', null, null, {kind: 'sel', o: [['HT','Sin IVA'],['TTC','IVA incluido']]}), F('country', null, null, {kind: 'sel', o: COUNTRY_OPTS}), F('vat', '%', 'Para mostrar tus precios con IVA incluido. Obligatorio si tu tarifa incluye IVA.', {kind: 'vatpick'})]},
      {t: 'Remuneración del gerente', dir: true},
      {t: 'Personal y estructura', f: [F('staffAnnual', '€/año', 'Coste anual con cargas de tus asalariados. 0 si no tienes.')], alt: {list: 'structure', total: F('structureTotal', '€/año', 'Alquiler, seguros, software, vehículo, gestoría… Pon 0 si no hay.'), cols: [{k: 'name', l: 'Partida', text: 1}, {k: 'cost', l: 'Coste anual', s: '€/año'}]}}
    ],
    details: [
      {t: 'Margen, riesgo, gastos e impuestos', f: [F('marginPercent', '%', 'Parte de la tarifa sin IVA que te tiene que quedar (margen comercial).'), F('riskPercent', '%', 'Impagos, abonos.'), F('feePercent', '%', 'Gastos bancarios, cobro.'), F('taxPercent', '%', 'Tipo medio del impuesto sobre el beneficio; pregúntaselo a tu asesor.'), F('targetNet', '€/año', 'Beneficio deseado además de tu remuneración, que ya está contada.')]}
    ],
    watch: ['riskPercent', 'feePercent', 'taxPercent']
  }
};
var DEF = {
  fabrication: {name: 'Hornada de hogazas (ejemplo)', v: {quantity: '20', unit: 'pièce', price: '3,76', priceMode: 'HT', vat: '', materialsTotal: '4,57', minutes: '90', laborHourly: '29,50', fixedMonthly: '0', productiveHours: '160', lossPercent: '0', marginPercent: '35', riskPercent: '2', feePercent: '1,2', taxPercent: '25', targetNet: '20', targetScope: 'lot', country: 'BE', unsoldPercent: ''}, lists: {materials: [{name: 'Harina T65', qty: '6', u: 'kg', price: '0,7617'}]}, mode: {materials: 'total'}},
  travaux: {name: 'Tejado de tejas, 180 m² (ejemplo)', v: {surface: '180', pricePerM2: '59,38', priceMode: 'HT', vat: '', yieldPerDay: '22', hoursPerDay: '8', materialPerM2: '24,377', lossPercent: '0', fuelLitersPerDay: '12', fuelPrice: '1,65', consumablesPerDay: '15', scaffoldingPerDay: '45', machinePerDay: '0', skipCost: '320', distanceKm: '46', costPerKm: '0,55', tripsMode: 'daily', tripsPerDay: '1', trips: '', otherCosts: '0', financingCost: '0', fullDays: 'false', fixedPercent: '12', contingencyPercent: '7', marginPercent: '18', retentionPercent: '0', riskPercent: '3', feePercent: '1,5', taxPercent: '25', targetNet: '2000', country: 'BE', scaffoldingFixed: '', weatherDays: ''}, lists: {team: [{name: 'Jefe de equipo', count: '1', hourlyCost: '42'}, {name: 'Oficiales', count: '2', hourlyCost: '36'}, {name: 'Peón', count: '1', hourlyCost: '26'}], materials: [{name: 'Teja mecánica', qty: '13', u: 'pièce', price: '1,4581'}, {name: 'Rastrel 27×40', qty: '3,2', u: 'm', price: '1,045'}, {name: 'Lámina bajo teja', qty: '1,1', u: 'm²', price: '1,89'}]}, mode: {materials: 'total'}},
  services: {name: 'Despacho de 2 personas (ejemplo)', v: {persons: '2', weeks: '44', weeklyHours: '40', billablePercent: '62', rate: '75', priceMode: 'HT', vat: '', directorMode: 'direct', directorAnnualCost: '69600', directorNet: '48000', contributionPercent: '45', staffAnnual: '38000', structureTotal: '36500', marginPercent: '20', riskPercent: '2', feePercent: '1', taxPercent: '25', targetNet: '30000', country: 'BE', dayHours: ''}, lists: {structure: [{name: '', cost: ''}]}, mode: {structure: 'total'}}
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
var S = lsGet('pnr-draft-v2-es');
if (!S || !CFG[S.type]) S = freshState('fabrication');
var cache = {};
cache[S.type] = S;
function saveDraft(){ lsSet('pnr-draft-v2-es', S); }
function unitWord(){ return UNIT_WORD[S.v.unit] || S.v.unit || 'pieza'; }
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
    var sel = '<select id="f-vatChoice" data-vat="1"><option value="">Elige el tipo</option>' + rates.map(function(x){ return '<option value="' + esc(clean(x)) + '"' + (choice === clean(x) ? ' selected' : '') + '>' + esc(x) + ' %</option>'; }).join('') + '<option value="autre"' + (choice === 'autre' ? ' selected' : '') + '>Otro tipo</option></select>';
    return '<div class="field" data-field="vat"><label for="f-vatChoice">' + label + ' <span class="mute" style="font-weight:400">(opcional)</span></label><div class="inp">' + sel + '</div>' + (choice === 'autre' ? '<div class="inp" style="margin-top:6px"><input id="f-vat" inputmode="decimal" autocomplete="off" data-k="vat" value="' + esc(value || '') + '" aria-label="Tipo de IVA"><em>%</em></div>' : '') + (f.h ? '<span class="hint">' + esc(f.h) + '</span>' : '') + '</div>';
  }
  if (f.kind === 'bool') return '<label class="check"><input type="checkbox" id="' + id + '" data-k="' + f.k + '"' + (value === 'true' ? ' checked' : '') + '><span><b>' + label + '</b><br><span class="mute small">' + esc(f.h || '') + '</span></span></label>';
  var s = suffixOf(f);
  return '<div class="field" data-field="' + f.k + '"><label for="' + id + '">' + label + (f.req ? '' : ' <span class="mute" style="font-weight:400">(opcional)</span>') + '</label><div class="inp"><input id="' + id + '" inputmode="decimal" autocomplete="off" data-k="' + f.k + '" value="' + esc(value || '') + '">' + (s ? '<em>' + s + '</em>' : '') + '</div>' + (f.h ? '<span class="hint">' + esc(f.h) + '</span>' : '') + '</div>';
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
    }).join('') + '<button type="button" class="x" data-del="' + def.list + ':' + i + '" aria-label="Eliminar la línea">×</button>' + (def.calc ? '<span class="row-cost num" data-rowcost="' + def.list + ':' + i + '"></span>' : '') + '</div>';
  }).join('') + '</div><div class="btn-row" style="margin-top:8px"><button type="button" class="btn btn-line btn-sm" data-add="' + def.list + '">+ Añadir una línea</button>' + (def.lib ? '<button type="button" class="btn btn-ghost btn-sm" data-libsave="' + def.list + '">Guardar estos precios en «Mis precios de compra»</button>' : '') + '</div>';
}
function dirHTML(){
  var m = S.v.directorMode || 'direct';
  var opts = [['direct','Conozco su coste total anual'],['markup','Neto + cargas en % del neto'],['fraction','Cargas en % del coste total']];
  var h = '<div class="seg" role="group" aria-label="Método">' + opts.map(function(o){ return '<button type="button" data-dir="' + o[0] + '" aria-pressed="' + (m === o[0]) + '">' + o[1] + '</button>'; }).join('') + '</div><div class="fields two" style="margin-top:12px">';
  if (m === 'direct') h += fieldHTML(F('directorAnnualCost', '€/año', 'Lo que le cuesta a la empresa, cotizaciones incluidas. Pon 0 solo si lo cuentas en otra parte.', {req: 1}), S.v.directorAnnualCost);
  else h += fieldHTML(F('directorNet', '€/año', 'Después de cotizaciones, antes del impuesto sobre la renta.', {req: 1}), S.v.directorNet) + fieldHTML(F('contributionPercent', '%', m === 'markup' ? 'Coste = neto × (1 + porcentaje). Pon 0 si no hay cargas.' : 'Coste = neto ÷ (1 − porcentaje), porcentaje inferior al 100 %.', {req: 1}), S.v.contributionPercent);
  return h + '</div><p class="hint" style="margin-top:8px">Tu porcentaje de cargas depende de tu régimen y de tu país: pregúntaselo a tu asesor o a tu organismo de previsión social.</p>';
}
function blockHTML(b, isDetail){
  var inner = '';
  if (b.dir) inner += dirHTML();
  if (b.alt){
    var mode = S.mode[b.alt.list] || 'total';
    inner += '<div class="seg" role="group" aria-label="Modo de entrada" style="margin-bottom:10px"><button type="button" data-mode="' + b.alt.list + ':total" aria-pressed="' + (mode === 'total') + '">Un total</button><button type="button" data-mode="' + b.alt.list + ':list" aria-pressed="' + (mode === 'list') + '">Línea por línea</button></div>';
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
  var note = S.carryNote || (S.example ? 'Ejemplo cargado: sustituye cada cifra por la tuya, también en las secciones plegadas.' : '');
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
    if (blank(raw)){ if (req) setErr(k, '«' + label + '» es necesario.'); return undefined; }
    var n = parseNum(raw);
    if (isNaN(n)){ setErr(k, '«' + label + '» no es un número válido.'); return undefined; }
    if (n < 0){ setErr(k, '«' + label + '» no puede ser negativo.'); return undefined; }
    if (dotThousands(raw)) notes.push('«' + raw + ' » se lee como ' + fmt(n, n % 1 ? 2 : 0) + (DEC === '.' ? ' porque la coma separa los millares. Escribe el punto para los decimales (3.1).' : ' porque el punto separa los millares. Escribe la coma para los decimales (3,1).'));
    return n;
  }
  allFields(st.type).forEach(function(f){
    var raw = st.v[f.k];
    if (f.kind === 'sel'){ if (raw) inputs[f.k] = raw; return; }
    if (f.kind === 'bool'){ inputs[f.k] = raw === 'true'; return; }
    if (f.kind === 'vatpick'){ var vv = num('vat', raw, LABELS.vat, false); if (vv !== undefined){ if (vv > 100) setErr('vat', 'El tipo de IVA debe ser inferior al 100 %.'); inputs.vat = vv; } return; }
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
      if (!rows.length) setErr(def.list, x.alt ? 'Añade al menos una línea en « ' + LABELS[def.list] + ' », o vuelve a « Un total ».' : 'Añade al menos una persona a tu equipo, con su número y su coste horario.');
      inputs[def.list] = rows.map(function(r, i){
        var o = {};
        var legacy = def.calc && blank(r.qty) && blank(r.price) && !blank(r[def.out]);
        if (legacy){ o.name = String(r.name || '').trim() || '—'; o[def.out] = num(def.list, r[def.out], 'Coste (línea ' + (i + 1) + ')', true); return o; }
        def.cols.forEach(function(col){
          if (col.text){ o[col.k] = String(r[col.k] || '').trim() || (col.k === 'name' ? '—' : ''); return; }
          if (col.sel){ o[col.k] = r[col.k] || col.sel[0][0]; return; }
          var n = num(def.list, r[col.k], col.l + ' (línea ' + (i + 1) + ')', true);
          if (def.list === 'team' && col.k === 'count' && n === 0) setErr(def.list, 'Línea ' + (i + 1) + ' del equipo: el número debe ser al menos 1, o elimina la línea.');
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
  if (inputs.priceMode === 'TTC' && inputs.vat === undefined) setErr('vat', 'Tu precio incluye IVA: elige el tipo de IVA que contiene.');
  var extra = {};
  if (st.type === 'fabrication' && inputs.unsoldPercent !== undefined){
    var u = inputs.unsoldPercent; delete inputs.unsoldPercent;
    if (u >= 100) setErr('unsoldPercent', 'El producto no vendido debe ser inferior al 100 % de la producción.');
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
  if (st.type === 'travaux' && (st.v.tripsMode || 'daily') === 'fixed' && inputs.distanceKm > 0 && inputs.trips === undefined) setErr('trips', 'Modo «número fijo»: indica el número de viajes de la obra.');
  return {inputs: inputs, err: err, notes: notes, extra: extra};
}
function runEngine(st){
  var b = buildInputs(st);
  if (b.err) return {err: b.err, inputs: b.inputs, notes: b.notes, extra: b.extra};
  try { return {r: PNR.calculate(st.type, b.inputs), inputs: b.inputs, notes: b.notes, extra: b.extra}; }
  catch (e){
    if (e instanceof PNR.PnrError){
      var f = e.field || '', label = LABELS[f];
      return {err: {field: f, msg: label ? '«' + label + ' »: valor fuera de límites.' : e.message}, inputs: b.inputs, notes: b.notes, extra: b.extra};
    }
    throw e;
  }
}

// ---------- calcul complet : résultat ----------
function L(label, value, cls){ return '<li class="' + (cls || '') + '"><span>' + label + '</span><i></i><span class="num">' + value + '</span></li>'; }
function unitOf(st, r){ return st.type === 'fabrication' ? (UNIT_WORD[r.details.unit] || r.details.unit || 'pieza') : st.type === 'travaux' ? 'm²' : 'h'; }
function netLabel(st){ return st.type === 'services' ? 'Beneficio tras impuestos, además de tu remuneración' : 'Neto real tras impuestos'; }
// avertissements du moteur à masquer selon le cas (mêmes textes que dans le moteur)
var W_TARGET = 'Objetivo imposible con la tarifa actual dentro de la capacidad disponible.';
var W_NOPRICE = ['El precio actual produce una pérdida con los supuestos introducidos.', W_TARGET, 'Las retenciones recuperables son un desfase de tesorería, no una pérdida. El coste de financiación debe introducirse por separado.'];
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
  if (run.err) return '<p class="eyebrow">Falta un dato</p><p class="err">' + esc(run.err.msg) + '</p><p class="limit">El cálculo se actualiza en cuanto corriges la casilla.</p>';
  var r = run.r, d = r.details, u = unitOf(st, r), per = ' / ' + u;
  var hasPrice = r.revenue > 0;
  var h = '';
  if (run.notes.length) h += '<p class="gap">' + run.notes.map(esc).join('<br>') + '</p>';
  var ex = run.extra || {};
  var uPl = UNIT_PL[u] || u;
  if (ex.unsold) h += '<p class="limit" style="border:0;padding:0">Cálculo sobre ' + fmt(d.quantity, d.quantity % 1 ? 2 : 0) + ' ' + uPl + ' que se venden, de una producción de ' + fmt(ex.produced, ex.produced % 1 ? 2 : 0) + ' (' + fmt(ex.unsold, 1) + ' % de producto no vendido): el coste se reparte sobre lo que se vende.</p>';
  h += '<p class="eyebrow">Tu precio mínimo</p><p class="big">' + eur(r.minimumPrice) + '<small>sin IVA' + per + '</small></p>' +
    '<p class="small" style="color:var(--night-mute)">Por debajo de este precio, pierdes dinero: paga todos tus costes, tus riesgos y tus gastos, sin beneficio.</p><ul class="lines">';
  h += L('Coste de producción', eur(d.beforeFeesThreshold) + per);
  h += L('Precio mínimo', eur(r.minimumPrice) + per, 'strong');
  if (d.marginPercent > 0) h += L('Precio recomendado (margen ' + fmt(d.marginPercent, d.marginPercent % 1 ? 1 : 0) + ' %)', eur(r.recommendedPrice) + per);
  var unitTarget = st.type === 'fabrication' && d.targetScope === 'unit';
  if (d.targetNet > 0) h += L('Precio para quedarte con ' + eur(unitTarget ? d.targetNet / d.quantity : d.targetNet, 0) + (unitTarget ? ' por ' + u : st.type === 'services' ? ' al año' : '') + ' en neto', eur(r.targetPrice) + per, 'strong');
  if (hasPrice) h += L('Tu precio actual' + (st.v.priceMode === 'TTC' ? ' (descontado el IVA)' : ''), eur(r.currentPrice) + per);
  h += '</ul>';
  if (ex.vat !== undefined && ex.vat > 0){
    var tt = function(x){ return eur(x * (1 + ex.vat / 100)) + per; };
    h += '<p class="eyebrow" style="margin-top:2px">Los mismos precios, IVA incluido (IVA ' + fmt(ex.vat, ex.vat % 1 ? 1 : 0) + ' %)</p><ul class="lines">' + L('Precio mínimo IVA incluido', tt(r.minimumPrice)) + (d.marginPercent > 0 ? L('Precio recomendado IVA incluido', tt(r.recommendedPrice)) : '') + (d.targetNet > 0 ? L('Precio para tu objetivo, IVA incluido', tt(r.targetPrice)) : '') + (hasPrice ? L('Tu precio actual IVA incluido', tt(r.currentPrice)) : '') + '</ul>';
  }
  if (st.type === 'services'){
    var dh = ex.dayHours || 8, dd = function(x){ return eur(x * dh) + ' / día'; };
    h += '<p class="eyebrow" style="margin-top:2px">Por día (' + fmt(dh, dh % 1 ? 1 : 0) + ' h facturadas)</p><ul class="lines">' + L('Precio mínimo', dd(r.minimumPrice)) + (d.marginPercent > 0 ? L('Precio recomendado', dd(r.recommendedPrice)) : '') + (d.targetNet > 0 ? L('Precio para tu objetivo', dd(r.targetPrice)) : '') + (hasPrice ? L('Tu tarifa actual', dd(r.currentPrice)) : '') + '</ul>';
  }
  if (d.marginPercent > 0 && r.recommendedPrice < r.minimumPrice - 1e-9) h += '<p class="gap">Tu margen deseado (' + fmt(d.marginPercent, 1) + ' %) es menor que tus riesgos y gastos (' + fmt(d.riskPercent + d.feePercent, 1) + ' %): el precio recomendado cae por debajo de tu mínimo. Sube tu margen.</p>';
  if (hasPrice){
    if (r.currentPrice < r.minimumPrice - 1e-9) h += '<p class="verdict">Tu precio está por debajo de tu mínimo: te faltan ' + eur(r.minimumPrice - r.currentPrice) + per + '.</p>';
    else if (d.targetNet > 0 && r.currentPrice < r.targetPrice - 1e-9) h += '<p class="verdict">Rentable, pero por debajo de tu objetivo: faltan ' + eur(r.targetPrice - r.currentPrice) + per + '.</p>';
    else h += '<p class="verdict good">Tu precio cubre tus costes' + (d.targetNet > 0 ? ' y alcanza tu objetivo' : '') + '.</p>';
    var rows = [['Facturación sin IVA', r.revenue, 'hsl(218 30% 60%)']].concat(r.breakdown.map(function(b){ return [BREAK_LABEL[b.label] || b.label, b.amount, 'hsl(214 16% 62%)']; })).concat([['Lo que te queda', r.net, r.net >= 0 ? 'var(--ok-night)' : 'var(--loss-night)']]);
    h += '<p class="eyebrow" style="margin-top:4px">Adónde va tu precio</p><ul class="cascade-night">' + rows.filter(function(x){ return Math.abs(x[1]) > 0.004 || x[0] === 'Lo que te queda'; }).map(function(x){
      var w = Math.min(100, Math.abs(x[1]) / r.revenue * 100);
      return '<li><div class="lab"><span>' + x[0] + '</span><span class="num">' + eur(x[1]) + '</span></div><div class="track"><i style="width:' + w.toFixed(1) + '%;background:' + x[2] + '"></i></div></li>';
    }).join('') + '</ul>';
    var div = st.type === 'fabrication' ? d.quantity : st.type === 'travaux' ? d.surface : d.hours;
    h += '<ul class="lines">' + L(netLabel(st), '<span class="' + (r.net >= 0 ? 'pos' : 'neg') + '">' + eur(r.net) + '</span>', 'strong') + L('Por ' + u, eur(r.net / div)) + L('Es decir', fmt(r.net / r.revenue * 100, 1) + ' % del precio sin IVA') + '</ul>';
  } else {
    h += '<p class="gap">Pon tu precio actual para ver lo que te queda y lo que se lo come.</p>';
  }
  h += '<p class="eyebrow" style="margin-top:4px">Detalles</p><ul class="lines">';
  if (st.type === 'fabrication'){
    h += L('Coste horario aplicado (tiempo + costes fijos)', eur(d.hourly) + ' / h') + L('Materias primas del lote', eur(d.material)) + L('Tiempo del lote', eur(d.labor));
  } else if (st.type === 'services'){
    h += L('Horas trabajadas al año', fmt(d.paidHours, 0) + ' h') + L('Horas facturadas al año', fmt(d.hours, 0) + ' h') + L('Costes anuales', eur(r.cost, 0));
    if (d.targetNet > 0 && hasPrice && d.requiredHours !== null) h += L('Horas que debes facturar para tu objetivo', fmt(d.requiredHours, 0) + ' h');
  } else {
    h += L('Duración de la obra', fmt(d.duration, 2) + ' d (' + d.days + ' d contados)') + L('Mano de obra', eur(d.labor)) + L('Materiales', eur(d.material)) + L('Gastos de obra', eur(d.expenses));
    if (hasPrice) h += L('Rendimiento mínimo a este precio', d.equilibriumStatus === 'found' ? fmt(d.displayedEquilibriumYield, 2) + ' m²/operario/d' : d.equilibriumStatus === 'any' ? 'sin límite' : 'ninguno', 'strong');
    if (d.retentionAmount > 0) h += L('Retención cobrada más tarde', eur(d.retentionAmount));
    if (ex.scaffoldFixed > 0) h += L('Andamio, precio cerrado (en los gastos)', eur(ex.scaffoldFixed));
    if (ex.weatherCost > 0) h += L(fmt(ex.weatherDays, 0) + ' días de mal tiempo (en los gastos)', eur(ex.weatherCost));
  }
  h += '</ul>';
  if (st.type === 'services' && d.targetNet > 0 && hasPrice && d.impossible) h += '<p class="verdict">Tu objetivo es imposible con esta tarifa: harían falta ' + fmt(d.requiredHours, 0) + ' h facturadas, y tienes ' + fmt(d.hours, 0) + '. Sube tu precio.</p>';
  if (st.type === 'services') h += '<p class="limit">Empresa individual: el impuesto sobre tu propia remuneración no se cuenta aquí. El beneficio se suma a tu remuneración.</p>';
  if (st.type === 'travaux' && hasPrice){
    var planned = parseNum(st.v.yieldPerDay);
    if (d.equilibriumStatus === 'found'){
      if (planned < d.displayedEquilibriumYield) h += '<p class="verdict">Tu rendimiento previsto (' + fmt(planned, 2) + ') ya está por debajo del mínimo (' + fmt(d.displayedEquilibriumYield, 2) + ' m²/operario/d): a este precio, la obra pierde dinero.</p>';
      else h += '<p class="gap">Si tu equipo baja de <b>' + fmt(d.displayedEquilibriumYield, 2) + ' m² por operario y día</b>, esta obra te cuesta dinero. Tú prevés ' + fmt(planned, 2) + '.</p>';
    } else if (d.equilibriumStatus === 'impossible') h += '<p class="verdict">Incluso con un equipo infinitamente rápido, este precio no paga los materiales ni los gastos fijos de la obra.</p>';
  }
  var zero = CFG[st.type].watch.filter(function(k){ return !(parseNum(st.v[k]) > 0); }).map(function(k){ return lower((LABELS[k] || k).split(' (')[0]); });
  if (zero.length) h += '<p class="limit">Contados como 0 en este cálculo: ' + zero.join(', ') + '. Comprueba que es intencionado.</p>';
  var warns = cleanWarnings(st, r);
  if (warns.length) h += '<ul class="warns">' + warns.map(function(w){ return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>';
  return h;
}
function miniHTML(st, run){
  if (run.err) return '<span class="mini-err">' + esc(run.err.msg) + '</span>';
  var r = run.r, u = unitOf(st, r);
  return '<span>Mínimo <b class="num">' + eur(r.minimumPrice) + '/' + u + '</b></span>' + (r.revenue > 0 ? '<span>Te queda <b class="num ' + (r.net >= 0 ? 'pos' : 'neg') + '">' + eur(r.net, 0) + '</b></span>' : '') + '<a href="#c-result" data-scroll="1">Detalle ↓</a>';
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
    if (!n){ toast('Nada que guardar: pon un nombre y un precio en cada línea.'); return; }
    Lib.save().then(function(){ toast(n + (n > 1 ? ' precios guardados' : ' precio guardado') + ' en «Mis precios de compra».'); renderDatalist(); }, function(){ toast('No se puede guardar en este navegador.'); });
    return;
  }
  else return;
  renderForm(); compute(); saveDraft();
});
$('#c-name').addEventListener('input', function(e){ S.name = e.target.value; saveDraft(); });
$('#c-client').addEventListener('input', function(e){ S.client = e.target.value; saveDraft(); });
$$('.type').forEach(function(b){ b.addEventListener('click', function(){ setType(b.getAttribute('data-type')); }); });
$('#c-example').addEventListener('click', function(e){ if (!armed(e.currentTarget, '¿Borrar tus cifras? Pulsa otra vez')) return; S = freshState(S.type); cache[S.type] = S; renderForm(); compute(); saveDraft(); toast('Ejemplo recargado.'); });
$('#c-clear').addEventListener('click', function(e){ if (!armed(e.currentTarget, '¿Borrarlo todo? Pulsa otra vez')) return; S = freshState(S.type, true); cache[S.type] = S; renderForm(); compute(); saveDraft(); });
document.addEventListener('click', function(e){ var a = e.target.closest('[data-scroll]'); if (a){ e.preventDefault(); $('#c-result').scrollIntoView({behavior: 'smooth', block: 'start'}); } });

// ---------- résumé texte et PDF ----------
var TYPE_NAME = {fabrication: 'Fabricación', travaux: 'Obras', services: 'Servicios'};
function fieldDef(type, k){ var all = allFields(type); var f = all.filter(function(x){ return x.k === k; })[0]; if (f) return f; var c = CFG[type]; var out = null; c.blocks.forEach(function(b){ if (b.alt && b.alt.total.k === k) out = b.alt.total; }); return out; }
function summaryLines(st, run){
  var r = run.r, d = r.details, u = unitOf(st, r), per = ' / ' + u, out = [];
  out.push(['Coste de producción', eur(d.beforeFeesThreshold) + per]);
  out.push(['Precio mínimo (riesgos y gastos incluidos)', eur(r.minimumPrice) + per]);
  if (d.marginPercent > 0) out.push(['Precio recomendado (margen ' + fmt(d.marginPercent, d.marginPercent % 1 ? 1 : 0) + ' % del precio)', eur(r.recommendedPrice) + per]);
  if (d.targetNet > 0) out.push(['Precio para tu neto deseado', eur(r.targetPrice) + per]);
  if (r.revenue > 0){ out.push(['Precio actual sin IVA', eur(r.currentPrice) + per]); out.push(['Facturación sin IVA', eur(r.revenue)]); r.breakdown.forEach(function(b){ if (Math.abs(b.amount) > 0.004) out.push(['  ' + b.label, eur(b.amount)]); }); out.push([netLabel(st), eur(r.net)]); }
  if (st.type === 'travaux' && r.revenue > 0 && d.equilibriumStatus === 'found') out.push(['Rendimiento mínimo a este precio', fmt(d.displayedEquilibriumYield, 2) + ' m²/operario/día']);
  if (st.type === 'services'){ out.push(['Horas facturadas al año', fmt(d.hours, 0) + ' h']); if (d.targetNet > 0 && r.revenue > 0 && d.requiredHours !== null) out.push(['Horas necesarias para el objetivo', fmt(d.requiredHours, 0) + ' h']); }
  return out;
}
var DIR_LABEL = {direct: 'coste total anual', markup: 'neto + cargas en % del neto', fraction: 'cargas en % del coste total'};
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
    else if (typeof v === 'boolean') { if (v) out.push([label, 'sí']); }
    else if (f && f.o){ var o = f.o.filter(function(x){ return x[0] === v; })[0]; out.push([label, o ? o[1] : v]); }
    else out.push([label, v]);
  });
  return out;
}
function summaryText(st, run){
  var t = 'PRIX NET RÉEL — ' + TYPE_NAME[st.type] + '\n' + (st.name || 'Cálculo') + (st.client ? ' — ' + st.client : '') + '\n' + new Date().toLocaleDateString('es-ES') + '\n\n';
  t += summaryLines(st, run).map(function(l){ return l[0] + ' : ' + l[1]; }).join('\n');
  t += '\n\nSupuestos introducidos:\n' + inputLines(st).map(function(l){ return '- ' + l[0] + ' : ' + l[1]; }).join('\n');
  return t + '\n\n' + PNR.DISCLAIMER;
}
$('#c-copy').addEventListener('click', function(){
  compute(); if (!lastRun || lastRun.err) return;
  var text = summaryText(S, lastRun);
  try { navigator.clipboard.writeText(text).then(function(){ toast('Resumen copiado.'); }, function(){ fallbackCopy(text); }); } catch(e){ fallbackCopy(text); }
});
function fallbackCopy(text){ var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('Resumen copiado.'); } catch(e){ toast('Aquí no se puede copiar: selecciona el texto del resultado.'); } ta.remove(); }
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
  doc.setTextColor(20, 28, 45); y = 26; doc.setFontSize(16); doc.text(pdfText(st.name || 'Cálculo'), M, y); y += 7;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.text(pdfText(TYPE_NAME[st.type] + (st.client ? ' · ' + st.client : '') + ' · ' + new Date().toLocaleDateString('es-ES')), M, y); y += 10;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Resultados', M, y); y += 7;
  summaryLines(st, run).forEach(function(l, i){ line(l[0], l[1], i === 1); });
  y += 5; doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Supuestos introducidos', M, y); y += 7;
  inputLines(st).forEach(function(l){ line(l[0], l[1]); });
  var warns = cleanWarnings(st, run.r);
  if (warns.length){ y += 5; doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('A tener en cuenta', M, y); y += 7; warns.forEach(function(w){ line('• ' + w); }); }
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
        page.drawText(winAnsi(st.name || 'Cálculo'), {x: M, y: y, size: 16, font: f[1], color: ink}); y -= 20;
        page.drawText(winAnsi(TYPE_NAME[st.type] + (st.client ? ' · ' + st.client : '') + ' · ' + new Date().toLocaleDateString('es-ES')), {x: M, y: y, size: 10, font: f[0], color: grey}); y -= 22;
        title('Resultados'); summaryLines(st, run).forEach(function(l, i){ line(l[0], l[1], i === 1); });
        title('Supuestos introducidos'); inputLines(st).forEach(function(l){ line(l[0], l[1]); });
        var warns = cleanWarnings(st, run.r);
        if (warns.length){ title('A tener en cuenta'); warns.forEach(function(w){ line('• ' + w); }); }
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
    '<div class="bar">PRIX NET RÉEL</div><h1>' + esc(st.name || 'Cálculo') + '</h1><p>' + esc(TYPE_NAME[st.type] + (st.client ? ' · ' + st.client : '') + ' · ' + new Date().toLocaleDateString('es-ES')) + '</p>' +
    '<h2>' + esc('Resultados') + '</h2><table>' + rows(summaryLines(st, run)) + '</table><h2>' + esc('Supuestos introducidos') + '</h2><table>' + rows(inputLines(st)) + '</table>' +
    (warns.length ? '<h2>' + esc('A tener en cuenta') + '</h2><ul>' + warns.map(function(w){ return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' : '') + '<p class="mute">' + esc(PNR.DISCLAIMER) + '</p></body></html>';
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
    setTimeout(function(){ try { f.contentWindow.focus(); f.contentWindow.print(); } catch(e){ toast('Aquí no se puede imprimir.'); } }, 300);
  }
  toast('Para el PDF: elige «Guardar como PDF» en la ventana de impresión.');
}
function pdfName(){ return 'prix-net-reel-' + ((S.name || 'calcul').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'calcul') + '.pdf'; }
$('#c-pdf').addEventListener('click', function(){
  if (SITE && PDF_PRINT){ compute(); if (!lastRun || lastRun.err) return; printReport(S, lastRun); return; }
  if (SITE){
    compute(); if (!lastRun || lastRun.err) return;
    var b = this; b.disabled = true;
    buildPdfSite(S, lastRun).then(function(blob){ return downloads.save({filename: pdfName(), data: blob}); }).then(function(){ toast('PDF listo.'); }, function(){ toast('No se ha podido crear el PDF. Vuelve a intentarlo.'); }).then(function(){ b.disabled = false; });
    return;
  }
  compute(); if (!lastRun || lastRun.err || !downloads || !window.jspdf) return;
  var doc = buildPdf(S, lastRun);
  var name = (S.name || 'calcul').replace(/[^\wÀ-ÿ -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'calcul';
  downloads.save({filename: 'prix-net-reel-' + name + '.pdf', data: doc.output('blob')}).then(function(){ toast('PDF listo.'); }, function(e){ if (e && e.code === 'declined') return; toast('No se ha podido guardar el PDF aquí.'); });
});

// ---------- enregistrement ----------
var Store = {mode: 'local', db: null, uid: null, ready: null};
Store.ready = Promise.all([cap('db'), cap('user')]).then(function(res){
  var db = res[0], user = res[1];
  if (!db || !user) return;
  return user.id().then(function(id){ if (id){ Store.db = db; Store.uid = id; Store.mode = 'db'; } }).catch(function(){});
});
function localAll(){ return lsGet('pnr-saved-v1-es') || []; }
Store.list = function(){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.collection('data/users/' + Store.uid).get().then(function(s){ return s.docs.filter(function(d){ return d.id !== 'prix'; }).map(function(d){ return Object.assign({id: d.id}, d.data()); }).filter(function(x){ return !!x.type; }); }, function(){ Store.mode = 'local'; return localAll(); });
  return localAll();
}); };
Store.save = function(rec){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.collection('data/users/' + Store.uid).doc(rec.id).set(rec).catch(function(){ Store.mode = 'local'; return Store.save(rec); });
  var all = localAll().filter(function(x){ return x.id !== rec.id; }); all.push(rec); if (!lsSet('pnr-saved-v1-es', all)) throw new Error('local');
}); };
Store.remove = function(id){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.collection('data/users/' + Store.uid).doc(id).delete().catch(function(){});
  lsSet('pnr-saved-v1-es', localAll().filter(function(x){ return x.id !== id; }));
}); };
$('#c-save').addEventListener('click', function(){
  compute(); if (!lastRun || lastRun.err) return;
  var r = lastRun.r;
  var name = (S.name || '').trim() || ('Cálculo de ' + lower(TYPE_NAME[S.type]));
  var update = S.savedId && S.savedName === name;
  if (!update) S.savedId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  var rec = {id: S.savedId, type: S.type, name: name, client: S.client || '', savedAt: new Date().toISOString(), v: S.v, lists: S.lists, mode: S.mode,
    summary: {unit: unitOf(S, r), minimumPrice: r.minimumPrice, recommendedPrice: r.recommendedPrice, targetPrice: r.targetPrice, net: r.net, revenue: r.revenue, margin: r.details.marginPercent, target: r.details.targetNet}};
  $('#c-save').disabled = true;
  Store.save(rec).then(function(){ S.savedName = name; S.name = name; $('#c-name').value = name; saveDraft(); toast(update ? 'Cálculo « ' + name + ' » actualizado.' : 'Cálculo « ' + name + ' » guardado. Cambia el nombre para guardar otro.'); }, function(){ toast('No se puede guardar en este navegador.'); }).then(function(){ $('#c-save').disabled = false; });
});
// ---------- mes prix d'achat ----------
var Lib = {items: []};
function libKey(n){ return String(n || '').trim().toLowerCase(); }
Lib.find = function(name, kind){ var k = libKey(name); if (!k) return null; return Lib.items.filter(function(x){ return libKey(x.name) === k && (!kind || x.kind === kind); })[0] || null; };
Lib.upsert = function(it){ var old = Lib.find(it.name, it.kind); if (old){ old.price = it.price; old.u = it.u || old.u; } else Lib.items.push(it); };
Lib.load = function(){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.doc('data/users/' + Store.uid + '/prix').get().then(function(d){ Lib.items = d.exists ? clone((d.data() || {}).items || []) : []; }, function(){ Lib.items = lsGet('pnr-prix-v1-es') || []; });
  Lib.items = lsGet('pnr-prix-v1-es') || [];
}).then(renderDatalist); };
Lib.save = function(){ return Store.ready.then(function(){
  if (Store.mode === 'db') return Store.db.doc('data/users/' + Store.uid + '/prix').set({items: Lib.items});
  if (!lsSet('pnr-prix-v1-es', Lib.items)) throw new Error('local');
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
    if (run.err) return {x: x, rank: 4, html: '<td>' + esc(x.name) + '</td><td>' + esc(TYPE_NAME[x.type] || '') + '</td><td colspan="5" class="mute">Por completar: ' + esc(run.err.msg) + '</td><td><span class="chip warn">por completar</span></td>'};
    var r = run.r, d = r.details, u = unitOf(st, r), hasPrice = r.revenue > 0, status, rank;
    if (!hasPrice){ status = '<span class="chip">sin precio</span>'; rank = 3; }
    else if (r.currentPrice < r.minimumPrice - 1e-9){ status = '<span class="chip bad">bajo el mínimo</span>'; rank = 0; }
    else if (d.targetNet > 0 && r.currentPrice < r.targetPrice - 1e-9){ status = '<span class="chip warn">bajo el objetivo</span>'; rank = 1; }
    else { status = '<span class="chip ok">rentable</span>'; rank = 2; }
    return {x: x, rank: rank, html: '<td>' + esc(x.name) + (upd ? ' <span class="mute small">(' + upd + ' con precio nuevo)</span>' : '') + '</td><td>' + esc(TYPE_NAME[x.type] || '') + '</td>' +
      '<td class="num">' + eur(r.minimumPrice) + ' / ' + u + '</td><td class="num">' + (d.marginPercent > 0 ? eur(r.recommendedPrice) : '—') + '</td><td class="num">' + (hasPrice ? eur(r.currentPrice) : '—') + '</td>' +
      '<td class="num ' + (hasPrice ? (r.currentPrice - r.minimumPrice >= 0 ? 'pos' : 'neg') : '') + '">' + (hasPrice ? (r.currentPrice - r.minimumPrice >= 0 ? '+' : '') + eur(r.currentPrice - r.minimumPrice) : '—') + '</td><td class="num">' + (hasPrice ? eur(r.net, 0) : '—') + '</td><td>' + status + '</td>'};
  }).sort(function(a, b){ return a.rank - b.rank; });
  return '<h3 style="font-size:1.3rem;margin-bottom:10px">Todos tus cálculos, recalculados con tus precios de compra de hoy</h3><div class="tablewrap"><table class="cmp"><thead><tr><th>Cálculo</th><th>Actividad</th><th>Mínimo sin IVA</th><th>Recomendado sin IVA</th><th>Precio actual sin IVA</th><th>Diferencia / mínimo</th><th>Te queda</th><th>Estado</th></tr></thead><tbody>' + rows.map(function(r){ return '<tr>' + r.html + '</tr>'; }).join('') + '</tbody></table></div>';
}
function libEditorHTML(){
  var rows = Lib.items.map(function(x, i){
    return '<div class="row lib-row" style="--cols:3"><div class="field"><label class="small" for="lb-' + i + '-name">Nombre</label><div class="inp"><input class="txt" id="lb-' + i + '-name" data-lib="' + i + '" data-libcol="name" value="' + esc(x.name) + '"></div></div><div class="field"><label class="small" for="lb-' + i + '-u">Unidad usada</label><div class="inp"><input class="txt" id="lb-' + i + '-u" data-lib="' + i + '" data-libcol="u" value="' + esc(x.u || '') + '"></div></div><div class="field"><label class="small" for="lb-' + i + '-price">Precio de compra (€ por kg, L o unidad)</label><div class="inp"><input inputmode="decimal" id="lb-' + i + '-price" data-lib="' + i + '" data-libcol="price" value="' + esc(x.price || '') + '"></div></div><div class="field"><label class="small" for="lb-' + i + '-kind">Para</label><div class="inp"><select id="lb-' + i + '-kind" data-lib="' + i + '" data-libcol="kind"><option value="fabrication"' + (x.kind === 'fabrication' ? ' selected' : '') + '>Fabricación</option><option value="travaux"' + (x.kind === 'travaux' ? ' selected' : '') + '>Obras</option></select></div></div><button type="button" class="x" data-libdel="' + i + '" aria-label="Eliminar">×</button></div>';
  }).join('');
  return '<h3 style="font-size:1.3rem;margin-bottom:6px">Mis precios de compra</h3><p class="mute small" style="margin-bottom:10px">Cambia un precio aquí y guarda: todos los cálculos que usan esa materia prima (con entrada línea por línea) se recalculan.</p>' +
    (rows ? '<div class="rows" style="--cols:3">' + rows + '</div>' : '<p class="mute small">Ningún precio guardado. En un cálculo, pasa las materias primas a «Línea por línea» y toca «Guardar estos precios».</p>') +
    '<div class="btn-row" style="margin-top:10px"><button type="button" class="btn btn-line btn-sm" id="lib-add">+ Añadir un precio</button>' + (Lib.items.length ? '<button type="button" class="btn btn-hivis btn-sm" id="lib-save">Guardar mis precios</button>' : '') + '</div>';
}
document.addEventListener('input', function(e){ var t = e.target; if (t.dataset && t.dataset.lib !== undefined){ Lib.items[+t.dataset.lib][t.dataset.libcol] = t.value; } });
document.addEventListener('change', function(e){ var t = e.target; if (t.dataset && t.dataset.lib !== undefined && t.tagName === 'SELECT'){ Lib.items[+t.dataset.lib][t.dataset.libcol] = t.value; } });
document.addEventListener('click', function(e){
  var b = e.target.closest('#lib-add,#lib-save,[data-libdel]'); if (!b) return;
  if (b.id === 'lib-add'){ Lib.items.push({name: '', u: '', price: '', kind: S.type === 'travaux' ? 'travaux' : 'fabrication'}); $('#s-lib').innerHTML = libEditorHTML(); return; }
  if (b.dataset.libdel !== undefined){ Lib.items.splice(+b.dataset.libdel, 1); $('#s-lib').innerHTML = libEditorHTML(); return; }
  Lib.items = Lib.items.filter(function(x){ return !blank(x.name); });
  Lib.save().then(function(){ toast('Precios de compra guardados. Tus cálculos se han recalculado.'); renderDatalist(); renderSaved(); }, function(){ toast('No se puede guardar en este navegador.'); });
});

function renderSaved(){
  $('#s-where').textContent = 'Cargando…';
  Store.list().then(function(list){
    $('#s-where').textContent = Store.mode === 'db' ? 'Guardados en tu cuenta de Claude: solo los ves tú, en todos tus dispositivos.' : 'Guardados en este navegador, en este dispositivo.';
    list.sort(function(a, b){ return String(b.savedAt).localeCompare(String(a.savedAt)); });
    $('#s-compare').innerHTML = compareHTML(list);
    $('#s-lib').innerHTML = libEditorHTML();
    if (!list.length){ $('#s-list').innerHTML = '<div class="empty"><b style="font-family:var(--f-display);font-size:1.2rem">Ningún cálculo guardado</b><span class="mute">Haz un cálculo completo y luego toca «Guardar».</span><a class="btn btn-hivis" href="#calcul">Hacer un cálculo</a></div>'; return; }
    $('#s-list').innerHTML = list.map(function(x){
      var s = x.summary || {};
      return '<div class="saved-item"><div><p class="eyebrow">' + esc(TYPE_NAME[x.type] || '') + '</p><h3>' + esc(x.name || 'Cálculo') + '</h3><p class="meta">' + (x.client ? esc(x.client) + ' · ' : '') + new Date(x.savedAt).toLocaleDateString('es-ES') + ' · mínimo <span class="num">' + eur(s.minimumPrice || 0) + ' / ' + esc(s.unit || '') + '</span>' + (s.revenue > 0 ? ' · te queda <span class="num">' + eur(s.net || 0) + '</span>' : '') + '</p></div><div class="btn-row"><button class="btn btn-line btn-sm" data-open-saved="' + esc(x.id) + '">Abrir</button><button class="btn btn-ghost btn-sm" data-del-saved="' + esc(x.id) + '">Eliminar</button></div></div>';
    }).join('');
    $$('[data-open-saved]').forEach(function(b){ b.addEventListener('click', function(){ var x = list.filter(function(i){ return i.id === b.getAttribute('data-open-saved'); })[0]; if (!x) return; S = stateFromRecord(x); var nU = applyLibrary(S); if (nU) S.carryNote = nU + ' precio(s) actualizado(s) desde «Mis precios de compra».'; cache[x.type] = S; renderForm(); compute(); saveDraft(); location.hash = 'calcul'; }); });
    $$('[data-del-saved]').forEach(function(b){ b.addEventListener('click', function(e){ if (!armed(e.currentTarget, 'Confirmar')) return; Store.remove(b.getAttribute('data-del-saved')).then(renderSaved); }); });
  });
}

// ---------- assistant ----------
var A = {sample: null, tools: false, turns: [], ctl: null, last: null};
// début de question et exemple proposés selon le métier choisi
var ASK_START = {fabrication: 'Fabrico un producto y quiero saber mi verdadero coste de producción y mi precio mínimo. ', travaux: 'Tengo que presupuestar una obra por m² y quiero saber mi precio mínimo. ', services: 'Quiero saber mi verdadera tarifa por hora y las horas que tengo que facturar. '};
var ASK_HINT = {fabrication: 'Ej.: 40 tarros de mermelada por tanda, 2 h de trabajo, 38 € de fruta y azúcar…', travaux: 'Ej.: tejado de tejas de 180 m², equipo de 4, facturo 59 € el m²…', services: 'Ej.: contable autónomo a 70 € la hora, 40 h por semana…'};
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
  PCT_STRICT.forEach(function(k){ if (typeof i[k] === 'number' && i[k] > 0 && i[k] < 1) throw new Error(k + ' = ' + i[k] + ' — los porcentajes se escriben como números (25 para 25 %). Si de verdad es menos del 1 %, pide confirmación a la persona.'); });
  if (i.priceMode === 'TTC' && i.vat === undefined) throw new Error('Precio con IVA incluido sin tipo de IVA: pide el tipo de IVA incluido en el precio.');
  if (type === 'fabrication' && i.materialsTotal === undefined && !(Array.isArray(i.materials) && i.materials.length)) throw new Error('Falta materialsTotal: pide el coste de las materias primas para todo el lote (0 si no hay).');
  if (type === 'travaux'){
    if (i.materialPerM2 === undefined && !(Array.isArray(i.materials) && i.materials.length)) throw new Error('Falta materialPerM2: pide el coste de los materiales por m² (0 si los suministra el cliente).');
    if (i.distanceKm > 0 && i.tripsMode === undefined) throw new Error('distanceKm indicado sin tripsMode: precisa «daily» (un viaje de ida y vuelta por día) o «fixed» con trips.');
  }
  if (type === 'services'){
    if (i.directorNet !== undefined && i.directorMode === undefined) throw new Error('directorNet indicado sin directorMode: usa «markup» (cargas en % del neto) o «fraction» (cargas en % del coste total).');
    if (i.directorAnnualCost === undefined && i.directorNet === undefined) throw new Error('Falta la remuneración del gerente: pide su coste anual total, o su neto anual y el porcentaje de cargas.');
    if (i.directorMode === undefined && i.directorAnnualCost !== undefined) i.directorMode = 'direct';
  }
}
function r2(n){ return n === null || n === undefined ? null : Math.round(n * 100) / 100; }
var DEFAULTS = {fabrication: ['fixedMonthly','lossPercent','marginPercent','riskPercent','feePercent','taxPercent','targetNet'], travaux: ['fuelLitersPerDay','consumablesPerDay','scaffoldingPerDay','machinePerDay','skipCost','distanceKm','otherCosts','fixedPercent','contingencyPercent','marginPercent','riskPercent','feePercent','taxPercent','targetNet'], services: ['staffAnnual','structureTotal','marginPercent','riskPercent','feePercent','taxPercent','targetNet']};
function compact(type, r, inputs){
  var d = r.details, hasPrice = r.revenue > 0;
  var o = {montants: '€ sin IVA', periode: type === 'fabrication' ? 'para el lote' : type === 'travaux' ? 'para la obra' : 'al año', unite: type === 'fabrication' ? d.unit : type === 'travaux' ? 'm²' : 'hora',
    cout_de_revient_par_unite: r2(d.beforeFeesThreshold), prix_plancher_par_unite: r2(r.minimumPrice)};
  if (d.marginPercent > 0) o.prix_conseille_par_unite = r2(r.recommendedPrice);
  if (d.targetNet > 0) o.prix_pour_objectif_par_unite = r2(r.targetPrice);
  o.couts = r.breakdown.filter(function(b){ return ['Riesgos', 'Gastos sobre facturación', 'Impuesto estimado'].indexOf(b.label) < 0 && Math.abs(b.amount) > 0.004; }).map(function(b){ return b.label + ' : ' + r2(b.amount); });
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
      setStatus('El motor está calculando…');
      var r;
      try { r = PNR.calculate(type, inputs); } catch (e){ throw new Error(e && e.message ? e.message : 'No se puede calcular con estos datos.'); }
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
  var u = type === 'fabrication' ? (UNIT_WORD[r.details.unit] || 'pieza') : type === 'travaux' ? 'm²' : 'h';
  var h = '<p class="eyebrow">Resultado del motor · ' + TYPE_NAME[type] + '</p><ul class="lines">' + L('Precio mínimo', eur(r.minimumPrice) + ' / ' + u, 'strong');
  if (r.details.marginPercent > 0) h += L('Precio recomendado', eur(r.recommendedPrice) + ' / ' + u);
  if (r.details.targetNet > 0) h += L('Precio para tu objetivo', eur(r.targetPrice) + ' / ' + u);
  if (r.revenue > 0) h += L('Lo que queda tras impuestos', eur(r.net));
  if (type === 'travaux' && r.revenue > 0 && r.details.equilibriumStatus === 'found') h += L('Rendimiento mínimo', fmt(r.details.displayedEquilibriumYield, 2) + ' m²/operario/d');
  h += '</ul><button class="btn btn-hivis btn-sm" type="button">Abrir en el cálculo completo</button>';
  div.innerHTML = h;
  div.querySelector('button').addEventListener('click', function(){ openFromInputs(type, inputs); });
  $('#a-thread').appendChild(div); $('#a-thread').scrollTop = 1e9;
}
function openFromInputs(type, inputs){
  var st = freshState(type, true); st.name = 'Cálculo del asistente';
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
  st.carryNote = 'Cálculo abierto desde el asistente: comprueba cada cifra y luego guarda.';
  S = st; cache[type] = st; renderForm(); compute(); saveDraft(); location.hash = 'calcul';
}
var ERR_COPY = {not_granted: 'El asistente no ha sido autorizado. Los cálculos siguen disponibles.', sampling_disabled: 'El asistente no está disponible para esta cuenta.', rate_limited: 'Demasiadas preguntas a la vez. Vuelve a intentarlo dentro de un momento.', session_expired: 'Vuelve a conectarte a Claude y luego inténtalo de nuevo.', refused: 'El asistente no puede responder a esta petición. Formúlala de otra manera.', empty_completion: 'Sin respuesta. Formula tu pregunta de forma más sencilla.', prompt_too_large: 'La conversación es demasiado larga. Recarga la página para empezar una nueva.', tools_unavailable: 'El asistente no puede usar el motor aquí.'};
function assistantOff(msg){ $('#a-form').hidden = true; $('#a-chips').hidden = true; setStatus(''); $('#a-thread').innerHTML = ''; bubble('sys', msg); }
if (!SITE) cap('sample').then(function(s){
  if (!s){ assistantOff(window.PNR_EDITION === 'test' ? 'Versión de prueba: el asistente IA forma parte de la versión completa. Aquí, las pruebas rápidas, el cálculo completo y la comparación de tus cálculos funcionan sin instalar nada.' : 'El asistente funciona cuando esta página está abierta en Claude, conectada a tu cuenta. Las pruebas y el cálculo completo funcionan en todas partes.'); return; }
  A.sample = s;
  (s.limits ? s.limits() : Promise.reject()).then(function(l){ A.tools = !!(l && l.tools); }, function(){ A.tools = false; }).then(function(){
    if (!A.tools){ assistantOff('Tu aplicación de Claude aún no permite que el asistente use el motor. Las pruebas y el cálculo completo funcionan.'); return; }
    bubble('ai', 'Hola. Dime qué quieres calcular: un producto, una obra o tu tarifa por hora. Te hago las preguntas una a una, y quien calcula es el motor.');
  });
});
function ask(text){
  if (SITE) return askSite(text);
  if (!A.sample || !A.tools || A.ctl) return;
  text = text.trim(); if (!text) return;
  $('#a-chips').hidden = true;
  bubble('me', text);
  var content = text + (A.last ? '\n\n[Contexto de la página: último cálculo enviado al motor (' + A.last.type + ') : ' + JSON.stringify(A.last.inputs) + ']' : '');
  A.turns.push({role: 'user', content: content});
  if (A.turns.length > 30) A.turns = A.turns.slice(-30);
  var out = bubble('ai', 'Pensando…');
  A.ctl = new AbortController();
  $('#a-send').hidden = true; $('#a-stop').hidden = false; setStatus('El asistente está pensando. Puede tardar hasta un minuto.');
  A.sample([{role: 'user', content: RULES}].concat(A.turns), {tools: toolList(), cache: false, signal: A.ctl.signal, onText: function(u){ out.textContent = u.text; $('#a-thread').scrollTop = 1e9; }})
    .then(function(res){ out.textContent = plainText(res.text); A.turns.push({role: 'assistant', content: res.text}); if (res.truncated) bubble('sys', 'Respuesta cortada: haz una pregunta más corta.'); setStatus(''); })
    .catch(function(e){
      var code = e && e.code;
      if (e && e.text){ out.textContent = e.text; } else out.remove();
      if (code === 'cancelled'){ setStatus('Detenido.'); A.turns.pop(); return; }
      if (['not_granted','sampling_disabled','not_declared','capability_disabled','capability_removed','tools_unavailable'].indexOf(code) >= 0){ assistantOff(ERR_COPY[code] || 'El asistente no está disponible aquí.'); return; }
      A.turns.pop();
      setStatus(ERR_COPY[code] || 'La respuesta se ha interrumpido. Vuelve a intentarlo.');
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
var SRV_MSG = {quota: 'Ya has usado tus 2 cálculos gratis.', auth: 'Introduce tu código de acceso para usar el asistente.', limit: 'Has alcanzado el límite de uso del mes. El contador se reinicia el día 1 de cada mes.', busy: 'El asistente tiene mucha demanda. Vuelve a intentarlo en unos instantes.', upstream: 'El asistente no responde por el momento. Vuelve a intentarlo en unos instantes.', config: 'El asistente no está disponible por el momento.', rate: 'Demasiados intentos. Prueba de nuevo dentro de unos minutos.', code: 'Código de acceso no válido.', ia: 'El asistente no está disponible temporalmente. No se te ha cobrado nada. Vuelve a intentarlo más tarde.', deja: 'Este pago ya ha activado un acceso. En otro dispositivo, introduce tu código de acceso personal.', paiement: 'No se ha podido confirmar el pago. Vuelve a intentarlo en unos instantes.', fini: 'Tu suscripción ya no está activa. Vuelve a suscribirte para seguir usando el asistente.', pay: 'Pago no disponible por el momento.'};
var NEW_CODE = null;
function pageLang(){ return document.documentElement.lang || 'fr'; }
function srvMsg(e, d){ return (e && SRV_MSG[e.error]) || d || (e && e.message) || ''; }
function priceLabel(){ return ACC && ACC.price_eur ? eur(ACC.price_eur, 0) + ' al mes' : (ACC && ACC.price) || ''; }
function quotaMsg(){ var R = (ACC && ACC.ready) || {}; return SRV_MSG.quota + ' ' + (R.pay ? 'Sigue con la suscripción: ' + priceLabel() + ', sin permanencia.' : 'La suscripción de ' + priceLabel() + ' estará disponible muy pronto. ¿Tienes un código de acceso? Introdúcelo aquí abajo.'); }
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
  if (ACC && ACC.visiteur){ el.hidden = false; el.innerHTML = '<b>Cálculos gratis, sin registro: ' + ACC.cases_left + ' / ' + ACC.cases_max + '</b>'; return; }
  if (!ACC || !(ACC.email || ACC.nom)){ el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = 'Conectado: ' + esc(ACC.email || ACC.nom) +(ACC.free && ACC.active ? ' · acceso gratuito' : '') + (ACC.active && ACC.limit ? ' · ' + ACC.used + ' / ' + ACC.limit + ' preguntas este mes' : '') +
    (ACC.free ? '' : ' · <button class="linkbtn" type="button" data-acc="portal">Gestionar mi suscripción</button>') + ' · <button class="linkbtn" type="button" data-acc="logout">Cerrar sesión</button>';
}
// site sans clé IA : l'assistant est annoncé, le reste du site marche normalement
function soon(){ A.ready = false; $('#a-pay').hidden = true; $('#a-form').hidden = true; $('#a-chips').hidden = true; $('#a-thread').innerHTML = ''; bubble('sys', 'El asistente IA llegará pronto. Mientras tanto, el cálculo completo, el PDF y la comparación de tus cálculos son gratuitos.'); $('#a-note').textContent = 'El asistente IA se ofrecerá con suscripción mensual.'; }
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
        else toast(srvMsg(r, 'No se ha podido confirmar el pago. Vuelve a intentarlo en unos instantes.'));
        siteStart();
      }, function(){ toast('No se ha podido iniciar sesión. Vuelve a intentarlo.'); siteStart(); });
      return;
    }
  }
  if (q.get('bienvenue')) toast('Suscripción activada. Haz tu primera pregunta.');
  else if (q.get('connecte')) toast('Has iniciado sesión.');
  else if (q.get('lien') === 'expire') toast('Enlace caducado o ya utilizado: pide uno nuevo.');
  else if (q.get('paiement') === 'erreur') toast('No se ha podido confirmar el pago. Si se te ha cobrado, pide tu enlace de acceso con tu correo electrónico.');
  var had = false; ['bienvenue','connecte','lien','paiement'].forEach(function(k){ if (q.has(k)){ q.delete(k); had = true; } });
  if (had) try { history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q.toString() : '') + location.hash); } catch(e){}
  $('#a-form').hidden = true; $('#a-chips').hidden = true;
  api('/api/me').then(function(m){
    ACC = m;
    var R = m.ready || {ai: true, pay: true, email: true};
    if (priceLabel()) $('#a-price').textContent = priceLabel();
    if (m.visiteur) $('#a-note').textContent = 'Tus preguntas las procesa Claude (Anthropic). Tus cálculos guardados se quedan en tu navegador.';
    else if (m.limit) $('#a-note').textContent = (m.abonne ? 'Incluido en la suscripción' : 'Acceso por invitación') + ' — hasta ' + m.limit + ' preguntas al mes. Tus preguntas las procesa Claude (Anthropic). Tus cálculos guardados se quedan en tu navegador.';
    else if (R.code && !R.pay) $('#a-note').textContent = 'Durante la prueba, el asistente está reservado a las personas invitadas. Tus preguntas las procesa Claude (Anthropic).';
    accountLine();
    $('#a-sub').hidden = !R.pay; $('#a-login').hidden = !R.email; $('#a-code').hidden = !R.code; $('#a-terms').hidden = !R.pay;
    var tp = $('#a-testpay');
    if (!tp){ tp = document.createElement('p'); tp.id = 'a-testpay'; tp.className = 'small mute'; $('#a-sub').insertAdjacentElement('afterend', tp); }
    tp.textContent = 'Pago en modo de prueba: no se realiza ningún cargo en ninguna tarjeta real.'; tp.hidden = !(R.pay && R.pay_test);
    if (!R.pay) $('#a-pay-kicker').textContent = m.visiteur ? 'Abonnement' : 'Prueba privada';
    if (!m.active && (!R.ai || (!R.pay && !R.email && !R.code))){ soon(); return; }
    if (m.active){
      $('#a-pay').hidden = true; $('#a-thread').hidden = false; $('#a-form').hidden = false; $('#a-chips').hidden = false; A.ready = true;
      bubble('ai', 'Hola. Dime qué quieres calcular: un producto, una obra o tu tarifa por hora. Te hago las preguntas una a una, y quien calcula es el motor.');
      if (NEW_CODE){ bubble('sys', 'Suscripción activada. Tu código de acceso personal: ' + NEW_CODE + '. Guárdalo: sirve para iniciar sesión en otro dispositivo.'); NEW_CODE = null; }
      if (metierQ && ASK_HINT[metierQ]) prepAsk(metierQ, false);
    } else if (m.visiteur) showPay(quotaMsg());
    else if (!R.pay) showPay(R.code ? 'El asistente está en prueba privada, por invitación. Introduce tu código de acceso para usarlo.' : 'El asistente está en prueba privada. Si tu dirección está invitada, recibe tu enlace de acceso por correo electrónico.');
    else if (m.email) showPay('Tu suscripción ya no está activa. Vuelve a suscribirte para seguir usando el asistente.');
    else showPay('Describe tu obra, tu producto o tu encargo con tus palabras: el asistente te hace las preguntas adecuadas y el motor calcula tu precio real.');
  }, function(){ showPay('El servidor no responde por el momento. Las pruebas y el cálculo completo funcionan igualmente.'); });
}
if (SITE){
  siteStart();
  $('#a-sub').addEventListener('click', function(){
    var b = this, em = ($('#a-email').value || '').trim();
    b.disabled = true;
    api('/api/checkout', em ? {email: em, lang: pageLang()} : {lang: pageLang()}).then(function(r){ if (r.url) location.href = r.url; else if (r.deja) siteStart(); else { b.disabled = false; toast(srvMsg(r, 'Pago no disponible por el momento.')); } }, function(){ b.disabled = false; toast('No se ha podido iniciar sesión. Vuelve a intentarlo.'); });
  });
  $('#a-login').addEventListener('submit', function(e){
    e.preventDefault();
    var em = $('#a-email').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)){ toast('Dirección de correo electrónico no válida.'); return; }
    api('/api/login', {email: em}).then(function(r){ toast(r.message || 'Si existe una suscripción para esta dirección, el enlace acaba de enviarse.'); }, function(){ toast('No se ha podido iniciar sesión. Vuelve a intentarlo.'); });
  });
  $('#a-code').addEventListener('submit', function(e){
    e.preventDefault();
    var b = this.querySelector('button'), c = $('#a-code-in').value.trim();
    if (c.replace(/[^0-9A-Za-z]/g, '').length < 8){ toast('Código de acceso no válido.'); return; }
    b.disabled = true;
    api('/api/code', {code: c}).then(function(r){
      b.disabled = false;
      if (!r.ok){ toast(srvMsg(r, 'Código de acceso no válido.')); return; }
      if (r.jeton) lsSet('pnr-session', r.jeton);
      $('#a-code-in').value = ''; $('#a-thread').innerHTML = ''; toast('Acceso abierto. Haz tu primera pregunta.'); siteStart();
    }, function(){ b.disabled = false; toast('No se ha podido iniciar sesión. Vuelve a intentarlo.'); });
  });
  $('#a-account').addEventListener('click', function(e){
    var b = e.target.closest('[data-acc]'); if (!b) return;
    if (b.dataset.acc === 'logout') api('/api/logout', {}).then(function(){ lsSet('pnr-session', null); location.reload(); }, function(){ lsSet('pnr-session', null); location.reload(); });
    else api('/api/portal', {lang: pageLang()}).then(function(r){ if (r.url) location.href = r.url; else toast(srvMsg(r, 'Área de suscripción no disponible.')); });
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
  if (text.length > 3000){ toast('Pregunta demasiado larga: 3000 caracteres como máximo.'); return; }
  $('#a-chips').hidden = true;
  bubble('me', text);
  var before = A.turns.slice();
  A.turns.push({role: 'user', content: text + (A.last ? '\n\n[Contexto de la página: último cálculo enviado al motor (' + A.last.type + ') : ' + JSON.stringify(A.last.inputs) + ']' : '')});
  trimTurns();
  var out = bubble('ai', 'Pensando…'), rounds = 0;
  A.ctl = new AbortController();
  $('#a-send').hidden = true; $('#a-stop').hidden = false; setStatus('El asistente está pensando. Puede tardar hasta un minuto.');
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
        bubble('sys', 'El cálculo no se ha completado. Vuelve a formular tu pregunta indicando tus cifras.'); setStatus(''); return;
      }
      if (hasTool && rounds++ < 5){
        var results = r.content.filter(function(b){ return b.type === 'tool_use'; }).map(function(b){
          var t = toolByName(b.name);
          try { if (!t) throw new Error('Herramienta desconocida: ' + b.name); return {type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(t.execute(b.input || {}))}; }
          catch(e){ return {type: 'tool_result', tool_use_id: b.id, content: String(e && e.message || e), is_error: true}; }
        });
        A.turns.push({role: 'user', content: results});
        if (!out) out = bubble('ai', 'Pensando…');
        return step();
      }
      if (out){ out.remove(); out = null; }
      if (r.stop_reason === 'max_tokens') bubble('sys', 'Respuesta cortada: haz una pregunta más corta.');
      if (ACC && ACC.visiteur && ACC.cases_left === 0 && !A.lastFree){ A.lastFree = true; bubble('sys', 'Era tu último cálculo gratis: todavía puedes afinarlo aquí. Para un cálculo nuevo, necesitarás la suscripción.'); }
      setStatus('');
    });
  }
  step().catch(function(e){
    if (out) out.remove();
    A.turns = before;
    if (e && e.name === 'AbortError'){ setStatus('Detenido.'); return; }
    if (e && e.error === 'quota'){ setStatus(''); if (ACC){ ACC.cases_left = 0; ACC.active = false; accountLine(); } showPay(quotaMsg()); return; }
    if (e && (e.error === 'auth' || e.error === 'inactive')){ if (e.error === 'auth') lsSet('pnr-session', null); setStatus(''); showPay(srvMsg(e)); return; }
    if (e && e.error === 'bad_request'){ A.turns = []; A.last = null; bubble('sys', 'Nueva conversación: la anterior era demasiado larga. Vuelve a hacer tu pregunta.'); setStatus(''); return; }
    setStatus(srvMsg(e, 'La respuesta se ha interrumpido. Vuelve a intentarlo.'));
  }).then(function(){ A.ctl = null; $('#a-send').hidden = false; $('#a-stop').hidden = true; $('#a-new').hidden = !A.turns.length || !A.ready; });
}
// nouveau calcul : nouvelle conversation (pour un visiteur, c'est un nouveau calcul offert)
$('#a-new').addEventListener('click', function(){
  if (A.ctl) return;
  A.turns = []; A.last = null; A.lastFree = false; $('#a-thread').innerHTML = ''; this.hidden = true;
  bubble('ai', 'Hola. Dime qué quieres calcular: un producto, una obra o tu tarifa por hora. Te hago las preguntas una a una, y quien calcula es el motor.');
  $('#a-chips').hidden = false; focusChat();
});
$('#a-form').addEventListener('submit', function(e){ e.preventDefault(); var t = $('#a-input').value; $('#a-input').value = ''; ask(t); });
$('#a-input').addEventListener('keydown', function(e){ if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); var t = $('#a-input').value; $('#a-input').value = ''; ask(t); } });
$('#a-stop').addEventListener('click', function(){ if (A.ctl) A.ctl.abort(); });
$$('#a-chips .chip').forEach(function(c){ c.addEventListener('click', function(){ ask(c.textContent); }); });

// ---------- guides ----------
$('#g-list').innerHTML = GUIDES.map(function(g){
  return '<details class="guide"><summary><small>' + esc(g.cat) + '</small><b>' + esc(g.h1) + '</b></summary><div class="body"><p><b>' + esc(g.answer) + '</b></p>' +
    (g.formula ? '<h4>' + esc(g.formulaTitle || 'La fórmula') + '</h4><div class="formula">' + g.formula.map(esc).join('<br>') + '</div>' : '') +
    '<h4>Ejemplo con cifras</h4><p>' + esc(g.example) + '</p>' + (g.extra ? '<p class="mute">' + esc(g.extra) + '</p>' : '') +
    (g.errors ? '<h4>Los errores que cuestan caro</h4><ol>' + g.errors.map(function(e){ return '<li>' + esc(e) + '</li>'; }).join('') + '</ol>' : '') +
    (g.faq ? g.faq.map(function(f){ return '<h4>' + esc(f[0]) + '</h4><p>' + esc(f[1]) + '</p>'; }).join('') : '') +
    '<div class="btn-row"><a class="btn btn-hivis btn-sm" href="#accueil" data-ask="' + g.type + '">Hacer mi cálculo</a></div></div></details>';
}).join('');

// ---------- exposé pour les tests automatiques ----------
window.__PNR_TEST = {coerce: coerce, guard: guard, compact: compact, openFromInputs: openFromInputs, buildInputs: buildInputs, state: function(){ return S; }, trim: function(t){ A.turns = t; trimTurns(); return A.turns; }};

// ---------- démarrage ----------
renderForm(); compute();
if (metierQ && CFG[metierQ]) setType(metierQ);
show(location.hash.slice(1) || 'accueil');
})();
