// PACER usage estimates stay local; no receipts, account IDs or URLs are uploaded.
// Keep the implementation usable in classic content scripts, popup pages, and MV3 workers.
globalThis.RECAPSpend = (() => {
  const KEY = 'pacer_spend_ledger_v1';
  const ADJUSTMENTS_KEY = 'pacer_spend_adjustments_v1';
  const THRESHOLD_2026 = 3000;
  const THRESHOLD_2027 = 4000;

  // The Judicial Conference announced the new fee and waiver effective 2027-01-01.
  // Rates after the announced temporary five-year period should be rechecked.
  function thresholdForQuarter(period) {
    const year = Number(String(period).split('-Q')[0]);
    return year >= 2027 ? THRESHOLD_2027 : THRESHOLD_2026;
  }

  function pageFeeCents(date = new Date()) {
    const q = quarter(date);
    return q && Number(q.slice(0, 4)) >= 2027 ? 12 : 10;
  }
  let pending = Promise.resolve();

  function quarter(date = new Date()) {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return null;
    // Model calendar-quarter cutoff in Eastern time; PACER has not publicly confirmed its precise billing cutoff time.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: 'numeric',
    }).formatToParts(d);
    const year = Number(parts.find(p => p.type === 'year').value);
    const month = Number(parts.find(p => p.type === 'month').value);
    return year + '-Q' + (Math.floor((month - 1) / 3) + 1);
  }

  // Our estimated quarter starts at midnight US Eastern, not the browser's timezone.
  function nextQuarterStart(date = new Date()) {
    const current = quarter(date);
    if (!current) return null;
    const [yearText, qText] = current.split('-Q');
    const year = Number(yearText) + (qText === '4' ? 1 : 0);
    const monthIndex = qText === '4' ? 0 : Number(qText) * 3;
    // Noon UTC is always on the boundary date in Eastern time, so the
    // local wall clock at this probe captures the correct DST offset.
    const probe = new Date(Date.UTC(year, monthIndex, 1, 12));
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(probe);
    const get = type => Number(parts.find(p => p.type === type).value);
    const localClockAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'),
      get('hour'), get('minute'));
    return new Date(Date.UTC(year, monthIndex, 1) -
      (localClockAsUtc - probe.getTime()));
  }

  function endOfQuarterState(entries, adjustments = {}, at = new Date()) {
    const now = new Date(at);
    const period = quarter(now);
    const boundary = nextQuarterStart(now);
    if (!boundary || !period) {
      return {active: false, quarter: null, remaining: 0, msLeft: 0};
    }
    const totals = summary(entries, period, adjustments);
    const msLeft = boundary.getTime() - now.getTime();
    return {
      active: msLeft > 0 && msLeft < 72 * 60 * 60 * 1000 && totals.remaining > 0,
      quarter: period, remaining: totals.remaining, msLeft, totals,
      boundary: boundary.toISOString(),
    };
  }

  function money(text) {
    const match = String(text || '').match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
    return match ? Math.round(Number(match[1].replace(/,/g, '')) * 100) : null;
  }

  function dollars(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  function pagesToCents(pages, capped = true, at = new Date()) {
    const count = Number(pages);
    if (!Number.isSafeInteger(count) || count < 1) return null;
    return Math.min(capped ? 30 : count, count) * pageFeeCents(at);
  }

  function receipt(root) {
    if (!root || !root.querySelectorAll) return null;
    const tables = Array.from(root.querySelectorAll('table'));
    // Prefer explicit invoice totals to line-item sums; a ZIP can have many files.
    for (const row of root.querySelectorAll('tr')) {
      const txt = row.textContent.replace(/\s+/g, ' ').trim();
      if (/^(total(?:\s+(?:amount|cost|charge|charges|due))?|amount due)\b/i.test(txt)) {
        const cents = money(txt);
        if (cents !== null) return cents;
      }
    }
    let charges = [];
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll('tr'));
      const headerIndex = rows.findIndex(row =>
        Array.from(row.querySelectorAll('th, td')).some(cell =>
          /^(?:cost|charge|amount)$/i.test(cell.textContent.trim())));
      if (headerIndex < 0) continue;
      const headers = Array.from(rows[headerIndex].querySelectorAll('th, td'));
      const index = headers.findIndex(cell =>
        /^(?:cost|charge|amount)$/i.test(cell.textContent.trim()));
      const current = [];
      for (const row of rows.slice(headerIndex + 1)) {
        const cells = Array.from(row.querySelectorAll('th, td'));
        if (cells.length <= index) continue;
        const text = row.textContent.trim();
        if (/\btotal\b/i.test(text)) {
          const total = money(cells[index].textContent) ?? money(text);
          if (total !== null) return total;
        }
        const cents = money(cells[index].textContent);
        if (cents !== null) current.push(cents);
      }
      if (current.length) charges.push(...current);
    }
    if (charges.length) return charges.reduce((sum, n) => sum + n, 0);
    // Some PACER receipts combine labels and values in one row.
    for (const row of root.querySelectorAll('tr')) {
      const text = row.textContent.replace(/\s+/g, ' ').trim();
      if (/\b(?:cost|charge|amount due)\s*:?\s*\$[\d,.]+/i.test(text)) {
        return money(text);
      }
    }
    return null;
  }

  function receiptPages(root, combined = false) {
    if (!root || !root.querySelectorAll) return null;
    const pageCounts = [];
    for (const row of root.querySelectorAll('tr')) {
      const cells = Array.from(row.querySelectorAll('td, th'));
      const index = cells.findIndex(c => /^billable pages$/i.test(c.textContent.trim()));
      if (index >= 0 && index + 1 < cells.length) {
        const p = Number(cells[index + 1].textContent.trim());
        if (Number.isSafeInteger(p) && p > 0) pageCounts.push(p);
      }
    }
    if (!pageCounts.length) {
      // Some receipts put "Billable Pages" in a table header, not beside a number.
      for (const table of root.querySelectorAll('table')) {
        const rows = Array.from(table.querySelectorAll('tr'));
        const header = rows.findIndex(row => Array.from(row.querySelectorAll('th, td'))
          .some(c => /^billable pages$/i.test(c.textContent.trim())));
        if (header < 0) continue;
        const columns = Array.from(rows[header].querySelectorAll('th, td'));
        const index = columns.findIndex(c => /^billable pages$/i.test(c.textContent.trim()));
        for (const row of rows.slice(header + 1)) {
          if (/\btotal\b/i.test(row.textContent)) continue;
          const cell = row.querySelectorAll('th, td')[index];
          const value = cell && Number(cell.textContent.trim());
          if (Number.isSafeInteger(value) && value > 0) pageCounts.push(value);
        }
      }
    }
    // A ZIP must be itemized. One combined page count would misapply the $3 cap.
    if (combined && pageCounts.length < 2) return null;
    return pageCounts.length ? pageCounts.reduce((sum, p) => sum + pagesToCents(p), 0) : null;
  }

  async function pdfPages(blob) {
    if (!blob || blob.size > 50 * 1024 * 1024 || blob.size < 12) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (new TextDecoder('latin1').decode(bytes.slice(0, 8)).indexOf('%PDF-') !== 0) return null;
    // Heuristic only: compressed object streams and unused page objects can defeat this.
    const text = new TextDecoder('latin1').decode(bytes);
    const matches = text.match(/\/Type\s*\/Page\b/g);
    return matches && matches.length ? matches.length : null;
  }

  async function zipPages(blob) {
    if (!blob || blob.size > 50 * 1024 * 1024) return null;
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);
    let eocd = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const files = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    if (files < 1 || files > 300) return null;
    let cents = 0, found = 0;
    for (let i = 0; i < files; i++) {
      if (offset + 46 > buffer.byteLength || view.getUint32(offset, true) !== 0x02014b50) return null;
      const method = view.getUint16(offset + 10, true);
      const compressed = view.getUint32(offset + 20, true);
      const uncompressed = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(buffer, offset + 46, nameLength));
      offset += 46 + nameLength + extraLength + commentLength;
      if (!/\.pdf$/i.test(name) || name.startsWith('__MACOSX/')) continue;
      if (uncompressed > 50 * 1024 * 1024 || localOffset + 30 > buffer.byteLength ||
          view.getUint32(localOffset, true) !== 0x04034b50) return null;
      const dataAt = localOffset + 30 + view.getUint16(localOffset + 26, true) +
        view.getUint16(localOffset + 28, true);
      if (dataAt + compressed > buffer.byteLength) return null;
      let pdf;
      if (method === 0) {
        pdf = new Blob([buffer.slice(dataAt, dataAt + compressed)], { type: 'application/pdf' });
      } else if (method === 8 && typeof DecompressionStream !== 'undefined') {
        try {
          const stream = new Blob([buffer.slice(dataAt, dataAt + compressed)])
            .stream().pipeThrough(new DecompressionStream('deflate-raw'));
          pdf = await new Response(stream).blob();
        } catch (_) { return null; }
      } else return null;
      const pages = await pdfPages(pdf);
      if (!pages) return null;
      cents += pagesToCents(pages);
      found++;
    }
    return found ? cents : null;
  }

  async function calculate({root, kind = 'pdf', blob = null, explicitCost = null, pages = null,
    transcript = false}) {
    const exact = receipt(root);
    if (exact !== null) return {cents: exact, source: 'receipt'};
    // ACMS view-model costs are dollar amounts, not integer cents.
    if (explicitCost !== null && explicitCost !== undefined && explicitCost !== '') {
      const n = Number(String(explicitCost).replace(/[$,]/g, ''));
      if (Number.isFinite(n) && n >= 0) {
        return {cents: Math.round(n * 100), source: 'receipt'};
      }
    }
    const receiptEstimate = receiptPages(root, kind === 'zip');
    if (receiptEstimate !== null) return {cents: receiptEstimate, source: 'estimated'};
    if (kind === 'audio') return {cents: 240, source: 'estimated'};
    if (kind === 'pdf' && pages !== null) {
      const cents = pagesToCents(pages, !transcript);
      if (cents !== null) return {cents, source: 'estimated'};
    }
    if (kind === 'pdf' && blob) {
      const p = await pdfPages(blob);
      if (p) return {cents: pagesToCents(p, !transcript), source: 'estimated'};
    }
    if (kind === 'zip' && blob) {
      const cents = await zipPages(blob);
      if (cents !== null) return {cents, source: 'estimated'};
    }
    return {cents: null, source: 'unresolved'};
  }

  async function capture(root, opts = {}) {
    const kind = opts.kind || 'pdf';
    const result = await calculate({...opts, root});
    return new Promise(resolve => {
      chrome.runtime.sendMessage({
        message: 'recordPacerSpend',
        transaction: {
          id: opts.id || (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random()),
          when: new Date().toISOString(),
          kind,
          court: String(opts.court || '').slice(0, 30),
          ...result,
        },
      }, response => {
        if (chrome.runtime.lastError) console.warn('RECAP: Spend tracker unavailable', chrome.runtime.lastError);
        resolve(response);
      });
    });
  }

  function record(storage, incoming) {
    pending = pending.catch(() => {}).then(async () => {
      if (!incoming || typeof incoming.id !== 'string' || incoming.id.length > 128 ||
          !['pdf','zip','audio'].includes(incoming.kind) ||
          !['receipt','estimated','unresolved'].includes(incoming.source) ||
          (incoming.cents !== null && (!Number.isSafeInteger(incoming.cents) ||
            incoming.cents < 0 || incoming.cents > 10000000)) ||
          !quarter(incoming.when)) throw Error('Invalid PACER transaction');
      const stored = await storage.get(KEY);
      const entries = Array.isArray(stored[KEY]) ? stored[KEY] : [];
      if (entries.some(e => e.id === incoming.id)) return false;
      const item = {
        id: incoming.id, when: incoming.when, kind: incoming.kind,
        court: incoming.court || '', cents: incoming.cents, source: incoming.source,
      };
      await storage.set({[KEY]: [...entries, item]});
      return true;
    });
    return pending;
  }

  function summary(entries, forQuarter = quarter(), adjustments = {}) {
    const transactions = (Array.isArray(entries) ? entries : [])
      .filter(e => quarter(e.when) === forQuarter);
    let confirmed = 0, estimated = 0, unresolved = 0;
    for (const e of transactions) {
      if (e.source === 'receipt') confirmed += e.cents || 0;
      else if (e.source === 'estimated') estimated += e.cents || 0;
      else unresolved++;
    }
    const other = Number.isSafeInteger(adjustments[forQuarter]) ? adjustments[forQuarter] : 0;
    const total = confirmed + estimated + other;
    const threshold = thresholdForQuarter(forQuarter);
    return {quarter: forQuarter, confirmed, estimated, other, unresolved, total,
      remaining: Math.max(0, threshold - total), threshold, count: transactions.length};
  }

  return {KEY, ADJUSTMENTS_KEY, quarter, nextQuarterStart, endOfQuarterState,
    thresholdForQuarter, pageFeeCents, money, dollars, pagesToCents, receipt,
    receiptPages, pdfPages, zipPages, calculate, capture, record, summary};
})();
