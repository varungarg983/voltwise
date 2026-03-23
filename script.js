const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "voltwise_nz_ev_dashboard_v2";
const THEME_KEY = "voltwise_theme";

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function toNum(value, fallback = 0) {
  const v = Number(value);
  return Number.isFinite(v) ? v : fallback;
}
function nzMoney(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-NZ", { style: "currency", currency: "NZD", maximumFractionDigits: 0 });
}
function nzMoney2(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-NZ", { style: "currency", currency: "NZD", maximumFractionDigits: 2 });
}
function pctStr(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  return `${v.toFixed(1)}%`;
}

function getTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute("content", theme === "light" ? "#edf4fb" : "#0b1020");

  const btn = $("btnTheme");
  if (btn) {
    btn.setAttribute("aria-pressed", String(theme === "light"));
    btn.querySelector(".theme-toggle-label").textContent = theme === "light" ? "Dark mode" : "Light mode";
    btn.querySelector(".theme-toggle-icon").textContent = theme === "light" ? "☾" : "☀";
  }
}

function getThemeColors() {
  const styles = getComputedStyle(document.body);
  return {
    legend: styles.getPropertyValue("--legend-text").trim(),
    tick: styles.getPropertyValue("--chart-tick").trim(),
    grid: styles.getPropertyValue("--chart-grid").trim()
  };
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((c === "\n" || c === "\r") && !inQuotes) {
      if (field.length || row.length) {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      }
      if (c === "\r" && next === "\n") i++;
    } else {
      field += c;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function weeklyEMI(principal, annualRatePct, years) {
  principal = Math.max(0, principal);
  const n = Math.max(1, Math.round(years * 52));
  const r = Math.max(0, annualRatePct) / 100 / 52;
  if (principal === 0) return { payment: 0, weeks: n, r };
  if (r === 0) return { payment: principal / n, weeks: n, r };
  const pmt = principal * r / (1 - Math.pow(1 + r, -n));
  return { payment: pmt, weeks: n, r };
}

function simulateLoan(principal, annualRatePct, payment, maxWeeks) {
  const r = Math.max(0, annualRatePct) / 100 / 52;
  let balance = Math.max(0, principal);
  const balances = [balance];
  let totalInterest = 0;
  let payoffWeek = null;
  let negativeAmort = false;

  for (let w = 0; w < maxWeeks; w++) {
    if (balance <= 0) {
      balances.push(0);
      continue;
    }
    const interest = balance * r;
    totalInterest += interest;
    const principalPaid = payment - interest;

    if (principalPaid <= 0) {
      negativeAmort = true;
      balance = balance + (interest - payment);
    } else {
      balance = balance - principalPaid;
    }

    if (balance <= 0 && payoffWeek === null) {
      payoffWeek = w + 1;
      balance = 0;
    }
    balances.push(balance);
  }

  return { balances, totalInterestPaid: totalInterest, payoffWeek, negativeAmort };
}

function buildDepSchedule(startValue, years, year1Pct, laterPct, treatAsNew) {
  const y = Math.max(1, Math.ceil(years));
  const yearStartValue = Array(y + 1).fill(0);
  const annualDep = Array(y + 1).fill(0);
  const yearEndValue = Array(y + 1).fill(0);
  const weeklyFactor = Array(y + 1).fill(1);
  let v = Math.max(0, startValue);

  for (let i = 1; i <= y; i++) {
    yearStartValue[i] = v;
    const rate = treatAsNew
      ? (i === 1 ? clamp(year1Pct / 100, 0, 0.95) : clamp(laterPct / 100, 0, 0.9))
      : clamp(laterPct / 100, 0, 0.9);
    const dep = v * rate;
    annualDep[i] = dep;
    const end = v - dep;
    yearEndValue[i] = end;
    weeklyFactor[i] = Math.pow(1 - rate, 1 / 52);
    v = end;
  }

  return { yearStartValue, annualDep, yearEndValue, weeklyFactor };
}

function carValueAtWeek(depSchedule, weekIndex) {
  const year = Math.floor(weekIndex / 52) + 1;
  const weekInYear = weekIndex % 52;
  const y = Math.min(year, depSchedule.yearStartValue.length - 1);
  const start = depSchedule.yearStartValue[y];
  const factor = depSchedule.weeklyFactor[y];
  return start * Math.pow(factor, weekInYear);
}

function annualTaxSaving(annualDep, taxRatePct, businessPct) {
  const t = clamp(taxRatePct / 100, 0, 0.7);
  const b = clamp(businessPct / 100, 0, 1);
  return annualDep * t * b;
}

async function fetchPetrolFromMBIE() {
  const url = "https://www.mbie.govt.nz/assets/Data-Files/Energy/Weekly-fuel-price-monitoring/weekly-table.csv";
  $("autofillStatus").textContent = "Fetching MBIE petrol…";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCSV(text);

  let bestFinal = null;
  let bestProv = null;

  for (const r of rows) {
    if (r.length < 7) continue;
    const date = r[1];
    const variable = r[2];
    const fuel = r[3];
    const value = toNum(r[4], NaN);
    const unit = (r[5] || "").toLowerCase();
    const status = (r[6] || "").toLowerCase();

    if (fuel !== "Regular Petrol" || variable !== "Adjusted retail price") continue;
    if (!Number.isFinite(value)) continue;

    let price = value;
    if (unit.includes("c") || unit.includes("cent")) price = value / 100;

    const rec = { date, price, status };
    if (status.includes("final")) {
      if (!bestFinal || date > bestFinal.date) bestFinal = rec;
    } else {
      if (!bestProv || date > bestProv.date) bestProv = rec;
    }
  }

  const chosen = bestFinal || bestProv;
  if (!chosen) throw new Error("Could not find Regular Petrol adjusted retail price.");
  $("petrolPrice").value = chosen.price.toFixed(2);
  $("autofillStatus").textContent = `Petrol set from MBIE (${chosen.status}, ${chosen.date})`;
}

function currentScenarioToJSON() {
  return {
    weeklyKm: toNum($("weeklyKm").value, 0),
    investReturn: toNum($("investReturn").value, 0),
    inflation: toNum($("inflation").value, 0),
    analysisYears: toNum($("analysisYears").value, 5),
    inflateRUC: $("inflateRUC").checked,
    sellCurrentForEV: $("sellCurrentForEV").checked,
    businessUse: $("businessUse").checked,

    curEmiWeekly: toNum($("curEmiWeekly").value, 0),
    curKmPerL: toNum($("curKmPerL").value, 23),
    petrolPrice: toNum($("petrolPrice").value, 2.8),
    curMarketValue: toNum($("curMarketValue").value, 0),
    curLoanBalance: toNum($("curLoanBalance").value, 0),
    curLoanRate: toNum($("curLoanRate").value, 0),
    curDepRate: toNum($("curDepRate").value, 10),

    evPrice: toNum($("evPrice").value, 0),
    evLoanRate: toNum($("evLoanRate").value, 0),
    evLoanYears: toNum($("evLoanYears").value, 5),
    evKwhPer100: toNum($("evKwhPer100").value, 18),
    elecPrice: toNum($("elecPrice").value, 0.3),
    rucPer1000: toNum($("rucPer1000").value, 76),
    depYear1: toNum($("depYear1").value, 25),
    depLater: toNum($("depLater").value, 15),

    taxRate: toNum($("taxRate").value, 30),
    businessPct: toNum($("businessPct").value, 100)
  };
}

function applyScenario(obj) {
  const safe = (k, fallback) => (obj && obj[k] !== undefined ? obj[k] : fallback);

  $("weeklyKm").value = safe("weeklyKm", 650);
  $("investReturn").value = safe("investReturn", 7.0);
  $("inflation").value = safe("inflation", 0.0);
  $("analysisYears").value = safe("analysisYears", 5);
  $("inflateRUC").checked = !!safe("inflateRUC", true);
  $("sellCurrentForEV").checked = !!safe("sellCurrentForEV", false);
  $("businessUse").checked = !!safe("businessUse", false);

  $("curEmiWeekly").value = safe("curEmiWeekly", 80);
  $("curKmPerL").value = safe("curKmPerL", 23);
  $("petrolPrice").value = safe("petrolPrice", 2.8);
  $("curMarketValue").value = safe("curMarketValue", 16000);
  $("curLoanBalance").value = safe("curLoanBalance", 15000);
  $("curLoanRate").value = safe("curLoanRate", 10.0);
  $("curDepRate").value = safe("curDepRate", 10.0);

  $("evPrice").value = safe("evPrice", 42000);
  $("evLoanRate").value = safe("evLoanRate", 10.0);
  $("evLoanYears").value = safe("evLoanYears", 5);
  $("evKwhPer100").value = safe("evKwhPer100", 18);
  $("elecPrice").value = safe("elecPrice", 0.30);
  $("rucPer1000").value = safe("rucPer1000", 76);
  $("depYear1").value = safe("depYear1", 25);
  $("depLater").value = safe("depLater", 15);

  $("taxRate").value = safe("taxRate", 30);
  $("businessPct").value = safe("businessPct", 100);
}

function saveToLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(currentScenarioToJSON()));
  } catch (e) {}
}

function loadFromLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    applyScenario(JSON.parse(raw));
    return true;
  } catch (e) {
    return false;
  }
}

let wealthChart = null;
let costChart = null;

function makeOrUpdateWealthChart(labels, curWealth, evWealth) {
  const ctx = $("wealthChart").getContext("2d");
  const theme = getThemeColors();
  if (!wealthChart) {
    wealthChart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Keep current",
            data: curWealth,
            borderColor: "#79d7ff",
            backgroundColor: "rgba(121,215,255,0.12)",
            tension: 0.26,
            fill: false
          },
          {
            label: "Buy EV",
            data: evWealth,
            borderColor: "#6ff0c4",
            backgroundColor: "rgba(111,240,196,0.12)",
            tension: 0.26,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: theme.legend } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${nzMoney2(ctx.parsed.y)}`
            }
          }
        },
        scales: {
          x: {
            ticks: { color: theme.tick },
            grid: { color: theme.grid }
          },
          y: {
            ticks: { color: theme.tick },
            grid: { color: theme.grid }
          }
        }
      }
    });
  } else {
    wealthChart.data.labels = labels;
    wealthChart.data.datasets[0].data = curWealth;
    wealthChart.data.datasets[1].data = evWealth;
    wealthChart.options.plugins.legend.labels.color = theme.legend;
    wealthChart.options.scales.x.ticks.color = theme.tick;
    wealthChart.options.scales.x.grid.color = theme.grid;
    wealthChart.options.scales.y.ticks.color = theme.tick;
    wealthChart.options.scales.y.grid.color = theme.grid;
    wealthChart.update();
  }
}

function makeOrUpdateCostChart(labels, curVals, evVals) {
  const ctx = $("costChart").getContext("2d");
  const theme = getThemeColors();
  if (!costChart) {
    costChart = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels,
        datasets: [
          {
            label: "Keep current",
            data: curVals,
            backgroundColor: ["#4f8cff", "#79d7ff", "#46536d", "#8b7dff"],
            borderWidth: 0
          },
          {
            label: "Buy EV",
            data: evVals,
            backgroundColor: ["#6ff0c4", "#4be6b4", "#ffcf70", "#8b7dff"],
            borderWidth: 0
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: theme.legend } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label} — ${ctx.label}: ${nzMoney2(ctx.parsed)}`
            }
          }
        }
      }
    });
  } else {
    costChart.data.labels = labels;
    costChart.data.datasets[0].data = curVals;
    costChart.data.datasets[1].data = evVals;
    costChart.options.plugins.legend.labels.color = theme.legend;
    costChart.update();
  }
}

function compute() {
  const warn = [];

  const weeklyKm = Math.max(0, toNum($("weeklyKm").value, 0));
  const investReturnPct = toNum($("investReturn").value, 0);
  const inflationPct = toNum($("inflation").value, 0);
  const analysisYears = Math.max(1, toNum($("analysisYears").value, 5));
  const inflateRUC = $("inflateRUC").checked;
  const sellCurrentForEV = $("sellCurrentForEV").checked;
  const businessUse = $("businessUse").checked;

  const curEmiWeekly = Math.max(0, toNum($("curEmiWeekly").value, 0));
  const curKmPerL = Math.max(0.1, toNum($("curKmPerL").value, 23));
  const petrolPrice0 = Math.max(0, toNum($("petrolPrice").value, 2.8));
  const curMarketValue = Math.max(0, toNum($("curMarketValue").value, 0));
  const curLoanBalance0 = Math.max(0, toNum($("curLoanBalance").value, 0));
  const curLoanRatePct = Math.max(0, toNum($("curLoanRate").value, 0));
  const curDepRatePct = Math.max(0, toNum($("curDepRate").value, 10));

  const evPrice = Math.max(0, toNum($("evPrice").value, 0));
  const evLoanRatePct = Math.max(0, toNum($("evLoanRate").value, 0));
  const evLoanYears = Math.max(0.5, toNum($("evLoanYears").value, 5));
  const evKwhPer100 = Math.max(5, toNum($("evKwhPer100").value, 18));
  const elecPrice0 = Math.max(0, toNum($("elecPrice").value, 0.3));
  const rucPer1000 = Math.max(0, toNum($("rucPer1000").value, 76));
  const depYear1Pct = Math.max(0, toNum($("depYear1").value, 25));
  const depLaterPct = Math.max(0, toNum($("depLater").value, 15));

  const taxRatePct = Math.max(0, toNum($("taxRate").value, 30));
  const businessPct = clamp(toNum($("businessPct").value, 100), 0, 100);

  const chartWeeks = Math.round(analysisYears * 52);
  const snapshotYears = [1, 5, 10, 15];
  const maxYears = Math.max(analysisYears, ...snapshotYears);
  const maxWeeks = Math.round(maxYears * 52);

  const currentEquity0 = Math.max(0, curMarketValue - curLoanBalance0);
  const downPayment = sellCurrentForEV ? currentEquity0 : 0;
  const evPrincipal = Math.max(0, evPrice - downPayment);

  const evLoan = weeklyEMI(evPrincipal, evLoanRatePct, evLoanYears);
  const evEmi = evLoan.payment;

  $("kpiEvEmi").textContent = nzMoney2(evEmi);
  $("kpiEvEmiSub").textContent = `Principal: ${nzMoney2(evPrincipal)}\nTerm: ${evLoanYears.toFixed(1)} yrs (${evLoan.weeks} weeks)\nRate: ${pctStr(evLoanRatePct)}`;

  const depCur = buildDepSchedule(curMarketValue, maxYears, curDepRatePct, curDepRatePct, false);
  const depEv = buildDepSchedule(evPrice, maxYears, depYear1Pct, depLaterPct, true);

  const curLoanModelEnabled = curLoanBalance0 > 0 && curLoanRatePct >= 0 && curEmiWeekly > 0;
  const curLoanSim = curLoanModelEnabled
    ? simulateLoan(curLoanBalance0, curLoanRatePct, curEmiWeekly, maxWeeks)
    : { balances: Array(maxWeeks + 1).fill(0), totalInterestPaid: 0, payoffWeek: null, negativeAmort: false };

  if (curLoanModelEnabled && curLoanSim.negativeAmort) {
    warn.push("Current car loan has negative amortization. EMI is not covering the interest.");
  }

  const evLoanSim = simulateLoan(evPrincipal, evLoanRatePct, evEmi, maxWeeks);
  if (evLoanSim.negativeAmort) {
    warn.push("EV loan produced negative amortization. Check loan settings.");
  }

  const invWeeklyRate = investReturnPct / 100 / 52;
  const inflWeekly = inflationPct / 100;
  let invCur = 0;
  let invEv = 0;

  let totalCurLoanPay = 0, totalCurPetrol = 0, totalCurDep = 0, totalCurTax = 0;
  let totalEvLoanPay = 0, totalEvElec = 0, totalEvRUC = 0, totalEvDep = 0, totalEvTax = 0;

  const labels = [];
  const seriesCurWealth = [];
  const seriesEvWealth = [];
  const snapshots = new Map();

  function taxSaveWeekly(depSchedule, yearIndex) {
    if (!businessUse) return 0;
    const dep = depSchedule.annualDep[yearIndex] || 0;
    return annualTaxSaving(dep, taxRatePct, businessPct) / 52;
  }

  for (let w = 0; w <= maxWeeks; w++) {
    const tYears = w / 52;
    const inflFactor = Math.pow(1 + inflWeekly, tYears);
    const petrolPrice = petrolPrice0 * inflFactor;
    const elecPrice = elecPrice0 * inflFactor;
    const rucPerKm = (rucPer1000 / 1000) * (inflateRUC ? inflFactor : 1);

    const curPetrol = (weeklyKm / curKmPerL) * petrolPrice;
    const evElec = weeklyKm * (evKwhPer100 / 100) * elecPrice;
    const evRUC = weeklyKm * rucPerKm;

    const curLoanPay = curEmiWeekly;
    const evLoanPay = w < evLoan.weeks ? evEmi : 0;

    const yearIdx = Math.floor(w / 52) + 1;
    const curTaxSave = taxSaveWeekly(depCur, yearIdx);
    const evTaxSave = taxSaveWeekly(depEv, yearIdx);

    const curWeeklyCash = curLoanPay + curPetrol - curTaxSave;
    const evWeeklyCash = evLoanPay + evElec + evRUC - evTaxSave;

    const diff = evWeeklyCash - curWeeklyCash;
    invCur = invCur * (1 + invWeeklyRate);
    invEv = invEv * (1 + invWeeklyRate);

    if (diff > 0) invCur += diff;
    else if (diff < 0) invEv += -diff;

    const curCarVal = carValueAtWeek(depCur, w);
    const evCarVal = carValueAtWeek(depEv, w);

    const curBal = curLoanModelEnabled ? curLoanSim.balances[w] : 0;
    const evBal = evLoanSim.balances[w];

    const curEquity = Math.max(0, curCarVal - curBal);
    const evEquity = Math.max(0, evCarVal - evBal);

    const curWealth = invCur + curEquity;
    const evWealth = invEv + evEquity;

    if (w <= chartWeeks && (w % 4 === 0 || w === chartWeeks)) {
      labels.push(`Y${(w / 52).toFixed(1)}`);
      seriesCurWealth.push(curWealth);
      seriesEvWealth.push(evWealth);
    }

    for (const y of snapshotYears) {
      if (w === Math.round(y * 52)) {
        snapshots.set(y, {
          curNetWealth: curWealth,
          evNetWealth: evWealth
        });
      }
    }

    if (w <= chartWeeks && w > 0) {
      totalCurLoanPay += curLoanPay;
      totalCurPetrol += curPetrol;
      totalCurTax += curTaxSave;

      totalEvLoanPay += evLoanPay;
      totalEvElec += evElec;
      totalEvRUC += evRUC;
      totalEvTax += evTaxSave;
    }
  }

  const curEndVal = carValueAtWeek(depCur, chartWeeks);
  const evEndVal = carValueAtWeek(depEv, chartWeeks);
  totalCurDep = Math.max(0, curMarketValue - curEndVal);
  totalEvDep = Math.max(0, evPrice - evEndVal);

  const curPetrolNow = (weeklyKm / curKmPerL) * petrolPrice0;
  const evElecNow = weeklyKm * (evKwhPer100 / 100) * elecPrice0;
  const evRUCNow = weeklyKm * (rucPer1000 / 1000);

  $("kpiRunWeekly").textContent = `${nzMoney2(curPetrolNow)} vs ${nzMoney2(evElecNow + evRUCNow)}`;
  $("kpiRunWeeklySub").textContent = `Current petrol: ${nzMoney2(curPetrolNow)}\nEV electricity: ${nzMoney2(evElecNow)}\nEV RUC: ${nzMoney2(evRUCNow)}`;

  const curBalEnd = curLoanModelEnabled ? curLoanSim.balances[chartWeeks] : 0;
  const evBalEnd = evLoanSim.balances[chartWeeks];
  const curEquityEnd = Math.max(0, curEndVal - curBalEnd);
  const evEquityEnd = Math.max(0, evEndVal - evBalEnd);

  function invUpTo(weeksTarget) {
    let invC = 0, invE = 0;
    for (let w = 0; w <= weeksTarget; w++) {
      const tYears = w / 52;
      const inflFactor = Math.pow(1 + inflWeekly, tYears);
      const petrolPrice = petrolPrice0 * inflFactor;
      const elecPrice = elecPrice0 * inflFactor;
      const rucPerKm = (rucPer1000 / 1000) * (inflateRUC ? inflFactor : 1);

      const curPetrol = (weeklyKm / curKmPerL) * petrolPrice;
      const evElec = weeklyKm * (evKwhPer100 / 100) * elecPrice;
      const evRUC = weeklyKm * rucPerKm;

      const curLoanPay = curEmiWeekly;
      const evLoanPay = w < evLoan.weeks ? evEmi : 0;

      const yearIdx = Math.floor(w / 52) + 1;
      const curTaxSave = taxSaveWeekly(depCur, yearIdx);
      const evTaxSave = taxSaveWeekly(depEv, yearIdx);

      const curWeeklyCash = curLoanPay + curPetrol - curTaxSave;
      const evWeeklyCash = evLoanPay + evElec + evRUC - evTaxSave;
      const diff = evWeeklyCash - curWeeklyCash;

      invC = invC * (1 + invWeeklyRate);
      invE = invE * (1 + invWeeklyRate);

      if (diff > 0) invC += diff;
      if (diff < 0) invE += -diff;
    }
    return { invC, invE };
  }

  const invAtChart = invUpTo(chartWeeks);
  const curWealthEnd = invAtChart.invC + curEquityEnd;
  const evWealthEnd = invAtChart.invE + evEquityEnd;

  $("kpiNetWealth").textContent = `${nzMoney(curWealthEnd)} vs ${nzMoney(evWealthEnd)}`;
  $("kpiNetWealthSub").textContent = `Keep current: ${nzMoney(curWealthEnd)}\nBuy EV: ${nzMoney(evWealthEnd)}\nHorizon: ${analysisYears.toFixed(1)} years`;

  const netDelta = evWealthEnd - curWealthEnd;
  const opp = Math.abs(invAtChart.invC - invAtChart.invE);
  $("kpiOpp").textContent = nzMoney(opp);
  $("kpiOppSub").textContent = `Invest return: ${pctStr(investReturnPct)}\nThe cheaper option compounds the weekly difference`;

  const threshold = Math.max(1000, evPrice * 0.02);
  const badge = $("recommendBadge");
  const text = $("recommendText");

  if (netDelta > threshold) {
    badge.className = "recommend-badge good";
    badge.textContent = "BUY";
  } else if (netDelta < -threshold) {
    badge.className = "recommend-badge bad";
    badge.textContent = "DON'T BUY";
  } else {
    badge.className = "recommend-badge neutral";
    badge.textContent = "NEUTRAL";
  }

  const weeklyDiffNow = (evEmi + evElecNow + evRUCNow) - (curEmiWeekly + curPetrolNow);
  const taxNote = businessUse
    ? `Business tax savings are switched on at ${pctStr(taxRatePct)} tax and ${businessPct.toFixed(0)}% business use.`
    : "Business tax savings are switched off.";
  const sellNote = sellCurrentForEV
    ? `Current-car equity of ${nzMoney(currentEquity0)} is being used as EV down payment.`
    : "No current-car equity is being used as down payment.";

  text.textContent = `Net wealth difference (EV - current) over ${analysisYears.toFixed(1)} years: ${nzMoney(netDelta)}.\n\nWeekly cash-cost difference today (EV - current): ${nzMoney2(weeklyDiffNow)}.\n${sellNote}\n${taxNote}`;

  const summaryList = $("summaryList");
  summaryList.innerHTML = "";
  [
    `Current-car petrol cost today: ${nzMoney2(curPetrolNow)} per week.`,
    `EV running cost today: ${nzMoney2(evElecNow + evRUCNow)} per week.`,
    `Estimated EV resale value after ${analysisYears.toFixed(1)} years: ${nzMoney(Math.max(0, evEndVal))}.`,
    `Estimated current-car resale value after ${analysisYears.toFixed(1)} years: ${nzMoney(Math.max(0, curEndVal))}.`
  ].forEach(item => {
    const li = document.createElement("li");
    li.textContent = item;
    summaryList.appendChild(li);
  });

  const warnBox = $("warnBox");
  if (warn.length) {
    warnBox.style.display = "block";
    warnBox.textContent = warn.join("\n");
  } else {
    warnBox.style.display = "none";
    warnBox.textContent = "";
  }

  const tbody = $("snapTable").querySelector("tbody");
  tbody.innerHTML = "";
  for (const y of [1, 5, 10, 15]) {
    const s = snapshots.get(y);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${y} year${y === 1 ? "" : "s"}</td>
      <td>${s ? nzMoney(s.curNetWealth) : "N/A"}</td>
      <td>${s ? nzMoney(s.evNetWealth) : "N/A"}</td>
      <td>${s ? nzMoney(s.evNetWealth - s.curNetWealth) : "N/A"}</td>`;
    tbody.appendChild(tr);
  }

  makeOrUpdateWealthChart(labels, seriesCurWealth, seriesEvWealth);

  const costLabels = ["Loan payments", "Energy", "RUC", "Depreciation"];
  const curVals = [totalCurLoanPay, totalCurPetrol, 0, totalCurDep];
  const evVals = [totalEvLoanPay, totalEvElec, totalEvRUC, totalEvDep];
  makeOrUpdateCostChart(costLabels, curVals, evVals);

  const outcomeLabel = netDelta > threshold
    ? "Recommendation: Buy EV"
    : netDelta < -threshold
      ? "Recommendation: Keep current car"
      : "Recommendation: Financially close";

  const mermaidText = `flowchart LR
    A["Scenario Inputs<br/>${weeklyKm.toFixed(0)} km/week<br/>Horizon ${analysisYears.toFixed(1)} years"]
    B["Keep Current Car<br/>EMI ${nzMoney2(curEmiWeekly)}/week<br/>Petrol ${nzMoney2(curPetrolNow)}/week"]
    C["Buy EV<br/>EMI ${nzMoney2(evEmi)}/week<br/>Energy + RUC ${nzMoney2(evElecNow + evRUCNow)}/week"]
    D["Weekly Cost Gap<br/>EV - Current = ${nzMoney2(weeklyDiffNow)}"]
    E["Invest Weekly Difference<br/>Return ${pctStr(investReturnPct)}"]
    F["Horizon End Wealth<br/>Current ${nzMoney(curWealthEnd)}<br/>EV ${nzMoney(evWealthEnd)}"]
    G["${outcomeLabel}<br/>Net difference ${nzMoney(netDelta)}"]

    A --> B
    A --> C
    B --> D
    C --> D
    D --> E
    E --> F
    F --> G
  `;
  $("mermaidDiagram").textContent = mermaidText;
  try {
    $("mermaidDiagram").removeAttribute("data-processed");
    mermaid.init(undefined, $("mermaidDiagram"));
  } catch (e) {}

  saveToLocal();
}

function resetDefaults() {
  applyScenario({
    weeklyKm: 650,
    investReturn: 7.0,
    inflation: 0.0,
    analysisYears: 5,
    inflateRUC: true,
    sellCurrentForEV: false,
    businessUse: false,
    curEmiWeekly: 80,
    curKmPerL: 23,
    petrolPrice: 2.8,
    curMarketValue: 16000,
    curLoanBalance: 15000,
    curLoanRate: 10.0,
    curDepRate: 10.0,
    evPrice: 42000,
    evLoanRate: 10.0,
    evLoanYears: 5,
    evKwhPer100: 18,
    elecPrice: 0.30,
    rucPer1000: 76,
    depYear1: 25,
    depLater: 15,
    taxRate: 30,
    businessPct: 100
  });
  $("autofillStatus").textContent = "Defaults restored";
  compute();
}

function wireScrolling() {
  document.querySelectorAll("[data-scroll]").forEach(btn => {
    btn.addEventListener("click", () => {
      const selector = btn.getAttribute("data-scroll");
      const el = document.querySelector(selector);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  applyTheme(getTheme());
  mermaid.initialize({ startOnLoad: false, theme: getTheme() === "light" ? "default" : "dark" });

  if (!loadFromLocal()) resetDefaults();
  else compute();

  wireScrolling();

  document.querySelectorAll("input").forEach(inp => {
    inp.addEventListener("input", compute);
    inp.addEventListener("change", compute);
  });

  $("btnFetchPetrol").addEventListener("click", async () => {
    try {
      await fetchPetrolFromMBIE();
      compute();
    } catch (e) {
      $("autofillStatus").textContent = "MBIE fetch failed, keeping manual/default value";
    }
  });

  $("btnPresetElecAvg").addEventListener("click", () => {
    $("elecPrice").value = "0.393";
    $("autofillStatus").textContent = "Electricity preset set to 0.393";
    compute();
  });

  $("btnPresetElecCheap").addEventListener("click", () => {
    $("elecPrice").value = "0.30";
    $("autofillStatus").textContent = "Electricity preset set to 0.30";
    compute();
  });

  $("btnReset").addEventListener("click", resetDefaults);

  $("btnTheme").addEventListener("click", () => {
    const nextTheme = getTheme() === "light" ? "dark" : "light";
    localStorage.setItem(THEME_KEY, nextTheme);
    applyTheme(nextTheme);
    mermaid.initialize({ startOnLoad: false, theme: nextTheme === "light" ? "default" : "dark" });
    compute();
  });

});
