// Shared renderers: readings table, decision trace and forecast chart. Loaded after common.js.
const raw = (html) => ({ __html: html });
const cellHtml = (c) => (c && c.__html !== undefined ? c.__html : esc(c ?? ""));

function miniTable(headers, rows) {
  if (!rows.length) return `<div class="muted">Nothing to show.</div>`;
  return `<div class="table-wrap"><table class="mini"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>
    ${rows.map((r) => `<tr>${r.map((c) => `<td>${cellHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

const prettyMetric = (m) => String(m).replace(/_/g, " ");

// One row per reading: current value against its normal range, warning limit and critical limit.
function readingsTableHtml(rows) {
  if (!rows || !rows.length) return `<span class="muted">No readings available.</span>`;
  return miniTable(["Reading", "Current", "Normal range", "Warning at", "Critical at", "Status"], rows.map((r) => [
    prettyMetric(r.metric),
    raw(`<b>${esc(r.value)}</b> ${esc(r.unit || "")}${r.gauge != null ? `<div class="gauge"><i class="g-${esc(r.status)}" style="width:${Math.min(r.gauge, 100)}%"></i></div>` : ""}`),
    r.normalRange ? `${r.normalRange.min} to ${r.normalRange.max}` : "-",
    r.warningThreshold ?? "-",
    r.criticalThreshold ?? "-",
    raw(badge(r.status)),
  ]));
}

const mins = (m) => (m == null ? "not reached" : m === 0 ? "already past" : `${m} min`);

function traceDetails(s) {
  const d = s.details || {};
  switch (s.key) {
    case "telemetry":
      return `<div class="muted">Reading taken ${esc(fmtDate(d.readingTime))} UTC</div>${readingsTableHtml(d.readings)}`;
    case "forecast":
      return `<div class="muted">${d.assumeIntervalMin ? `What-if: the last change is assumed to repeat every ${esc(d.assumeIntervalMin)} minutes. ` : ""}Confidence: ${esc(d.confidence)}.</div>` +
        miniTable(["Reading", "Change per hour", "Time to warning", "Time to critical"],
          d.metrics.map((m) => [prettyMetric(m.metric), m.slopePerHour, mins(m.minutesToWarning), mins(m.minutesToCritical)]));
    case "diagnosis":
      return miniTable(["Candidate cause", "Match score", "Matched words", ""],
        d.candidates.map((c) => [c.issue, c.score, c.matched.join(", ") || "-", raw(c.id === d.finalChoice ? badge("lead", "Chosen") : "")])) +
        (d.rationale ? `<div class="muted" style="margin-top:6px">AI rationale: ${esc(d.rationale)}</div>` : "") +
        (d.ruleChoice !== d.finalChoice ? `<div class="muted">Symptom matching alone would have picked a different article.</div>` : "");
    case "parts":
      return `<div class="muted">Source: ${esc(d.source)}.${d.mapping?.faultType ? ` Team table for ${esc(d.mapping.faultType)}: ${d.mapping.parts?.length ? esc(d.mapping.parts.join(", ")) : "no parts"}.` : ""}</div>` +
        miniTable(["Part", "Category", "Unit cost", "Stock / reorder level", "Lead time", "Compatible", "In team table", "Named in article", ""],
        d.considered.map((p) => [raw(`${esc(p.name)}<div class="muted">${esc(p.partNumber)}</div>`), prettyMetric(p.category), money(p.unitCost),
          `${p.inStock} / ${p.reorderLevel}`, `${p.leadTimeDays} d`, p.compatible ? "yes" : "no", p.inTeamTable ? "yes" : "no", p.mentionedInArticle ? "yes" : "no", raw(p.selected ? badge("lead", "Selected") : "")])) +
        (d.reorder?.length ? `<div style="margin-top:6px"><b>Reorder:</b> ${d.reorder.map((r) => `${esc(r.partNumber)} x${esc(r.orderQuantity)} from ${esc(r.supplierName)} (${money(r.totalCost)}, ${esc(r.leadTimeDays)} days)`).join("; ")}</div>` : "");
    case "crew":
      return `<div>Estimated effort: ${esc(fmtMinutes(d.estimatedEffortMinutes))}. ${d.requiredSkills?.length ? `Required skills (team table): ${esc(d.requiredSkills.map(prettyMetric).join(", "))}.` : `Disciplines: ${esc(d.disciplines.join(", ") || "not specified")}.`}</div>${list(d.reasons)}`;
    case "dispatch":
      return `<div class="muted">${esc(d.rule)}${d.urgentPlanning ? " Urgent planning: earliest possible slot, maintenance windows ignored." : ""}</div>` +
        miniTable(["Technician", "Shift", "Available", "Has machine skill", "Required skills covered", "Next free slot", "Verdict"],
          d.technicians.map((t) => [t.name, t.shift, t.available ? "yes" : "no", t.skillMatch ? "yes" : "no", t.skillCoverage || "-", t.nextSlot ? fmtDate(t.nextSlot) + " UTC" : "-", t.verdict])) +
        `<div style="margin-top:8px"><b>Options tried, in order</b></div>` +
        miniTable(["Crew", "Lead", "Slot (UTC)", "Proposed by", "Outcome"],
          d.attempts.map((a) => [a.crewSize, a.lead, `${fmtDate(a.start)} to ${fmtTime(a.end)}`, a.proposedBy, a.outcome]));
    case "alternatives":
      return miniTable(["Crew size", "Booked time", "Can be scheduled", "Lead", "Support", "Start (UTC)", ""],
        d.alternatives.map((a) => [a.crewSize, fmtMinutes(a.bookedMinutes), a.feasible ? "yes" : "no", a.lead || "-", a.support.join(", ") || "-",
          a.start ? fmtDate(a.start) : "-", raw(a.selected ? badge("lead", "Selected") : "")]));
    case "scenarios":
      return `<div class="muted">Forecast confidence: ${esc(d.forecastConfidence)}.</div>` +
        miniTable(["Option", "When (UTC)", "Machine condition then", "Estimated cost", "Downtime", "Note"],
          d.scenarios.map((x) => [x.option, x.when ? fmtDate(x.when) : "-", raw(badge(x.projectedCondition === "breakdown" ? "critical" : x.projectedCondition, x.projectedCondition)),
            x.costEstimate != null ? money(x.costEstimate) : "-", x.downtimeMinutes != null ? fmtMinutes(x.downtimeMinutes) : "-", x.note]));
    case "decision":
      return `<div>${esc(d.trigger)}</div>${d.warnings?.length ? `<div class="warn" style="margin-top:6px">${d.warnings.map(esc).join("<br>")}</div>` : ""}`;
    default:
      return "";
  }
}

// Numbered timeline of everything the orchestrator considered, in order.
function traceHtml(steps) {
  return `<div class="trace">${steps.map((s) => `
    <div class="trace-step">
      <div class="trace-num">${s.step}</div>
      <div class="trace-body">
        <div class="trace-head"><b>${esc(s.title)}</b> ${s.agent ? `<span class="badge b-support">${esc(s.agent)}</span>` : ""} ${badge(s.source === "llm" ? "ai" : s.source, s.source === "llm" ? "AI model" : s.source === "ai" ? "AI model" : "Rules")}</div>
        <div>${esc(s.summary)}</div>
        <details><summary>Show details</summary>${traceDetails(s)}</details>
      </div>
    </div>`).join("")}</div>`;
}

// SVG: past readings (solid), projection (dashed) and the warning / critical limits.
function forecastChart(m) {
  const W = 480, H = 190, L = 48, R = 12, T = 12, B = 30;
  const t0 = Date.parse(m.last.time);
  const hist = m.history.map((p) => ({ x: (Date.parse(p.time) - t0) / 60000, y: p.value }));
  const proj = m.projection.map((p) => ({ x: p.minutes, y: p.value }));
  const xMin = Math.min(0, ...hist.map((p) => p.x)), xMax = Math.max(...proj.map((p) => p.x), 1);
  const ys = [...hist, ...proj].map((p) => p.y).concat([m.warningThreshold, m.criticalThreshold]);
  const yLo = Math.min(...ys), yHi = Math.max(...ys), pad = (yHi - yLo || 1) * 0.08;
  const sx = (x) => L + ((x - xMin) / (xMax - xMin || 1)) * (W - L - R);
  const sy = (y) => T + (1 - (y - (yLo - pad)) / (yHi - yLo + 2 * pad || 1)) * (H - T - B);
  const pts = (a) => a.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const cross = proj.find((p) => (m.lowIsBad ? p.y <= m.criticalThreshold : p.y >= m.criticalThreshold));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => xMax * f);
  const line = (y, color, label) => `<line x1="${L}" x2="${W - R}" y1="${sy(y)}" y2="${sy(y)}" stroke="${color}" stroke-dasharray="5 4"/><text x="${W - R}" y="${sy(y) - 4}" text-anchor="end" font-size="10" fill="${color}">${label} ${y}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Forecast for ${esc(prettyMetric(m.metric))}">
    ${ticks.map((x) => `<line x1="${sx(x)}" x2="${sx(x)}" y1="${T}" y2="${H - B}" stroke="#eef1f6"/><text x="${sx(x)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="#64748b">${x === 0 ? "last reading" : "+" + (x >= 60 ? Math.round(x / 60) + " h" : Math.round(x) + " min")}</text>`).join("")}
    ${line(m.warningThreshold, "#d97706", "warning")}${line(m.criticalThreshold, "#dc2626", "critical")}
    <text x="4" y="${sy(yHi)}" font-size="10" fill="#64748b">${Math.round(yHi * 10) / 10}</text><text x="4" y="${sy(yLo)}" font-size="10" fill="#64748b">${Math.round(yLo * 10) / 10}</text>
    <polyline points="${pts(proj)}" fill="none" stroke="#2f5bea" stroke-width="2" stroke-dasharray="6 4"/>
    <polyline points="${pts(hist)}" fill="none" stroke="#0f172a" stroke-width="2"/>
    ${hist.map((p) => `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="3" fill="#0f172a"/>`).join("")}
    ${cross ? `<circle cx="${sx(cross.x)}" cy="${sy(cross.y)}" r="5" fill="#dc2626"/><text x="${Math.min(sx(cross.x), W - 70)}" y="${sy(cross.y) + 16}" font-size="10" fill="#dc2626">critical in ~${Math.round(cross.x)} min</text>` : ""}
  </svg>`;
}
