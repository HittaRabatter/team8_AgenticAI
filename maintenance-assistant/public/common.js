const $ = (id) => document.getElementById(id);

async function api(url, options) {
  const r = await fetch(url, options && {
    ...options,
    headers: { "Content-Type": "application/json" },
    body: options.body && JSON.stringify(options.body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const money = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const pad = (n) => String(n).padStart(2, "0");

// All times are shown in UTC because shifts and maintenance windows are defined in UTC.
function fmtDate(v) {
  if (!v) return "";
  const d = new Date(v);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function fmtTime(v) {
  const d = new Date(v);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function fmtMinutes(m) {
  if (m == null) return "";
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
}
const initials = (name) => String(name || "?").split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();

function badge(value, label) {
  const key = String(value ?? "").toLowerCase().replace(/\s+/g, "-");
  return `<span class="badge b-${esc(key)}">${esc(label ?? String(value ?? "").replace(/_/g, " "))}</span>`;
}

function renderNav(active) {
  const links = [["dashboard.html", "Dashboard"], ["workorders.html", "Work Orders"], ["schedule.html", "Technician Schedule"],
    ["decisions.html", "AI Decisions"], ["machines.html", "Machines"], ["index.html", "Data Explorer"], ["settings.html", "Settings"]];
  $("topbar").innerHTML = `
    <div class="brand"><div class="brand-mark">M</div>Maintenance Assistant</div>
    <nav>${links.map(([href, label]) => `<a href="${href}" class="${href === active ? "active" : ""}">${label}</a>`).join("")}</nav>`;
}

const list = (items, tag = "ul") => (items && items.length ? `<${tag}>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</${tag}>` : `<span class="muted">None</span>`);

// Technician-facing view of a work order. `extra` may carry warnings, decisions and a create callback from a preview.
function showBrief(wo, extra = {}) {
  const b = wo.technicianBrief;
  const crew = wo.crew || [];
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const close = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const schedule = wo.scheduledDate
    ? `${esc(fmtDate(wo.scheduledDate))} to ${esc(wo.scheduledEnd ? fmtTime(wo.scheduledEnd) : "")} UTC · ${esc(wo.shift || "")} shift${wo.maintenanceWindowId ? ` · window ${esc(wo.maintenanceWindowId)} (${esc(wo.productionImpact)} impact)` : ""}`
    : "Not scheduled";

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <div>
          <div class="muted">${esc(wo.workOrderNumber)} · ${esc(wo.machineName || wo.machineId)}</div>
          <h2 style="font-size:18px;margin-top:2px">${esc(wo.title)}</h2>
          <div class="pills" style="margin-top:8px">${badge(wo.priority)} ${badge(wo.status)} ${badge(wo.type)}</div>
        </div>
        <button data-close>Close</button>
      </div>
      <div class="modal-body">
        ${extra.warnings?.length ? `<div class="warn">${extra.warnings.map(esc).join("<br>")}</div>` : ""}
        <div class="sec"><h3>Schedule</h3>${schedule}${wo.estimatedDuration ? `<div class="muted">Booked ${esc(fmtMinutes(wo.estimatedDuration))}${wo.estimatedEffortMinutes && wo.estimatedEffortMinutes !== wo.estimatedDuration ? ` (total effort ${esc(fmtMinutes(wo.estimatedEffortMinutes))} shared by the crew)` : ""}</div>` : ""}</div>
        ${crew.length ? `<div class="sec"><h3>Crew (${crew.length})</h3><div class="crew">${crew.map((c) => `
          <div class="crew-row"><div class="avatar ${c.role}" style="width:34px;height:34px;font-size:12px">${esc(initials(c.name))}</div>
          <div><b>${esc(c.name)}</b> ${badge(c.role)} <span class="muted">${esc(c.shift)} shift</span><div>${esc(c.focus || "")}</div></div></div>`).join("")}</div>
          ${b?.crewReason ? `<div class="muted" style="margin-top:8px">Why more than one technician: ${esc(b.crewReason)}</div>` : ""}</div>` : `<div class="sec"><h3>Technician</h3>${esc(wo.assignedTo || "Unassigned")}</div>`}
        ${b ? `
        <div class="sec"><h3>What is going on</h3><div class="callout">${esc(b.summary)}</div></div>
        <div class="sec"><h3>Readings that triggered this</h3>${readingsTableHtml(b.observedReadings)}</div>
        <div class="two">
          <div class="sec"><h3>Likely causes</h3>${list(b.likelyCauses)}</div>
          <div class="sec"><h3>Diagnostic steps, in order</h3>${list(b.diagnosticSteps, "ol")}</div>
        </div>
        <div class="sec"><h3>Recommended actions</h3>${list(b.recommendedActions)}</div>
        <div class="sec"><h3>Parts to bring</h3>${b.partsToBring.length ? `<div class="table-wrap"><table><thead><tr><th>Part</th><th>Qty</th><th>Location</th><th>In stock</th></tr></thead><tbody>
          ${b.partsToBring.map((p) => `<tr><td>${esc(p.name)}<br><span class="muted">${esc(p.partNumber)}</span></td><td>${esc(p.quantity)}</td><td>${esc(p.location || "")}</td><td>${esc(p.inStock ?? "")}</td></tr>`).join("")}</tbody></table></div>` : `<span class="muted">No parts expected</span>`}</div>
        ${b.relatedHistory.length ? `<div class="sec"><h3>Earlier incidents on this machine</h3>${list(b.relatedHistory.map((h) => `${fmtDate(h.date).slice(0, 10)}: ${h.fault} (${fmtMinutes(h.downtimeMinutes)} down). ${h.resolution || ""}`))}</div>` : ""}
        <div class="sec"><h3>Safety</h3>${list(b.safety)}</div>` : `
        <div class="sec"><h3>Description</h3>${esc(wo.description)}</div>
        ${wo.notes ? `<div class="sec"><h3>Notes</h3>${esc(wo.notes)}</div>` : ""}`}
        ${wo.tasks?.length ? `<div class="sec"><h3>Repair plan, in order</h3>${miniTable(["#", "Phase", "Task", "Time", "Safety"], wo.tasks.map((t) => [t.sequence, t.phase, raw(`${esc(t.title)}<div class="muted">${esc(t.description)}</div>`), fmtMinutes(t.estimatedDurationMinutes), t.safetyNotes || ""]))}</div>` : ""}
        ${wo.decisionTrace ? `<div class="sec"><h3>How the system decided</h3>${traceHtml(wo.decisionTrace.steps)}</div>` : ""}
        ${wo.reorderRequired?.length ? `<div class="sec"><h3>Parts to reorder</h3>${list(wo.reorderRequired.map((r) => `${r.partNumber} x${r.orderQuantity} from ${r.supplierName}: ${money(r.totalCost)}, ${r.leadTimeDays} days${r.atRisk ? " (arrives after the repair date)" : ""}`))}</div>` : ""}
        ${wo.estimatedPartsCost != null ? `<div class="muted">Parts cost ${esc(money(wo.estimatedPartsCost))}${wo.historicalFailureCostAvg ? ` · average past failure on this machine ${esc(money(wo.historicalFailureCostAvg))}` : ""}${extra.decisions ? ` · decided by ${esc(extra.decisions.diagnosis)}/${esc(extra.decisions.dispatch)}` : ""}</div>` : ""}
      </div>
      <div class="modal-foot">
        ${extra.onCreate ? `<button class="primary" data-create>Create this work order</button>` : ""}
        <button data-close>Close</button>
      </div>
    </div>`;
  overlay.querySelectorAll("[data-close]").forEach((el) => (el.onclick = close));
  const createBtn = overlay.querySelector("[data-create]");
  if (createBtn) createBtn.onclick = async () => { createBtn.disabled = true; try { await extra.onCreate(); close(); } catch (e) { createBtn.disabled = false; alert(e.message); } };
  document.body.appendChild(overlay);
}

// Dry-run the orchestrator for a machine and show the proposed work order.
async function previewCheck(machineId, onDone) {
  const r = await api(`/api/orchestrate/${encodeURIComponent(machineId)}`, { method: "POST", body: { dryRun: true } });
  if (r.action !== "dry_run") {
    alert(r.action === "skipped_duplicate" ? `An open work order already covers this issue (${r.existingWorkOrder.id}).` : `No action needed: ${r.reason || r.action}`);
    return;
  }
  showBrief(r.workOrder, {
    warnings: r.warnings, decisions: r.decisions,
    onCreate: r.duplicateOf ? null : async () => {
      await api(`/api/orchestrate/${encodeURIComponent(machineId)}`, { method: "POST", body: { dryRun: false } });
      if (onDone) await onDone();
    },
  });
}
