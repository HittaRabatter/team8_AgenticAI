// Trend forecast per metric: least-squares line over recent readings, projected forward against the warning and critical limits.
const MIN = 60000;

function fitSlopePerMs(points) {
  const n = points.length;
  if (n < 2) return 0;
  const t0 = points[0].t;
  const xs = points.map((p) => p.t - t0), ys = points.map((p) => p.v);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  return den === 0 ? 0 : xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / den;
}

// "assumed" = what-if: the last observed change is taken to repeat every assumeIntervalMin minutes.
function confidenceOf(points, assumed) {
  if (assumed) return "assumed";
  const spanMin = (points[points.length - 1].t - points[0].t) / MIN;
  if (points.length < 3 || spanMin < 30) return "low";
  return points.length < 6 ? "medium" : "high";
}

function minutesUntil(limit, last, slopePerMin, lowIsBad) {
  const past = lowIsBad ? last <= limit : last >= limit;
  if (past) return 0;
  const toward = lowIsBad ? slopePerMin < 0 : slopePerMin > 0;
  return toward ? Math.round((limit - last) / slopePerMin) : null;
}

function forecastMetric({ readings, threshold, horizonHours = 24, assumeIntervalMin = null }) {
  const points = readings
    .map((r) => ({ t: Date.parse(r.timestamp), v: r.metrics?.[threshold.metric] }))
    .filter((p) => typeof p.v === "number" && Number.isFinite(p.t));
  if (!points.length) return null;
  const lowIsBad = threshold.criticalThreshold < threshold.warningThreshold;
  const last = points[points.length - 1];
  const prev = points[points.length - 2];

  let slopePerMin = 0;
  if (assumeIntervalMin && prev) slopePerMin = (last.v - prev.v) / assumeIntervalMin;
  else if (points.length > 1) slopePerMin = fitSlopePerMs(points.slice(-6)) * MIN;

  const level = (v) => {
    const past = (lim) => (lowIsBad ? v <= lim : v >= lim);
    return past(threshold.criticalThreshold) ? 2 : past(threshold.warningThreshold) ? 1 : 0;
  };
  const stepMin = Math.max(5, Math.round((horizonHours * 60) / 48));
  const projection = [];
  for (let m = 0; m <= horizonHours * 60; m += stepMin) {
    const value = Math.round((last.v + slopePerMin * m) * 100) / 100;
    projection.push({ minutes: m, value, level: level(value) });
  }
  return {
    metric: threshold.metric, unit: threshold.unit || null, lowIsBad,
    normalRange: threshold.normalRange || null,
    warningThreshold: threshold.warningThreshold, criticalThreshold: threshold.criticalThreshold,
    last: { time: new Date(last.t).toISOString(), value: last.v },
    history: points.map((p) => ({ time: new Date(p.t).toISOString(), value: p.v })),
    slopePerHour: Math.round(slopePerMin * 60 * 100) / 100,
    confidence: confidenceOf(points, Boolean(assumeIntervalMin && prev)),
    minutesToWarning: minutesUntil(threshold.warningThreshold, last.v, slopePerMin, lowIsBad),
    minutesToCritical: minutesUntil(threshold.criticalThreshold, last.v, slopePerMin, lowIsBad),
    projection,
  };
}

// readings: any order; thresholds: for the machine type.
function forecastFromReadings(readings, thresholds, opts = {}) {
  const asc = [...readings].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  const metrics = thresholds.map((t) => forecastMetric({ readings: asc, threshold: t, ...opts })).filter(Boolean)
    .sort((a, b) => (a.minutesToCritical ?? Infinity) - (b.minutesToCritical ?? Infinity));
  const first = metrics.find((m) => m.minutesToCritical != null);
  return {
    readingsUsed: asc.length,
    lastReadingAt: asc.length ? asc[asc.length - 1].timestamp : null,
    assumeIntervalMin: opts.assumeIntervalMin || null,
    metrics,
    earliestCriticalMinutes: first ? first.minutesToCritical : null,
    drivingMetric: first ? first.metric : null,
    confidence: first ? first.confidence : (metrics[0]?.confidence || "low"),
  };
}

async function buildForecast(db, machineId, opts = {}) {
  const q = async (name, query, parameters = []) => (await db.container(name).items.query({ query, parameters }).fetchAll()).resources;
  const [machine] = await q("Machines", "SELECT * FROM c WHERE c.id = @id", [{ name: "@id", value: machineId }]);
  if (!machine) throw Object.assign(new Error(`machine ${machineId} not found`), { status: 404 });
  const [readings, thresholds] = await Promise.all([
    q("Telemetry", "SELECT TOP 20 * FROM c WHERE c.machineId = @m ORDER BY c.timestamp DESC", [{ name: "@m", value: machineId }]),
    q("Thresholds", "SELECT * FROM c WHERE c.machineType = @t", [{ name: "@t", value: machine.type }]),
  ]);
  return { machine: { id: machine.id, name: machine.name, type: machine.type },
    ...forecastFromReadings(readings, thresholds, opts), horizonHours: opts.horizonHours || 24 };
}

module.exports = { forecastFromReadings, buildForecast };
