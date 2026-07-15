/**
 * Shared export helpers for Project Management report pages.
 *
 * IMPORTANT — what this is and isn't:
 * - CSV export: converts already-fetched, real API response data into
 *   a CSV string client-side. No backend export endpoint exists
 *   anywhere in this system (checked directly in routes/*.ts before
 *   building this) — this avoids needing one, since it operates on
 *   numbers the browser already has from a real API call, not
 *   invented or recomputed values.
 * - "Excel" export: there is no .xlsx binary writer here (that would
 *   need either a backend endpoint or a client-side library — neither
 *   exists yet). CSV opens natively in Excel and is offered as the
 *   practical equivalent, not disguised as a true .xlsx file.
 * - PDF export: uses the browser's native print-to-PDF (window.print
 *   with a print stylesheet), not a PDF-generation library — zero new
 *   dependencies, zero backend change.
 */
function pmExportToCsv(filename, rows, columns) {
    if (!rows || !rows.length) { alert('Nothing to export — no data in the current view.'); return; }
    const header = columns.map(c => '"' + c.label.replace(/"/g, '""') + '"').join(',');
    const lines = rows.map(row => columns.map(c => {
        const val = typeof c.value === 'function' ? c.value(row) : row[c.value];
        return '"' + String(val ?? '').replace(/"/g, '""') + '"';
    }).join(','));
    const csv = [header, ...lines].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename.endsWith('.csv') ? filename : filename + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function pmExportToPdf(){
    window.print();
}
