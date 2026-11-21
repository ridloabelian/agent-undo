export function renderInspectorHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>agent-undo — Local Transactional Firewall Inspector</title>
  <style>
    :root {
      --bg: #0b1020;
      --panel: #121a2f;
      --panel-alt: #18233f;
      --border: #263459;
      --text: #e6ecf8;
      --muted: #93a3c7;
      --accent: #4f8cff;
      --green: #22c55e;
      --amber: #f59e0b;
      --red: #ef4444;
      --cyan: #06b6d4;
      --purple: #a855f7;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.45;
    }
    header {
      border-bottom: 1px solid var(--border);
      background: rgba(18, 26, 47, 0.92);
      position: sticky;
      top: 0;
      z-index: 20;
      backdrop-filter: blur(8px);
    }
    .container {
      max-width: 1280px;
      margin: 0 auto;
      padding: 16px 20px;
    }
    .header-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .brand-logo {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      background: linear-gradient(135deg, var(--accent), var(--cyan));
      display: grid;
      place-items: center;
      font-weight: 800;
      color: #07101f;
      font-family: var(--mono);
    }
    .brand h1 {
      margin: 0;
      font-size: 18px;
      letter-spacing: -0.02em;
    }
    .brand small {
      color: var(--muted);
      font-size: 12px;
      display: block;
    }
    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid var(--border);
      background: var(--panel-alt);
    }
    .pill.ok { border-color: rgba(34, 197, 94, 0.45); color: #86efac; }
    .pill.warn { border-color: rgba(245, 158, 11, 0.45); color: #fcd34d; }
    .pill.bad { border-color: rgba(239, 68, 68, 0.45); color: #fca5a5; }
    .pill.info { border-color: rgba(79, 140, 255, 0.45); color: #93c5fd; }

    .grid-2 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      gap: 16px;
      margin-bottom: 16px;
    }
    .grid-4 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .card h2 {
      margin: 0 0 12px 0;
      font-size: 15px;
      font-weight: 700;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .meter {
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px;
    }
    .meter-label {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .meter-value {
      font-size: 18px;
      font-weight: 700;
      font-family: var(--mono);
      margin-bottom: 8px;
    }
    .progress-track {
      height: 8px;
      background: #0a0f1d;
      border-radius: 999px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: var(--accent);
      transition: width 120ms linear;
    }
    .progress-fill.green { background: var(--green); }
    .progress-fill.amber { background: var(--amber); }
    .progress-fill.red { background: var(--red); }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    button {
      border: 1px solid var(--border);
      background: var(--panel-alt);
      color: var(--text);
      padding: 7px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease;
    }
    button:hover { background: #223156; border-color: var(--accent); }
    button.btn-undo {
      background: rgba(239, 68, 68, 0.16);
      border-color: rgba(239, 68, 68, 0.5);
      color: #fecaca;
    }
    button.btn-undo:hover { background: rgba(239, 68, 68, 0.28); }
    button.btn-approve {
      background: rgba(34, 197, 94, 0.16);
      border-color: rgba(34, 197, 94, 0.5);
      color: #bbf7d0;
    }
    button.btn-approve:hover { background: rgba(34, 197, 94, 0.28); }
    button.btn-rollback {
      background: rgba(168, 85, 247, 0.18);
      border-color: rgba(168, 85, 247, 0.55);
      color: #e9d5ff;
    }
    button.btn-rollback:hover { background: rgba(168, 85, 247, 0.32); }

    .action-item {
      border: 1px solid var(--border);
      background: var(--panel-alt);
      border-radius: 10px;
      padding: 12px;
      margin-bottom: 10px;
    }
    .action-top {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .action-title {
      font-weight: 700;
      font-size: 14px;
    }
    .mono {
      font-family: var(--mono);
      font-size: 12px;
    }
    .muted { color: var(--muted); font-size: 12px; }
    .diff-box {
      margin-top: 8px;
      background: #080c17;
      border: 1px solid #1e2a4a;
      border-radius: 8px;
      padding: 10px;
      font-family: var(--mono);
      font-size: 12px;
      overflow-x: auto;
      white-space: pre-wrap;
    }
    .diff-add { color: #86efac; }
    .diff-del { color: #fca5a5; }
    .diff-hunk { color: #67e8f9; }
    .countdown-wrap {
      margin-top: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.04em;
    }
    .toast {
      position: fixed;
      right: 20px;
      bottom: 20px;
      background: #172445;
      border: 1px solid var(--accent);
      color: var(--text);
      padding: 10px 14px;
      border-radius: 10px;
      font-size: 13px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.45);
      display: none;
      z-index: 50;
    }
    .world-list {
      display: grid;
      gap: 8px;
      max-height: 280px;
      overflow-y: auto;
    }
    .world-row {
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <header>
    <div class="container header-row">
      <div class="brand">
        <div class="brand-logo">AU</div>
        <div>
          <h1>agent-undo Inspector</h1>
          <small>Local Transactional Firewall &bull; Grace Windows &bull; Compensating Rollbacks</small>
        </div>
      </div>
      <div class="badges">
        <span id="policy-badge" class="pill info">Policy: loading...</span>
        <span id="audit-badge" class="pill ok">Audit Chain: checking...</span>
        <button onclick="refreshAll()">Refresh</button>
      </div>
    </div>
  </header>

  <main class="container">
    <section class="grid-4" id="budget-meters"></section>

    <section class="card">
      <h2>
        <span>Interactive Firewall Playground</span>
        <span class="muted">Session: <code id="session-label">default</code></span>
      </h2>
      <div class="toolbar">
        <button onclick="simulate('email')">Send Email (30s Grace)</button>
        <button onclick="simulate('charge25')">Stripe $25 Charge (Grace + Refund)</button>
        <button onclick="simulate('charge75')">Stripe $75 Charge (Approval)</button>
        <button onclick="simulate('calendar')">Create Calendar Event (Grace)</button>
        <button onclick="simulate('file')">Edit notes/roadmap.md (Diff + Snapshot)</button>
        <button onclick="simulate('deny')">Write .env (Policy Deny)</button>
      </div>
    </section>

    <section class="card">
      <h2>
        <span>Active Staging Queue (Grace Window &amp; Approvals)</span>
        <span class="muted" id="queue-count-label">0 pending</span>
      </h2>
      <div id="staging-queue"><p class="muted">No staged or approval-pending actions.</p></div>
    </section>

    <section class="card">
      <h2>
        <span>Recent Executed, Undone &amp; Denied Actions</span>
        <span class="muted" id="history-count-label">0 actions</span>
      </h2>
      <div id="action-history"><p class="muted">No actions recorded yet.</p></div>
    </section>

    <section class="grid-2">
      <div class="card">
        <h2><span>Mock World State (Emails, Calendar, Stripe, Sandbox Files)</span></h2>
        <div class="world-list" id="world-state"></div>
      </div>
      <div class="card">
        <h2><span>Immutable Audit Log (SHA-256 Hash Chain)</span></h2>
        <div style="max-height: 280px; overflow: auto;">
          <table>
            <thead>
              <tr><th>#</th><th>Event</th><th>Actor</th><th>Summary</th><th>Hash</th></tr>
            </thead>
            <tbody id="audit-rows"></tbody>
          </table>
        </div>
      </div>
    </section>
  </main>

  <div id="toast" class="toast"></div>

  <script>
    const SESSION_ID = 'default';
    let cachedActions = [];

    function esc(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function showToast(message) {
      const el = document.getElementById('toast');
      el.textContent = message;
      el.style.display = 'block';
      clearTimeout(window.__toastTimer);
      window.__toastTimer = setTimeout(() => {
        el.style.display = 'none';
      }, 3200);
    }

    function statusPill(status) {
      if (status === 'executed') return '<span class="pill ok">executed</span>';
      if (status === 'grace_pending') return '<span class="pill warn">grace_pending</span>';
      if (status === 'pending_approval') return '<span class="pill info">pending_approval</span>';
      if (status === 'undone') return '<span class="pill warn">undone (canceled)</span>';
      if (status === 'rolled_back') return '<span class="pill info">rolled_back</span>';
      if (status === 'denied' || status === 'failed' || status === 'rollback_failed') {
        return '<span class="pill bad">' + esc(status) + '</span>';
      }
      return '<span class="pill">' + esc(status) + '</span>';
    }

    function renderDiffHtml(unifiedDiff) {
      return String(unifiedDiff || '').split('\\n').map((line) => {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          return '<div class="diff-add">' + esc(line) + '</div>';
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
          return '<div class="diff-del">' + esc(line) + '</div>';
        }
        if (line.startsWith('@@')) {
          return '<div class="diff-hunk">' + esc(line) + '</div>';
        }
        return '<div>' + esc(line) + '</div>';
      }).join('');
    }

    function meterCard(label, used, max, prefix = '') {
      const hasMax = max !== null && max !== undefined && max > 0;
      const pct = hasMax ? Math.min(100, (used / max) * 100) : 0;
      const color = pct >= 90 ? 'red' : pct >= 65 ? 'amber' : 'green';
      const usedText = prefix ? prefix + Number(used).toFixed(2) : String(used);
      const maxText = hasMax ? (prefix ? prefix + Number(max).toFixed(2) : String(max)) : '∞';
      return '<div class="meter">'
        + '<div class="meter-label"><span>' + esc(label) + '</span><span>' + Math.round(pct) + '%</span></div>'
        + '<div class="meter-value">' + esc(usedText) + ' / ' + esc(maxText) + '</div>'
        + '<div class="progress-track"><div class="progress-fill ' + color + '" style="width:' + pct + '%"></div></div>'
        + '</div>';
    }

    function renderBudgets(overview) {
      const b = overview.budget;
      document.getElementById('budget-meters').innerHTML = [
        meterCard('Session Spend', b.sessionSpendUsd, b.sessionMaxSpendUsd, '$'),
        meterCard('Daily Spend', b.dailySpendUsd, b.dailyMaxSpendUsd, '$'),
        meterCard('Session Mutations', b.sessionMutations, b.sessionMaxMutations, ''),
        meterCard('Daily Mutations', b.dailyMutations, b.dailyMaxMutations, ''),
      ].join('');

      const p = overview.policySummary;
      document.getElementById('policy-badge').textContent =
        'Policy: ' + p.ruleCount + ' rules • default ' + p.defaultDecision + ' (' + p.defaultGraceSeconds + 's)';

      const a = overview.auditVerification;
      const auditEl = document.getElementById('audit-badge');
      auditEl.className = 'pill ' + (a.valid ? 'ok' : 'bad');
      auditEl.textContent = a.valid
        ? 'Audit Chain: Verified (' + a.totalEntries + ' entries)'
        : 'Audit Chain: TAMPERED at seq ' + a.brokenAtSeq;
    }

    function renderActions(actions) {
      cachedActions = actions;
      const pending = actions.filter((a) => a.status === 'grace_pending' || a.status === 'pending_approval' || a.status === 'approved');
      const history = actions.filter((a) => !['grace_pending', 'pending_approval', 'approved'].includes(a.status));

      document.getElementById('queue-count-label').textContent = pending.length + ' pending';
      document.getElementById('history-count-label').textContent = history.length + ' actions';

      const queueEl = document.getElementById('staging-queue');
      if (pending.length === 0) {
        queueEl.innerHTML = '<p class="muted">No staged or approval-pending actions.</p>';
      } else {
        queueEl.innerHTML = pending.map((a) => {
          const countdownHtml = a.status === 'grace_pending'
            ? '<div class="countdown-wrap">'
              + '<div class="meter-label"><span>Grace window auto-executes in <strong class="grace-sec" data-id="' + esc(a.id) + '" data-exec="' + esc(a.executeAtMs) + '" data-total="' + esc(a.graceSeconds * 1000) + '">--</strong></span><span>Rule: ' + esc(a.ruleId || 'default') + '</span></div>'
              + '<div class="progress-track"><div class="progress-fill amber grace-bar" data-id="' + esc(a.id) + '" style="width:100%"></div></div>'
              + '</div>'
            : '<div class="muted" style="margin-top:6px;">Blocked reason: ' + esc(a.reason) + '</div>';

          const approveBtn = a.status === 'pending_approval'
            ? '<button class="btn-approve" onclick="approveAction(\\'' + esc(a.id) + '\\')">Approve &amp; Execute</button>'
            : '';

          return '<div class="action-item">'
            + '<div class="action-top">'
            + '  <div>'
            + '    <span class="action-title">' + esc(a.diffSummary || a.toolName) + '</span> '
            +      statusPill(a.status)
            + '    <div class="mono muted">' + esc(a.id) + ' &bull; ' + esc(a.toolName) + (a.spendUsd > 0 ? ' &bull; $' + a.spendUsd.toFixed(2) : '') + '</div>'
            + '  </div>'
            + '  <div class="toolbar">'
            +      approveBtn
            + '    <button class="btn-undo" onclick="undoAction(\\'' + esc(a.id) + '\\')">Undo (Cancel)</button>'
            + '  </div>'
            + '</div>'
            + countdownHtml
            + '<div class="diff-box">' + renderDiffHtml(a.diff && a.diff.unifiedDiff) + '</div>'
            + '</div>';
        }).join('');
      }

      const histEl = document.getElementById('action-history');
      if (history.length === 0) {
        histEl.innerHTML = '<p class="muted">No actions recorded yet.</p>';
      } else {
        histEl.innerHTML = history.slice(0, 20).map((a) => {
          const rollbackBtn = a.status === 'executed' && a.reversible
            ? '<button class="btn-rollback" onclick="undoAction(\\'' + esc(a.id) + '\\')">Rollback (Compensate)</button>'
            : '';
          const note = a.denyCode
            ? 'Denied (' + a.denyCode + '): ' + a.reason
            : a.errorMessage
              ? 'Error: ' + a.errorMessage
              : (a.diff && a.diff.reversibilityNote) || '';

          return '<div class="action-item">'
            + '<div class="action-top">'
            + '  <div>'
            + '    <span class="action-title">' + esc(a.diffSummary || a.toolName) + '</span> '
            +      statusPill(a.status)
            + '    <div class="mono muted">' + esc(a.id) + ' &bull; ' + esc(a.toolName) + (a.spendUsd > 0 ? ' &bull; $' + a.spendUsd.toFixed(2) : '') + '</div>'
            + (note ? '<div class="muted" style="margin-top:4px;">' + esc(note) + '</div>' : '')
            + '  </div>'
            + '  <div class="toolbar">' + rollbackBtn + '</div>'
            + '</div>'
            + '</div>';
        }).join('');
      }

      tickCountdowns();
    }

    function renderWorld(world) {
      const items = [];
      for (const e of world.emails || []) {
        items.push('<div class="world-row"><strong>Email [' + esc(e.folder) + ']</strong> ' + esc(e.subject) + '<div class="muted">' + esc(e.fromAddr) + ' &rarr; ' + esc(e.toAddr) + '</div></div>');
      }
      for (const ev of world.events || []) {
        items.push('<div class="world-row"><strong>Calendar [' + esc(ev.status) + ']</strong> ' + esc(ev.title) + '<div class="muted">' + esc(ev.startIso) + '</div></div>');
      }
      for (const c of world.charges || []) {
        items.push('<div class="world-row"><strong>Stripe [' + esc(c.status) + ']</strong> $' + (c.amountCents / 100).toFixed(2) + ' ' + esc(c.currency.toUpperCase()) + ' &mdash; ' + esc(c.description) + '<div class="muted">' + esc(c.id) + (c.refundId ? ' &bull; Refund: ' + esc(c.refundId) : '') + '</div></div>');
      }
      for (const f of world.files || []) {
        items.push('<div class="world-row"><strong>Sandbox File</strong> <code>' + esc(f.path) + '</code> (' + f.sizeBytes + 'B)</div>');
      }
      document.getElementById('world-state').innerHTML = items.length > 0 ? items.join('') : '<p class="muted">World state empty.</p>';
    }

    function renderAudit(audit) {
      document.getElementById('audit-rows').innerHTML = (audit.entries || []).map((row) =>
        '<tr>'
        + '<td class="mono">' + row.seq + '</td>'
        + '<td class="mono">' + esc(row.eventType) + '</td>'
        + '<td>' + esc(row.actor) + '</td>'
        + '<td>' + esc(row.summary) + '</td>'
        + '<td class="mono muted" title="' + esc(row.entryHash) + '">' + esc(row.entryHash.slice(0, 12)) + '&hellip;</td>'
        + '</tr>'
      ).join('');
    }

    function tickCountdowns() {
      const now = Date.now();
      let shouldRefresh = false;
      document.querySelectorAll('.grace-sec').forEach((el) => {
        const execMs = Number(el.getAttribute('data-exec') || 0);
        const totalMs = Math.max(1, Number(el.getAttribute('data-total') || 30000));
        const remMs = Math.max(0, execMs - now);
        el.textContent = (remMs / 1000).toFixed(1) + 's';
        const bar = document.querySelector('.grace-bar[data-id="' + el.getAttribute('data-id') + '"]');
        if (bar) {
          bar.style.width = Math.min(100, (remMs / totalMs) * 100) + '%';
        }
        if (remMs === 0) {
          shouldRefresh = true;
        }
      });
      if (shouldRefresh && !window.__refreshingDue) {
        window.__refreshingDue = true;
        setTimeout(() => {
          window.__refreshingDue = false;
          void refreshAll();
        }, 300);
      }
    }

    async function refreshAll() {
      try {
        const [ovRes, actRes, audRes, worldRes] = await Promise.all([
          fetch('/api/overview?sessionId=' + encodeURIComponent(SESSION_ID)),
          fetch('/api/actions?limit=50'),
          fetch('/api/audit?limit=40'),
          fetch('/api/world'),
        ]);
        const [ov, act, aud, world] = await Promise.all([
          ovRes.json(),
          actRes.json(),
          audRes.json(),
          worldRes.json(),
        ]);
        renderBudgets(ov);
        renderActions(act.actions || []);
        renderAudit(aud);
        renderWorld(world);
      } catch (err) {
        console.error(err);
      }
    }

    async function undoAction(id) {
      const res = await fetch('/api/actions/' + encodeURIComponent(id) + '/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'web-inspector' }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast('Undo failed: ' + (data.error || res.statusText));
      } else {
        showToast(data.mode === 'soft_cancel' ? 'Canceled action before execution' : 'Rolled back action via compensating handler');
      }
      await refreshAll();
    }

    async function approveAction(id) {
      const res = await fetch('/api/actions/' + encodeURIComponent(id) + '/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'web-inspector' }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast('Approve failed: ' + (data.error || res.statusText));
      } else {
        showToast('Approved & executed ' + data.action.toolName);
      }
      await refreshAll();
    }

    async function simulate(kind) {
      const presets = {
        email: {
          toolName: 'gmail.send_email',
          args: {
            to: 'board@acme.local',
            subject: 'Draft Q4 Metrics Summary',
            body: 'Hi team,\\nSending our preliminary Q4 numbers for review.',
          },
        },
        charge25: {
          toolName: 'stripe.create_charge',
          args: {
            customerId: 'cus_demo_99',
            amountCents: 2500,
            currency: 'usd',
            description: 'API sandbox credit pack ($25)',
          },
        },
        charge75: {
          toolName: 'stripe.create_charge',
          args: {
            customerId: 'cus_demo_99',
            amountCents: 7500,
            currency: 'usd',
            description: 'Enterprise add-on upgrade ($75)',
          },
        },
        calendar: {
          toolName: 'calendar.create_event',
          args: {
            title: 'Agent Safety Architecture Review',
            startIso: '2026-11-25T15:00:00Z',
            endIso: '2026-11-25T15:30:00Z',
            attendees: ['platform@acme.local'],
          },
        },
        file: {
          toolName: 'fs.write_file',
          args: {
            path: 'notes/roadmap.md',
            content: '# Q4 Agent Safety Roadmap\\n\\n- Transactional firewall active\\n- Pre-write snapshots enabled\\n- Updated at ' + new Date().toISOString() + '\\n',
          },
        },
        deny: {
          toolName: 'fs.write_file',
          args: {
            path: '.env',
            content: 'STRIPE_SECRET_KEY=sk_live_compromised\\n',
          },
        },
      };

      const payload = presets[kind];
      const res = await fetch('/api/actions/intercept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, sessionId: SESSION_ID, agentId: 'playground-agent' }),
      });
      const data = await res.json();
      showToast('Result: ' + data.status + (data.action && data.action.denyCode ? ' (' + data.action.denyCode + ')' : ''));
      await refreshAll();
    }

    setInterval(tickCountdowns, 100);
    setInterval(refreshAll, 2000);
    void refreshAll();
  </script>
</body>
</html>`;
}
