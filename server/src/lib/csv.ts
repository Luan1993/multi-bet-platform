/**
 * Geração de CSV compatível com Excel (UTF-8 com BOM + separador ;)
 * para exportação de relatórios pelos painéis.
 */
function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[;"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCell).join(";")];
  for (const row of rows) lines.push(row.map(escapeCell).join(";"));
  // BOM para o Excel reconhecer UTF-8
  return "\ufeff" + lines.join("\r\n");
}

export function csvDownload(filename: string, csv: string): {
  contentType: string;
  disposition: string;
  body: string;
} {
  return {
    contentType: "text/csv; charset=utf-8",
    disposition: `attachment; filename="${filename}"`,
    body: csv,
  };
}

/** Formata centavos como 1234,56 (sem símbolo) para planilhas. */
export function centsToNumber(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}
