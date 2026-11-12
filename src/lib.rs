use serde::Serialize;
use wasm_bindgen::prelude::*;

// ---------------------------------------------------------------------------
// Hardcoded mockup data: a transit hub's tenant portfolio, Nov 2025 - Oct 2026.
// Each tenant: (name, base monthly rent, base monthly utilities, base service charge)
// ---------------------------------------------------------------------------
const TENANTS: [(&str, f64, f64, f64); 8] = [
    ("Metro Café", 42_000.0, 6_800.0, 3_100.0),
    ("Terminal Pharmacy", 58_500.0, 4_200.0, 3_800.0),
    ("SkyView Lounge", 96_000.0, 14_500.0, 7_200.0),
    ("Urban Fitness", 71_000.0, 18_900.0, 5_400.0),
    ("City Bank Branch", 64_000.0, 3_900.0, 4_600.0),
    ("Newsstand & Gifts", 23_500.0, 2_100.0, 1_700.0),
    ("Regional Bus Co.", 82_000.0, 9_300.0, 6_100.0),
    ("Parking Operator", 118_000.0, 12_700.0, 8_900.0),
];

const METRICS: [&str; 3] = ["Revenue", "Utilities", "Service Charges"];

const MONTHS: [&str; 12] = [
    "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
    "2026-07", "2026-08", "2026-09", "2026-10",
];

#[derive(Clone, Serialize)]
struct Record {
    date: &'static str,
    tenant: &'static str,
    metric: &'static str,
    amount: f64,
}

#[derive(Serialize)]
struct Series {
    metric: &'static str,
    values: Vec<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Kpi {
    label: &'static str,
    value: f64,
    change_pct: f64,
}

#[derive(Serialize)]
struct Payload<'a> {
    rows: Vec<&'a Record>,
    labels: Vec<&'static str>,
    series: Vec<Series>,
    kpis: Vec<Kpi>,
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// Deterministic generation of realistic monthly figures from the base values above.
fn build_records() -> Vec<Record> {
    let mut out = Vec::with_capacity(TENANTS.len() * MONTHS.len() * METRICS.len());
    for (t, &(name, rent, util, svc)) in TENANTS.iter().enumerate() {
        for (m, &date) in MONTHS.iter().enumerate() {
            let mf = m as f64;
            let wave = (mf * 0.7 + t as f64).sin(); // tenant-specific noise
            let growth = 1.0 + 0.004 * mf; // slow rent escalation
            let season = ((mf - 1.0) * std::f64::consts::PI / 6.0).cos(); // heating/cooling load

            out.push(Record { date, tenant: name, metric: "Revenue", amount: round2(rent * growth * (1.0 + 0.05 * wave)) });
            out.push(Record { date, tenant: name, metric: "Utilities", amount: round2(util * (1.0 + 0.12 * season + 0.04 * wave)) });
            out.push(Record { date, tenant: name, metric: "Service Charges", amount: round2(svc * (1.0 + 0.02 * wave)) });
        }
    }
    out
}

#[wasm_bindgen]
pub struct Dashboard {
    records: Vec<Record>,
}

#[wasm_bindgen]
impl Dashboard {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Dashboard {
        Dashboard { records: build_records() }
    }

    /// Names of all available metrics.
    pub fn metrics(&self) -> Vec<String> {
        METRICS.iter().map(|s| s.to_string()).collect()
    }

    /// Filter by metric names, sort by `sort_key` ("date" | "tenant" | "metric" | "amount"),
    /// and return everything the UI needs: table rows, chart series and KPIs.
    pub fn query(&self, metrics: Vec<String>, sort_key: &str, ascending: bool) -> Result<JsValue, JsValue> {
        let selected = |m: &str| metrics.iter().any(|x| x.as_str() == m);

        // 1. Filter
        let mut rows: Vec<&Record> = self.records.iter().filter(|r| selected(r.metric)).collect();

        // 2. Sort (with stable tie-breakers so the order is always deterministic)
        rows.sort_by(|a, b| {
            let primary = match sort_key {
                "amount" => a.amount.total_cmp(&b.amount),
                "tenant" => a.tenant.cmp(b.tenant),
                "metric" => a.metric.cmp(b.metric),
                _ => a.date.cmp(b.date),
            };
            let ord = primary
                .then_with(|| a.date.cmp(b.date))
                .then_with(|| a.tenant.cmp(b.tenant))
                .then_with(|| a.metric.cmp(b.metric));
            if ascending { ord } else { ord.reverse() }
        });

        // 3. Chart series: monthly portfolio total per selected metric
        let mut series = Vec::new();
        for m in METRICS {
            if !selected(m) {
                continue;
            }
            let values = MONTHS.iter().map(|&mo| self.month_total(m, mo)).collect();
            series.push(Series { metric: m, values });
        }

        let payload = Payload { rows, labels: MONTHS.to_vec(), series, kpis: self.kpis() };
        serde_wasm_bindgen::to_value(&payload).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}

impl Dashboard {
    fn month_total(&self, metric: &str, month: &str) -> f64 {
        let sum: f64 = self
            .records
            .iter()
            .filter(|r| r.metric == metric && r.date == month)
            .map(|r| r.amount)
            .sum();
        round2(sum)
    }

    /// Latest-month KPIs with month-over-month change (always portfolio-wide).
    fn kpis(&self) -> Vec<Kpi> {
        let (cur_m, prev_m) = (MONTHS[MONTHS.len() - 1], MONTHS[MONTHS.len() - 2]);
        let pct = |cur: f64, prev: f64| if prev == 0.0 { 0.0 } else { (cur - prev) / prev * 100.0 };

        let cur: Vec<f64> = METRICS.iter().map(|m| self.month_total(m, cur_m)).collect();
        let prev: Vec<f64> = METRICS.iter().map(|m| self.month_total(m, prev_m)).collect();
        let noi = |v: &[f64]| v[0] + v[2] - v[1]; // revenue + service charges - utilities

        let mut kpis: Vec<Kpi> = METRICS
            .iter()
            .enumerate()
            .map(|(i, &label)| Kpi { label, value: cur[i], change_pct: pct(cur[i], prev[i]) })
            .collect();
        kpis.push(Kpi { label: "Net Operating Income", value: noi(&cur), change_pct: pct(noi(&cur), noi(&prev)) });
        kpis
    }
}
