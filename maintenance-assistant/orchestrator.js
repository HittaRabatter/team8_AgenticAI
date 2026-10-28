// Preventative Maintenance Orchestrator: telemetry -> breaches -> diagnosis -> parts -> shift-aware booking -> WorkOrder.
// Read-only toward infrastructure; the only write is a WorkOrders document.
// An LLM (when configured) proposes the diagnosis and dispatch; code validates every choice and falls back to rules.
const { MIN, HOUR, DAY, DEFAULT_DURATION_MIN, bookingIntervals, buildSlots, isFree } = require("./scheduler");
const llm = require("./llm");
const { recommendOrder } = require("./procurement");
const { forecastFromReadings } = require("./forecast");
const agents = require("./agents");

const fail = (status, message) => Object.assign(new Error(message), { status });
const fmtUtc = (iso) => new Date(iso).toISOString().slice(0, 16).replace("T", " ");
// The four-agent workflow from the team's use-case notes.
const AGENT_OF = { telemetry: "Anomaly Detection Agent", forecast: "Anomaly Detection Agent", diagnosis: "Fault Diagnosis Agent",
  parts: "Repair Planner Agent", crew: "Repair Planner Agent", dispatch: "Maintenance Scheduler Agent",
  alternatives: "Maintenance Scheduler Agent", scenarios: "Maintenance Scheduler Agent", decision: "Maintenance Scheduler Agent" };
const GENERIC = new Set(["systems", "system", "machine", "maintenance", "tire"]);
const tokens = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && t !== "warning");
const rankOf = (status) => (["normal", "ok", "healthy"].includes(String(status).toLowerCase()) ? 0 : String(status).toLowerCase() === "warning" ? 1 : 2);

function createTools(db) {
  const query = async (container, q = "SELECT * FROM c", parameters = []) =>
    (await db.container(container).items.query({ query: q, parameters }).fetchAll()).resources;

  return {
    query,

    get_telemetry: async (machineId) =>
      (await query("Telemetry", "SELECT TOP 1 * FROM c WHERE c.machineId = @m ORDER BY c.timestamp DESC",
        [{ name: "@m", value: machineId }]))[0] || null,

    get_thresholds: (machineType) =>
      query("Thresholds", "SELECT * FROM c WHERE c.machineType = @t", [{ name: "@t", value: machineType }]),

    get_recent_telemetry: (machineId, n = 20) =>
      query("Telemetry", `SELECT TOP ${Math.min(Math.max(Number(n) || 20, 2), 100)} * FROM c WHERE c.machineId = @m ORDER BY c.timestamp DESC`,
        [{ name: "@m", value: machineId }]),

    // Backed by the KnowledgeBase container; no AI Search index is configured.
    search_knowledge_base: async (text, machineType) => {
      const want = new Set(tokens(text));
      const articles = await query("KnowledgeBase", "SELECT * FROM c WHERE c.machineType = @t",
        [{ name: "@t", value: machineType }]);
      let best = null, bestScore = 0;
      for (const a of articles) {
        const strong = new Set(tokens(`${a.faultType} ${a.issue}`));
        const weak = new Set(tokens((a.symptoms || []).join(" ")));
        let score = 0;
        for (const t of want) score += strong.has(t) ? 3 : weak.has(t) ? 1 : 0;
        if (score > bestScore) { best = a; bestScore = score; }
      }
      return best;
    },

    check_parts_stock: async (partId) =>
      (await query("PartsInventory", "SELECT * FROM c WHERE c.id = @id", [{ name: "@id", value: partId }]))[0] || null,

    list_available_technicians: (skill) =>
      query("Technicians", "SELECT * FROM c WHERE c.available = true AND ARRAY_CONTAINS(c.skills, @s)",
        [{ name: "@s", value: skill }]),

    create_work_order: async (payload) => (await db.container("WorkOrders").items.create(payload)).resource.id,
  };
}

// 0 = normal, 1 = warning, 2 = critical. Thresholds with critical < warning are "low is bad".
function evaluateBreaches(metrics, thresholds) {
  const out = [];
  for (const t of thresholds) {
    const value = metrics?.[t.metric];
    if (typeof value !== "number") continue;
    const low = t.criticalThreshold < t.warningThreshold;
    const past = (limit) => (low ? value <= limit : value >= limit);
    const level = past(t.criticalThreshold) ? 2 : past(t.warningThreshold) ? 1 : 0;
    if (!level) continue;
    const span = Math.abs(t.criticalThreshold - t.warningThreshold) || 1;
    out.push({
      metric: t.metric, value, unit: t.unit, level,
      warningThreshold: t.warningThreshold, criticalThreshold: t.criticalThreshold,
      severityRatio: Math.min(Math.abs(value - t.warningThreshold) / span, 1),
    });
  }
  return out.sort((a, b) => b.level - a.level || b.severityRatio - a.severityRatio);
}

// Every metric of a reading with its limits and status, for display and for the decision trace.
function readingsTable(metrics, thresholds) {
  const byMetric = new Map(thresholds.map((t) => [t.metric, t]));
  return Object.entries(metrics || {})
    .filter(([, v]) => typeof v === "number")
    .map(([metric, value]) => {
      const t = byMetric.get(metric);
      if (!t) return { metric, value, unit: null, normalRange: null, warningThreshold: null, criticalThreshold: null, level: null, status: "not monitored", gauge: null };
      const low = t.criticalThreshold < t.warningThreshold;
      const past = (limit) => (low ? value <= limit : value >= limit);
      const level = past(t.criticalThreshold) ? 2 : past(t.warningThreshold) ? 1 : 0;
      const range = t.normalRange || {};
      // Early warning from the team's use-case notes: a reading within the margin below its warning limit.
      const margin = agents.earlyWarningMargin;
      const approaching = level === 0 && (low ? value <= t.warningThreshold + margin : value >= t.warningThreshold - margin);
      const gauge = low
        ? ((range.max ?? t.warningThreshold) - value) / (((range.max ?? t.warningThreshold) - t.criticalThreshold) || 1)
        : (value - (range.min ?? 0)) / ((t.criticalThreshold - (range.min ?? 0)) || 1);
      return { metric, value, unit: t.unit || null, normalRange: t.normalRange || null, warningThreshold: t.warningThreshold,
        criticalThreshold: t.criticalThreshold, lowIsBad: low, level, status: level === 2 ? "critical" : level === 1 ? "warning" : approaching ? "approaching" : "normal",
        gauge: Math.round(Math.min(Math.max(gauge, 0), 1.1) * 100) };
    })
    .sort((a, b) => (b.level ?? -1) - (a.level ?? -1));
}

// Same scoring as search_knowledge_base, for all articles, so the decision trace can show the alternatives.
function rankArticles(articles, text) {
  const want = new Set(tokens(text));
  return articles.map((a) => {
    const strong = new Set(tokens(`${a.faultType} ${a.issue}`));
    const weak = new Set(tokens((a.symptoms || []).join(" ")));
    const matched = [...want].filter((t) => strong.has(t) || weak.has(t));
    const score = [...want].reduce((s, t) => s + (strong.has(t) ? 3 : weak.has(t) ? 1 : 0), 0);
    return { id: a.id, issue: a.issue, score, matched };
  }).sort((a, b) => b.score - a.score);
}

function parseHours(text) {
  const m = /(\d+)(?:\s*-\s*(\d+))?\s*hours?/i.exec(text || "");
  return m ? Number(m[2] || m[1]) * 60 : null;
}

// One part per category named in the article's solutions, preferring the best name match.
async function selectParts(tools, machineType, article) {
  const text = [...(article.solutions || []), ...(article.possibleCauses || [])].join(" ").toLowerCase();
  const parts = await tools.query("PartsInventory", "SELECT * FROM c WHERE ARRAY_CONTAINS(c.compatibleMachines, @t)",
    [{ name: "@t", value: machineType }]);
  const byCategory = new Map();
  for (const p of parts) {
    const phrase = p.category.replace(/_/g, " ");
    if (!new RegExp(`\\b${phrase}s?\\b`).test(text)) continue;
    const overlap = tokens(p.name).filter((t) => text.includes(t)).length;
    const cur = byCategory.get(p.category);
    if (!cur || overlap > cur.overlap) byCategory.set(p.category, { part: p, overlap });
  }
  return [...byCategory.values()].map((v) => v.part);
}

// Skill overlap with the article text, ignoring generic words.
function relatedScore(tech, article) {
  const text = new Set(tokens(JSON.stringify([article?.issue, article?.solutions, article?.diagnosticSteps])));
  return tech.skills.flatMap((k) => tokens(k)).filter((k) => text.has(k) && !GENERIC.has(k)).length;
}

const impactRank = (slot) => (slot.windowId ? { none: 0, low: 1, medium: 2, high: 3 }[String(slot.productionImpact).toLowerCase()] ?? 2 : 9);
const clamp = (n, lo, hi) => Math.min(Math.max(Math.round(Number(n)) || lo, lo), hi);

const RULES = `You are the Preventative Maintenance Orchestrator for a tire factory.
Rules: never invent ids; use only ids from the input; prefer the root cause that matches the most severe breached metric;
only choose parts named or implied by the article's solutions; respect the output JSON shape exactly.
Consider the machine's failure history, part unit cost, stock and lead time: prefer the smallest set of parts that fixes the root cause.
The team's Repair Planner rules also apply: ${agents.repairRules.join("; ") || "none loaded"}.
Each article carries teamMapping: the required skills and part numbers the team defined for that fault. Prefer those parts; deviate only with a reason in the rationale.`;

const DIAGNOSE_PROMPT = `${RULES}
Task: pick the troubleshooting article and the parts needed, and explain the situation to the technician who will do the work.
crewSize is how many technicians the job needs (1 to 3): more than one when the work spans different disciplines (for example mechanical plus electrical) or is too long for one person.
Return JSON: {"rootCauseArticleId": string, "parts": [{"partId": string, "quantity": integer}], "title": string, "description": string, "rationale": string, "crewSize": integer, "crewReason": string, "technicianSummary": string}.
technicianSummary: 3 to 5 plain sentences covering what is wrong, the evidence in the readings, what to check first and what to avoid.`;

const DISPATCH_PROMPT = `${RULES}
Task: choose the lead technician and book one of that technician's pre-computed slots. Support technicians are added by the system.
Shifts matter: every slot already lies inside the technician's shift, so choose only from the listed slots.
For critical severity choose the earliest slot. For warning severity prefer slots inside a maintenance window with the lowest production impact, then the earliest.
If any candidate has skillMatch true you must choose among those.
Return JSON: {"technicianId": string, "slotStart": string, "rationale": string}.`;

// Disciplines inferred from the article text, matched against technician skills.
const AREAS = {
  electrical: {
    label: "Electrical and instrumentation",
    keywords: /sensor|thermostat|calibrat|plc|controller|wiring|encoder|motor|servo|heating element|drive|instrument/i,
    skills: ["electrical_systems", "instrumentation", "plc_programming", "plc_troubleshooting", "control_panels", "motor_drives",
      "servo_systems", "measurement_systems", "load_cell_calibration", "sensor_alignment", "temperature_control"],
  },
  mechanical: {
    label: "Mechanical and hydraulic",
    keywords: /bearing|seal|alignment|vibration|balanc|screw|\bdie\b|bladder|mold|hydraulic|steam|cooling|belt|regulator|drum|tension/i,
    skills: ["mechanical_systems", "bearing_replacement", "alignment", "vibration_analysis", "hydraulic_systems", "mold_maintenance",
      "bladder_replacement", "precision_alignment", "drum_balancing", "screw_maintenance", "tension_control"],
  },
};

function skillAreasNeeded(article) {
  const text = [article?.issue, ...(article?.solutions || []), ...(article?.possibleCauses || [])].join(" ");
  return Object.keys(AREAS).filter((a) => AREAS[a].keywords.test(text));
}

function buildBrief({ machine, article, breaches, readingRows, history, requiredParts, partsById, crew, crewReasons, narrative, bookedMinutes }) {
  const label = (b) => (b.level === 2 ? `critical at ${b.criticalThreshold}` : b.level === 1 ? `warning at ${b.warningThreshold}` : "projected to reach its limit");
  const readings = breaches.map((b) => `${b.metric.replace(/_/g, " ")} ${b.value}${b.unit ? " " + b.unit : ""} (${label(b)})`);
  return {
    summary: narrative.technicianSummary ||
      `${machine.name} is reporting ${readings.join(", ") || "abnormal readings"}. This matches "${article?.issue || "an unclassified fault"}"` +
      `${article?.impact ? ` (impact: ${article.impact})` : ""}. Confirm the cause with the diagnostic steps before replacing parts.`,
    observedReadings: readingRows,
    likelyCauses: article?.possibleCauses || [],
    diagnosticSteps: article?.diagnosticSteps || [],
    recommendedActions: article?.solutions || [],
    partsToBring: requiredParts.map((r) => ({ partNumber: r.partNumber, name: r.partName, quantity: r.quantity,
      location: partsById.get(r.partId)?.location || null, inStock: partsById.get(r.partId)?.quantityInStock ?? null })),
    relatedHistory: [...history].sort((a, b) => String(b.occurrenceDate).localeCompare(String(a.occurrenceDate))).slice(0, 3)
      .map((h) => ({ fault: h.faultType, date: h.occurrenceDate, downtimeMinutes: h.downtime, resolution: h.description })),
    crew: crew.map((c) => ({ technicianId: c.technicianId, name: c.name, role: c.role, focus: c.focus })),
    crewReason: crew.length > 1 ? (narrative.crewReason || crewReasons.join(" ")) : null,
    expectedRepairTime: article?.estimatedRepairTime || null,
    bookedMinutes,
    safety: ["Apply lockout/tagout and confirm zero energy before opening the machine.",
      "Record the readings before and after the repair in the work order notes.",
      "Collect the listed parts from the stock locations before the shift starts."],
  };
}

// Ordered, actionable tasks: the article's diagnostic steps first, then its repair actions.
function buildTasks(article, effortMin) {
  const steps = [
    ...(article?.diagnosticSteps || []).map((title) => ({ title, phase: "diagnose" })),
    ...(article?.solutions || []).map((title) => ({ title, phase: "repair" })),
  ];
  const each = Math.max(5, Math.round(effortMin / (steps.length || 1) / 5) * 5);
  return steps.map((s, i) => ({ sequence: i + 1, phase: s.phase, title: s.title, estimatedDurationMinutes: each,
    description: s.phase === "diagnose" ? "Record the result before continuing." : "Do this only if the diagnostic steps confirm the cause.",
    safetyNotes: s.phase === "repair" ? "Apply lockout/tagout before starting." : null }));
}

async function runOrchestrator(db, machineId, { dryRun = false, useLlm = true, crewOverride = null, assumeIntervalMin = null } = {}) {
  const tools = createTools(db);
  const trace = [];
  const step = (key, title, summary, details = {}, source = "rules") => {
    const s = { step: trace.length + 1, key, title, agent: AGENT_OF[key] || null, summary, source, details };
    trace.push(s);
    return s;
  };

  const [machine] = await tools.query("Machines", "SELECT * FROM c WHERE c.id = @id", [{ name: "@id", value: machineId }]);
  if (!machine) throw fail(404, `machine ${machineId} not found`);

  const telemetry = await tools.get_telemetry(machineId);
  if (!telemetry) return { action: "none", reason: "no telemetry available", machineId };

  const thresholds = await tools.get_thresholds(machine.type);
  let breaches = evaluateBreaches(telemetry.metrics, thresholds);
  const readingRows = readingsTable(telemetry.metrics, thresholds);
  const recent = await tools.get_recent_telemetry(machineId, 20);
  const forecast = forecastFromReadings(recent, thresholds, { assumeIntervalMin });
  const forecastSummary = { confidence: forecast.confidence, earliestCriticalMinutes: forecast.earliestCriticalMinutes,
    drivingMetric: forecast.drivingMetric, assumeIntervalMin: forecast.assumeIntervalMin, readingsUsed: forecast.readingsUsed };

  // A low-confidence trend (few or closely spaced readings) is shown but never changes the decision.
  const actionable = ["medium", "high", "assumed"].includes(forecast.confidence);
  const predicted = actionable && forecast.earliestCriticalMinutes != null && forecast.earliestCriticalMinutes <= 72 * 60;
  const severity = Math.max(rankOf(telemetry.status), ...breaches.map((b) => b.level));
  const approaching = readingRows.filter((r) => r.status === "approaching");
  if (severity === 0 && !predicted && !approaching.length) {
    return { action: "none", reason: "Status is normal and no limit is projected to be reached within 72 hours.", machineId,
      telemetryId: telemetry.id, forecast: forecastSummary, readings: readingRows };
  }
  if (!breaches.length) {
    breaches = forecast.metrics.filter((m) => m.minutesToCritical != null && m.minutesToCritical <= 72 * 60)
      .map((m) => ({ metric: m.metric, value: m.last.value, unit: m.unit, level: 0, warningThreshold: m.warningThreshold,
        criticalThreshold: m.criticalThreshold, severityRatio: 0 }));
  }
  if (!breaches.length) {
    breaches = approaching.map((r) => ({ metric: r.metric, value: r.value, unit: r.unit, level: 0, warningThreshold: r.warningThreshold,
      criticalThreshold: r.criticalThreshold, severityRatio: 0 }));
  }

  const critical = severity === 2;
  const urgent = critical || predicted;
  const now = new Date();
  const nowMs = now.getTime();
  const warnings = [];
  const decisions = { diagnosis: "rules", dispatch: "rules" };
  const readingAgeDays = Math.round((nowMs - Date.parse(telemetry.timestamp)) / DAY);
  if (readingAgeDays >= 1) warnings.push(`The latest telemetry is ${readingAgeDays} days old; the forecast is treated as starting now.`);

  step("telemetry", "Read the latest telemetry",
    `${breaches.filter((b) => b.level > 0).length} of ${readingRows.filter((r) => r.level != null).length} monitored readings are past a limit (status: ${telemetry.status}).`,
    { readingTime: telemetry.timestamp, status: telemetry.status, readings: readingRows });
  const worst = forecast.metrics.find((m) => m.metric === forecast.drivingMetric);
  step("forecast", "Project the trend forward",
    forecast.earliestCriticalMinutes == null
      ? `No monitored metric is trending toward its critical limit (${forecast.confidence} confidence, ${forecast.readingsUsed} readings).`
      : `${worst.metric.replace(/_/g, " ")} is projected to reach its critical limit in about ${forecast.earliestCriticalMinutes} minutes (${forecast.confidence} confidence, ${forecast.readingsUsed} readings).` +
        (predicted ? " This is trusted enough to raise urgency." : " Confidence is too low to change the decision; it is shown for information."),
    { assumeIntervalMin: forecast.assumeIntervalMin, confidence: forecast.confidence, acted: predicted,
      metrics: forecast.metrics.map((m) => ({ metric: m.metric, slopePerHour: m.slopePerHour, minutesToWarning: m.minutesToWarning, minutesToCritical: m.minutesToCritical })) });
  const llmOn = useLlm && llm.isConfigured();
  const typeParam = [{ name: "@t", value: machine.type }];

  const [articles, compatibleParts, history, suppliers] = await Promise.all([
    tools.query("KnowledgeBase", "SELECT * FROM c WHERE c.machineType = @t", typeParam),
    // All parts: the team's fault-to-parts table can name parts that are shared across machine types.
    tools.query("PartsInventory"),
    tools.query("MaintenanceHistory", "SELECT * FROM c WHERE c.machineId = @m", [{ name: "@m", value: machineId }]),
    tools.query("Suppliers"),
  ]);

  // Rule-based diagnosis: best article for the most severe breached metric.
  let article = null, driver = null;
  for (const b of breaches) {
    article = await tools.search_knowledge_base(b.metric, machine.type);
    if (article) { driver = b; break; }
  }
  if (!article) article = await tools.search_knowledge_base((telemetry.alerts || []).join(" "), machine.type);
  // Parts: the team's fault-to-parts table when it knows this fault, otherwise keyword matching on the article.
  const mappingFor = (a) => ({ faultType: a?.faultType || null, skills: agents.faultSkills[a?.faultType] || null, parts: agents.faultParts[a?.faultType] || null });
  const mappedParts = (a) => mappingFor(a).parts?.map((pn) => compatibleParts.find((p) => p.partNumber === pn)).filter(Boolean) || null;
  const keywordParts = async (a) => (a ? (await selectParts(tools, machine.type, a)).map((p) => compatibleParts.find((x) => x.id === p.id) || p) : []);
  const partsFor = async (a) => ((await mappedParts(a)) || (await keywordParts(a))).map((part) => ({ part, quantity: 1 }));
  let partsNeeded = await partsFor(article);
  let partsSource = mappingFor(article).parts ? "team fault-to-parts table" : "keyword match";
  let narrative = {};
  const ruleArticle = article;

  if (llmOn) {
    try {
      const d = await llm.chatJson(DIAGNOSE_PROMPT, {
        machine: { id: machine.id, name: machine.name, type: machine.type },
        severity: critical ? "critical" : "warning",
        telemetry: { id: telemetry.id, metrics: telemetry.metrics, alerts: telemetry.alerts },
        breaches,
        articles: articles.map((a) => ({ id: a.id, issue: a.issue, faultType: a.faultType, symptoms: a.symptoms,
          possibleCauses: a.possibleCauses, solutions: a.solutions, estimatedRepairTime: a.estimatedRepairTime,
          teamMapping: { requiredSkills: mappingFor(a).skills, requiredPartNumbers: mappingFor(a).parts } })),
        parts: compatibleParts.map((p) => ({ id: p.id, partNumber: p.partNumber, name: p.name, category: p.category, compatibleMachines: p.compatibleMachines,
          quantityInStock: p.quantityInStock,
          reorderLevel: p.reorderLevel, unitCost: p.unitCost, leadTimeDays: p.leadTimeDays })),
        machineFailureHistory: history.map((h) => ({ fault: h.faultType, date: h.occurrenceDate, downtimeMinutes: h.downtime, cost: h.cost })),
      });
      const chosen = articles.find((a) => a.id === d.rootCauseArticleId);
      if (!chosen) throw new Error("unknown article id");
      article = chosen;
      partsNeeded = (Array.isArray(d.parts) ? d.parts : [])
        .map((x) => ({ part: compatibleParts.find((p) => p.id === x.partId), quantity: clamp(x.quantity, 1, 5) }))
        .filter((x) => x.part);
      narrative = { title: d.title, description: d.description, rationale: d.rationale,
        crewSize: clamp(d.crewSize, 1, 3), crewReason: d.crewReason, technicianSummary: d.technicianSummary };
      partsSource = "AI model";
      decisions.diagnosis = "llm";
    } catch (e) {
      warnings.push(`LLM diagnosis unavailable (${e.message}); rule-based diagnosis used.`);
    }
  }
  if (!article) warnings.push("No matching knowledge-base article found.");
  {
    const text = breaches.map((b) => b.metric).join(" ");
    step("diagnosis", "Choose the most likely root cause",
      article ? `"${article.issue}" was chosen${decisions.diagnosis === "llm" ? " by the AI model" : " by symptom matching"}.` : "No article matched the readings.",
      { ruleChoice: ruleArticle?.id || null, finalChoice: article?.id || null, agree: ruleArticle?.id === article?.id,
        candidates: rankArticles(articles, text), rationale: narrative.rationale || null }, decisions.diagnosis);
  }

  const [existing] = article
    ? await tools.query("WorkOrders",
        "SELECT c.id, c.status FROM c WHERE c.machineId = @m AND c.rootCauseArticleId = @a AND c.status IN ('open','in_progress')",
        [{ name: "@m", value: machineId }, { name: "@a", value: article.id }])
    : [];
  if (existing && !dryRun) return { action: "skipped_duplicate", existingWorkOrder: existing, machineId, rootCauseArticleId: article.id };
  if (existing) warnings.push(`Open work order ${existing.id} already covers this issue; this run is analysis only.`);

  const requiredParts = [];
  for (const { part: p, quantity: qty } of partsNeeded) {
    const stock = await tools.check_parts_stock(p.id);
    requiredParts.push({ partId: p.id, partNumber: p.partNumber, partName: p.name, quantity: qty,
      unitCost: p.unitCost, lineCost: Math.round(qty * p.unitCost * 100) / 100, isAvailable: stock.quantityInStock >= qty });
  }
  const estimatedPartsCost = Math.round(requiredParts.reduce((s, r) => s + r.lineCost, 0) * 100) / 100;
  const historicalFailureCostAvg = history.length ? Math.round(history.reduce((s, h) => s + (h.cost || 0), 0) / history.length) : null;
  const historicalDowntimeAvg = history.length ? Math.round(history.reduce((s, h) => s + (h.downtime || 0), 0) / history.length) : null;
  const articleText = [...(article?.solutions || []), ...(article?.possibleCauses || [])].join(" ").toLowerCase();
  const partsStep = step("parts", "Select the parts",
    requiredParts.length ? `${requiredParts.length} part(s) selected from the ${partsSource}, estimated cost ${estimatedPartsCost}.` : "No specific parts are implied by the article.",
    { source: partsSource, mapping: mappingFor(article),
      considered: compatibleParts.map((p) => ({ partNumber: p.partNumber, name: p.name, category: p.category, unitCost: p.unitCost,
        inStock: p.quantityInStock, reorderLevel: p.reorderLevel, leadTimeDays: p.leadTimeDays,
        compatible: (p.compatibleMachines || []).includes(machine.type),
        mentionedInArticle: new RegExp(`\\b${p.category.replace(/_/g, " ")}s?\\b`).test(articleText),
        inTeamTable: Boolean(mappingFor(article).parts?.includes(p.partNumber)),
        selected: requiredParts.some((r) => r.partId === p.id) }))
        .filter((p) => p.selected || p.inTeamTable || p.compatible) }, decisions.diagnosis === "llm" ? "llm" : "rules");

  // Dispatch: technician(s) + slot, constrained by shifts, existing bookings and maintenance windows.
  let durationMin = parseHours(article?.estimatedRepairTime);
  if (durationMin == null) {
    durationMin = DEFAULT_DURATION_MIN;
    warnings.push(`No repair-time estimate in the article; booked ${DEFAULT_DURATION_MIN} minutes.`);
  }
  const roundUp = (ms) => Math.ceil(ms / (15 * MIN)) * 15 * MIN;
  const earliest = roundUp(nowMs + (urgent ? 1 : 4) * HOUR);
  const horizon = nowMs + (urgent ? 3 : 14) * DAY;

  const [bookedOrders, windows, allTechnicians] = await Promise.all([
    tools.query("WorkOrders", "SELECT c.machineId, c.assignedTo, c.assignedTechnician, c.crew, c.status, c.scheduledDate, c.scheduledEnd, c.estimatedDuration FROM c WHERE c.status IN ('open','scheduled','in_progress')"),
    tools.query("MaintenanceWindows", "SELECT * FROM c WHERE c.isAvailable = true AND c.endTime > @now",
      [{ name: "@now", value: now.toISOString() }]),
    tools.query("Technicians"),
  ]);
  const technicians = allTechnicians.filter((t) => t.available === true);
  const busy = bookingIntervals(bookedOrders, nowMs);
  const techBusy = (id) => [...(busy.byTech.get(id) || []), ...(busy.byMachine.get(machineId) || [])];

  // Crew size: long jobs and jobs that no single technician can cover need more than one technician.
  const areasNeeded = skillAreasNeeded(article);
  const requiredSkills = mappingFor(article).skills || [];
  const covers = (t) => requiredSkills.filter((s) => t.skills.includes(s));
  const bestCover = technicians.reduce((m, t) => Math.max(m, covers(t).length), 0);
  const crewReasons = [];
  if (durationMin >= 360) crewReasons.push(`The job is estimated at ${Math.round(durationMin / 60)} hours; splitting it shortens the booking.`);
  if (requiredSkills.length) {
    if (bestCover < Math.ceil(requiredSkills.length * 0.8)) {
      crewReasons.push(`No single available technician covers the ${requiredSkills.length} required skills (the best covers ${bestCover}).`);
    }
  } else if (areasNeeded.length > 1) {
    crewReasons.push(`The repair spans ${areasNeeded.map((a) => AREAS[a].label.toLowerCase()).join(" and ")} work.`);
  }
  const crewWanted = Math.min(3, technicians.length,
    crewOverride || Math.max(crewReasons.length ? 2 : 1, narrative.crewSize || 1));
  if (crewOverride) crewReasons.push(`Crew size ${crewOverride} was set manually for this what-if run.`);
  step("crew", "Decide how many technicians are needed",
    crewWanted > 1 ? `A crew of ${crewWanted} is planned.` : "One technician is enough.",
    { estimatedEffortMinutes: durationMin, disciplines: areasNeeded.map((a) => AREAS[a].label), requiredSkills, reasons: crewReasons,
      crewSize: crewWanted, llmSuggested: narrative.crewSize || null, manualOverride: crewOverride }, narrative.crewSize ? decisions.diagnosis : "rules");

  const blockFor = (n) => (n === 1 ? durationMin : Math.ceil(((durationMin / n) * 1.15) / 15) * 15);
  const candidatesFor = (useWindows, blockMin) => technicians
    .map((tech) => ({
      tech,
      skillMatch: tech.skills.includes(machine.type),
      related: relatedScore(tech, article),
      slots: buildSlots({
        shift: tech.shiftSchedule, busy: techBusy(tech.id), windows: useWindows ? windows : null,
        lo: earliest, hi: horizon, durationMs: blockMin * MIN,
      }),
    }))
    .filter((c) => c.slots.length);

  const coverage = (t) => areasNeeded.filter((a) => t.skills.some((s) => AREAS[a].skills.includes(s)));
  const pickSupport = (lead, slot, n) => {
    // With the team skill table, helpers are ranked by how many of the lead's missing required skills they cover.
    const missing = requiredSkills.length ? requiredSkills.filter((s) => !lead.skills.includes(s)) : areasNeeded.filter((a) => !coverage(lead).includes(a));
    const fillOf = (t) => (requiredSkills.length ? missing.filter((s) => t.skills.includes(s)) : missing.filter((a) => coverage(t).includes(a)));
    const helpers = technicians
      .filter((t) => t.id !== lead.id && isFree({ shift: t.shiftSchedule, busy: techBusy(t.id), start: slot.start, end: slot.end }))
      .map((t) => ({ t, fill: fillOf(t), rel: (t.skills.includes(machine.type) ? 2 : 0) + relatedScore(t, article) }))
      .sort((a, b) => b.fill.length - a.fill.length || b.rel - a.rel);
    if (helpers.length < n - 1) return null;
    return helpers.slice(0, n - 1).map((h) => ({ tech: h.t,
      focus: !h.fill.length ? "Assist the lead with the repair"
        : requiredSkills.length ? `Covers ${h.fill.map((s) => s.replace(/_/g, " ")).join(", ")}` : `${h.fill.map((a) => AREAS[a].label).join(" and ")} work` }));
  };

  const plan = (n) => {
    const block = blockFor(n);
    let cands = candidatesFor(!urgent, block);
    let windowFallback = false;
    if (!urgent && !cands.length) { cands = candidatesFor(false, block); windowFallback = cands.length > 0; }
    const skilled = cands.filter((c) => c.skillMatch);
    const pool = skilled.length ? skilled : cands.filter((c) => c.related >= 2);
    const pairs = pool
      .flatMap((c) => c.slots.map((slot) => ({ cand: c, slot })))
      .sort((a, b) => (urgent ? 0 : impactRank(a.slot) - impactRank(b.slot)) || a.slot.start.localeCompare(b.slot.start));
    return { n, block, cands, pool, pairs, windowFallback };
  };

  // The LLM proposes the lead and slot; code accepts it only if it is valid and a full crew can be formed.
  // `quiet` runs (what-if alternatives) skip the LLM and leave warnings and the trace untouched.
  const choose = async (p, { quiet = false, log = null } = {}) => {
    let llmPair = null;
    if (llmOn && !quiet && p.cands.length) {
      try {
        const d = await llm.chatJson(DISPATCH_PROMPT, {
          machineId, severity: urgent ? "critical" : "warning", bookedMinutes: p.block, crewSize: p.n,
          candidates: p.cands.map((c) => ({ technicianId: c.tech.id, name: c.tech.name, skills: c.tech.skills,
            shift: c.tech.shiftSchedule, skillMatch: c.skillMatch, slots: c.slots })),
        });
        const cand = p.pool.find((c) => c.tech.id === d.technicianId);
        const slot = cand?.slots.find((s) => s.start === d.slotStart);
        if (!slot) throw new Error("technician or slot not among valid options");
        llmPair = { cand, slot };
        narrative.dispatchRationale = d.rationale;
      } catch (e) {
        warnings.push(`LLM dispatch unavailable (${e.message}); rule-based dispatch used.`);
      }
    }
    for (const pair of [...(llmPair ? [llmPair] : []), ...p.pairs]) {
      const support = p.n > 1 ? pickSupport(pair.cand.tech, pair.slot, p.n) : [];
      if (log && log.length < 12) {
        log.push({ crewSize: p.n, lead: pair.cand.tech.name, start: pair.slot.start, end: pair.slot.end,
          proposedBy: pair === llmPair ? "ai" : "rules", windowImpact: pair.slot.productionImpact || null,
          outcome: support ? "accepted" : `rejected: no second technician free for the whole slot` });
      }
      if (support) return { pair, support, plan: p, byLlm: pair === llmPair };
    }
    return null;
  };

  const attempts = [];
  let chosen = await choose(plan(crewWanted), { log: attempts });
  if (!chosen && crewWanted > 1) {
    warnings.push(`A crew of ${crewWanted} is recommended, but no suitable second technician is free in the same shift; booked one technician for the full duration.`);
    chosen = await choose(plan(1), { log: attempts });
  }
  if (chosen?.byLlm) decisions.dispatch = "llm";
  if (chosen?.plan.windowFallback) warnings.push("No upcoming maintenance window fits; booked the earliest slot inside the technician's shift instead.");

  const tech = chosen?.pair.cand.tech || null;
  const slot = chosen?.pair.slot || null;
  const bookedMinutes = chosen?.plan.block || durationMin;
  const crew = tech ? [
    { technicianId: tech.id, name: tech.name, role: "lead", shift: tech.shiftSchedule,
      focus: requiredSkills.length && covers(tech).length ? `Lead diagnosis; covers ${covers(tech).map((s) => s.replace(/_/g, " ")).join(", ")}`
        : coverage(tech).length ? `Lead diagnosis and ${coverage(tech).map((a) => AREAS[a].label.toLowerCase()).join(" and ")} work` : "Lead diagnosis and repair" },
    ...chosen.support.map((s) => ({ technicianId: s.tech.id, name: s.tech.name, role: "support", shift: s.tech.shiftSchedule, focus: s.focus })),
  ] : [];
  if (!slot) warnings.push(`No technician has a free ${durationMin}-minute slot inside their shift within ${urgent ? 3 : 14} days. Unscheduled; escalate to a supervisor.`);
  else if (!chosen.pair.cand.skillMatch) warnings.push(`No available technician with skill "${machine.type}"; assigned by related skills.`);
  const stamp = nowMs;
  // Reorder is sized against the booked repair date so late supplier delivery is flagged.
  const daysUntilRepair = slot ? (Date.parse(slot.start) - nowMs) / DAY : null;
  const reorder = requiredParts
    .map((r) => recommendOrder({ part: compatibleParts.find((p) => p.id === r.partId), requiredQty: r.quantity, suppliers, daysUntilNeeded: daysUntilRepair }))
    .filter(Boolean);
  partsStep.details.reorder = reorder;
  const driverText = driver ? `${driver.metric}=${driver.value}${driver.unit ? " " + driver.unit : ""}` : (telemetry.alerts || []).join(", ");
  const technicianBrief = buildBrief({ machine, article, breaches, readingRows, history, requiredParts,
    partsById: new Map(compatibleParts.map((p) => [p.id, p])), crew, crewReasons, narrative, bookedMinutes });

  if (slot && forecast.earliestCriticalMinutes != null && Date.parse(slot.start) > nowMs + forecast.earliestCriticalMinutes * MIN && actionable) {
    warnings.push("The booked slot starts after the projected critical time. Consider an emergency visit or an earlier slot.");
  }

  // What-if: the same decision for each possible crew size, without calling the AI model.
  const alternatives = [];
  for (let n = 1; n <= Math.min(3, technicians.length); n++) {
    const pl = plan(n);
    const ch = await choose(pl, { quiet: true });
    alternatives.push({ crewSize: n, bookedMinutes: pl.block, feasible: Boolean(ch), lead: ch?.pair.cand.tech.name || null,
      support: ch ? ch.support.map((s) => s.tech.name) : [], start: ch?.pair.slot.start || null, end: ch?.pair.slot.end || null,
      selected: n === crew.length });
  }

  const refPlan = chosen?.plan || plan(crewWanted);
  const techTable = allTechnicians.map((t) => {
    const c = refPlan.cands.find((x) => x.tech.id === t.id);
    const inPool = refPlan.pool.some((x) => x.tech.id === t.id);
    const role = crew.find((x) => x.technicianId === t.id)?.role;
    return { id: t.id, name: t.name, shift: t.shiftSchedule, available: t.available === true, skillMatch: t.skills.includes(machine.type),
      skillCoverage: requiredSkills.length ? `${covers(t).length}/${requiredSkills.length}` : null,
      nextSlot: c?.slots[0]?.start || null,
      verdict: t.available !== true ? "Unavailable" : role ? `Chosen as ${role}` : !c ? "No free slot inside the shift within the planning window"
        : !inPool ? "Not a lead candidate: lacks the machine skill while skilled technicians exist" : "Considered, a better option was found" };
  });
  step("dispatch", "Pick technicians and book a slot",
    slot ? `${crew.map((c) => `${c.name} (${c.role})`).join(", ")} booked ${fmtUtc(slot.start)} to ${fmtUtc(slot.end).slice(11)} UTC.` : "No technician has a free slot inside their shift.",
    { rule: "A slot must fit entirely inside the technician's shift and avoid their other bookings and this machine's other work.",
      urgentPlanning: urgent, technicians: techTable, attempts, crew }, decisions.dispatch);
  step("alternatives", "What if the crew size were different?",
    `${alternatives.filter((a) => a.feasible).length} of ${alternatives.length} crew sizes can be scheduled.`, { alternatives });

  const levelAtHours = (h) => forecast.metrics.reduce((lvl, m) => {
    const v = m.last.value + m.slopePerHour * h;
    const past = (lim) => (m.lowIsBad ? v <= lim : v >= lim);
    return Math.max(lvl, past(m.criticalThreshold) ? 2 : past(m.warningThreshold) ? 1 : 0);
  }, 0);
  const condition = (l) => ["normal", "warning", "critical"][l];
  const hoursToSlot = slot ? (Date.parse(slot.start) - nowMs) / HOUR : null;
  const scenarios = [
    { option: "Repair at the booked slot", when: slot?.start || null,
      projectedCondition: hoursToSlot != null && actionable ? condition(levelAtHours(hoursToSlot)) : "unknown",
      costEstimate: estimatedPartsCost, downtimeMinutes: bookedMinutes, note: "Planned stop, parts from stock." },
    { option: "Wait 24 hours, then repair", when: new Date(nowMs + 24 * HOUR).toISOString(),
      projectedCondition: actionable ? condition(levelAtHours(24)) : "unknown", costEstimate: estimatedPartsCost, downtimeMinutes: bookedMinutes,
      note: actionable ? "Same repair, but the machine keeps running in a worsening state." : "Not enough readings to project the condition reliably." },
    { option: "Run until it fails", when: forecast.earliestCriticalMinutes != null ? new Date(nowMs + forecast.earliestCriticalMinutes * MIN).toISOString() : null,
      projectedCondition: "breakdown", costEstimate: historicalFailureCostAvg, downtimeMinutes: historicalDowntimeAvg,
      note: "Average cost and downtime of this machine's past failures." },
  ];
  step("scenarios", "Compare the options",
    historicalFailureCostAvg != null
      ? `Repairing now costs about ${estimatedPartsCost} in parts; an average past failure on this machine cost ${historicalFailureCostAvg} and ${Math.round((historicalDowntimeAvg || 0) / 60 * 10) / 10} hours of downtime.`
      : "No failure history is available to compare against.",
    { forecastConfidence: forecast.confidence, scenarios });
  const priority = critical ? "critical" : predicted ? "high" : severity > 0 ? article?.priority || "high" : "medium";
  step("decision", "Decision",
    `Create a ${priority} priority predictive work order${slot ? ` for ${fmtUtc(slot.start)} UTC` : " (unscheduled)"}` +
    `${crew.length ? ` with ${crew.map((c) => c.name).join(" and ")}` : ""}.`,
    { trigger: critical ? "A reading is past its critical limit." : severity > 0 ? "A reading is past its warning limit." : predicted ? "The forecast projects a limit will be reached." : "A reading is within the early-warning margin of its warning limit.",
      priority, decidedBy: decisions, warnings }, decisions.dispatch === "llm" || decisions.diagnosis === "llm" ? "ai" : "rules");
  const decisionTrace = { generatedAt: now.toISOString(), steps: trace, scenarios, alternatives, forecast: forecastSummary };

  const workOrder = {
    id: `wo-pm-${stamp}`,
    workOrderNumber: `WO-PM-${stamp}`,
    machineId,
    faultType: article?.faultType || null,
    rootCauseArticleId: article?.id || null,
    title: narrative.title || `Predictive Maintenance - ${article?.issue || "Threshold breach"}`,
    description: narrative.description || `${machine.name}: ${critical ? "critical" : severity ? "warning" : "projected"} reading (${driverText}). ` +
      `${severity ? "Breached" : "Trending toward limits"}: ${breaches.map((b) => b.metric).join(", ")}.`,
    type: "predictive",
    priority,
    status: "open",
    assignedTo: tech?.id || null,
    assignedTechnician: tech?.id || null,
    createdDate: now.toISOString(),
    createdAt: now.toISOString(),
    scheduledDate: slot?.start || null,
    scheduledEnd: slot?.end || null,
    shift: tech?.shiftSchedule || null,
    maintenanceWindowId: slot?.windowId || null,
    productionImpact: slot?.productionImpact || null,
    estimatedDuration: bookedMinutes,
    estimatedEffortMinutes: durationMin,
    crewSize: crew.length,
    crew,
    technicianBrief,
    decisionTrace,
    tasks: buildTasks(article, durationMin),
    requiredParts,
    reorderRequired: reorder,
    estimatedPartsCost,
    historicalFailureCostAvg,
    partsUsed: [],
    diagnosticSteps: article?.diagnosticSteps || [],
    notes: [
      `Triggered from telemetry ${telemetry.id} (${telemetry.status}).`,
      slot ? `Booked ${slot.start} to ${slot.end} UTC inside the ${tech.shiftSchedule} shift${crew.length > 1 ? ` for a crew of ${crew.length}` : ""}.` : null,
      narrative.rationale, narrative.dispatchRationale,
      reorder.length ? `Reorder flagged: ${reorder.map((r) => `${r.partNumber} x${r.orderQuantity} from ${r.supplierName} (${r.leadTimeDays}d, ${r.totalCost})`).join("; ")}.` : null,
      ...warnings,
    ].filter(Boolean).join(" "),
    cost: 0,
  };

  const extras = { trace, forecast: forecastSummary, forecastDetail: forecast, scenarios, alternatives, readings: readingRows, duplicateOf: existing?.id || null };
  if (dryRun) return { action: "dry_run", severity, decisions, breaches, reorder, warnings, workOrder, ...extras };
  await tools.create_work_order(workOrder);
  return { action: "created", severity, decisions, breaches, reorder, warnings, workOrder, ...extras };
}

module.exports = { runOrchestrator, evaluateBreaches, rankOf, createTools, readingsTable };
