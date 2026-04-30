/* =========================================================================
   LOGIC RAIL — Poslovni plan kalkulator
   Sva logika izračuna, vizualizacije i PDF generiranja
   ========================================================================= */

let costChartInst, revChartInst, sensChartInst, cfChartInst;
let lastData = null;
let currentLang = (typeof localStorage !== 'undefined' && localStorage.getItem('lr_lang')) || 'hr';
if (!I18N[currentLang]) currentLang = 'hr';

/* ---------- I18N ---------- */
function t(key, vars) {
  let s = (I18N[currentLang] && I18N[currentLang][key] !== undefined)
    ? I18N[currentLang][key]
    : (I18N.hr[key] !== undefined ? I18N.hr[key] : key);
  if (typeof s !== 'string') return s; // arrays etc. pass through
  if (vars) {
    Object.keys(vars).forEach(k => {
      s = s.split('{' + k + '}').join(vars[k]);
    });
  }
  return s;
}

function applyTranslations() {
  document.documentElement.lang = currentLang;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });
  document.querySelectorAll('.lang-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === currentLang);
  });
}

function setLang(lang) {
  if (!I18N[lang]) return;
  currentLang = lang;
  try { localStorage.setItem('lr_lang', lang); } catch (e) {}
  applyTranslations();
  // Re-render dynamic content (hero, tables, charts) so new language applies
  if (lastData) calc();
}

/* ---------- DEFAULT VALUES ---------- */
const DEFAULTS = {
  trains_monthly: 31,
  mix_light: 60,
  empty_weight: 700,
  km_full: 361,
  km_empty: 234,
  trasa_full_light: 450,
  trasa_full_heavy: 550,
  trasa_empty: 380,
  price_station: 13.27,
  num_stations: 2,
  shunting_lj: 2.29,
  el_charge_light: 800,
  el_charge_heavy: 900,
  el_charge_ret: 680,
  extra_empty: 0,
  revenue_full_light: 9650,
  revenue_full_heavy: 10000,
  revenue_empty: 0,
  loco_rent: 52000,
  wage_driver: 5225,
  wage_inspector: 4950,
  wage_mgmt: 7700,
  wage_ops_mgr: 6600,
  dispatch_cost: 500,
  car_cost: 0,
  other_fixed: 2000,
  insurance_cost: 2500
};

/* ---------- HELPERS ---------- */
function v(id) { return parseFloat(document.getElementById(id).value) || 0; }
function fmt(n, dec = 0) {
  return new Intl.NumberFormat('hr-HR', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(n);
}
function fmtEur(n, dec = 2) { return fmt(n, dec) + ' €'; }
function fmtEurK(n) { return fmt(Math.round(n), 0) + ' €'; }

/* ---------- TAB SWITCHING ---------- */
function showTab(id) {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === id);
  });
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  // Charts redraw na promjenu taba (zbog hidden canvas reflow)
  setTimeout(() => calc(), 50);
}

function updMix(val) {
  document.getElementById('mix_light_val').textContent = val + '%';
  document.getElementById('mix_info').textContent = t('field.mixInfo', { light: val, heavy: 100 - val });
  calc();
}

function resetDefaults() {
  Object.entries(DEFAULTS).forEach(([k, val]) => {
    const el = document.getElementById(k);
    if (el) el.value = val;
  });
  document.getElementById('mix_light_val').textContent = DEFAULTS.mix_light + '%';
  document.getElementById('mix_info').textContent = t('field.mixInfo', { light: DEFAULTS.mix_light, heavy: 100 - DEFAULTS.mix_light });
  calc();
  showToast(t('toast.defaultsRestored'), 'success');
}

function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  setTimeout(() => el.classList.remove('show'), 2800);
}

/* =========================================================================
   GLAVNI IZRAČUN
   ========================================================================= */
function calc() {
  // ----- INPUT VALUES -----
  const trains = v('trains_monthly');
  const mixLight = v('mix_light') / 100;        // % lakših vlakova (<2200t bruto)
  const mixHeavy = 1 - mixLight;                 // % težih vlakova (2200-2500t bruto)
  const emptyW = v('empty_weight');
  const kmFull = v('km_full');
  const kmEmpty = v('km_empty');

  const trasaFullLight = v('trasa_full_light');
  const trasaFullHeavy = v('trasa_full_heavy');
  const trasaEmptyBase = v('trasa_empty');
  const priceStation = v('price_station');
  const numStations = v('num_stations');
  const shuntingLj = v('shunting_lj');
  const elChargeLight = v('el_charge_light');
  const elChargeHeavy = v('el_charge_heavy');
  const elChargeRet = v('el_charge_ret');
  const extraEmpty = v('extra_empty');

  const revFullLight = v('revenue_full_light');
  const revFullHeavy = v('revenue_full_heavy');
  const revEmpty = v('revenue_empty');

  // Mix-ponderirane efektivne vrijednosti (za downstream prikaz i kalkulacije)
  const elCharge = elChargeLight * mixLight + elChargeHeavy * mixHeavy;
  const revFull = revFullLight * mixLight + revFullHeavy * mixHeavy;
  const locoRent = v('loco_rent');
  const wageDriver = v('wage_driver');
  const wageInspector = v('wage_inspector');
  const wageMgmt = v('wage_mgmt');
  const wageOpsMgr = v('wage_ops_mgr');
  const dispatchCost = v('dispatch_cost');
  const carCost = v('car_cost');
  const otherFixed = v('other_fixed');
  const insuranceCost = v('insurance_cost');

  // ----- TRASA CALCULATIONS -----
  const avgTrasaFullBase = trasaFullLight * mixLight + trasaFullHeavy * mixHeavy;
  const stationCostFull = priceStation * numStations;
  // El. naknada: lumpsum po smjeru po težinskoj klasi (puni vlak ponderiran po mixu 2200/2500, prazni <800t tier).
  const elFull = elCharge;
  const elEmpty = elChargeRet;
  const totalTrasaFull = avgTrasaFullBase + stationCostFull + shuntingLj + elFull;
  const totalTrasaEmpty = trasaEmptyBase + elEmpty + extraEmpty;
  const trasaPerPair = totalTrasaFull + totalTrasaEmpty;

  // ----- LOCOMOTIVE LOGIC -----
  // Puni vlak (2200/2500t > 1600t) na dijelu LJ-Sežana treba 2 lokomotive,
  // na ostalom dijelu 1 lokomotiva. Prazni povrat (~700t) = 1 lokomotiva cijelim putem.
  // 1.15 = loko-dana po paru za STVARNU vožnju vlakova (puni + prazni, uz LJ-Sežana extension).
  const locoDaysPerPair = 1.15;
  // Aktivno vrijeme lokomotive: 2/3 = vlakovi, 1/3 = lokomotivske vožnje (light running) i čekanje.
  // → faktor 1.5 množi vožnju vlakova da dobijemo ukupno aktivno vrijeme.
  const lightWaitFactor = 1.5;
  const locoDaysActivePerPair = locoDaysPerPair * lightWaitFactor;
  const totalLocoDays = trains * locoDaysActivePerPair;
  // 28 = 30 kalendarskih dana − 2 dana servisa/rezerve mjesečno.
  const locoAvailDays = 28;
  // Start s 2 lokomotive; 3. (i sljedeća) se dodaje tek kad demand zahtijeva.
  const locoNeeded = Math.max(2, Math.ceil(totalLocoDays / locoAvailDays));
  // Najam: fiksni mjesečni iznos po lokomotivi, bez obzira na utilizaciju.
  const locoRentMonthly = locoNeeded * locoRent;
  const locoRentPerPair = locoRentMonthly / Math.max(trains, 1);

  // ----- DRIVERS (1.5 strojovođa po paru efektivno) -----
  // Po paru vlakova: 2 strojovođe na punom (12h) + 1 strojovođa na praznom (12h) = 3 smjene od 12h
  // Korisnik tražio prosjek 1.5 strojovođa po paru za troškovni izračun -> alternativna metrika
  // Praktično: jedan strojovođa može odraditi ~13 vožnji od 12h u mjesecu (160h/mj radnog vremena)
  const drivingShiftsPerPair = 3; // 2 puni + 1 prazni
  const totalDrivingShifts = trains * drivingShiftsPerPair;
  const shiftsPerDriverPerMonth = 13;
  const driversNeeded = Math.max(2, Math.ceil(totalDrivingShifts / shiftsPerDriverPerMonth));

  // ----- INSPECTORS -----
  // 1 pregledač = 1 puni ILI 1 prazni vlak po smjeni (10h)
  // 18 smjena/mj × 1 pregled/smjena = 18 pregleda/mj/pregledač
  // Po paru vlakova = 2 pregleda (puni + prazni) → 1 pregledač pokriva 9 parova/mj.
  // (Bez godišnjeg odmora.)
  const inspectorShiftsPerPair = 2;
  const inspectorShiftsPerMonth = 18;
  const inspectorsNeeded = Math.max(1, Math.ceil(trains * inspectorShiftsPerPair / inspectorShiftsPerMonth));

  // ----- MONTHLY COSTS -----
  const totalTrasaFullMonthly = totalTrasaFull * trains;
  const totalTrasaEmptyMonthly = totalTrasaEmpty * trains;
  const totalTrasaMonthly = totalTrasaFullMonthly + totalTrasaEmptyMonthly;

  const driverWageMonthly = driversNeeded * wageDriver;
  const inspectorWageMonthly = inspectorsNeeded * wageInspector;
  const dispatchMonthly = trains * dispatchCost;
  const carMonthly = trains * carCost;

  // FIKSNI - ne ovise o broju vlakova
  const fixedCosts = wageMgmt + wageOpsMgr + otherFixed + insuranceCost;
  // VARIJABILNI - ovise o broju vlakova (operativni: pregledači sad scale-aju s prometom)
  const varCosts = locoRentMonthly + totalTrasaMonthly + driverWageMonthly + inspectorWageMonthly + dispatchMonthly + carMonthly;

  const totalCosts = fixedCosts + varCosts;

  // ----- REVENUE -----
  const revenueMonthly = trains * revFull + trains * revEmpty;
  const revenuePerPair = revFull + revEmpty;

  // ----- PROFIT -----
  const profit = revenueMonthly - totalCosts;
  const margin = revenueMonthly > 0 ? (profit / revenueMonthly) * 100 : 0;
  const costPerPair = totalCosts / Math.max(trains, 1);
  const breakEven = calcBreakEven({
    revFull, revEmpty, fixedCosts, locoRent, totalTrasaFull, totalTrasaEmpty,
    wageDriver, wageInspector, dispatchCost, carCost, locoAvailDays, locoDaysActivePerPair, shiftsPerDriverPerMonth,
    inspectorShiftsPerPair, inspectorShiftsPerMonth
  });

  // ===== SAVE STATE =====
  lastData = {
    inputs: {
      trains, mixLight, mixHeavy, emptyW, kmFull, kmEmpty,
      trasaFullLight, trasaFullHeavy, trasaEmptyBase, priceStation, numStations,
      shuntingLj, elChargeLight, elChargeHeavy, elCharge, elChargeRet, extraEmpty,
      revFullLight, revFullHeavy, revFull, revEmpty,
      locoRent, wageDriver, wageInspector, wageMgmt, wageOpsMgr, dispatchCost, carCost, otherFixed, insuranceCost
    },
    calc: {
      avgTrasaFullBase, totalTrasaFull, totalTrasaEmpty, trasaPerPair,
      totalLocoDays, locoNeeded, locoAvailDays, locoRentMonthly, locoRentPerPair,
      locoDaysPerPair, lightWaitFactor, locoDaysActivePerPair,
      totalDrivingShifts, driversNeeded, shiftsPerDriverPerMonth, inspectorsNeeded,
      inspectorShiftsPerPair, inspectorShiftsPerMonth,
      totalTrasaFullMonthly, totalTrasaEmptyMonthly, totalTrasaMonthly,
      driverWageMonthly, inspectorWageMonthly, dispatchMonthly, carMonthly,
      fixedCosts, varCosts, totalCosts,
      revenueMonthly, revenuePerPair, profit, margin, costPerPair, breakEven,
      stationCostFull, elFull, elEmpty
    }
  };

  // ===== CASHFLOW (24-month projection) =====
  lastData.cashflow = calcCashflow();

  // ===== UI UPDATES =====
  renderHero();
  renderResources();
  renderCosts();
  renderRevenue();
  renderPlan();
  renderCashflow();
  renderCharts();
}

/* =========================================================================
   CASHFLOW — 24-mjesečna projekcija s realnim vremenskim razmacima
   - Početno stanje (t=0): depozit (2 × locoRent po loko) + najam unaprijed za M1
   - Prihodi: naplaćeni 30 dana nakon usluge → prihod iz mj N stiže u mj N+1
   - Plaće: 10 dana nakon kraja mjeseca → trošak mj N plaća se u mj N+1
   - Najam loko: u tekućem mjesecu (M1 već pokriven inicijalom, M2+ svaki mj)
   - Trase i dispečer: 30 dana nakon mjeseca usluge → mj N → mj N+1
   - Osiguranje, ostali fiksni, automobili: u tekućem mjesecu
   ========================================================================= */
function calcCashflow() {
  const d = lastData.calc;
  const i = lastData.inputs;
  const months = 24;

  // Year-2 escalation factors (applied in months 13-24)
  const ESC_LOCO = 1.02;   // +2% locomotive rent
  const ESC_OPEX = 1.05;   // +5% wages, track access, electricity

  const revM       = d.revenueMonthly;
  const wagesM     = d.driverWageMonthly + d.inspectorWageMonthly + i.wageMgmt + i.wageOpsMgr;
  const trasaM     = d.totalTrasaMonthly;
  const dispatchM  = d.dispatchMonthly;
  const locoRentM  = d.locoRentMonthly;
  const insuranceM = i.insuranceCost;
  const otherFixedM = i.otherFixed;
  const carM       = d.carMonthly;

  // t=0: 2 mj depozit + 1 mj najma unaprijed = 3 × locoRent × locoNeeded
  const initialOutlay = d.locoNeeded * i.locoRent * 3;

  let balance = -initialOutlay;
  let minBalance = balance;
  let minMonth = 0;
  let breakevenMonth = null;

  const rows = [];
  for (let m = 1; m <= months; m++) {
    const isY2 = m > 12;
    const escLoco = isY2 ? ESC_LOCO : 1;
    const escOpex = isY2 ? ESC_OPEX : 1;

    const inflow = m >= 2 ? revM : 0;

    const locoRentOut   = m === 1 ? 0 : locoRentM * escLoco;   // M1 already paid in initial outlay
    const currentMonth  = insuranceM + otherFixedM + carM;
    const wagesPrev     = m >= 2 ? wagesM    * escOpex : 0;
    const trasaPrev     = m >= 2 ? trasaM    * escOpex : 0;
    const dispatchPrev  = m >= 2 ? dispatchM           : 0;

    const outflow = locoRentOut + currentMonth + wagesPrev + trasaPrev + dispatchPrev;
    const net = inflow - outflow;
    balance += net;

    if (balance < minBalance) { minBalance = balance; minMonth = m; }
    if (breakevenMonth === null && balance >= 0) breakevenMonth = m;

    rows.push({
      month: m,
      inflow,
      outflow,
      net,
      balance,
      breakdown: { locoRentOut, currentMonth, wagesPrev, trasaPrev, dispatchPrev }
    });
  }

  return { initialOutlay, rows, minBalance, minMonth, endBalance: balance, breakevenMonth };
}

/* =========================================================================
   BREAK-EVEN CALCULATION
   ========================================================================= */
function calcBreakEven(p) {
  for (let n = 1; n <= 500; n++) {
    const ld = Math.max(2, Math.ceil(n * p.locoDaysActivePerPair / p.locoAvailDays));
    const lrm = ld * p.locoRent;
    const ttm = (p.totalTrasaFull + p.totalTrasaEmpty) * n;
    const ds = Math.max(2, Math.ceil((n * 3) / p.shiftsPerDriverPerMonth));
    const dwm = ds * p.wageDriver;
    const insp = Math.max(1, Math.ceil(n * p.inspectorShiftsPerPair / p.inspectorShiftsPerMonth));
    const iwm = insp * p.wageInspector;
    const disp = n * p.dispatchCost;
    const car = n * p.carCost;
    const tc = lrm + ttm + dwm + iwm + disp + car + p.fixedCosts;
    const rev = n * (p.revFull + p.revEmpty);
    if (rev >= tc) return n;
  }
  return null;
}

/* =========================================================================
   RENDERERS
   ========================================================================= */
function renderHero() {
  const d = lastData.calc;
  const i = lastData.inputs;
  const isProfit = d.profit >= 0;
  const profitClass = isProfit ? 'profit-positive' : 'profit-negative';
  const profitColor = isProfit ? 'green' : 'red';
  const badge = isProfit
    ? `<span class="badge badge-green"><span class="badge-dot"></span>${t('hero.profitable')}</span>`
    : `<span class="badge badge-red"><span class="badge-dot"></span>${t('hero.loss')}</span>`;

  const html = `
    <div class="hero-card profit-card ${profitClass}">
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div>
          <div class="hero-label">${t('hero.profit')}</div>
          <div class="hero-value ${profitColor}">${fmtEurK(d.profit)}</div>
          <div class="hero-sub">${badge} · ${t('hero.margin')} ${fmt(d.margin, 1)}%</div>
        </div>
      </div>
    </div>
    <div class="hero-card">
      <div class="hero-label">${t('hero.revenue')}</div>
      <div class="hero-value">${fmtEurK(d.revenueMonthly)}</div>
      <div class="hero-sub">${t('hero.trainPairs', { n: i.trains })}</div>
    </div>
    <div class="hero-card">
      <div class="hero-label">${t('hero.costs')}</div>
      <div class="hero-value">${fmtEurK(d.totalCosts)}</div>
      <div class="hero-sub">${t('hero.costPerPair', { amount: fmtEurK(d.costPerPair) })}</div>
    </div>
    <div class="hero-card">
      <div class="hero-label">${t('hero.breakEven')}</div>
      <div class="hero-value">${d.breakEven ? d.breakEven : '—'}</div>
      <div class="hero-sub">${t('hero.beTrains')}</div>
    </div>
  `;
  document.getElementById('hero-summary').innerHTML = html;
}

function renderResources() {
  const d = lastData.calc;
  const i = lastData.inputs;

  // Loko alert
  document.getElementById('loko-analysis').innerHTML = `
    <svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path></svg>
    <div>
      <strong>${t('res.alertTitle')}</strong> ${t('res.alertBody', {
        trains: i.trains,
        loco: d.locoNeeded,
        locoDays: fmt(d.totalLocoDays, 1),
        dpp: fmt(d.locoDaysPerPair, 2),
        factor: fmt(d.lightWaitFactor, 2),
        avail: d.locoAvailDays,
        avgW: fmt(i.mixLight * 1850 + i.mixHeavy * 2350, 0),
        emptyW: i.emptyW,
        rent: fmtEurK(i.locoRent),
        total: fmtEurK(d.locoRentMonthly),
        perPair: fmtEurK(d.locoRentPerPair)
      })}
    </div>
  `;

  // Resource cards
  document.getElementById('cards-resources').innerHTML = `
    <div class="metric-tile">
      <svg class="metric-tile-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="14" rx="2"></rect><line x1="3" y1="11" x2="21" y2="11"></line><circle cx="8" cy="17" r="2"></circle><circle cx="16" cy="17" r="2"></circle></svg>
      <div class="metric-tile-label">${t('res.tile.loco')}</div>
      <div class="metric-tile-value">${d.locoNeeded}</div>
      <div class="metric-tile-sub">${fmtEurK(d.locoRentMonthly)}/mj</div>
    </div>
    <div class="metric-tile">
      <svg class="metric-tile-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
      <div class="metric-tile-label">${t('res.tile.drivers')}</div>
      <div class="metric-tile-value">${d.driversNeeded}</div>
      <div class="metric-tile-sub">${fmtEurK(d.driverWageMonthly)}/mj</div>
    </div>
    <div class="metric-tile">
      <svg class="metric-tile-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"></path></svg>
      <div class="metric-tile-label">${t('res.tile.inspectors')}</div>
      <div class="metric-tile-value">${d.inspectorsNeeded}</div>
      <div class="metric-tile-sub">${fmtEurK(d.inspectorWageMonthly)}/mj</div>
    </div>
    <div class="metric-tile">
      <svg class="metric-tile-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>
      <div class="metric-tile-label">${t('res.tile.mgmt')}</div>
      <div class="metric-tile-value">1</div>
      <div class="metric-tile-sub">${fmtEurK(lastData.inputs.wageMgmt)}/mj</div>
    </div>
    <div class="metric-tile">
      <svg class="metric-tile-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
      <div class="metric-tile-label">${t('res.tile.opsMgr')}</div>
      <div class="metric-tile-value">1</div>
      <div class="metric-tile-sub">${fmtEurK(lastData.inputs.wageOpsMgr)}/mj</div>
    </div>
  `;

  // Loko table
  document.getElementById('loko-table').innerHTML = `
    <tr><td>${t('res.loko.r1')}</td><td>${fmt(d.locoDaysPerPair, 2)}</td></tr>
    <tr><td>${t('res.loko.r2')}</td><td>× ${fmt(d.lightWaitFactor, 2)}</td></tr>
    <tr><td>${t('res.loko.r3')}</td><td>${fmt(d.locoDaysActivePerPair, 3)}</td></tr>
    <tr><td>${t('res.loko.r4')}</td><td>${i.trains}</td></tr>
    <tr><td>${t('res.loko.r5')}</td><td>${fmt(d.totalLocoDays, 2)}</td></tr>
    <tr><td>${t('res.loko.r6')}</td><td>${d.locoAvailDays}</td></tr>
    <tr class="total"><td>${t('res.loko.r7')}</td><td>${d.locoNeeded}</td></tr>
    <tr class="subtle"><td>${t('res.loko.r8', { rent: fmtEurK(i.locoRent), n: d.locoNeeded })}</td><td>${fmtEurK(d.locoRentMonthly)}/mj</td></tr>
    <tr class="subtle"><td>${t('res.loko.r9')}</td><td>${fmtEurK(d.locoRentPerPair)}</td></tr>
  `;

  // Drivers table
  document.getElementById('drivers-table').innerHTML = `
    <tr><td>${t('res.drv.r1')}</td><td>${i.trains * 2}</td></tr>
    <tr><td>${t('res.drv.r2')}</td><td>${i.trains}</td></tr>
    <tr><td>${t('res.drv.r3')}</td><td>${d.totalDrivingShifts}</td></tr>
    <tr><td>${t('res.drv.r4')}</td><td>${d.shiftsPerDriverPerMonth}</td></tr>
    <tr class="total"><td>${t('res.drv.r5')}</td><td>${d.driversNeeded}</td></tr>
    <tr class="subtle"><td>${t('res.drv.r6', { wage: fmtEurK(i.wageDriver), n: d.driversNeeded })}</td><td>${fmtEurK(d.driverWageMonthly)}/mj</td></tr>
  `;
}

function renderCosts() {
  const d = lastData.calc;
  const i = lastData.inputs;

  // Cards
  document.getElementById('cards-cost').innerHTML = `
    <div class="metric-tile">
      <div class="metric-tile-label">${t('cst.tile.locoRent')}</div>
      <div class="metric-tile-value">${fmtEurK(d.locoRentMonthly)}</div>
      <div class="metric-tile-sub">${t('cst.percentTotal', { p: fmt(d.locoRentMonthly / d.totalCosts * 100, 1) })}</div>
    </div>
    <div class="metric-tile">
      <div class="metric-tile-label">${t('cst.tile.trasa')}</div>
      <div class="metric-tile-value">${fmtEurK(d.totalTrasaMonthly)}</div>
      <div class="metric-tile-sub">${t('cst.percentTotal', { p: fmt(d.totalTrasaMonthly / d.totalCosts * 100, 1) })}</div>
    </div>
    <div class="metric-tile">
      <div class="metric-tile-label">${t('cst.tile.wages')}</div>
      <div class="metric-tile-value">${fmtEurK(d.driverWageMonthly + d.inspectorWageMonthly + i.wageMgmt + i.wageOpsMgr)}</div>
      <div class="metric-tile-sub">${t('cst.percentTotal', { p: fmt((d.driverWageMonthly + d.inspectorWageMonthly + i.wageMgmt + i.wageOpsMgr) / d.totalCosts * 100, 1) })}</div>
    </div>
    <div class="metric-tile">
      <div class="metric-tile-label">${t('cst.tile.perPair')}</div>
      <div class="metric-tile-value">${fmtEurK(d.costPerPair)}</div>
      <div class="metric-tile-sub">${t('cst.vsRev', { amount: fmtEurK(d.revenuePerPair) })}</div>
    </div>
  `;

  // Fixed costs
  document.getElementById('fixed-costs-table').innerHTML = `
    <tr class="head"><td colspan="2">${t('cst.fixedHead')}</td></tr>
    <tr><td>${t('cst.fc.mgmt')}</td><td>${fmtEurK(i.wageMgmt)}</td></tr>
    <tr><td>${t('cst.fc.opsMgr')}</td><td>${fmtEurK(i.wageOpsMgr)}</td></tr>
    <tr><td>${t('cst.fc.other')}</td><td>${fmtEurK(i.otherFixed)}</td></tr>
    <tr><td>${t('cst.fc.insurance')}</td><td>${fmtEurK(i.insuranceCost)}</td></tr>
    <tr class="total"><td>${t('cst.fc.total')}</td><td>${fmtEurK(d.fixedCosts)}</td></tr>
  `;

  // Var costs
  document.getElementById('var-costs-table').innerHTML = `
    <tr class="head"><td colspan="2">${t('cst.varHead', { n: i.trains })}</td></tr>
    <tr><td>${t('cst.vc.loco', { n: d.locoNeeded, amount: fmtEurK(i.locoRent) })}</td><td>${fmtEurK(d.locoRentMonthly)}</td></tr>
    <tr><td>${t('cst.vc.trasaFull', { n: i.trains, amount: fmtEurK(d.totalTrasaFull) })}</td><td>${fmtEurK(d.totalTrasaFullMonthly)}</td></tr>
    <tr><td>${t('cst.vc.trasaEmpty', { n: i.trains, amount: fmtEurK(d.totalTrasaEmpty) })}</td><td>${fmtEurK(d.totalTrasaEmptyMonthly)}</td></tr>
    <tr><td>${t('cst.vc.drivers', { n: d.driversNeeded, amount: fmtEurK(i.wageDriver) })}</td><td>${fmtEurK(d.driverWageMonthly)}</td></tr>
    <tr><td>${t('cst.vc.inspectors', { n: d.inspectorsNeeded, amount: fmtEurK(i.wageInspector) })}</td><td>${fmtEurK(d.inspectorWageMonthly)}</td></tr>
    <tr><td>${t('cst.vc.dispatch', { n: i.trains, amount: fmtEurK(i.dispatchCost) })}</td><td>${fmtEurK(d.dispatchMonthly)}</td></tr>
    <tr><td>${t('cst.vc.car', { n: i.trains, amount: fmtEurK(i.carCost) })}</td><td>${fmtEurK(d.carMonthly)}</td></tr>
    <tr class="total"><td>${t('cst.vc.total')}</td><td>${fmtEurK(d.varCosts)}</td></tr>
  `;
}

function renderRevenue() {
  const d = lastData.calc;
  const i = lastData.inputs;

  document.getElementById('cards-revenue').innerHTML = `
    <div class="metric-tile">
      <div class="metric-tile-label">${t('rev.tile.monthly')}</div>
      <div class="metric-tile-value" style="color: var(--green)">${fmtEurK(d.revenueMonthly)}</div>
      <div class="metric-tile-sub">${t('rev.tile.monthlySub', { n: i.trains, amount: fmtEurK(i.revFull) })}</div>
    </div>
    <div class="metric-tile">
      <div class="metric-tile-label">${t('rev.tile.trasa')}</div>
      <div class="metric-tile-value">${fmtEurK(d.totalTrasaMonthly)}</div>
      <div class="metric-tile-sub">${t('rev.tile.trasaSub', { p: fmt(d.totalTrasaMonthly / Math.max(d.revenueMonthly, 1) * 100, 1) })}</div>
    </div>
    <div class="metric-tile">
      <div class="metric-tile-label">${t('rev.tile.perTrain')}</div>
      <div class="metric-tile-value" style="color: ${(d.revenuePerPair - d.costPerPair) >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtEurK(d.revenuePerPair - d.costPerPair)}</div>
      <div class="metric-tile-sub">${fmt((d.revenuePerPair - d.costPerPair) / Math.max(d.revenuePerPair, 1) * 100, 1)}%</div>
    </div>
    <div class="metric-tile">
      <div class="metric-tile-label">${t('rev.tile.ebitda')}</div>
      <div class="metric-tile-value" style="color: ${d.margin >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(d.margin, 1)}%</div>
      <div class="metric-tile-sub">${t('rev.tile.ebitdaSub')}</div>
    </div>
  `;

  // Trasa full razrada
  document.getElementById('trasa-full-table').innerHTML = `
    <tr><td>${t('rev.trasaF.r1', { l: fmt(i.mixLight * 100, 0), al: fmtEur(i.trasaFullLight), h: fmt(i.mixHeavy * 100, 0), ah: fmtEur(i.trasaFullHeavy) })}</td><td>${fmtEur(d.avgTrasaFullBase)}</td></tr>
    <tr><td>${t('rev.trasaF.r2', { n: i.numStations, amount: fmtEur(i.priceStation) })}</td><td>${fmtEur(d.stationCostFull)}</td></tr>
    <tr><td>${t('rev.trasaF.r3')}</td><td>${fmtEur(i.shuntingLj)}</td></tr>
    <tr><td>${t('rev.trasaF.r4')}</td><td>${fmtEur(d.elFull)}</td></tr>
    <tr class="total"><td>${t('rev.trasaF.r5')}</td><td>${fmtEur(d.totalTrasaFull)}</td></tr>
    <tr class="subtle"><td>${t('rev.trasaF.r6', { n: i.trains })}</td><td>${fmtEurK(d.totalTrasaFullMonthly)}</td></tr>
  `;

  // Trasa empty razrada
  document.getElementById('trasa-empty-table').innerHTML = `
    <tr><td>${t('rev.trasaE.r1', { kg: i.emptyW })}</td><td>${fmtEur(i.trasaEmptyBase)}</td></tr>
    <tr><td>${t('rev.trasaE.r2')}</td><td>${fmtEur(d.elEmpty)}</td></tr>
    ${i.extraEmpty > 0 ? `<tr><td>${t('rev.trasaE.r3')}</td><td>${fmtEur(i.extraEmpty)}</td></tr>` : ''}
    <tr class="total"><td>${t('rev.trasaE.r4')}</td><td>${fmtEur(d.totalTrasaEmpty)}</td></tr>
    <tr class="subtle"><td>${t('rev.trasaE.r5', { n: i.trains })}</td><td>${fmtEurK(d.totalTrasaEmptyMonthly)}</td></tr>
  `;
}

function renderPlan() {
  const d = lastData.calc;
  const i = lastData.inputs;

  // P&L
  document.getElementById('pl-table').innerHTML = `
    <tr class="head"><td colspan="2">${t('plan.pl.revHead')}</td></tr>
    <tr><td>${t('plan.pl.revLight', { l: fmt(i.mixLight * 100, 0), n: i.trains, amount: fmtEurK(i.revFullLight) })}</td><td>${fmtEurK(i.trains * i.mixLight * i.revFullLight)}</td></tr>
    <tr><td>${t('plan.pl.revHeavy', { h: fmt(i.mixHeavy * 100, 0), n: i.trains, amount: fmtEurK(i.revFullHeavy) })}</td><td>${fmtEurK(i.trains * i.mixHeavy * i.revFullHeavy)}</td></tr>
    ${i.revEmpty > 0 ? `<tr><td>${t('plan.pl.revEmpty', { n: i.trains, amount: fmtEurK(i.revEmpty) })}</td><td>${fmtEurK(i.trains * i.revEmpty)}</td></tr>` : ''}
    <tr class="total"><td>${t('plan.pl.totalRev')}</td><td>${fmtEurK(d.revenueMonthly)}</td></tr>
    <tr class="head"><td colspan="2">${t('plan.pl.expHead')}</td></tr>
    <tr><td>${t('plan.pl.locoRent')}</td><td>${fmtEurK(d.locoRentMonthly)}</td></tr>
    <tr><td>${t('plan.pl.trasa')}</td><td>${fmtEurK(d.totalTrasaMonthly)}</td></tr>
    <tr><td>${t('plan.pl.drivers', { n: d.driversNeeded })}</td><td>${fmtEurK(d.driverWageMonthly)}</td></tr>
    <tr><td>${t('plan.pl.dispatch')}</td><td>${fmtEurK(d.dispatchMonthly)}</td></tr>
    <tr><td>${t('plan.pl.car')}</td><td>${fmtEurK(d.carMonthly)}</td></tr>
    <tr><td>${t('plan.pl.inspectors', { n: d.inspectorsNeeded })}</td><td>${fmtEurK(d.inspectorWageMonthly)}</td></tr>
    <tr><td>${t('plan.pl.mgmt')}</td><td>${fmtEurK(i.wageMgmt)}</td></tr>
    <tr><td>${t('plan.pl.opsMgr')}</td><td>${fmtEurK(i.wageOpsMgr)}</td></tr>
    <tr><td>${t('plan.pl.otherFixed')}</td><td>${fmtEurK(i.otherFixed)}</td></tr>
    <tr><td>${t('plan.pl.insurance')}</td><td>${fmtEurK(i.insuranceCost)}</td></tr>
    <tr class="total"><td>${t('plan.pl.totalExp')}</td><td>${fmtEurK(d.totalCosts)}</td></tr>
    <tr class="total ${d.profit >= 0 ? 'profit' : 'loss'}"><td>${t('plan.pl.profitLoss')}</td><td>${fmtEurK(d.profit)}</td></tr>
    <tr class="subtle"><td>${t('plan.pl.ebitda')}</td><td>${fmt(d.margin, 1)}%</td></tr>
  `;

  // Resources
  document.getElementById('resources-table').innerHTML = `
    <tr class="head"><td colspan="2">${t('plan.res.opStruct')}</td></tr>
    <tr><td>${t('plan.res.loco')}</td><td>${t('plan.res.locoQty', { n: d.locoNeeded })}</td></tr>
    <tr><td>${t('plan.res.drivers')}</td><td>${t('plan.res.driversQty', { n: d.driversNeeded })}</td></tr>
    <tr><td>${t('plan.res.inspectors')}</td><td>${t('plan.res.inspectorsQty', { n: d.inspectorsNeeded })}</td></tr>
    <tr><td>${t('plan.res.mgmt')}</td><td>${t('plan.res.onePerson')}</td></tr>
    <tr><td>${t('plan.res.opsMgr')}</td><td>${t('plan.res.onePerson')}</td></tr>
    <tr><td>${t('plan.res.dispatchers')}</td><td>${t('plan.res.outsource')}</td></tr>
    <tr class="head"><td colspan="2">${t('plan.res.opKpi')}</td></tr>
    <tr><td>${t('plan.res.pairsMonth')}</td><td>${i.trains}</td></tr>
    <tr><td>${t('plan.res.pairsYear')}</td><td>${i.trains * 12}</td></tr>
    <tr><td>${t('plan.res.locoDays')}</td><td>${fmt(d.totalLocoDays, 1)}</td></tr>
    <tr><td>${t('plan.res.driverShifts')}</td><td>${t('plan.res.driverShiftsQty', { n: d.totalDrivingShifts })}</td></tr>
    <tr><td>${t('plan.res.avgWeight')}</td><td>${t('plan.res.avgWeightVal', { kg: fmt(i.mixLight * 1850 + i.mixHeavy * 2350, 0), l: fmt(i.mixLight * 100, 0), h: fmt(i.mixHeavy * 100, 0) })}</td></tr>
    <tr><td>${t('plan.res.perPair')}</td><td>${fmtEurK(d.revenuePerPair)} / ${fmtEurK(d.costPerPair)}</td></tr>
  `;

  // Annual table
  document.getElementById('annual-table').innerHTML = `
    <tr class="head"><td colspan="2">${t('plan.annual.head')}</td></tr>
    <tr><td>${t('plan.annual.rev')}</td><td>${fmtEurK(d.revenueMonthly * 12)}</td></tr>
    <tr><td>${t('plan.annual.costs')}</td><td>${fmtEurK(d.totalCosts * 12)}</td></tr>
    <tr class="total ${d.profit >= 0 ? 'profit' : 'loss'}"><td>${t('plan.annual.profitLoss')}</td><td>${fmtEurK(d.profit * 12)}</td></tr>
    <tr><td>${t('plan.annual.pairs')}</td><td>${t('plan.annual.pairsVal', { n: i.trains * 12 })}</td></tr>
    <tr class="subtle"><td>${t('plan.pl.ebitda')}</td><td>${fmt(d.margin, 1)}%</td></tr>
  `;
}

/* =========================================================================
   CASHFLOW RENDERER (alert + tile-ovi + tablica)
   Chart se crta u renderCharts() radi konzistentnosti s ostalim grafovima.
   ========================================================================= */
function renderCashflow() {
  const d = lastData.calc;
  const i = lastData.inputs;
  const cf = lastData.cashflow;

  // Alert s pretpostavkama modela
  document.getElementById('cf-alert').innerHTML = `
    <svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path></svg>
    <div>
      <strong>${t('cf.alertTitle')}</strong>
      <ul style="margin: 6px 0 0 0; padding-left: 18px; line-height: 1.6;">
        <li>${t('cf.alert.r1')}</li>
        <li>${t('cf.alert.r2')}</li>
        <li>${t('cf.alert.r3')}</li>
        <li>${t('cf.alert.r4')}</li>
        <li>${t('cf.alert.r5')}</li>
        <li>${t('cf.alert.r6')}</li>
        <li>${t('cf.alert.r7')}</li>
        <li>${t('cf.alert.r8')}</li>
      </ul>
    </div>
  `;

  // Hero tile-ovi
  const endColor = cf.endBalance >= 0 ? 'var(--green)' : 'var(--red)';
  const beTileVal = cf.breakevenMonth ? 'M' + cf.breakevenMonth : '—';
  const beTileSub = cf.breakevenMonth ? t('cf.tile.breakevenSub') : t('cf.tile.breakevenNone');

  document.getElementById('cards-cashflow').innerHTML = `
    <div class="metric-tile">
      <div class="metric-tile-label">${t('cf.tile.initial')}</div>
      <div class="metric-tile-value" style="color: var(--red)">${fmtEurK(-cf.initialOutlay)}</div>
      <div class="metric-tile-sub">${t('cf.tile.initialSub')}</div>
    </div>
    <div class="metric-tile">
      <div class="metric-tile-label">${t('cf.tile.minBalance')}</div>
      <div class="metric-tile-value" style="color: var(--red)">${fmtEurK(cf.minBalance)}</div>
      <div class="metric-tile-sub">${t('cf.tile.minBalanceSub', { n: cf.minMonth })}</div>
    </div>
    <div class="metric-tile">
      <div class="metric-tile-label">${t('cf.tile.endBalance')}</div>
      <div class="metric-tile-value" style="color: ${endColor}">${fmtEurK(cf.endBalance)}</div>
      <div class="metric-tile-sub">${t('cf.tile.endBalanceSub')}</div>
    </div>
    <div class="metric-tile">
      <div class="metric-tile-label">${t('cf.tile.breakeven')}</div>
      <div class="metric-tile-value">${beTileVal}</div>
      <div class="metric-tile-sub">${beTileSub}</div>
    </div>
  `;

  // Tablica
  let html = `
    <tr class="head">
      <td>${t('cf.col.month')}</td>
      <td class="num">${t('cf.col.inflow')}</td>
      <td class="num">${t('cf.col.outflow')}</td>
      <td class="num">${t('cf.col.net')}</td>
      <td class="num">${t('cf.col.balance')}</td>
    </tr>
    <tr class="subtle">
      <td>
        ${t('cf.row.initial')}
        <div style="font-size: 11px; color: var(--text-tertiary); margin-top: 2px;">
          ${t('cf.row.initialDesc', { n: d.locoNeeded, rent: fmtEurK(i.locoRent) })}
        </div>
      </td>
      <td class="num">—</td>
      <td class="num" style="color: var(--red)">${fmtEurK(cf.initialOutlay)}</td>
      <td class="num" style="color: var(--red)">${fmtEurK(-cf.initialOutlay)}</td>
      <td class="num" style="color: var(--red)">${fmtEurK(-cf.initialOutlay)}</td>
    </tr>
  `;
  cf.rows.forEach(r => {
    const balanceColor = r.balance >= 0 ? 'var(--green)' : 'var(--red)';
    const netColor = r.net >= 0 ? 'var(--green)' : 'var(--red)';
    html += `
      <tr>
        <td>${t('cf.month', { n: r.month })}</td>
        <td class="num">${r.inflow > 0 ? fmtEurK(r.inflow) : '—'}</td>
        <td class="num" style="color: var(--red)">${fmtEurK(r.outflow)}</td>
        <td class="num" style="color: ${netColor}">${fmtEurK(r.net)}</td>
        <td class="num" style="color: ${balanceColor}">${fmtEurK(r.balance)}</td>
      </tr>
    `;
  });
  document.getElementById('cashflow-table').innerHTML = html;
}

/* =========================================================================
   CHARTS
   ========================================================================= */
Chart.defaults.color = '#9ca3b8';
Chart.defaults.borderColor = '#2a3447';
Chart.defaults.font.family = "'Inter', sans-serif";

function renderCharts() {
  const d = lastData.calc;
  const i = lastData.inputs;

  // COST CHART
  if (costChartInst) costChartInst.destroy();
  const costCtx = document.getElementById('costChart');
  if (costCtx) {
    costChartInst = new Chart(costCtx, {
      type: 'doughnut',
      data: {
        labels: [t('chart.cost.locoRent'), t('chart.cost.trasaFull'), t('chart.cost.trasaEmpty'), t('chart.cost.drivers'), t('chart.cost.dispatcher'), t('chart.cost.car'), t('chart.cost.mgmt'), t('chart.cost.opsMgr'), t('chart.cost.inspectors'), t('chart.cost.other'), t('chart.cost.insurance')],
        datasets: [{
          data: [
            Math.round(d.locoRentMonthly),
            Math.round(d.totalTrasaFullMonthly),
            Math.round(d.totalTrasaEmptyMonthly),
            Math.round(d.driverWageMonthly),
            Math.round(d.dispatchMonthly),
            Math.round(d.carMonthly),
            Math.round(i.wageMgmt),
            Math.round(i.wageOpsMgr),
            Math.round(d.inspectorWageMonthly),
            Math.round(i.otherFixed),
            Math.round(i.insuranceCost)
          ],
          backgroundColor: ['#4f8cff', '#6ba3ff', '#a3c5ff', '#34d399', '#0F6E56', '#059669', '#fbbf24', '#d97706', '#f59e0b', '#6b7390', '#8b5cf6'],
          borderColor: '#1a2030',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: {
              font: { size: 12 },
              padding: 10,
              boxWidth: 14,
              usePointStyle: true,
              pointStyle: 'circle',
              generateLabels: (chart) => {
                const data = chart.data;
                if (data.labels.length && data.datasets.length) {
                  const total = data.datasets[0].data.reduce((a, b) => a + b, 0);
                  return data.labels.map((label, i) => ({
                    text: label + ' — ' + fmt(data.datasets[0].data[i] / total * 100, 1) + '%',
                    fillStyle: data.datasets[0].backgroundColor[i],
                    strokeStyle: data.datasets[0].backgroundColor[i],
                    pointStyle: 'circle',
                    index: i
                  }));
                }
                return [];
              }
            }
          },
          tooltip: {
            callbacks: {
              label: (ctx) => ctx.label + ': ' + fmtEurK(ctx.parsed)
            }
          }
        }
      }
    });
  }

  // REVENUE CHART
  if (revChartInst) revChartInst.destroy();
  const revCtx = document.getElementById('revenueChart');
  if (revCtx) {
    const months = t('months.short');
    revChartInst = new Chart(revCtx, {
      type: 'bar',
      data: {
        labels: months,
        datasets: [
          { label: t('chart.rev.label'), data: months.map(() => Math.round(d.revenueMonthly)), backgroundColor: '#34d399', borderRadius: 4 },
          { label: t('chart.cost.label'), data: months.map(() => Math.round(d.totalCosts)), backgroundColor: '#f87171', borderRadius: 4 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { font: { size: 12 }, usePointStyle: true, padding: 12 } },
          tooltip: { callbacks: { label: (ctx) => ctx.dataset.label + ': ' + fmtEurK(ctx.parsed.y) } }
        },
        scales: {
          y: {
            ticks: { callback: (v) => fmt(v / 1000, 0) + 'k €' },
            grid: { color: '#2a3447' }
          },
          x: { grid: { display: false } }
        }
      }
    });
  }

  // SENSITIVITY CHART
  if (sensChartInst) sensChartInst.destroy();
  const sensCtx = document.getElementById('sensitivityChart');
  if (sensCtx) {
    // Dinamičan raspon: uvijek uključuje korisnikovu trenutnu postavku (i.trains).
    const sensMin = 4;
    const sensMax = Math.max(28, i.trains + 5);
    const range = Array.from({ length: sensMax - sensMin + 1 }, (_, idx) => idx + sensMin);
    const profits = range.map(n => {
      const ld = Math.max(2, Math.ceil(n * d.locoDaysActivePerPair / d.locoAvailDays));
      const lrm = ld * i.locoRent;
      const ttm = (d.totalTrasaFull + d.totalTrasaEmpty) * n;
      const ds = Math.max(2, Math.ceil((n * 3) / d.shiftsPerDriverPerMonth));
      const dwm = ds * i.wageDriver;
      const insp = Math.max(1, Math.ceil(n * d.inspectorShiftsPerPair / d.inspectorShiftsPerMonth));
      const iwm = insp * i.wageInspector;
      const disp = n * i.dispatchCost;
      const car = n * i.carCost;
      const tc = lrm + ttm + dwm + iwm + disp + car + d.fixedCosts;
      const rev = n * (i.revFull + i.revEmpty);
      return Math.round(rev - tc);
    });
    const isCurrent = range.map(n => n === i.trains);

    sensChartInst = new Chart(sensCtx, {
      type: 'bar',
      data: {
        labels: range,
        datasets: [{
          label: t('chart.sens.label'),
          data: profits,
          backgroundColor: profits.map((p, idx) => {
            if (isCurrent[idx]) return p >= 0 ? '#10b981' : '#dc2626';
            return p >= 0 ? '#34d399' : '#f87171';
          }),
          borderColor: isCurrent.map(c => c ? '#fbbf24' : 'transparent'),
          borderWidth: isCurrent.map(c => c ? 3 : 0),
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (ctx) => ctx[0].label + t('chart.sens.tipPairs') + (isCurrent[ctx[0].dataIndex] ? t('chart.sens.tipCurrent') : ''),
              label: (ctx) => t('chart.sens.tipProfit') + fmtEurK(ctx.parsed.y)
            }
          }
        },
        scales: {
          y: {
            ticks: { callback: (v) => fmt(v / 1000, 0) + 'k €' },
            grid: { color: '#2a3447' }
          },
          x: {
            title: { display: true, text: t('chart.sens.xLabel'), color: '#9ca3b8' },
            grid: { display: false },
            ticks: {
              color: (ctx) => range[ctx.index] === i.trains ? '#fbbf24' : '#9ca3b8',
              font: (ctx) => ({ weight: range[ctx.index] === i.trains ? '700' : '400' })
            }
          }
        }
      }
    });
  }

  // CASHFLOW CHART (mixed: bar inflow/outflow + line cumulative balance)
  if (cfChartInst) cfChartInst.destroy();
  const cfCtx = document.getElementById('cashflowChart');
  if (cfCtx && lastData.cashflow) {
    const cf = lastData.cashflow;
    const cfLabels   = cf.rows.map(r => 'M' + r.month);
    const cfInflows  = cf.rows.map(r => Math.round(r.inflow));
    const cfOutflows = cf.rows.map(r => -Math.round(r.outflow));   // negative => below zero
    const cfBalances = cf.rows.map(r => Math.round(r.balance));

    cfChartInst = new Chart(cfCtx, {
      type: 'bar',
      data: {
        labels: cfLabels,
        datasets: [
          { type: 'bar',  label: t('cf.chart.inflow'),  data: cfInflows,  backgroundColor: '#34d399', borderRadius: 3, order: 2 },
          { type: 'bar',  label: t('cf.chart.outflow'), data: cfOutflows, backgroundColor: '#f87171', borderRadius: 3, order: 2 },
          { type: 'line', label: t('cf.chart.balance'), data: cfBalances, borderColor: '#4f8cff', backgroundColor: 'rgba(79,140,255,0.12)', borderWidth: 2, pointRadius: 3, pointBackgroundColor: '#4f8cff', tension: 0.25, fill: false, order: 1 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { font: { size: 12 }, usePointStyle: true, padding: 12 } },
          tooltip: {
            callbacks: {
              label: (ctx) => ctx.dataset.label + ': ' + fmtEurK(ctx.parsed.y)
            }
          }
        },
        scales: {
          y: {
            ticks: { callback: (v) => fmt(v / 1000, 0) + 'k €' },
            grid: { color: '#2a3447' }
          },
          x: { grid: { display: false } }
        }
      }
    });
  }
}

/* =========================================================================
   PDF EXPORT — kompletan poslovni plan
   ========================================================================= */
async function exportPDF() {
  if (!lastData) { showToast(t('toast.calcFirst'), 'error'); return; }
  showToast(t('toast.generating'), '');

  // Render each chart on an offscreen canvas sized to match its PDF box aspect ratio.
  // Avoids responsive-sizing distortion from the live (often hidden) canvases.
  const costImgData = await captureChart(costChartInst, 1240, 800);  // 170×110 mm box
  const revImgData  = await captureChart(revChartInst,  1360, 800);  // 170×100 mm box
  const sensImgData = await captureChart(sensChartInst, 1180, 900);  // 170×130 mm box
  const cfImgData   = await captureChart(cfChartInst,   1500, 800);  // 170×95 mm box (24 month bars + line)

  const routeSvgs = document.querySelectorAll('.route-svg');
  const locoImg1  = routeSvgs[0] ? await svgToDataUrl(routeSvgs[0]) : null;
  const locoImg2  = routeSvgs[1] ? await svgToDataUrl(routeSvgs[1]) : null;

  try {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  doc.setFont('Inter', 'normal');
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  let pageNum = 1;

  const d = lastData.calc;
  const i = lastData.inputs;
  const today = new Date().toLocaleDateString(t('locale'), { day: 'numeric', month: 'long', year: 'numeric' });

  // ===== NASLOVNA STRANICA =====
  // Plavi gornji blok
  doc.setFillColor(31, 64, 145);
  doc.rect(0, 0, pageW, 80, 'F');

  // Logo
  doc.setFillColor(79, 140, 255);
  doc.roundedRect(20, 25, 16, 16, 3, 3, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('Inter', 'bold');
  doc.setFontSize(11);
  doc.text('LR', 28, 35.5, { align: 'center' });

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(28);
  doc.setFont('Inter', 'bold');
  doc.text('Logic Rail', 42, 35);

  doc.setFontSize(11);
  doc.setFont('Inter', 'normal');
  doc.setTextColor(200, 220, 255);
  doc.text(t('pdf.brandTagline'), 42, 43);

  // Naslov dokumenta
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(20);
  doc.setFont('Inter', 'bold');
  doc.text(t('pdf.docTitle'), 20, 65);
  doc.setFontSize(11);
  doc.setFont('Inter', 'normal');
  doc.text(t('pdf.docSub'), 20, 73);

  // Glavni sadržaj naslovne
  doc.setTextColor(20, 30, 40);
  doc.setFontSize(10);
  doc.setFont('Inter', 'normal');
  doc.text(t('pdf.dateLbl'), 20, 100);
  doc.setFont('Inter', 'bold');
  doc.text(today, 50, 100);

  doc.setFont('Inter', 'normal');
  doc.text(t('pdf.versionLbl'), 20, 107);
  doc.setFont('Inter', 'bold');
  doc.text('1.0', 50, 107);

  doc.setFont('Inter', 'normal');
  doc.text(t('pdf.preparedByLbl'), 20, 114);
  doc.setFont('Inter', 'bold');
  doc.text(t('pdf.preparedByVal'), 50, 114);

  // KPI box
  const isProfit = d.profit >= 0;
  doc.setFillColor(245, 248, 253);
  doc.roundedRect(20, 130, pageW - 40, 90, 4, 4, 'F');

  doc.setFontSize(10);
  doc.setFont('Inter', 'bold');
  doc.setTextColor(100, 110, 130);
  doc.text(t('pdf.kpiHead'), 28, 142);

  // KPI grid 2x2
  const kpis = [
    { label: t('pdf.kpi.rev'), val: fmtEurK(d.revenueMonthly), color: [60, 130, 90] },
    { label: t('pdf.kpi.cst'), val: fmtEurK(d.totalCosts), color: [180, 90, 90] },
    { label: t('pdf.kpi.profit'), val: fmtEurK(d.profit), color: isProfit ? [34, 150, 100] : [200, 70, 70] },
    { label: t('pdf.kpi.margin'), val: fmt(d.margin, 1) + '%', color: isProfit ? [34, 150, 100] : [200, 70, 70] }
  ];

  kpis.forEach((kpi, idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const x = 28 + col * 88;
    const y = 152 + row * 32;

    doc.setFontSize(8);
    doc.setFont('Inter', 'bold');
    doc.setTextColor(120, 130, 150);
    doc.text(kpi.label, x, y);

    doc.setFontSize(18);
    doc.setFont('Inter', 'bold');
    doc.setTextColor(...kpi.color);
    doc.text(kpi.val, x, y + 10);
  });

  // Sazetak
  doc.setFontSize(10);
  doc.setFont('Inter', 'bold');
  doc.setTextColor(40, 50, 70);
  doc.text(t('pdf.summaryHead'), 20, 240);

  doc.setFontSize(9);
  doc.setFont('Inter', 'normal');
  doc.setTextColor(60, 70, 90);
  const summaryText = t('pdf.summary', {
    trains: i.trains,
    trainsY: i.trains * 12,
    avgW: fmt(i.mixLight * 1850 + i.mixHeavy * 2350, 0),
    l: fmt(i.mixLight * 100, 0),
    h: fmt(i.mixHeavy * 100, 0),
    loco: d.locoNeeded,
    drivers: d.driversNeeded,
    insp: d.inspectorsNeeded,
    rev: fmtEurK(d.revenueMonthly),
    cst: fmtEurK(d.totalCosts),
    pl: t(isProfit ? 'pdf.summaryProfit' : 'pdf.summaryLoss'),
    profit: fmtEurK(Math.abs(d.profit)),
    margin: fmt(Math.abs(d.margin), 1),
    be: d.breakEven || '>500'
  });
  const splitSummary = doc.splitTextToSize(summaryText, pageW - 40);
  doc.text(splitSummary, 20, 248);

  // Footer naslovne
  doc.setFontSize(8);
  doc.setTextColor(150, 160, 180);
  doc.text(t('pdf.pageLbl') + ' ' + pageNum, pageW / 2, pageH - 10, { align: 'center' });
  pageNum++;

  // ============== STRANICA 2 — UVOD I OPIS ==============
  doc.addPage();
  let y = 20;
  y = drawPageHeader(doc, t('pdf.s1.title'), y);

  doc.setFontSize(10);
  doc.setFont('Inter', 'normal');
  doc.setTextColor(40, 50, 70);
  y = drawText(doc, t('pdf.s1.intro'), 20, y, pageW - 40);
  y += 4;

  y = drawSubheading(doc, t('pdf.s1.opsHead'), y);
  y = drawText(doc, t('pdf.s1.ops'), 20, y, pageW - 40);
  y += 4;

  y = drawSubheading(doc, t('pdf.s1.techHead'), y);
  const technical = [
    [t('pdf.s1.t1'), `${i.kmFull} km`],
    [t('pdf.s1.t2'), `${i.kmEmpty} km`],
    [t('pdf.s1.t3'), t('pdf.s1.t3v')],
    [t('pdf.s1.t4'), t('pdf.s1.t4v', { l: fmt(i.mixLight * 100, 0), h: fmt(i.mixHeavy * 100, 0) })],
    [t('pdf.s1.t5'), t('pdf.s1.t5v', { kg: fmt(i.mixLight * 1850 + i.mixHeavy * 2350, 0) })],
    [t('pdf.s1.t6'), t('pdf.s1.t5v', { kg: i.emptyW })],
    [t('pdf.s1.t7'), t('pdf.s1.t7v')]
  ];
  doc.autoTable({
    startY: y,
    body: technical,
    theme: 'plain',
    styles: { font: 'Inter', fontSize: 9, cellPadding: 2.5, textColor: [40, 50, 70] },
    columnStyles: {
      0: { cellWidth: 90, textColor: [100, 110, 130] },
      1: { cellWidth: 80, fontStyle: 'bold', halign: 'right' }
    },
    didDrawCell: (data) => {
      if (data.section === 'body') {
        doc.setDrawColor(220, 225, 235);
        doc.setLineWidth(0.1);
        doc.line(data.cell.x, data.cell.y + data.cell.height, data.cell.x + data.cell.width, data.cell.y + data.cell.height);
      }
    }
  });
  y = doc.lastAutoTable.finalY + 8;

  y = drawSubheading(doc, t('pdf.s1.locoHead'), y);
  y = drawText(doc, t('pdf.s1.locoBody'), 20, y, pageW - 40);

  // Loco supply route diagrams appended to this page
  if (locoImg1 || locoImg2) {
    y += 5;
    y = drawSubheading(doc, t('card.locoSupply.title'), y);
    y += 2;
    const svgW = pageW - 40;
    const svgH = 35;
    if (locoImg1) { doc.addImage(locoImg1, 'PNG', 20, y, svgW, svgH); y += svgH + 4; }
    if (locoImg2) { doc.addImage(locoImg2, 'PNG', 20, y, svgW, svgH); }
  }

  drawPageFooter(doc, pageNum++);

  // ============== STRANICA 3 — RESURSI ==============
  doc.addPage();
  y = 20;
  y = drawPageHeader(doc, t('pdf.s2.title'), y);

  doc.setFontSize(10);
  doc.setFont('Inter', 'normal');
  y = drawText(doc, t('pdf.s2.intro'), 20, y, pageW - 40);
  y += 4;

  const resourcesData = [
    [t('pdf.r.loco'), t('pdf.r.locoQty', { n: d.locoNeeded }), fmtEurK(d.locoRentMonthly) + '/mj'],
    [t('pdf.r.drivers'), t('pdf.r.driversQty', { n: d.driversNeeded }), fmtEurK(d.driverWageMonthly) + '/mj'],
    [t('pdf.r.inspectors'), t('pdf.r.driversQty', { n: d.inspectorsNeeded }), fmtEurK(d.inspectorWageMonthly) + '/mj'],
    [t('pdf.r.mgmt'), t('pdf.r.onePerson'), fmtEurK(i.wageMgmt) + '/mj'],
    [t('pdf.r.opsMgr'), t('pdf.r.onePerson'), fmtEurK(i.wageOpsMgr) + '/mj'],
    [t('pdf.r.dispatchers'), t('pdf.r.dispatchersQty', { n: i.trains }), fmtEurK(d.dispatchMonthly) + '/mj']
  ];
  doc.autoTable({
    startY: y,
    head: [[t('pdf.col.resource'), t('pdf.col.qty'), t('pdf.col.monthly')]],
    body: resourcesData,
    theme: 'striped',
    headStyles: { font: 'Inter', fillColor: [31, 64, 145], textColor: [255, 255, 255], fontSize: 9, fontStyle: 'bold' },
    styles: { font: 'Inter', fontSize: 9, cellPadding: 3 },
    columnStyles: { 2: { halign: 'right', fontStyle: 'bold' } }
  });
  y = doc.lastAutoTable.finalY + 8;

  y = drawSubheading(doc, t('pdf.s2.locoHead'), y);
  doc.autoTable({
    startY: y,
    body: [
      [t('pdf.s2.lc1'), fmt(d.locoDaysPerPair, 2)],
      [t('pdf.s2.lc2'), '× ' + fmt(d.lightWaitFactor, 2)],
      [t('pdf.s2.lc3'), fmt(d.locoDaysActivePerPair, 3)],
      [t('pdf.s2.lc4'), String(i.trains)],
      [t('pdf.s2.lc5'), fmt(d.totalLocoDays, 2)],
      [t('pdf.s2.lc6'), String(d.locoAvailDays)],
      [t('pdf.s2.lc7'), String(d.locoNeeded)],
      [t('pdf.s2.lc8'), fmtEurK(i.locoRent)],
      [t('pdf.s2.lc9'), fmtEurK(d.locoRentPerPair)],
      [t('pdf.s2.lc10'), fmtEurK(d.locoRentMonthly)]
    ],
    theme: 'plain',
    styles: { font: 'Inter', fontSize: 9, cellPadding: 2.5 },
    columnStyles: {
      0: { cellWidth: 100, textColor: [100, 110, 130] },
      1: { cellWidth: 70, halign: 'right', fontStyle: 'bold' }
    },
    didParseCell: (data) => {
      if (data.row.index === 6) {
        data.cell.styles.fillColor = [240, 245, 252];
        data.cell.styles.textColor = [31, 64, 145];
      }
    }
  });
  y = doc.lastAutoTable.finalY + 8;

  y = drawSubheading(doc, t('pdf.s2.drvHead'), y);
  doc.autoTable({
    startY: y,
    body: [
      [t('pdf.s2.dc1'), String(i.trains * 2)],
      [t('pdf.s2.dc2'), String(i.trains)],
      [t('pdf.s2.dc3'), String(d.totalDrivingShifts)],
      [t('pdf.s2.dc4'), String(d.shiftsPerDriverPerMonth)],
      [t('pdf.s2.dc5'), String(d.driversNeeded)],
      [t('pdf.s2.dc6'), fmtEurK(i.wageDriver)],
      [t('pdf.s2.dc7'), fmtEurK(d.driverWageMonthly)]
    ],
    theme: 'plain',
    styles: { font: 'Inter', fontSize: 9, cellPadding: 2.5 },
    columnStyles: {
      0: { cellWidth: 100, textColor: [100, 110, 130] },
      1: { cellWidth: 70, halign: 'right', fontStyle: 'bold' }
    },
    didParseCell: (data) => {
      if (data.row.index === 6) {
        data.cell.styles.fillColor = [240, 245, 252];
        data.cell.styles.textColor = [31, 64, 145];
      }
    }
  });

  drawPageFooter(doc, pageNum++);

  // ============== STRANICA 4 — TROŠKOVI ==============
  doc.addPage();
  y = 20;
  y = drawPageHeader(doc, t('pdf.s3.title'), y);

  doc.setFontSize(10);
  y = drawText(doc, t('pdf.s3.intro'), 20, y, pageW - 40);
  y += 4;

  y = drawSubheading(doc, t('pdf.s3.fixedHead'), y);
  doc.autoTable({
    startY: y,
    head: [[t('pdf.col.item'), t('pdf.col.amount')]],
    body: [
      [t('pdf.s3.fc1'), fmtEurK(i.wageMgmt)],
      [t('pdf.s3.fc2'), fmtEurK(i.wageOpsMgr)],
      [t('pdf.s3.fc3', { n: d.inspectorsNeeded, amount: fmtEurK(i.wageInspector) }), fmtEurK(d.inspectorWageMonthly)],
      [t('pdf.s3.fc4'), fmtEurK(i.otherFixed)],
      [t('pdf.s3.fc_ins'), fmtEurK(i.insuranceCost)],
      [t('pdf.s3.fc5'), fmtEurK(d.fixedCosts)]
    ],
    theme: 'striped',
    headStyles: { font: 'Inter', fillColor: [31, 64, 145], textColor: [255, 255, 255], fontSize: 9 },
    styles: { font: 'Inter', fontSize: 9, cellPadding: 3 },
    columnStyles: { 1: { halign: 'right' } },
    didParseCell: (data) => {
      if (data.row.index === 3 && data.section === 'body') {
        data.cell.styles.fillColor = [240, 245, 252];
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.textColor = [31, 64, 145];
      }
    }
  });
  y = doc.lastAutoTable.finalY + 8;

  y = drawSubheading(doc, t('pdf.s3.varHead'), y);
  doc.autoTable({
    startY: y,
    head: [[t('pdf.col.item'), t('pdf.col.amount')]],
    body: [
      [t('pdf.s3.vc1', { n: d.locoNeeded, amount: fmtEurK(i.locoRent) }), fmtEurK(d.locoRentMonthly)],
      [t('pdf.s3.vc2', { n: i.trains, amount: fmtEur(d.totalTrasaFull) }), fmtEurK(d.totalTrasaFullMonthly)],
      [t('pdf.s3.vc3', { n: i.trains, amount: fmtEur(d.totalTrasaEmpty) }), fmtEurK(d.totalTrasaEmptyMonthly)],
      [t('pdf.s3.vc4', { n: d.driversNeeded, amount: fmtEurK(i.wageDriver) }), fmtEurK(d.driverWageMonthly)],
      [t('pdf.s3.vc5', { n: i.trains, amount: fmtEurK(i.dispatchCost) }), fmtEurK(d.dispatchMonthly)],
      [t('pdf.s3.vc_car', { n: i.trains, amount: fmtEurK(i.carCost) }), fmtEurK(d.carMonthly)],
      [t('pdf.s3.vc6'), fmtEurK(d.varCosts)]
    ],
    theme: 'striped',
    headStyles: { font: 'Inter', fillColor: [31, 64, 145], textColor: [255, 255, 255], fontSize: 9 },
    styles: { font: 'Inter', fontSize: 9, cellPadding: 3 },
    columnStyles: { 1: { halign: 'right' } },
    didParseCell: (data) => {
      if (data.row.index === 6 && data.section === 'body') {
        data.cell.styles.fillColor = [240, 245, 252];
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.textColor = [31, 64, 145];
      }
    }
  });
  y = doc.lastAutoTable.finalY + 8;

  y = drawSubheading(doc, t('pdf.s3.trasaHead'), y);
  doc.setFontSize(9);
  doc.setFont('Inter', 'bold');
  doc.setTextColor(31, 64, 145);
  doc.text(t('pdf.s3.fullSub', { km: i.kmFull }), 20, y);
  y += 5;
  doc.autoTable({
    startY: y,
    body: [
      [t('pdf.s3.tFull1', { l: fmt(i.mixLight * 100, 0), al: fmtEur(i.trasaFullLight), h: fmt(i.mixHeavy * 100, 0), ah: fmtEur(i.trasaFullHeavy) }), fmtEur(d.avgTrasaFullBase)],
      [t('pdf.s3.tFull2', { n: i.numStations, amount: fmtEur(i.priceStation) }), fmtEur(d.stationCostFull)],
      [t('pdf.s3.tFull3'), fmtEur(i.shuntingLj)],
      [t('pdf.s3.tFull4'), fmtEur(d.elFull)],
      [t('pdf.s3.tFull5'), fmtEur(d.totalTrasaFull)]
    ],
    theme: 'plain',
    styles: { font: 'Inter', fontSize: 8.5, cellPadding: 2 },
    columnStyles: {
      0: { cellWidth: 120, textColor: [100, 110, 130] },
      1: { cellWidth: 50, halign: 'right', fontStyle: 'bold' }
    },
    didParseCell: (data) => {
      if (data.row.index === 4) {
        data.cell.styles.fillColor = [240, 245, 252];
        data.cell.styles.textColor = [31, 64, 145];
      }
    }
  });
  y = doc.lastAutoTable.finalY + 5;

  doc.setFontSize(9);
  doc.setFont('Inter', 'bold');
  doc.setTextColor(31, 64, 145);
  doc.text(t('pdf.s3.emptySub', { km: i.kmEmpty }), 20, y);
  y += 5;
  doc.autoTable({
    startY: y,
    body: [
      [t('pdf.s3.tEmpty1', { kg: i.emptyW }), fmtEur(i.trasaEmptyBase)],
      [t('pdf.s3.tEmpty2'), fmtEur(d.elEmpty)],
      [t('pdf.s3.tEmpty3'), fmtEur(d.totalTrasaEmpty)]
    ],
    theme: 'plain',
    styles: { font: 'Inter', fontSize: 8.5, cellPadding: 2 },
    columnStyles: {
      0: { cellWidth: 120, textColor: [100, 110, 130] },
      1: { cellWidth: 50, halign: 'right', fontStyle: 'bold' }
    },
    didParseCell: (data) => {
      if (data.row.index === 2) {
        data.cell.styles.fillColor = [240, 245, 252];
        data.cell.styles.textColor = [31, 64, 145];
      }
    }
  });

  drawPageFooter(doc, pageNum++);

  // ============== NOVA STRANICA — STRUKTURA TROŠKOVA (grafikon) ==============
  doc.addPage();
  y = 20;
  y = drawPageHeader(doc, t('card.costStructure.title'), y);
  doc.setFont('Inter', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 110, 130);
  doc.text(t('card.costStructure.sub'), 20, y);
  y += 10;
  doc.addImage(costImgData, 'PNG', 20, y, pageW - 40, 110);
  drawPageFooter(doc, pageNum++);

  // ============== STRANICA 5 — RAČUN DOBITI I GUBITKA ==============
  doc.addPage();
  y = 20;
  y = drawPageHeader(doc, t('pdf.s4.title'), y);

  doc.setFontSize(10);
  y = drawText(doc, t('pdf.s4.intro'), 20, y, pageW - 40);
  y += 4;

  const plBody = [];
  plBody.push([{ content: t('pdf.s4.revHead'), colSpan: 2, styles: { fillColor: [220, 230, 245], fontStyle: 'bold', textColor: [31, 64, 145] } }]);
  plBody.push([t('pdf.s4.revLight', { l: fmt(i.mixLight * 100, 0), n: i.trains, amount: fmtEurK(i.revFullLight) }), fmtEurK(i.trains * i.mixLight * i.revFullLight)]);
  plBody.push([t('pdf.s4.revHeavy', { h: fmt(i.mixHeavy * 100, 0), n: i.trains, amount: fmtEurK(i.revFullHeavy) }), fmtEurK(i.trains * i.mixHeavy * i.revFullHeavy)]);
  if (i.revEmpty > 0) plBody.push([t('pdf.s4.revEmpty', { n: i.trains, amount: fmtEurK(i.revEmpty) }), fmtEurK(i.trains * i.revEmpty)]);
  plBody.push([{ content: t('pdf.s4.totalRev'), styles: { fontStyle: 'bold' } }, { content: fmtEurK(d.revenueMonthly), styles: { fontStyle: 'bold' } }]);
  plBody.push([{ content: t('pdf.s4.expHead'), colSpan: 2, styles: { fillColor: [220, 230, 245], fontStyle: 'bold', textColor: [31, 64, 145] } }]);
  plBody.push([t('pdf.s4.locoRent'), fmtEurK(d.locoRentMonthly)]);
  plBody.push([t('pdf.s4.trasa'), fmtEurK(d.totalTrasaMonthly)]);
  plBody.push([t('pdf.s4.drivers', { n: d.driversNeeded }), fmtEurK(d.driverWageMonthly)]);
  plBody.push([t('pdf.s4.dispatch'), fmtEurK(d.dispatchMonthly)]);
  plBody.push([t('pdf.s4.car'), fmtEurK(d.carMonthly)]);
  plBody.push([t('pdf.s4.inspectors', { n: d.inspectorsNeeded }), fmtEurK(d.inspectorWageMonthly)]);
  plBody.push([t('pdf.s4.mgmt'), fmtEurK(i.wageMgmt)]);
  plBody.push([t('pdf.s4.opsMgr'), fmtEurK(i.wageOpsMgr)]);
  plBody.push([t('pdf.s4.otherFixed'), fmtEurK(i.otherFixed)]);
  plBody.push([t('pdf.s4.insurance'), fmtEurK(i.insuranceCost)]);
  plBody.push([{ content: t('pdf.s4.totalExp'), styles: { fontStyle: 'bold' } }, { content: fmtEurK(d.totalCosts), styles: { fontStyle: 'bold' } }]);
  plBody.push([
    { content: t('pdf.s4.profitLoss'), styles: { fontStyle: 'bold', fontSize: 11, fillColor: isProfit ? [220, 245, 230] : [250, 230, 230], textColor: isProfit ? [30, 130, 80] : [180, 50, 50] } },
    { content: fmtEurK(d.profit), styles: { fontStyle: 'bold', fontSize: 11, fillColor: isProfit ? [220, 245, 230] : [250, 230, 230], textColor: isProfit ? [30, 130, 80] : [180, 50, 50] } }
  ]);
  plBody.push([{ content: t('pdf.s4.margin'), styles: { textColor: [100, 110, 130] } }, { content: fmt(d.margin, 1) + '%', styles: { textColor: [100, 110, 130], fontStyle: 'bold' } }]);

  doc.autoTable({
    startY: y,
    body: plBody,
    theme: 'plain',
    styles: { font: 'Inter', fontSize: 9.5, cellPadding: 3 },
    columnStyles: { 1: { halign: 'right' } },
    didDrawCell: (data) => {
      if (data.section === 'body' && data.row.raw[0].colSpan !== 2) {
        doc.setDrawColor(220, 225, 235);
        doc.setLineWidth(0.1);
        doc.line(data.cell.x, data.cell.y + data.cell.height, data.cell.x + data.cell.width, data.cell.y + data.cell.height);
      }
    }
  });
  y = doc.lastAutoTable.finalY + 8;

  y = drawSubheading(doc, t('pdf.s4.annualHead'), y);
  doc.autoTable({
    startY: y,
    body: [
      [t('pdf.s4.annualRev'), fmtEurK(d.revenueMonthly * 12)],
      [t('pdf.s4.annualCst'), fmtEurK(d.totalCosts * 12)],
      [t('pdf.s4.annualPL'), fmtEurK(d.profit * 12)],
      [t('pdf.s4.annualPairs'), String(i.trains * 12)]
    ],
    theme: 'plain',
    styles: { font: 'Inter', fontSize: 9.5, cellPadding: 3 },
    columnStyles: {
      0: { textColor: [100, 110, 130] },
      1: { halign: 'right', fontStyle: 'bold' }
    },
    didParseCell: (data) => {
      if (data.row.index === 2) {
        data.cell.styles.fillColor = isProfit ? [220, 245, 230] : [250, 230, 230];
        data.cell.styles.textColor = isProfit ? [30, 130, 80] : [180, 50, 50];
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fontSize = 11;
      }
    }
  });
  y = doc.lastAutoTable.finalY + 8;

  // Per-train kalkulacija
  y = drawSubheading(doc, t('pdf.s4.marginHead'), y);
  doc.autoTable({
    startY: y,
    body: [
      [t('pdf.s4.mPair1'), fmtEurK(d.revenuePerPair)],
      [t('pdf.s4.mPair2'), fmtEurK(d.costPerPair)],
      [t('pdf.s4.mPair3'), fmtEurK(d.revenuePerPair - d.costPerPair)],
      [t('pdf.s4.mPair4'), fmt((d.revenuePerPair - d.costPerPair) / Math.max(d.revenuePerPair, 1) * 100, 1) + '%']
    ],
    theme: 'plain',
    styles: { font: 'Inter', fontSize: 9.5, cellPadding: 3 },
    columnStyles: {
      0: { textColor: [100, 110, 130] },
      1: { halign: 'right', fontStyle: 'bold' }
    }
  });

  drawPageFooter(doc, pageNum++);

  // ============== NOVA STRANICA — PRIHOD VS TROŠKOVI (grafikon) ==============
  doc.addPage();
  y = 20;
  y = drawPageHeader(doc, t('card.revVsCost.title'), y);
  doc.setFont('Inter', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 110, 130);
  doc.text(t('card.revVsCost.sub'), 20, y);
  y += 10;
  doc.addImage(revImgData, 'PNG', 20, y, pageW - 40, 100);
  drawPageFooter(doc, pageNum++);

  // ============== STRANICA 6 — ANALIZA OSJETLJIVOSTI ==============
  doc.addPage();
  y = 20;
  y = drawPageHeader(doc, t('pdf.s5.title'), y);

  doc.setFontSize(10);
  y = drawText(doc, t('pdf.s5.intro', { be: d.breakEven || '>500' }), 20, y, pageW - 40);
  y += 4;

  // Sensitivity table
  y = drawSubheading(doc, t('pdf.s5.tblHead'), y);
  const sensRange = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100];
  const sensBody = sensRange.map(n => {
    const ld = Math.max(2, Math.ceil(n * d.locoDaysActivePerPair / d.locoAvailDays));
    const lrm = ld * i.locoRent;
    const ttm = (d.totalTrasaFull + d.totalTrasaEmpty) * n;
    const ds = Math.max(2, Math.ceil((n * 3) / d.shiftsPerDriverPerMonth));
    const dwm = ds * i.wageDriver;
    const insp = Math.max(1, Math.ceil(n * d.inspectorShiftsPerPair / d.inspectorShiftsPerMonth));
    const iwm = insp * i.wageInspector;
    const disp = n * i.dispatchCost;
    const car = n * i.carCost;
    const tc = lrm + ttm + dwm + iwm + disp + car + d.fixedCosts;
    const rev = n * (i.revFull + i.revEmpty);
    const p = rev - tc;
    return [String(n), fmtEurK(rev), fmtEurK(tc), fmtEurK(p), p >= 0 ? t('pdf.statusProfit') : t('pdf.statusLoss')];
  });
  doc.autoTable({
    startY: y,
    head: [[t('pdf.col.pairs'), t('pdf.col.rev'), t('pdf.col.cst'), t('pdf.col.pl'), t('pdf.col.status')]],
    body: sensBody,
    theme: 'striped',
    headStyles: { font: 'Inter', fillColor: [31, 64, 145], textColor: [255, 255, 255], fontSize: 9 },
    styles: { font: 'Inter', fontSize: 9, cellPadding: 2.5 },
    columnStyles: {
      0: { halign: 'center', cellWidth: 25 },
      1: { halign: 'right' },
      2: { halign: 'right' },
      3: { halign: 'right', fontStyle: 'bold' },
      4: { halign: 'center', cellWidth: 25 }
    },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 4) {
        if (data.cell.raw === t('pdf.statusProfit')) {
          data.cell.styles.textColor = [30, 130, 80];
          data.cell.styles.fontStyle = 'bold';
        } else {
          data.cell.styles.textColor = [180, 50, 50];
          data.cell.styles.fontStyle = 'bold';
        }
      }
    }
  });
  y = doc.lastAutoTable.finalY + 10;

  y = drawSubheading(doc, t('pdf.s5.risksHead'), y);
  const risks = [
    t('pdf.s5.r1'),
    t('pdf.s5.r2', { amount: fmtEurK(i.locoRent) }),
    t('pdf.s5.r3'),
    t('pdf.s5.r4'),
    t('pdf.s5.r5'),
    t('pdf.s5.r6')
  ];
  doc.setFontSize(9.5);
  doc.setFont('Inter', 'normal');
  doc.setTextColor(40, 50, 70);
  risks.forEach(r => {
    doc.text('•', 22, y);
    const lines = doc.splitTextToSize(r, pageW - 50);
    doc.text(lines, 28, y);
    y += lines.length * 5 + 1;
  });
  y += 4;

  y = drawSubheading(doc, t('pdf.s5.conclHead'), y);
  const conclusion = t('pdf.s5.concl', {
    trains: i.trains,
    rev: fmtEurK(i.revFull),
    rent: fmtEurK(i.locoRent),
    pl: t(isProfit ? 'pdf.s5.cProfit' : 'pdf.s5.cLoss'),
    profit: fmtEurK(Math.abs(d.profit)),
    margin: fmt(Math.abs(d.margin), 1),
    sign: t(isProfit ? 'pdf.s5.cPos' : 'pdf.s5.cNeg'),
    profitable: t(isProfit ? 'pdf.s5.cIsProfit' : 'pdf.s5.cIsLoss'),
    lever: d.breakEven ? t('pdf.s5.cLeverBE', { be: d.breakEven }) : t('pdf.s5.cLeverNoBE')
  });
  y = drawText(doc, conclusion, 20, y, pageW - 40);

  drawPageFooter(doc, pageNum++);

  // ============== NOVA STRANICA — ANALIZA OSJETLJIVOSTI (grafikon) ==============
  doc.addPage();
  y = 20;
  y = drawPageHeader(doc, t('card.sens.title'), y);
  doc.setFont('Inter', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 110, 130);
  doc.text(t('card.sens.sub'), 20, y);
  y += 10;
  doc.addImage(sensImgData, 'PNG', 20, y, pageW - 40, 130);
  drawPageFooter(doc, pageNum++);

  // ============== NOVA STRANICA — TIJEK NOVCA (intro + KPI + chart) ==============
  const cf = lastData.cashflow;
  doc.addPage();
  y = 20;
  y = drawPageHeader(doc, t('pdf.s_cf.title'), y);

  doc.setFontSize(10);
  doc.setFont('Inter', 'normal');
  doc.setTextColor(40, 50, 70);
  y = drawText(doc, t('pdf.s_cf.intro'), 20, y, pageW - 40);
  y += 4;

  // KPI tablica (4 ključne brojke)
  y = drawSubheading(doc, t('pdf.s_cf.kpiHead'), y);
  const beVal = cf.breakevenMonth ? 'M' + cf.breakevenMonth : t('cf.tile.breakevenNone');
  doc.autoTable({
    startY: y,
    body: [
      [t('cf.tile.initial'), fmtEurK(-cf.initialOutlay)],
      [t('cf.tile.minBalance') + ' (M' + cf.minMonth + ')', fmtEurK(cf.minBalance)],
      [t('cf.tile.breakeven'), beVal],
      [t('cf.tile.endBalance'), fmtEurK(cf.endBalance)]
    ],
    theme: 'plain',
    styles: { font: 'Inter', fontSize: 9.5, cellPadding: 3 },
    columnStyles: {
      0: { textColor: [100, 110, 130] },
      1: { halign: 'right', fontStyle: 'bold' }
    },
    didParseCell: (data) => {
      if (data.column.index === 1) {
        if (data.row.index === 0 || data.row.index === 1) {
          data.cell.styles.textColor = [180, 50, 50];
        } else if (data.row.index === 3) {
          data.cell.styles.textColor = cf.endBalance >= 0 ? [30, 130, 80] : [180, 50, 50];
        } else if (data.row.index === 2) {
          data.cell.styles.textColor = cf.breakevenMonth ? [30, 130, 80] : [120, 130, 150];
        }
      }
    }
  });
  y = doc.lastAutoTable.finalY + 6;

  // Cashflow grafikon
  if (cfImgData) {
    doc.addImage(cfImgData, 'PNG', 20, y, pageW - 40, 95);
    y += 95 + 4;
  }

  drawPageFooter(doc, pageNum++);

  // ============== NOVA STRANICA — TIJEK NOVCA (pretpostavke + tablica) ==============
  doc.addPage();
  y = 20;
  y = drawPageHeader(doc, t('pdf.s_cf.title'), y);

  // Pretpostavke (kompaktni bullets)
  y = drawSubheading(doc, t('pdf.s_cf.assumpHead'), y);
  doc.setFontSize(9);
  doc.setFont('Inter', 'normal');
  doc.setTextColor(40, 50, 70);
  const cfAssumptions = [
    t('cf.alert.r1'),
    t('cf.alert.r2'),
    t('cf.alert.r3'),
    t('cf.alert.r4'),
    t('cf.alert.r5'),
    t('cf.alert.r6'),
    t('cf.alert.r7'),
    t('cf.alert.r8')
  ];
  cfAssumptions.forEach(line => {
    doc.text('•', 22, y);
    const lines = doc.splitTextToSize(line, pageW - 50);
    doc.text(lines, 28, y);
    y += lines.length * 4.5 + 0.5;
  });
  y += 4;

  // Tablica
  y = drawSubheading(doc, t('pdf.s_cf.tblHead'), y);
  doc.setFontSize(8.5);
  doc.setTextColor(120, 130, 150);
  doc.text(t('pdf.s_cf.tblNote'), 20, y);
  y += 5;

  const cfTblHead = [[t('cf.col.month'), t('cf.col.inflow'), t('cf.col.outflow'), t('cf.col.net'), t('cf.col.balance')]];
  const cfTblBody = [
    [t('cf.row.initial'), '—', fmtEurK(cf.initialOutlay), fmtEurK(-cf.initialOutlay), fmtEurK(-cf.initialOutlay)]
  ].concat(cf.rows.map(r => [
    'M' + r.month,
    r.inflow > 0 ? fmtEurK(r.inflow) : '—',
    fmtEurK(r.outflow),
    fmtEurK(r.net),
    fmtEurK(r.balance)
  ]));

  doc.autoTable({
    startY: y,
    head: cfTblHead,
    body: cfTblBody,
    theme: 'striped',
    headStyles: { font: 'Inter', fillColor: [31, 64, 145], textColor: [255, 255, 255], fontSize: 8.5, fontStyle: 'bold', halign: 'center' },
    styles: { font: 'Inter', fontSize: 8, cellPadding: 1.8 },
    columnStyles: {
      0: { cellWidth: 24, fontStyle: 'bold', textColor: [60, 70, 90] },
      1: { halign: 'right' },
      2: { halign: 'right', textColor: [180, 50, 50] },
      3: { halign: 'right' },
      4: { halign: 'right', fontStyle: 'bold' }
    },
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      // First row (initial state) — sve crveno
      if (data.row.index === 0) {
        if (data.column.index >= 2) data.cell.styles.textColor = [180, 50, 50];
        return;
      }
      // Months: net column (3) i balance column (4) coloured by sign
      const r = cf.rows[data.row.index - 1];
      if (!r) return;
      if (data.column.index === 3) {
        data.cell.styles.textColor = r.net >= 0 ? [30, 130, 80] : [180, 50, 50];
      }
      if (data.column.index === 4) {
        data.cell.styles.textColor = r.balance >= 0 ? [30, 130, 80] : [180, 50, 50];
      }
    }
  });

  drawPageFooter(doc, pageNum++);

  // ============== STRANICA 7 — ULAZNI PARAMETRI ==============
  doc.addPage();
  y = 20;
  y = drawPageHeader(doc, t('pdf.s6.title'), y);

  doc.setFontSize(10);
  y = drawText(doc, t('pdf.s6.intro'), 20, y, pageW - 40);
  y += 4;

  y = drawSubheading(doc, t('pdf.s6.opHead'), y);
  doc.autoTable({
    startY: y,
    body: [
      [t('pdf.s6.op1'), String(i.trains)],
      [t('pdf.s6.op2'), `${fmt(i.mixLight * 100, 0)}% / ${fmt(i.mixHeavy * 100, 0)}%`],
      [t('pdf.s6.op3'), `${i.emptyW} t`],
      [t('pdf.s6.op4'), `${i.kmFull} km`],
      [t('pdf.s6.op5'), `${i.kmEmpty} km`]
    ],
    theme: 'plain',
    styles: { font: 'Inter', fontSize: 9, cellPadding: 2.5 },
    columnStyles: {
      0: { cellWidth: 90, textColor: [100, 110, 130] },
      1: { cellWidth: 80, halign: 'right', fontStyle: 'bold' }
    }
  });
  y = doc.lastAutoTable.finalY + 8;

  y = drawSubheading(doc, t('pdf.s6.priceHead'), y);
  doc.autoTable({
    startY: y,
    body: [
      [t('pdf.s6.p1'), fmtEur(i.trasaFullLight)],
      [t('pdf.s6.p2'), fmtEur(i.trasaFullHeavy)],
      [t('pdf.s6.p3'), fmtEur(i.trasaEmptyBase)],
      [t('pdf.s6.p4'), fmtEur(i.priceStation)],
      [t('pdf.s6.p5'), String(i.numStations)],
      [t('pdf.s6.p6'), fmtEur(i.shuntingLj)],
      [t('pdf.s6.p7'), fmtEur(i.elChargeLight)],
      [t('pdf.s6.p8'), fmtEur(i.elChargeHeavy)],
      [t('pdf.s6.p9'), fmtEur(i.elChargeRet)]
    ],
    theme: 'plain',
    styles: { font: 'Inter', fontSize: 9, cellPadding: 2.5 },
    columnStyles: {
      0: { cellWidth: 90, textColor: [100, 110, 130] },
      1: { cellWidth: 80, halign: 'right', fontStyle: 'bold' }
    }
  });
  y = doc.lastAutoTable.finalY + 8;

  y = drawSubheading(doc, t('pdf.s6.tariffHead'), y);
  doc.autoTable({
    startY: y,
    body: [
      [t('pdf.s6.t1'), fmtEurK(i.revFullLight)],
      [t('pdf.s6.t2'), fmtEurK(i.revFullHeavy)],
      [t('pdf.s6.t3'), fmtEurK(i.revEmpty)]
    ],
    theme: 'plain',
    styles: { font: 'Inter', fontSize: 9, cellPadding: 2.5 },
    columnStyles: {
      0: { cellWidth: 90, textColor: [100, 110, 130] },
      1: { cellWidth: 80, halign: 'right', fontStyle: 'bold' }
    }
  });
  y = doc.lastAutoTable.finalY + 8;

  y = drawSubheading(doc, t('pdf.s6.laborHead'), y);
  doc.autoTable({
    startY: y,
    body: [
      [t('pdf.s6.l1'), fmtEurK(i.locoRent)],
      [t('pdf.s6.l2'), fmtEurK(i.wageDriver)],
      [t('pdf.s6.l3'), fmtEurK(i.wageInspector)],
      [t('pdf.s6.l4'), fmtEurK(i.wageMgmt)],
      [t('pdf.s6.l5'), fmtEurK(i.dispatchCost)],
      [t('pdf.s6.l_car'), fmtEurK(i.carCost)],
      [t('pdf.s6.l6'), fmtEurK(i.otherFixed)],
      [t('pdf.s6.l_ins'), fmtEurK(i.insuranceCost)]
    ],
    theme: 'plain',
    styles: { font: 'Inter', fontSize: 9, cellPadding: 2.5 },
    columnStyles: {
      0: { cellWidth: 90, textColor: [100, 110, 130] },
      1: { cellWidth: 80, halign: 'right', fontStyle: 'bold' }
    }
  });

  drawPageFooter(doc, pageNum++);

  // SAVE
  const filename = `${t('pdf.filename')}_${new Date().toISOString().slice(0, 10)}.pdf`;
  doc.save(filename);
  showToast(t('toast.pdfDone', { filename }), 'success');
  } catch (err) {
    console.error('PDF export error:', err);
    showToast('PDF greška: ' + err.message, 'error');
  }
}

/* ---------- PDF helpers ---------- */
function drawPageHeader(doc, title, y) {
  const pageW = doc.internal.pageSize.getWidth();
  doc.setFillColor(31, 64, 145);
  doc.rect(0, 0, pageW, 14, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(9);
  doc.setFont('Inter', 'bold');
  doc.text(t('pdf.headerLine1'), 20, 9);
  doc.setFont('Inter', 'normal');
  doc.text(t('pdf.headerLine2'), pageW - 20, 9, { align: 'right' });

  doc.setTextColor(31, 64, 145);
  doc.setFontSize(16);
  doc.setFont('Inter', 'bold');
  doc.text(title, 20, y + 8);
  doc.setDrawColor(31, 64, 145);
  doc.setLineWidth(0.6);
  doc.line(20, y + 11, pageW - 20, y + 11);
  return y + 18;
}

function drawSubheading(doc, txt, y) {
  doc.setTextColor(31, 64, 145);
  doc.setFontSize(11);
  doc.setFont('Inter', 'bold');
  doc.text(txt, 20, y);
  return y + 6;
}

function drawText(doc, txt, x, y, w) {
  doc.setFont('Inter', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(40, 50, 70);
  const lines = doc.splitTextToSize(txt, w);
  doc.text(lines, x, y);
  return y + lines.length * 5;
}

function drawPageFooter(doc, num) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  doc.setDrawColor(220, 225, 235);
  doc.setLineWidth(0.3);
  doc.line(20, pageH - 14, pageW - 20, pageH - 14);
  doc.setFontSize(8);
  doc.setTextColor(150, 160, 180);
  doc.setFont('Inter', 'normal');
  doc.text(t('pdf.footer'), 20, pageH - 8);
  doc.text(t('pdf.pageLbl') + ' ' + num, pageW - 20, pageH - 8, { align: 'right' });
}

/* ---------- Chart/SVG → image helpers (for PDF export) ---------- */

// Renders a Chart.js chart onto an offscreen canvas at fixed dimensions and returns a PNG data URL.
// We render fresh on a sized canvas (rather than re-using the live one) so the PDF box aspect ratio
// is preserved and the chart isn't distorted by the live canvas's responsive sizing.
async function captureChart(chartInst, width, height) {
  if (!chartInst || !chartInst.config) return null;
  const off = document.createElement('canvas');
  off.width = width;
  off.height = height;
  off.style.cssText = `position:fixed;left:-99999px;top:0;width:${width}px;height:${height}px`;
  document.body.appendChild(off);

  let temp = null;
  try {
    const cfg = chartInst.config;
    temp = new Chart(off, {
      type: cfg.type,
      data: cfg.data,
      options: {
        ...cfg.options,
        responsive: false,
        maintainAspectRatio: false,
        animation: false,
        devicePixelRatio: 2
      }
    });
    temp.update('none');
  } catch (e) {
    console.error('captureChart failed:', e);
  }

  const dataUrl = getCanvasDataUrl(off);
  if (temp) temp.destroy();
  off.remove();
  return dataUrl;
}

// Composites Chart.js canvas onto a light background so dark-mode colors read on white PDF
function getCanvasDataUrl(canvas) {
  if (!canvas) return null;
  const tmp = document.createElement('canvas');
  tmp.width  = canvas.width  || 800;
  tmp.height = canvas.height || 400;
  const ctx = tmp.getContext('2d');
  ctx.fillStyle = '#f0f4fa';
  ctx.fillRect(0, 0, tmp.width, tmp.height);
  ctx.drawImage(canvas, 0, 0);
  return tmp.toDataURL('image/png');
}

// Serialises an inline SVG element to a PNG data URL with an explicit dark background
function svgToDataUrl(svgEl) {
  return new Promise(resolve => {
    const clone = svgEl.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width',  '800');
    clone.setAttribute('height', '240');
    // Ensure text renders with a fallback font when drawn on canvas
    clone.querySelectorAll('text').forEach(el => {
      if (!el.getAttribute('font-family')) el.setAttribute('font-family', 'Arial, sans-serif');
    });
    const svgStr = new XMLSerializer().serializeToString(clone);
    const blob   = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url    = URL.createObjectURL(blob);
    const img    = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 800; canvas.height = 240;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, 800, 240);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

/* ---------- INIT ---------- */
applyTranslations();
calc();
