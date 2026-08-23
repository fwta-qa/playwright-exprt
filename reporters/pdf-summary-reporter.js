// reporters/pdf-summary-reporter.js
//
// Custom Playwright reporter that produces a plain-language PDF summary of
// the test run, meant for QA/stakeholders who don't need the full technical
// HTML report. It reads the "qa-summary.json" attachment produced by
// al-autofill-form.test.js (run metadata, ENV config, and per-phase outcome)
// and renders it as a styled HTML page, then prints that page to PDF using
// Chromium (same engine Playwright already uses to run tests).
//
// Runs automatically as part of the configured reporters in
// playwright.config.js — no extra command needed.

const fs = require('fs');
const path = require('path');

class PdfSummaryReporter {
  constructor() {
    this.results = [];
  }

  onTestEnd(test, result) {
    // Find the qa-summary.json attachment (if the test produced one) and
    // parse it so we can render a friendly breakdown instead of raw JSON.
    const summaryAttachment = result.attachments.find(a => a.name === 'qa-summary.json');
    let summary = null;

    if (summaryAttachment) {
      try {
        const raw = summaryAttachment.body
          ? summaryAttachment.body.toString('utf-8')
          : fs.readFileSync(summaryAttachment.path, 'utf-8');
        summary = JSON.parse(raw);
      } catch (e) {
        summary = { note: `Could not parse qa-summary.json: ${e.message}` };
      }
    }

    this.results.push({
      title: test.title,
      file: path.basename(test.location.file),
      status: result.status,
      duration: result.duration,
      error: result.error ? result.error.message : null,
      summary,
    });
  }

  async onEnd() {
    const html = this.buildHtml();
    const outputDir = path.join(process.cwd(), 'test-results');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const htmlPath = path.join(outputDir, 'qa-report.html');
    fs.writeFileSync(htmlPath, html, 'utf-8');

    try {
      // Re-use Playwright's own Chromium install to print the HTML to PDF —
      // no extra dependency needed.
      const { chromium } = require('@playwright/test');
      const browser = await chromium.launch();
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      const pdfPath = path.join(outputDir, 'QA-Report.pdf');
      await page.pdf({
        path: pdfPath,
        format: 'A4',
        printBackground: true,
        margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' },
      });
      await browser.close();
      console.log(`\n📄 QA PDF report generated: ${pdfPath}`);
    } catch (e) {
      console.warn(`⚠️ Could not generate PDF report: ${e.message}`);
      console.warn(`   HTML version is still available at: ${htmlPath}`);
    }
  }

  escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  statusBadge(status) {
    const map = {
      passed: { label: 'PASSED', color: '#1a7f37', bg: '#e6f6ea' },
      failed: { label: 'FAILED', color: '#c1121f', bg: '#fdeaea' },
      timedOut: { label: 'TIMED OUT', color: '#b45309', bg: '#fff4e5' },
      skipped: { label: 'SKIPPED', color: '#57606a', bg: '#f1f2f4' },
    };
    const s = map[status] || { label: status.toUpperCase(), color: '#57606a', bg: '#f1f2f4' };
    return `<span style="background:${s.bg};color:${s.color};padding:4px 12px;border-radius:12px;font-weight:600;font-size:13px;">${s.label}</span>`;
  }

  renderPhases(summary) {
    if (!summary || !summary.phases) {
      return '<p style="color:#57606a;">No phase data captured for this run.</p>';
    }
    const p = summary.phases;
    const rows = [];

    rows.push(['Corporate Details', p.corporateDetails || 'n/a']);

    if (Array.isArray(p.expatriateWorkers)) {
      p.expatriateWorkers.forEach(w => {
        rows.push([
          `Expatriate Worker #${w.index}`,
          `${w.status || 'n/a'} — ${this.escapeHtml(w.name || '?')}, ${this.escapeHtml(w.nationality || '?')}, type: ${this.escapeHtml(w.type || '?')}`,
        ]);
      });
    }

    if (p.localUnderstudyCandidates) {
      const c = p.localUnderstudyCandidates;
      rows.push(['Local Understudy Candidates', `${c.status || 'n/a'}${c.attempted ? ` (${c.count} candidate(s))` : ''}`]);
    }

    if (p.additionalAttachment) {
      const a = p.additionalAttachment;
      rows.push(['Additional Attachment', `${a.status || 'n/a'} — files uploaded: ${(a.filesUploaded || []).length}`]);
    }

    if (p.employerDeclaration) {
      const d = p.employerDeclaration;
      rows.push(['Employer\'s Declaration & E-Signature', `${d.status || 'n/a'}${d.signed ? ' (signed)' : ''}`]);
    }

    if (p.finalSubmit) {
      const s = p.finalSubmit;
      rows.push(['Final Submit', s.status || 'n/a']);
    }

    if (p.hardFailure) {
      rows.push(['Hard Failure', p.hardFailure]);
    }

    return `
      <table style="width:100%;border-collapse:collapse;margin-top:8px;">
        <thead>
          <tr style="background:#f6f8fa;text-align:left;">
            <th style="padding:8px 12px;border:1px solid #d0d7de;width:30%;">Phase</th>
            <th style="padding:8px 12px;border:1px solid #d0d7de;">Outcome</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(([label, val]) => `
            <tr>
              <td style="padding:8px 12px;border:1px solid #d0d7de;font-weight:600;">${this.escapeHtml(label)}</td>
              <td style="padding:8px 12px;border:1px solid #d0d7de;">${this.escapeHtml(val)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  renderEnvConfig(summary) {
    if (!summary || !summary.envConfig) return '';
    const env = summary.envConfig;
    const entries = Object.entries(env);
    return `
      <table style="width:100%;border-collapse:collapse;margin-top:8px;">
        <tbody>
          ${entries.map(([k, v]) => `
            <tr>
              <td style="padding:6px 12px;border:1px solid #d0d7de;font-weight:600;width:40%;">${this.escapeHtml(k)}</td>
              <td style="padding:6px 12px;border:1px solid #d0d7de;">${this.escapeHtml(v)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  buildHtml() {
    const now = new Date().toLocaleString();
    const passedCount = this.results.filter(r => r.status === 'passed').length;
    const failedCount = this.results.filter(r => r.status !== 'passed').length;
    const overall = failedCount === 0 ? 'passed' : 'failed';

    const testsHtml = this.results.map(r => `
      <div style="border:1px solid #d0d7de;border-radius:8px;padding:16px;margin-bottom:20px;page-break-inside:avoid;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <h3 style="margin:0;font-size:16px;">${this.escapeHtml(r.title)}</h3>
          ${this.statusBadge(r.status)}
        </div>
        <p style="color:#57606a;font-size:13px;margin:4px 0;">File: ${this.escapeHtml(r.file)} &nbsp;|&nbsp; Duration: ${(r.duration / 1000).toFixed(1)}s</p>
        ${r.error ? `<p style="background:#fdeaea;color:#c1121f;padding:8px 12px;border-radius:6px;font-size:13px;">${this.escapeHtml(r.error)}</p>` : ''}

        <h4 style="margin:16px 0 4px;font-size:14px;">Run Configuration</h4>
        ${this.renderEnvConfig(r.summary)}

        <h4 style="margin:16px 0 4px;font-size:14px;">Phase Breakdown</h4>
        ${this.renderPhases(r.summary)}
      </div>
    `).join('');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>EXPRT AL Automation - QA Report</title>
</head>
<body style="font-family: Arial, Helvetica, sans-serif; color:#1f2328; margin:0; padding:32px;">
  <h1 style="margin:0 0 4px;">EXPRT AL Automation — QA Report</h1>
  <p style="color:#57606a;margin:0 0 24px;">Generated: ${now}</p>

  <div style="display:flex;gap:16px;margin-bottom:28px;">
    <div style="flex:1;border:1px solid #d0d7de;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:28px;font-weight:700;">${this.results.length}</div>
      <div style="color:#57606a;font-size:13px;">Total Tests</div>
    </div>
    <div style="flex:1;border:1px solid #d0d7de;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:28px;font-weight:700;color:#1a7f37;">${passedCount}</div>
      <div style="color:#57606a;font-size:13px;">Passed</div>
    </div>
    <div style="flex:1;border:1px solid #d0d7de;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:28px;font-weight:700;color:#c1121f;">${failedCount}</div>
      <div style="color:#57606a;font-size:13px;">Failed</div>
    </div>
    <div style="flex:1;border:1px solid #d0d7de;border-radius:8px;padding:16px;text-align:center;">
      ${this.statusBadge(overall)}
      <div style="color:#57606a;font-size:13px;margin-top:6px;">Overall Result</div>
    </div>
  </div>

  ${testsHtml}
</body>
</html>`;
  }
}

module.exports = PdfSummaryReporter;
