const assert = require('node:assert/strict');
const { test } = require('node:test');
const invoice = require('../lib/invoice');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

const tea = { id: 1, name: 'Tea', sku: 'TEA', hsn: '0902', qty: 1, price: 100 };

function billedOrder(items, coupon = '') {
  const db = { nextOrderId: 1001, orders: [] };
  const { subtotal, discount, tax, total } = pricing.computeTotals(items, coupon);

  return orders.add(db, {
    date: '2021-11-30', items, coupon, subtotal, discount, tax, total
  });
}

test('invoice shows the billed total and GST for an order with mixed HSN slabs', () => {
  const order = billedOrder([
    { id: 2, name: 'Rice', sku: 'RICE', hsn: '1006', price: 100, qty: 2 },
    { id: 3, name: 'Ghee', sku: 'GHEE', hsn: '0405', price: 100, qty: 1 },
    tea
  ]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual({ total: figures.total, gst: figures.tax }, { total: 440, gst: 40 });
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [
    [5, 10], [12, 12], [18, 18]
  ]);
  const html = invoice.render(order);
  assert.match(html, /Total GST\)<\/td><td class="r">₹40\.00/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹440\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice matches an undiscounted order at the default GST rate', () => {
  const order = billedOrder([{ name: 'Unclassified item', price: 50, qty: 2 }]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.total, 118);
  assert.deepEqual(figures, {
    subtotal: 100, discount: 0, tax: 18, cgst: 9, sgst: 9, total: 118,
    rows: [{
      name: 'Unclassified item', sku: '-', hsn: '-', qty: 2, price: 50,
      gstPercent: 18, line: 100, lineTax: 18
    }]
  });
  const html = invoice.render(order);
  assert.match(html, /Invoice Total<\/td><td class="r">₹118\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice apportions a coupon across the 5%, 12%, and 18% HSN slabs', () => {
  const items = [
    { id: 2, name: 'Rice', sku: 'RICE', hsn: '1006', price: 100, qty: 2 },
    { id: 3, name: 'Ghee', sku: 'GHEE', hsn: '0405', price: 100, qty: 1 },
    tea
  ];
  const order = billedOrder(items, 'WELCOME');
  const { rows, ...figures } = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.discount, order.tax, order.total], [20, 38, 418]);
  assert.deepEqual(figures, {
    subtotal: 400, discount: 20, tax: 38, cgst: 19, sgst: 19, total: 418
  });
  assert.deepEqual(rows.map(({ hsn, gstPercent, lineTax }) => [hsn, gstPercent, lineTax]), [
    ['1006', 5, 9.5], ['0405', 12, 11.4], ['0902', 18, 17.1]
  ]);
});

test('invoice applies a percentage coupon before GST and respects the checkout cap', () => {
  const order = billedOrder([{ ...tea, price: 2000 }], 'SAVE10');
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.discount, order.tax, order.total], [150, 333, 2183]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [150, 333, 2183]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice reduces taxable value by the flat coupon', () => {
  const order = billedOrder([{ ...tea, price: 300 }], 'FLAT50');
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.discount, order.tax, order.total], [50, 45, 295]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [50, 45, 295]);
});

test('reconciliation matches both GST and total on an order with an uncapped percentage coupon', () => {
  const order = billedOrder([tea], 'WELCOME');

  assert.deepEqual([order.discount, order.tax, order.total], [5, 17.1, 112.1]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
  assert.deepEqual(reports.getGstReconciliation({ orders: [order] }), {
    totalChecked: 1,
    mismatchCount: 0,
    totalDelta: 0,
    rows: [{
      orderId: order.id, date: order.date, customer: 'Walk-in', coupon: 'WELCOME',
      ledgerSubtotal: 100, ledgerDiscount: 5, ledgerTax: 17.1, ledgerTotal: 112.1,
      invoiceDiscount: 5, invoiceTax: 17.1, invoiceTotal: 112.1, delta: 0, matched: true
    }]
  });
});

test('invoice honors whole-percent GST rates stored as numbers or strings on older lines', () => {
  for (const gstRate of [5, '5', 1, '1']) {
    const rate = Number(gstRate);
    const figures = invoice.computeInvoiceFigures({ items: [{ ...tea, gstRate }] });

    assert.equal(figures.rows[0].gstPercent, rate);
    assert.equal(figures.tax, rate);
    assert.equal(figures.total, 100 + rate);
  }
});

test('invoice preserves flat GST when the recorded order was billed before HSN pricing', () => {
  const rice = { ...tea, name: 'Rice', hsn: '1006' };
  const order = {
    id: 1001, date: '2021-07-01', items: [rice],
    subtotal: 100, discount: 0, tax: 18, total: 118
  };
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([figures.rows[0].gstPercent, figures.rows[0].lineTax, figures.tax, figures.total], [18, 18, 18, 118]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice preserves pre-HSN line rates when both calculations give the same total', () => {
  const order = {
    date: '01/07/2021', items: [tea, { ...tea, hsn: '1006', price: 0.02 }],
    subtotal: 100.02, discount: 0, tax: 18, total: 118.02
  };

  assert.deepEqual(invoice.computeInvoiceFigures(order).rows.map(({ gstPercent }) => gstPercent), [18, 18]);
  assert.deepEqual(invoice.computeInvoiceFigures({ ...order, date: '22/07/2021' })
    .rows.map(({ gstPercent }) => gstPercent), [18, 5]);
});

test('invoice distributes historic flat GST after the recorded discount and preserves the rounded sum', () => {
  const order = {
    date: '2021-07-01', items: [{ ...tea, price: 0.04 }, { ...tea, price: 0.04 }],
    subtotal: 0.08, discount: 0.02, tax: 0.01, total: 0.07
  };
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(figures.rows.map(({ lineTax }) => lineTax), [0.01, 0]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [0.02, 0.01, 0.07]);
});

test('invoice preserves legacy rounding when a percentage coupon produced a fractional discount', () => {
  const order = {
    date: '2021-07-01', items: [{ ...tea, price: 100.26 }], coupon: 'WELCOME',
    subtotal: 100.26, discount: 5.01, tax: 17.14, total: 112.39
  };
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([figures.discount, figures.rows[0].lineTax, figures.tax, figures.total],
    [5.01, 17.14, 17.14, 112.39]);
});

test('reconciliation flags a post-migration order whose recorded figures resemble flat GST', () => {
  const order = {
    date: '2021-11-30', items: [{ ...tea, hsn: '1006' }],
    subtotal: 100, discount: 10, tax: 16.2, total: 106.2
  };

  const report = reports.getGstReconciliation({ orders: [order] });
  assert.equal(report.mismatchCount, 1);
  assert.deepEqual([report.rows[0].invoiceTax, report.rows[0].invoiceTotal], [5, 105]);
});

test('invoice uses verified flat GST on the migration day when HSN totals disagree', () => {
  const order = {
    date: '22/07/2021', items: [{ ...tea, hsn: '1006' }],
    subtotal: 100, discount: 0, tax: 18, total: 118
  };

  assert.equal(invoice.computeInvoiceFigures(order).total, 118);
  assert.equal(invoice.computeInvoiceFigures({ ...order, discount: 10, tax: 16.2, total: 106.2 }).total, 105);
  const afterCutover = { ...order, date: '23/07/2021' };
  assert.equal(reports.getGstReconciliation({ orders: [afterCutover] }).mismatchCount, 1);
});

test('invoice accepts decimal and zero GST rates on older order lines', () => {
  const decimalRate = { ...tea, gstRate: 0.05 };
  const zeroRate = { ...tea, gstRate: 0 };
  const figures = invoice.computeInvoiceFigures({ items: [decimalRate, zeroRate] });

  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [
    [5, 5], [0, 0]
  ]);
  assert.equal(figures.tax, 5);
  assert.equal(figures.total, 205);
});

test('invoice adds the rounded line GST amounts and uses the checkout CGST and SGST split', () => {
  const order = billedOrder([{ ...tea, price: 0.03 }, { ...tea, id: 2, price: 0.03 }]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.tax, order.total], [0.02, 0.08]);
  assert.deepEqual(figures.rows.map(({ lineTax }) => lineTax), [0.01, 0.01]);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [0.02, 0.01, 0.01, 0.08]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});
