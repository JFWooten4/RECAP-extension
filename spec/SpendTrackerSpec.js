describe('PACER quarterly spending tracker', () => {
  it('uses calendar quarters instead of account anniversaries', () => {
    expect(RECAPSpend.quarter('2026-03-31T12:00:00')).toBe('2026-Q1');
    expect(RECAPSpend.quarter('2026-04-01T12:00:00')).toBe('2026-Q2');
    expect(RECAPSpend.quarter('2026-12-31T12:00:00')).toBe('2026-Q4');
  });
  it('extracts an itemized receipt and avoids the ZIP-wide page cap', () => {
    const d = document.createElement('div');
    d.innerHTML = '<table><tr><th>Document</th><th>Cost</th></tr>' +
      '<tr><td>1</td><td>$3.00</td></tr><tr><td>2</td><td>$1.40</td></tr></table>';
    expect(RECAPSpend.receipt(d)).toBe(440);
  });
  it('prefers explicit total cost to adding itemized charges twice', () => {
    const d = document.createElement('div');
    d.innerHTML = '<table><tr><th>Cost</th></tr><tr><td>$2.00</td></tr>' +
      '<tr><td>Total $2.00</td></tr></table>';
    expect(RECAPSpend.receipt(d)).toBe(200);
  });
  it('applies the PDF cap per document, without capping transcripts', () => {
    expect(RECAPSpend.pagesToCents(60)).toBe(300);
    expect(RECAPSpend.pagesToCents(60, false)).toBe(600);
    expect(RECAPSpend.pagesToCents(0)).toBe(null);
  });
  it('estimates audio costs when the receipt has no charge', async () => {
    expect(await RECAPSpend.calculate({kind: 'audio'}))
      .toEqual({cents: 240, source: 'estimated'});
  });
  it('never invents a cost when PDF and ZIP page counts are unavailable', async () => {
    expect(await RECAPSpend.calculate({kind: 'zip'}))
      .toEqual({cents: null, source: 'unresolved'});
  });
  it('rolls over while retaining historical entries and adjustments', () => {
    const ledger = [{when: '2026-06-30T12:00:00', cents: 200, source: 'receipt'},
      {when: '2026-07-01T12:00:00', cents: 300, source: 'estimated'}];
    expect(RECAPSpend.summary(ledger, '2026-Q2', {'2026-Q2': 200}).total).toBe(400);
    expect(RECAPSpend.summary(ledger, '2026-Q3').total).toBe(300);
  });
  it('deduplicates a repeated event but retains actual separate purchases', async () => {
    const map = {};
    const storage = {get: async k => ({[k]: map[k]}),
      set: async v => Object.assign(map, v)};
    const base = {when: '2026-10-26T20:00:00Z', kind: 'pdf',
      court: 'dcd', cents: 100, source: 'receipt'};
    expect(await RECAPSpend.record(storage, {...base, id: 'one'})).toBe(true);
    expect(await RECAPSpend.record(storage, {...base, id: 'one'})).toBe(false);
    expect(await RECAPSpend.record(storage, {...base, id: 'two'})).toBe(true);
    expect(RECAPSpend.summary(map[RECAPSpend.KEY], '2026-Q4').total).toBe(200);
  });
});
