const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');

function loadTypeScript(relativePath, dependencies = {}) {
  const filename = path.join(root, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const moduleObject = { exports: {} };
  const localRequire = (request) => Object.hasOwn(dependencies, request)
    ? dependencies[request]
    : require(request);
  new Function('exports', 'require', 'module', outputText)(
    moduleObject.exports, localRequire, moduleObject,
  );
  return moduleObject.exports;
}

const format = loadTypeScript('src/domain/format.ts');
const clock = loadTypeScript('src/domain/clock.ts');
const movements = loadTypeScript('src/domain/movements.ts');
const versionedRecords = loadTypeScript('src/domain/versioned-records.ts');
const tenantSnapshot = loadTypeScript('src/domain/tenant-snapshot.ts');
const ingredientIds = loadTypeScript('src/domain/ingredient-ids.ts');
const idempotency = loadTypeScript('src/domain/idempotency.ts');
const tabSession = loadTypeScript('src/lib/tab-session.ts');
const receipts = loadTypeScript('src/domain/receipts.ts', { './format': format });
const auth = loadTypeScript('src/domain/auth.ts');
const apiOrigin = loadTypeScript('src/domain/api-origin.ts');
const permissions = loadTypeScript('src/domain/permissions.ts');
const counts = loadTypeScript('src/domain/counts.ts', { './format': format });
const purchasePrices = loadTypeScript('src/domain/purchase-prices.ts', { './format': format });
const selectors = loadTypeScript('src/domain/selectors.ts', { './format': format, './clock': clock });
const purchaseSuggestions = loadTypeScript('src/domain/purchase-suggestions.ts', {
  './format': format, './selectors': selectors,
});

test('converts a configured package to base units and back', () => {
  assert.equal(format.convertQty(1, 'caixa', 'un', 'un', { caixa: 12 }), 12);
  assert.equal(format.convertQty(12, 'un', 'caixa', 'un', { caixa: 12 }), 1);
});

test('role permissions keep supplier and recipe management admin-only', () => {
  assert.equal(permissions.can('admin', 'suppliers.manage'), true);
  assert.equal(permissions.can('admin', 'recipes.manage'), true);
  assert.equal(permissions.can('manager', 'suppliers.manage'), false);
  assert.equal(permissions.can('manager', 'recipes.manage'), false);
  assert.equal(permissions.can('manager', 'purchases.receive'), true);
  assert.equal(permissions.can('manager', 'count.approve'), true);
  assert.equal(permissions.can('operator', 'purchases.receive'), true);
  assert.equal(permissions.can('operator', 'stock.adjust'), false);
});

test('converts between configured package units through the base unit', () => {
  assert.equal(format.convertQty(1, 'fardo', 'caixa', 'un', { fardo: 48, caixa: 12 }), 4);
});

test('uses quantity to base conversion factors consistently for purchase units', () => {
  assert.equal(format.quantityFactorToBase('g', 'kg'), 0.001);
  assert.equal(format.quantityFactorToBase('kg', 'g'), 1000);
  assert.equal(format.quantityFactorToBase('ml', 'L'), 0.001);
  assert.equal(format.quantityFactorToBase('L', 'ml'), 1000);
  assert.equal(format.quantityFactorToBase('caixa', 'un', { caixa: 12 }), 12);
  assert.equal(format.quantityFactorToBase('kg', 'un'), null);
});

test('rebuilds supplier prices from audited base-unit movements and ignores reversed receipts', () => {
  const supplier = { id: 's1', restaurantId: 'r1', avgLeadTimeDays: 3, minOrderCents: 5000 };
  const movements = [
    { id: 'm1', restaurantId: 'r1', itemId: 'cheese', supplierId: 's1', type: 'PURCHASE',
      unitCostCents: 12000, occurredAt: '2026-11-01T12:00:00Z' },
    { id: 'm2', restaurantId: 'r1', itemId: 'cheese', supplierId: 's1', type: 'PURCHASE',
      unitCostCents: 25000, occurredAt: '2026-11-02T12:00:00Z' },
    { id: 'm3', restaurantId: 'r1', itemId: 'cheese', type: 'ADJUSTMENT', reversalOf: 'm2',
      occurredAt: '2026-11-03T12:00:00Z' },
  ];
  const result = purchasePrices.purchasePriceHistory(movements, [supplier]);
  assert.equal(result.pricePoints.length, 1);
  assert.equal(result.pricePoints[0].unitCostCents, 12000);
  assert.equal(result.supplierItems[0].lastPriceCents, 12000);
  assert.equal(result.supplierItems[0].lastPurchaseAt, movements[0].occurredAt);
});

test('normalizes demo receipts and calculates weighted cost in base units', () => {
  const result = purchasePrices.receivedStockValues(2, 10000, 500, 20, 0.001);
  assert.deepEqual(result, { quantity: 2.5, receivedQuantity: 0.5, unitCostCents: 12000 });
});

test('demo receipt pricing preserves a confirmed zero and falls back only when actual price is absent', () => {
  assert.equal(purchasePrices.receiptUnitCostCents(0, 750), 0);
  assert.equal(purchasePrices.receiptUnitCostCents(123, 750), 123);
  assert.equal(purchasePrices.receiptUnitCostCents(null, 750), 750);
});

test('summarizes partial receipts at their actual prices and excludes reversed receipts', () => {
  const summary = receipts.summarizePurchaseReceipts([
    { lines: [{ line_id: 'line-1', quantity_received: 2, unit_cost_cents: 1000 }] },
    { lines: [{ line_id: 'line-1', quantity_received: 1, unit_cost_cents: 1600 }] },
    { reversed_at: '2026-11-03T12:00:00Z', lines: [
      { line_id: 'line-1', quantity_received: 3, unit_cost_cents: 900 },
    ] },
  ]);
  assert.deepEqual(summary['line-1'], { quantity: 3, totalCents: 3600 });
  assert.equal(Math.round(summary['line-1'].totalCents / summary['line-1'].quantity), 1200);
  assert.equal(receipts.receiptHistoryMatchesPurchase([
    { lines: [{ line_id: 'line-1', quantity_received: 2, unit_cost_cents: 1000 }] },
    { lines: [{ line_id: 'line-1', quantity_received: 1, unit_cost_cents: 1600 }] },
    { reversed_at: '2026-11-03T12:00:00Z', lines: [
      { line_id: 'line-1', quantity_received: 3, unit_cost_cents: 900 },
    ] },
  ], [{ id: 'line-1', qtyReceived: 3 }]), true);
  assert.equal(receipts.receiptHistoryMatchesPurchase([], [{ id: 'line-1', qtyReceived: 3 }]), false);
});

test('receipt quantity rejects over-receiving instead of silently clamping it', () => {
  assert.deepEqual(receipts.receiptQuantityDelta('12', 10), { quantity: 0, invalid: true });
  assert.deepEqual(receipts.receiptQuantityDelta('10', 10), { quantity: 10, invalid: false });
  assert.deepEqual(receipts.receiptQuantityDelta('1,234', 10), { quantity: 1.234, invalid: false });
  assert.deepEqual(receipts.receiptQuantityDelta('1,2345', 10), { quantity: 0, invalid: true });
  assert.deepEqual(receipts.receiptQuantityDelta('', 10), { quantity: 0, invalid: false });
  assert.deepEqual(receipts.receiptQuantityDelta('-1', 10), { quantity: 0, invalid: true });
  assert.deepEqual(receipts.receiptQuantityDelta('abc', 10), { quantity: 0, invalid: true });
});

test('parses money in Brazilian and decimal-point formats into exact cents', () => {
  assert.equal(format.parseMoney('R$ 1.234,56'), 123456);
  assert.equal(format.parseMoney('12.50'), 1250);
  assert.equal(format.parseMoney('1234.56'), 123456);
  assert.equal(format.parseMoney('1,5'), 150);
  assert.equal(format.parseMoney('1.234'), 123400);
  assert.equal(format.parseMoney('0,005'), 1);
});

test('strict money input distinguishes blank and invalid values from a real zero price', () => {
  assert.equal(format.parseMoneyInput(''), null);
  assert.equal(format.parseMoneyInput('   '), null);
  assert.equal(format.parseMoneyInput('abc'), null);
  assert.equal(format.parseMoneyInput('R$ 12,34'), 1234);
  assert.equal(format.parseMoneyInput('0,00'), 0);
  assert.equal(format.parseMoneyInput('-1,00'), -100);
  assert.equal(format.parseMoneyInput('999999999999999999999999'), null);
});

test('optional ingredient cost accepts blank as unknown and zero as known, but rejects invalid or negative values', () => {
  assert.deepEqual(format.parseOptionalNonNegativeMoney(''), { cents: 0, known: false });
  assert.deepEqual(format.parseOptionalNonNegativeMoney('0,00'), { cents: 0, known: true });
  assert.equal(format.parseOptionalNonNegativeMoney('invalid'), null);
  assert.equal(format.parseOptionalNonNegativeMoney('-1'), null);
});

test('physical count parser rejects invalid or negative values instead of coercing them to zero', () => {
  assert.equal(format.parseCountQty('0'), 0);
  assert.equal(format.parseCountQty(' 1,25 '), 1.25);
  assert.equal(format.parseCountQty('.5'), 0.5);
  assert.equal(format.parseCountQty('abc'), null);
  assert.equal(format.parseCountQty('-1'), null);
  assert.equal(format.parseCountQty('Infinity'), null);
  assert.equal(format.parseCountQty('1e3'), null);
  assert.equal(format.parseCountQty('0,0004'), 0.0004);
});

test('stock quantity parser enforces the persisted thousandth precision', () => {
  assert.equal(format.parseStockQty('1,234'), 1.234);
  assert.equal(format.parseStockQty('1,2340'), 1.234);
  assert.equal(format.parseStockQty('1,2345'), null);
  assert.equal(format.parseStockQty('0,0004'), null);
  assert.equal(format.parseStockQty('0'), 0);
});

test('count approval preview uses current unsaved inputs and flags invalid drafts', () => {
  const count = { id: 'count-1', lines: [
    { itemId: 'item-1', expectedQty: 5, countedQty: 4 },
    { itemId: 'item-2', expectedQty: 2, countedQty: null },
  ] };
  const draft = counts.countWithDraftValues(count, { 'item-1': '3,5', 'item-2': '1,2345' });
  assert.equal(draft.count.lines[0].countedQty, 3.5);
  assert.equal(draft.count.lines[1].countedQty, null);
  assert.deepEqual(draft.invalidItemIds, ['item-2']);
});

test('offers only compatible standard units plus configured packages', () => {
  assert.deepEqual(format.compatibleIngredientUnits('kg', { saco: 25 }), ['kg', 'g', 'saco']);
  assert.deepEqual(format.compatibleIngredientUnits('L', { bombona: 20 }), ['L', 'ml', 'bombona']);
  assert.deepEqual(format.compatibleIngredientUnits('un', { caixa: 12 }), ['un', 'caixa']);
});

test('recipe totals use package conversions and round each line to cents', () => {
  const state = { items: [
    { id: 'cheese', unit: 'un', costCents: 100, conversions: { caixa: 12 } },
    { id: 'oil', unit: 'l', costCents: 500, conversions: {} },
    { id: 'oil-2', unit: 'l', costCents: 500, conversions: {} },
    { id: 'oil-3', unit: 'l', costCents: 500, conversions: {} },
  ] };
  const recipe = { ingredients: [
    { itemId: 'cheese', qty: 1, unit: 'caixa' },
    { itemId: 'oil', qty: 0.001, unit: 'l' },
    { itemId: 'oil-2', qty: 0.001, unit: 'l' },
    { itemId: 'oil-3', qty: 0.001, unit: 'l' },
  ] };

  assert.equal(selectors.recipeCostCents(state, recipe), 1203);
});

test('recipe line cost prefers the conversion frozen on the saved recipe version', () => {
  assert.equal(format.ingredientLineCostCents(1, 'caixa', 'un', 100, { caixa: 12 }, 10), 1000);
  assert.equal(format.ingredientLineCostCents(1, 'caixa', 'un', 100, { caixa: 12 }), 1200);
  assert.equal(selectors.recipeCostCents({ items: [
    { id: 'item-1', unit: 'un', costCents: 100, conversions: { caixa: 12 } },
  ] }, { ingredients: [
    { itemId: 'item-1', qty: 1, unit: 'caixa', conversionToBase: 10 },
  ] }), 1000);
});

test('recipe portion cost divides the full batch by the configured yield', () => {
  const state = { items: [
    { id: 'rice', unit: 'kg', costCents: 300 },
    { id: 'beans', unit: 'kg', costCents: 500 },
  ] };
  const recipe = { yieldPortions: 4, ingredients: [
    { itemId: 'rice', qty: 2, unit: 'kg' },
    { itemId: 'beans', qty: 1, unit: 'kg' },
  ] };

  assert.equal(selectors.recipeCostCents(state, recipe), 1100);
  assert.equal(selectors.recipeCostPerPortionCents(state, recipe), 275);
});

test('recipe margin stays unavailable when an ingredient has a stale cost but unknown status', () => {
  const state = { items: [
    { id: 'flour', name: 'Farinha', unit: 'kg', costCents: 800, costKnown: false },
  ] };
  const recipe = { salePriceCents: 2000, ingredients: [
    { itemId: 'flour', qty: 1, unit: 'kg' },
  ] };

  assert.equal(selectors.recipeMarginCalculable(state, recipe), false);
  assert.deepEqual(selectors.recipeCostGaps(state, recipe), ['Farinha']);
});

test('manual outgoing movements decrease stock in the API payload', () => {
  assert.deepEqual(movements.manualMovementPayload({
    kind: 'out', qty: 2.5, reason: 'Uso autorizado', currentQty: 10,
  }), {
    kind: 'adjustment_out', quantity: 2.5, reason: 'Uso autorizado', unit_cost_cents: null,
  });
});

test('manual incoming movements increase stock in the API payload', () => {
  assert.deepEqual(movements.manualMovementPayload({
    kind: 'in', qty: 2.5, reason: 'Correção de entrada', currentQty: 10,
  }), {
    kind: 'adjustment_in', quantity: 2.5, reason: 'Correção de entrada', unit_cost_cents: null,
  });
});

test('manual stock adjustment sends a signed delta and expected balance', () => {
  assert.deepEqual(movements.manualMovementPayload({
    kind: 'adjust', qty: 7.25, reason: 'Contagem', currentQty: 10,
  }), {
    kind: 'adjustment_out', quantity: 2.75, reason: 'Contagem', unit_cost_cents: null,
    expected_balance: 10,
  });
});

test('manual movement payload trims the audit reason', () => {
  assert.equal(movements.manualMovementPayload({
    kind: 'in', qty: 1, reason: '  reposição avulsa  ', currentQty: 2,
  }).reason, 'reposição avulsa');
});

test('stock snapshot reconciliation does not apply an older operation result', () => {
  assert.equal(movements.isStockSnapshotCurrent(9, 10, '2026-11-12T12:00:00Z', '2026-11-12T12:01:00Z'), false);
  assert.equal(movements.isStockSnapshotCurrent(11, 10, '2026-11-12T12:00:00Z', '2026-11-12T12:01:00Z'), true);
  assert.equal(movements.isStockSnapshotCurrent(undefined, undefined,
    '2026-11-12T12:00:00Z', '2026-11-12T12:01:00Z'), false);
});

test('inventory reconciliation keeps newer stock while accepting newer catalog edits', () => {
  const current = { id: 'item-1', restaurantId: 'tenant-1', name: 'Rice', category: 'Secos', unit: 'kg',
    currentQty: 5, minQty: 1, costCents: 100, primarySupplierId: null,
    updatedAt: '2026-11-12T12:01:00Z', version: 3, stockVersion: 5 };
  const replay = { ...current, currentQty: 8, updatedAt: '2026-11-12T12:00:00Z', stockVersion: 4 };
  const oldReplay = movements.reconcileInventoryItem(current, replay);
  assert.equal(oldReplay.currentQty, 5);
  assert.equal(oldReplay.stockVersion, 5);

  const newerCatalog = { ...replay, name: 'Rice Premium', costCents: 125, version: 4 };
  const merged = movements.reconcileInventoryItem(current, newerCatalog);
  assert.equal(merged.name, 'Rice Premium');
  assert.equal(merged.costCents, 125);
  assert.equal(merged.currentQty, 5);
  assert.equal(merged.stockVersion, 5);
});

test('versioned cache keeps newer purchases, suppliers, recipes, and counts when stale reads finish late', () => {
  const domains = [
    { id: 'purchase-1', version: 8, status: 'received' },
    { id: 'supplier-1', version: 4, name: 'Updated supplier' },
    { id: 'recipe-1', version: 6, name: 'Updated recipe' },
    { id: 'count-1', version: 3, status: 'approved' },
  ];
  for (const current of domains) {
    const stale = { ...current, version: current.version - 1, status: 'draft', name: 'Old response' };
    assert.equal(versionedRecords.preferVersionedRecord(current, stale), current);
  }
  const current = { id: 'purchase-1', version: 8 };
  assert.equal(versionedRecords.preferVersionedRecord(current, { id: current.id, version: 9 }).version, 9);
  assert.equal(versionedRecords.preferVersionedRecord(current, { id: current.id }).version, 8);
});

test('versioned snapshot merge preserves newer cached records and keeps unseen tenant records', () => {
  const cached = [
    { id: 'purchase-1', version: 8, status: 'received' },
    { id: 'purchase-local', version: 2, status: 'draft' },
  ];
  const snapshot = [
    { id: 'purchase-1', version: 7, status: 'draft' },
    { id: 'purchase-2', version: 1, status: 'draft' },
  ];
  const merged = versionedRecords.mergeVersionedRecords(cached, snapshot);
  assert.deepEqual(merged.map(({ id }) => id), ['purchase-1', 'purchase-2', 'purchase-local']);
  assert.equal(merged[0].status, 'received');
  assert.equal(merged[0].version, 8);
  assert.equal(merged[2].version, 2);
  assert.deepEqual(versionedRecords.mergeVersionedRecords([], snapshot), snapshot);
});

test('tenant-scoped snapshots never expose a previous restaurant summary', () => {
  const summary = { total: 12, valueCents: 35000 };
  assert.equal(tenantSnapshot.valueForTenant({ tenantId: 'restaurant-a', value: summary }, 'restaurant-a'), summary);
  assert.equal(tenantSnapshot.valueForTenant({ tenantId: 'restaurant-a', value: summary }, 'restaurant-b'), null);
  assert.equal(tenantSnapshot.valueForTenant(null, 'restaurant-a'), null);
});

test('ingredient hydration keys stay stable when callers recreate the same id list', () => {
  const first = ingredientIds.ingredientIdsKey(['ingredient-b', 'ingredient-a', 'ingredient-b', '']);
  const recreated = ingredientIds.ingredientIdsKey(['ingredient-a', 'ingredient-b']);
  assert.equal(first, 'ingredient-a\u0000ingredient-b');
  assert.equal(recreated, first);
});

test('opening balances are distinct from purchases in the movement history', () => {
  assert.equal(movements.isOpeningBalanceMovement('adjustment_in', 'INITIAL', 'Saldo inicial cadastrado'), true);
  assert.equal(movements.isOpeningBalanceMovement('purchase', null, 'Initial balance'), true);
  assert.equal(movements.isOpeningBalanceMovement('purchase', 'purchase-42', 'Purchase received'), false);
});

test('count movements expose their readable count code and label', () => {
  assert.equal(movements.countMovementCode('count_out', 'Physical count CT-0021'), 'CT-0021');
  assert.equal(movements.countMovementCode('count_in', 'Contagem física CT-0042'), 'CT-0042');
  assert.equal(movements.countMovementCode('adjustment_out', 'Contagem física CT-0042'), null);
});

test('stock coverage labels distinguish zero stock from less than one day remaining', () => {
  assert.equal(selectors.consumptionCoverageLabel(0, 0), 'Sem estoque');
  assert.equal(selectors.consumptionCoverageLabel(0.25, 0.5), 'Saldo cobre menos de 1 dia');
  assert.equal(selectors.consumptionCoverageLabel(4, 3.6), 'Saldo cobre cerca de 4 dias');
});

test('replenishment priority sorts empty and critical stock before healthier items', () => {
  const items = [
    { name: 'Azeite', currentQty: 12.49, minQty: 10 },
    { name: 'Sal', currentQty: 8, minQty: 10 },
    { name: 'Queijo', currentQty: 2, minQty: 10 },
    { name: 'Tomate A', currentQty: 0, minQty: 0 },
    { name: 'Tomate B', currentQty: 0, minQty: 0 },
    { name: 'Arroz', currentQty: 20, minQty: 10 },
  ];
  const sorted = [...items].sort(selectors.compareReplenishmentPriority);
  assert.deepEqual(sorted.map((item) => item.name), [
    'Tomate A', 'Tomate B', 'Queijo', 'Sal', 'Azeite', 'Arroz',
  ]);
  assert.equal(selectors.itemStatus({ currentQty: 10, minQty: 10 }), 'near_minimum');
  assert.equal(selectors.itemStatus({ currentQty: 12.49, minQty: 10 }), 'near_minimum');
  assert.equal(selectors.itemStatus({ currentQty: 12.5, minQty: 10 }), 'normal');
  assert.equal(selectors.itemStatus({ currentQty: 1, minQty: 0 }), 'normal');
});

test('inactive ingredients are omitted from active replenishment alerts', () => {
  const active = { id: 'active', name: 'Ativo', currentQty: 0, minQty: 3, active: true };
  const inactive = { id: 'inactive', name: 'Inativo', currentQty: 0, minQty: 5, active: false };
  const state = { items: [active, inactive], movements: [], events: [], supplierItems: [], suppliers: [] };
  assert.deepEqual(selectors.belowMinItems(state).map((item) => item.id), ['active']);
  assert.deepEqual(selectors.recommendedPurchases(state).map((purchase) => purchase.item.id), ['active']);
});

test('latest item and supplier purchase use partial receipt movements and skip reversed receipts', () => {
  const purchase = { id: 'purchase-1', code: 'PC-0001', restaurantId: 'r1', supplierId: 's1',
    status: 'partial', createdAt: '2026-11-01T08:00:00Z', receivedAt: null,
    lines: [{ id: 'line-1', itemId: 'cheese', qtyOrdered: 10, qtyReceived: 4,
      expectedUnitCostCents: 2000, receivedUnitCostCents: 1800 }] };
  const state = { restaurant: { id: 'r1' }, purchases: [purchase], movements: [
    { id: 'receipt-old', restaurantId: 'r1', itemId: 'cheese', type: 'PURCHASE',
      occurredAt: '2026-11-02T10:00:00Z', unit: 'kg', unitCostCents: 1700, origin: 'purchase-1' },
    { id: 'receipt-reversal', restaurantId: 'r1', itemId: 'cheese', type: 'ADJUSTMENT',
      occurredAt: '2026-11-03T10:00:00Z', unit: 'kg', unitCostCents: 1700, origin: 'purchase-1',
      reversalOf: 'receipt-old' },
    { id: 'receipt-new', restaurantId: 'r1', itemId: 'cheese', type: 'PURCHASE',
      occurredAt: '2026-11-04T10:00:00Z', unit: 'kg', unitCostCents: 1800, origin: 'purchase-1' },
  ] };

  const itemReceipt = selectors.latestItemPurchaseReceipt(state, 'cheese');
  const supplierReceipt = selectors.supplierLastPurchase(state, 's1');
  assert.equal(itemReceipt.receivedAt, '2026-11-04T10:00:00Z');
  assert.equal(itemReceipt.unitCostCents, 1800);
  assert.equal(itemReceipt.purchase.code, 'PC-0001');
  assert.equal(supplierReceipt.receivedAt, itemReceipt.receivedAt);
});

test('production time windows follow AppState asOf instead of the frozen demo clock', () => {
  const state = {
    asOf: '2026-11-15T12:00:00Z',
    purchases: [
      { status: 'received', createdAt: '2026-11-10T12:00:00Z', supplierId: 's1', lines: [] },
      { status: 'received', createdAt: '2026-10-31T12:00:00Z', supplierId: 's1', lines: [] },
      { status: 'cancelled', createdAt: '2026-11-12T12:00:00Z', supplierId: 's1', lines: [] },
    ],
    losses: [
      { at: '2026-11-14T12:00:00Z', valueCents: 300 },
      { at: '2026-11-01T12:00:00Z', valueCents: 700 },
      { at: '2026-10-31T12:00:00Z', valueCents: 900 },
    ],
    counts: [
      { status: 'approved', approvedAt: '2026-11-03T12:00:00Z' },
      { status: 'approved', approvedAt: '2026-10-31T12:00:00Z' },
    ],
    movements: [
      { itemId: 'beef', type: 'CONSUMPTION', qty: 2, occurredAt: '2026-11-01T12:00:00Z' },
      { itemId: 'beef', type: 'CONSUMPTION', qty: 9, occurredAt: '2026-10-01T12:00:00Z' },
    ],
    pricePoints: [
      { itemId: 'beef', unitCostCents: 100, at: '2026-10-01T12:00:00Z' },
      { itemId: 'beef', unitCostCents: 125, at: '2026-11-01T12:00:00Z' },
    ],
  };

  assert.equal(selectors.purchasesThisMonth(state).length, 1);
  assert.equal(selectors.lossesMonthCents(state), 1000);
  assert.equal(selectors.lossesWeekCents(state), 300);
  assert.equal(selectors.approvedCountsThisMonth(state).length, 1);
  assert.equal(selectors.consumptionSince(state, 'beef', 30), 2);
  assert.equal(selectors.priceVariation(state, { id: 'beef' }).variation, 0.25);
});

test('demo received-goods value uses only this tenant month, prices, and unreversed receipts', () => {
  const state = {
    restaurant: { id: 'r1' }, asOf: '2026-11-15T12:00:00Z',
    movements: [
      { id: 'in-month', restaurantId: 'r1', type: 'PURCHASE', qty: 1.5, unitCostCents: 101,
        occurredAt: '2026-11-10T12:00:00Z' },
      { id: 'reversed', restaurantId: 'r1', type: 'PURCHASE', qty: 1, unitCostCents: 500,
        occurredAt: '2026-11-11T12:00:00Z' },
      { id: 'reversal', restaurantId: 'r1', type: 'ADJUSTMENT', qty: 1, unitCostCents: 500,
        reversalOf: 'reversed', occurredAt: '2026-11-12T12:00:00Z' },
      { id: 'unpriced', restaurantId: 'r1', type: 'PURCHASE', qty: 2, unitCostCents: null,
        occurredAt: '2026-11-13T12:00:00Z' },
      { id: 'foreign', restaurantId: 'r2', type: 'PURCHASE', qty: 1, unitCostCents: 9999,
        occurredAt: '2026-11-10T12:00:00Z' },
      { id: 'old', restaurantId: 'r1', type: 'PURCHASE', qty: 1, unitCostCents: 9999,
        occurredAt: '2026-10-30T12:00:00Z' },
    ],
  };
  assert.deepEqual(selectors.receivedGoodsThisMonth(state), { valueCents: 152, unpricedCount: 1 });
});

test('loss comparison requires complete priced receipts and never divides by zero', () => {
  assert.deepEqual(selectors.comparePricedLossesToReceivedGoods(500, 1, 1, 0, 0),
    { status: 'no-receipts', percentage: null });
  assert.deepEqual(selectors.comparePricedLossesToReceivedGoods(500, 1, 1, 10000, 1),
    { status: 'unpriced-receipts', percentage: null });
  assert.deepEqual(selectors.comparePricedLossesToReceivedGoods(0, 2, 0, 10000, 0),
    { status: 'unpriced-losses', percentage: null });
  assert.deepEqual(selectors.comparePricedLossesToReceivedGoods(0, 0, 0, 10000, 0),
    { status: 'no-losses', percentage: null });
  assert.deepEqual(selectors.comparePricedLossesToReceivedGoods(500, 1, 1, 10000, 0),
    { status: 'percentage', percentage: 5 });
  assert.deepEqual(selectors.comparePricedLossesToReceivedGoods(null, 1, 1, 10000, 0),
    { status: 'unavailable', percentage: null });
});

test('higher weekly loss amounts receive higher alert severity', () => {
  assert.equal(selectors.lossAlertSeverity(30_000), 'medium');
  assert.equal(selectors.lossAlertSeverity(30_001), 'high');
});

test('authentication startup errors give safe and actionable Portuguese guidance', () => {
  assert.match(auth.authStartupMessage(401, 'Invalid or expired DACOT-HUB handoff'), /volte ao DACOT-HUB/i);
  assert.match(auth.authStartupMessage(401, 'Authenticated DACOT session required'), /sessão expirou/i);
  assert.match(auth.authStartupMessage(403, 'Inventory access is inactive or revoked'), /inativo ou foi revogado/i);
  assert.match(auth.authStartupMessage(503, 'DACOT-HUB is unavailable'), /indisponível/i);
  assert.match(auth.authStartupMessage(null), /verifique sua conexão/i);
  assert.match(auth.authStartupMessage(0, 'VITE_API_BASE_URL was not configured'), /serviço Estoque não está configurada/i);
  assert.match(auth.authStartupMessage(0, 'API_ORIGIN_INVALID'), /configuração de conexão.*inválida/i);
  assert.doesNotMatch(auth.authStartupMessage(503, 'internal database connection detail'), /internal database/i);
});

test('production API origin accepts only HTTPS DACOT origins without path or credentials', () => {
  assert.deepEqual(apiOrigin.resolveApiOrigin('https://api-estoque.dacot.com.br/', true),
    { baseUrl: 'https://api-estoque.dacot.com.br', error: null });
  for (const value of [
    'http://api-estoque.dacot.com.br',
    'https://attacker.example',
    'https://api-estoque.dacot.com.br/api',
    'https://user:pass@api-estoque.dacot.com.br',
    'https://api-estoque.dacot.com.br/?handoff=leak',
  ]) {
    assert.deepEqual(apiOrigin.resolveApiOrigin(value, true),
      { baseUrl: null, error: 'API_ORIGIN_INVALID' }, value);
  }
  assert.deepEqual(apiOrigin.resolveApiOrigin(undefined, true),
    { baseUrl: null, error: 'API_ORIGIN_MISSING' });
  assert.deepEqual(apiOrigin.resolveApiOrigin(undefined, false),
    { baseUrl: 'http://localhost:8000', error: null });
});

test('API authentication failures end sessions without logging out on permission, CSRF, or backend errors', () => {
  assert.equal(auth.responseEndsAuthenticatedSession(401, 'Session expired'), true);
  assert.equal(auth.responseEndsAuthenticatedSession(403, 'Inventory access is inactive or revoked'), true);
  assert.equal(auth.responseEndsAuthenticatedSession(403, 'Insufficient permissions'), false);
  assert.equal(auth.responseEndsAuthenticatedSession(403, 'Request origin is not authorized'), false);
  assert.equal(auth.responseEndsAuthenticatedSession(503, 'DACOT-HUB is unavailable'), true);
  assert.equal(auth.responseEndsAuthenticatedSession(503, 'Database unavailable'), false);
  assert.equal(auth.responseEndsAuthenticatedSession(502, 'DACOT-HUB is unavailable'), false);
});

test('supplier spend totals only actual recent receipts at effective prices', () => {
  const asOf = '2026-11-15T12:00:00Z';
  const state = {
    asOf,
    restaurant: { id: 'r1' },
    purchases: [
      { id: 'partial', code: 'PC-1', restaurantId: 'r1', supplierId: 's1', status: 'partial',
        createdAt: '2026-11-01T12:00:00Z', lines: [] },
      { id: 'cancelled', code: 'PC-2', restaurantId: 'r1', supplierId: 's1', status: 'cancelled',
        createdAt: '2026-11-02T12:00:00Z', lines: [] },
      { id: 'draft', code: 'PC-3', restaurantId: 'r1', supplierId: 's1', status: 'draft',
        createdAt: '2026-11-03T12:00:00Z', lines: [] },
      { id: 'other-tenant', code: 'PC-4', restaurantId: 'r2', supplierId: 's1', status: 'received',
        createdAt: '2026-11-03T12:00:00Z', lines: [] },
    ],
    movements: [
      { id: 'partial-receipt', restaurantId: 'r1', itemId: 'cheese', type: 'PURCHASE',
        qty: 2, unitCostCents: 500, occurredAt: '2026-11-05T12:00:00Z', origin: 'partial' },
      { id: 'cancelled-receipt', restaurantId: 'r1', itemId: 'milk', type: 'PURCHASE',
        qty: 1, unitCostCents: 400, occurredAt: '2026-11-06T12:00:00Z', origin: 'PC-2' },
      { id: 'reversed-receipt', restaurantId: 'r1', itemId: 'oil', type: 'PURCHASE',
        qty: 5, unitCostCents: 900, occurredAt: '2026-11-07T12:00:00Z', origin: 'partial' },
      { id: 'receipt-reversal', restaurantId: 'r1', itemId: 'oil', type: 'ADJUSTMENT',
        qty: 5, unitCostCents: 900, occurredAt: '2026-11-08T12:00:00Z', origin: 'partial',
        reversalOf: 'reversed-receipt' },
      { id: 'draft-no-receipt', restaurantId: 'r1', itemId: 'rice', type: 'ADJUSTMENT',
        qty: 10, unitCostCents: 700, occurredAt: '2026-11-09T12:00:00Z', origin: 'draft' },
      { id: 'other-tenant-receipt', restaurantId: 'r2', itemId: 'beef', type: 'PURCHASE',
        qty: 3, unitCostCents: 800, occurredAt: '2026-11-10T12:00:00Z', origin: 'PC-4' },
      { id: 'old-receipt', restaurantId: 'r1', itemId: 'coffee', type: 'PURCHASE',
        qty: 3, unitCostCents: 300, occurredAt: '2026-08-01T12:00:00Z', origin: 'partial' },
    ],
  };

  assert.equal(selectors.supplierRecentValue(state, 's1'), 1400);
});

test('approved count divergence uses frozen cost and does not reprice legacy unknowns', () => {
  const item = { id: 'beef', costCents: 4000 };
  const count = { status: 'approved', financialImpactCents: -500, financialImpactComplete: true,
    lines: [{ itemId: 'beef', expectedQty: 5, countedQty: 4.75 }] };
  assert.equal(selectors.countFinancialCents({ items: [item] }, count), -500);

  const legacyApiCount = { ...count, financialImpactCents: null, financialImpactComplete: false };
  assert.equal(selectors.countFinancialCents({ items: [item] }, legacyApiCount), null);
  assert.equal(selectors.countDivergences({ lines: [
    { expectedQty: 5, countedQty: 4.999 },
  ] }), 1);
  assert.equal(selectors.countFinancialCents({ items: [{ ...item, costCents: 500 }] }, {
    status: 'open', lines: [{ itemId: 'beef', expectedQty: 5, countedQty: 4.999 }],
  }), -1);
  assert.equal(format.roundCentsFromMilliUnits(-0.001, 500), -1);
  assert.equal(format.roundCentsFromMilliUnits(0.001, 500), 1);
});

test('explicitly known zero ingredient cost is distinct from an unknown legacy cost', () => {
  assert.equal(selectors.itemCostKnown({ id: 'water', costCents: 0, costKnown: true }), true);
  assert.equal(selectors.itemCostKnown({ id: 'legacy-water', costCents: 0 }), false);
  assert.equal(selectors.itemCostKnown({ id: 'legacy-flour', costCents: 250 }), true);
});

test('known stock value excludes explicit unknown costs and preserves the legacy inference', () => {
  const state = { items: [
    { id: 'priced', currentQty: 2, costCents: 125, costKnown: true },
    { id: 'unknown', currentQty: 10, costCents: 900, costKnown: false },
    { id: 'unknown-legacy', currentQty: 4, costCents: 800 },
    { id: 'known-zero', currentQty: 7, costCents: 0, costKnown: true },
  ] };
  assert.equal(selectors.stockValueCents(state), 3450);
});

test('movement value stays unavailable for unknown cost but preserves known zero', () => {
  assert.equal(selectors.itemMovementValueCents({ costCents: 900, costKnown: false }, 1), null);
  assert.equal(selectors.itemMovementValueCents({ costCents: 0, costKnown: true }, 1), 0);
  assert.equal(selectors.itemMovementValueCents({ costCents: 500, costKnown: true }, 0.001), 1);
});

test('purchase suggestions distinguish known zero, unknown price, and tenant scoped supplier prices', () => {
  const base = { id: 'rice', restaurantId: 'tenant-a', unit: 'kg', costCents: 0,
    costKnown: true, conversions: { bag: 25 } };
  const suggest = (item, supplierItems = [], supplierId = '') => purchaseSuggestions.suggestedPurchaseUnitCostCents({
    restaurantId: 'tenant-a', item, supplierId, supplierItems, unit: 'bag',
  });
  assert.equal(suggest(base), 0);
  assert.equal(suggest({ ...base, costKnown: false }), null);
  assert.equal(suggest({ ...base, costKnown: false }, [{ id: 'offer', restaurantId: 'tenant-b', itemId: 'rice',
    supplierId: 'supplier-a', lastPriceCents: 100, lastPurchaseAt: '2026-01-01',
    leadTimeDays: 1, minOrderCents: 0 }], 'supplier-a'), null);
  assert.equal(suggest(base, [{ id: 'offer', restaurantId: 'tenant-a', itemId: 'rice',
    supplierId: 'supplier-a', lastPriceCents: 100, lastPurchaseAt: '2026-01-01',
    leadTimeDays: 1, minOrderCents: 0 }], 'supplier-a'), 2500);
});

test('supplier offers preserve a confirmed zero purchase price as a real offer', () => {
  const state = {
    suppliers: [{ id: 'supplier-zero', name: 'Zero' }, { id: 'supplier-estimate', name: 'Estimate' },
      { id: 'supplier-empty', name: 'Empty' }],
    supplierItems: [
      { id: 'zero', itemId: 'rice', supplierId: 'supplier-zero', restaurantId: 'tenant-a',
        lastPriceCents: 0, lastPurchaseAt: '2026-11-01T12:00:00Z' },
      { id: 'estimate', itemId: 'rice', supplierId: 'supplier-estimate', restaurantId: 'tenant-a',
        lastPriceCents: 250, lastPurchaseAt: null },
      { id: 'empty', itemId: 'rice', supplierId: 'supplier-empty', restaurantId: 'tenant-a',
        lastPriceCents: 0, lastPurchaseAt: null },
    ],
  };
  const offers = selectors.supplierOffers(state, 'rice');
  assert.equal(offers[0].id, 'zero');
  assert.equal(selectors.supplierOfferHasPrice(offers[0]), true);
  assert.equal(selectors.supplierOfferHasPrice(offers[2]), false);
});

test('count divergence totals gross per-line values even when signed impact nets to zero', () => {
  const count = { status: 'approved', financialImpactCents: 0, financialImpactComplete: true,
    financialDivergenceCents: 2000, lines: [
      { itemId: 'surplus', expectedQty: 5, countedQty: 6,
        financialImpactCents: 1000, financialImpactComplete: true },
      { itemId: 'shortage', expectedQty: 5, countedQty: 4,
        financialImpactCents: -1000, financialImpactComplete: true },
    ] };
  assert.equal(selectors.countFinancialCents({ items: [] }, count), 0);
  assert.equal(selectors.countFinancialDivergenceCents({ items: [] }, count), 2000);
});

test('idempotency reservation reuses a key for the same pending payload', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  let generated = 0;
  const makeKey = () => `key-${++generated}`;
  const first = idempotency.reserveOperationKey(storage, 'movement-1', '{"qty":1}', makeKey);
  const retry = idempotency.reserveOperationKey(storage, 'movement-1', '{"qty":1}', makeKey);

  assert.equal(first.key, 'key-1');
  assert.equal(retry.key, first.key);
  assert.equal(generated, 1);
  assert.equal(idempotency.pendingOperationPayload(storage, 'movement-1'), '{"qty":1}');
});

test('receipt retry migrates old reservations and keeps the original version precondition', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const lines = [{ line_id: 'line-1', quantity_received: 2, unit_cost_cents: 725 }];
  const currentScope = idempotency.tenantOperationScope('restaurant-a', receipts.receiptOperationScope('purchase-1'));
  const legacyScope = idempotency.tenantOperationScope('restaurant-a', 'receipt-purchase-1-v4');
  const oldPayload = JSON.stringify({ expected_version: 4, lines });
  values.set(`dacot.idempotency.${legacyScope}`, JSON.stringify({
    key: 'receipt-key', fingerprint: oldPayload, payload: oldPayload,
  }));

  assert.equal(receipts.receiptOperationScope('purchase-1'), 'receipt-purchase-1');
  assert.equal(idempotency.migrateOperationReservation(storage, [legacyScope], currentScope,
    receipts.normalizePendingReceiptFingerprint), true);
  const resumed = idempotency.reserveOperationKey(storage, currentScope,
    receipts.receiptOperationFingerprint(lines), () => 'new-key',
    JSON.stringify({ expected_version: 5, lines }));

  assert.equal(resumed.key, 'receipt-key');
  assert.equal(resumed.payload, oldPayload);
  assert.equal(JSON.parse(resumed.payload).expected_version, 4);
  assert.equal(idempotency.pendingOperationPayload(storage, currentScope), oldPayload);
  assert.equal(values.has(`dacot.idempotency.${legacyScope}`), false);
  assert.throws(() => idempotency.reserveOperationKey(storage, currentScope,
    receipts.receiptOperationFingerprint([{ ...lines[0], quantity_received: 1 }]), () => 'changed-key'),
  /operação anterior sem confirmação/);
});

test('receipt retry discovers legacy reservations from versions older than the immediately previous one', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
  };
  const lines = [{ line_id: 'line-1', quantity_received: 2, unit_cost_cents: 725 }];
  const legacyScope = idempotency.tenantOperationScope('restaurant-a', 'receipt-purchase-1-v2');
  const oldPayload = JSON.stringify({ expected_version: 2, lines });
  values.set(`dacot.idempotency.${legacyScope}`, JSON.stringify({
    key: 'receipt-key-v2', fingerprint: oldPayload, payload: oldPayload,
  }));

  const discovered = idempotency.storedOperationScopes(storage,
    idempotency.tenantOperationScope('restaurant-a', 'receipt-purchase-1-v'));
  const currentScope = idempotency.tenantOperationScope('restaurant-a', receipts.receiptOperationScope('purchase-1'));
  assert.deepEqual(discovered, [legacyScope]);
  assert.equal(idempotency.migrateOperationReservation(storage, discovered, currentScope,
    receipts.normalizePendingReceiptFingerprint), true);
  const resumed = idempotency.reserveOperationKey(storage, currentScope,
    receipts.receiptOperationFingerprint(lines), () => 'new-key',
    JSON.stringify({ expected_version: 10, lines }));

  assert.equal(resumed.key, 'receipt-key-v2');
  assert.equal(JSON.parse(resumed.payload).expected_version, 2);
});

test('idempotency scopes are isolated by authenticated restaurant', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  assert.equal(idempotency.tenantOperationScope('restaurant-a', 'movement-item-1'),
    'restaurant-a:movement-item-1');
  const tenantA = idempotency.tenantOperationScope('restaurant-a', 'purchase-create');
  const tenantB = idempotency.tenantOperationScope('restaurant-b', 'purchase-create');
  assert.notEqual(tenantA, tenantB);
  idempotency.reserveOperationKey(storage, tenantA, '{"order":"a"}', () => 'key-a');
  assert.equal(idempotency.pendingOperationPayload(storage, tenantB), null);
  assert.equal(idempotency.pendingOperationPayload(storage, tenantA), '{"order":"a"}');
  assert.throws(() => idempotency.tenantOperationScope(null, 'purchase-create'), /sessão do restaurante/);
});

test('a duplicated browser tab gets a distinct authenticated tab session id', async () => {
  const channels = new Map();
  const createChannel = (name) => {
    const members = channels.get(name) ?? new Set();
    channels.set(name, members);
    const channel = {
      onmessage: null,
      postMessage(value) {
        for (const peer of members) {
          if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data: value }));
        }
      },
      close() { members.delete(this); },
    };
    members.add(channel);
    return channel;
  };
  const originalId = '123e4567-e89b-42d3-a456-426614174001';
  const storageA = new Map([['dacot.tab-session-id', originalId]]);
  const storageB = new Map([['dacot.tab-session-id', originalId]]);
  const storage = (values) => ({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  });
  const ids = [
    '123e4567-e89b-42d3-a456-426614174002',
    '123e4567-e89b-42d3-a456-426614174003',
    '123e4567-e89b-42d3-a456-426614174004',
    '123e4567-e89b-42d3-a456-426614174005',
  ];
  const makeId = () => ids.shift();
  const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

  const first = await tabSession.acquireTabSessionId(storage(storageA), makeId, createChannel, wait);
  const duplicate = await tabSession.acquireTabSessionId(storage(storageB), makeId, createChannel, wait);

  assert.equal(first.id, originalId);
  assert.notEqual(duplicate.id, first.id);
  assert.equal(storageB.get('dacot.tab-session-id'), duplicate.id);

  const storageC = new Map([['dacot.tab-session-id', originalId]]);
  const storageD = new Map([['dacot.tab-session-id', originalId]]);
  const simultaneousIds = [
    '123e4567-e89b-42d3-a456-426614174006',
    '123e4567-e89b-42d3-a456-426614174007',
    '123e4567-e89b-42d3-a456-426614174008',
    '123e4567-e89b-42d3-a456-426614174009',
    '123e4567-e89b-42d3-a456-426614174010',
    '123e4567-e89b-42d3-a456-426614174011',
  ];
  const makeSimultaneousId = () => simultaneousIds.shift();
  const [simultaneousC, simultaneousD] = await Promise.all([
    tabSession.acquireTabSessionId(storage(storageC), makeSimultaneousId, createChannel, wait),
    tabSession.acquireTabSessionId(storage(storageD), makeSimultaneousId, createChannel, wait),
  ]);
  assert.notEqual(simultaneousC.id, originalId);
  assert.notEqual(simultaneousD.id, originalId);
  assert.notEqual(simultaneousC.id, simultaneousD.id);
});

test('tab session fallback reuses an id on reload but rotates a copied id when the channel is unavailable', async () => {
  const originalId = '123e4567-e89b-42d3-a456-426614174020';
  const nextId = '123e4567-e89b-42d3-a456-426614174021';
  const storageFor = () => {
    const values = new Map([['dacot.tab-session-id', originalId]]);
    return {
      values,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };
  };
  const reloadStorage = storageFor();
  const reload = await tabSession.acquireTabSessionId(reloadStorage, () => nextId, null, undefined, true);
  assert.equal(reload.id, originalId);

  const duplicateStorage = storageFor();
  const duplicate = await tabSession.acquireTabSessionId(duplicateStorage, () => nextId, null, undefined, false);
  assert.equal(duplicate.id, nextId);
  assert.equal(duplicateStorage.values.get('dacot.tab-session-id'), nextId);
});

test('idempotency reservation blocks changed payload while previous result is uncertain', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const operation = idempotency.reserveOperationKey(storage, 'loss-item', 'payload-a', () => 'key-a');

  assert.throws(
    () => idempotency.reserveOperationKey(storage, 'loss-item', 'payload-b', () => 'key-b'),
    /operação anterior sem confirmação/,
  );
  assert.equal(JSON.parse(storage.getItem(operation.storageKey)).fingerprint, 'payload-a');
});

test('definitive client errors release an idempotency reservation; unknown outcomes do not', () => {
  assert.equal(idempotency.isDefinitiveHttpRejection(Object.assign(new Error('invalid'), { status: 422 })), true);
  assert.equal(idempotency.isDefinitiveHttpRejection(Object.assign(new Error('server error'), { status: 503 })), false);
  assert.equal(idempotency.isDefinitiveHttpRejection(Object.assign(new Error('timeout'), { status: 408 })), false);
  assert.equal(idempotency.isDefinitiveHttpRejection(Object.assign(new Error('rate limited'), { status: 429 })), false);
  assert.equal(idempotency.isDefinitiveHttpRejection(new Error('network failed')), false);
});

test('pending partial receipt payload is restored safely after a page reload', () => {
  const payload = JSON.stringify({ lines: [
    { line_id: 'line-1', quantity_received: 2.5, unit_cost_cents: 725 },
  ] });
  assert.deepEqual(receipts.parsePendingReceiptLines(payload), [
    { line_id: 'line-1', quantity_received: 2.5, unit_cost_cents: 725 },
  ]);
  assert.equal(receipts.parsePendingReceiptLines('{bad'), null);
  assert.equal(receipts.parsePendingReceiptLines(JSON.stringify({ lines: [
    { line_id: 'line-1', quantity_received: -2, unit_cost_cents: 725 },
  ] })), null);
});

test('optional money fields preserve zero and use the suggestion only when blank', () => {
  assert.equal(format.parseMoneyOrFallback('0,00', 750), 0);
  assert.equal(format.parseMoneyOrFallback('  ', 750), 750);
  assert.equal(format.parseMoneyOrFallback(undefined, 750), 750);
});
