// Reorder recommendations: stock level, required quantity, supplier lead time/reliability and minimum order value.
const DAY = 86400000;
const RELIABILITY = { high: 2, medium: 1 };

function supplierOptions(part, suppliers) {
  const byNumber = suppliers.filter((s) => (s.partsSupplied || []).includes(part.partNumber));
  if (byNumber.length) return byNumber;
  return suppliers.filter((s) => s.name === part.manufacturer);
}

// Prefer suppliers that can deliver in time, then reliability, rating and lead time.
function rankSuppliers(options, daysUntilNeeded) {
  const meets = (s) => (daysUntilNeeded == null || s.leadTimeDays <= daysUntilNeeded ? 1 : 0);
  return [...options].sort((a, b) =>
    meets(b) - meets(a) ||
    (RELIABILITY[String(b.reliability).toLowerCase()] || 0) - (RELIABILITY[String(a.reliability).toLowerCase()] || 0) ||
    (b.rating || 0) - (a.rating || 0) ||
    a.leadTimeDays - b.leadTimeDays);
}

// Returns null when no order is needed. Order brings stock back to twice the reorder level after the required use.
function recommendOrder({ part, requiredQty = 0, suppliers, daysUntilNeeded = null }) {
  const projected = part.quantityInStock - requiredQty;
  if (projected >= part.reorderLevel) return null;

  let quantity = Math.max(1, part.reorderLevel * 2 - projected);
  const [supplier] = rankSuppliers(supplierOptions(part, suppliers), daysUntilNeeded);
  let minimumBumped = false;
  if (supplier && quantity * part.unitCost < supplier.minimumOrderValue) {
    quantity = Math.ceil(supplier.minimumOrderValue / part.unitCost);
    minimumBumped = true;
  }
  const leadTimeDays = supplier?.leadTimeDays ?? part.leadTimeDays;
  const atRisk = daysUntilNeeded != null && leadTimeDays > daysUntilNeeded;

  return {
    partId: part.id,
    partNumber: part.partNumber,
    partName: part.name,
    quantityInStock: part.quantityInStock,
    requiredQuantity: requiredQty,
    reorderLevel: part.reorderLevel,
    orderQuantity: quantity,
    unitCost: part.unitCost,
    totalCost: Math.round(quantity * part.unitCost * 100) / 100,
    supplierId: supplier?.id || null,
    supplierName: supplier?.name || part.manufacturer || null,
    supplierContact: supplier?.contactEmail || null,
    reliability: supplier?.reliability || null,
    rating: supplier?.rating ?? null,
    paymentTerms: supplier?.paymentTerms || null,
    leadTimeDays,
    daysUntilNeeded: daysUntilNeeded == null ? null : Math.round(daysUntilNeeded * 10) / 10,
    atRisk,
    minimumOrderBumped: minimumBumped,
    reason: projected < 0
      ? "Stock does not cover the required quantity."
      : "Stock after planned use falls below the reorder level.",
    note: !supplier ? "No supplier on file; using part lead time." : atRisk ? "Supplier lead time is longer than the time until the repair; expedite or reschedule." : null,
  };
}

module.exports = { DAY, recommendOrder };
