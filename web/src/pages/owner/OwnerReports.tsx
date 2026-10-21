import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { Alert, Button, Card, Field, Input, PageTitle, Table, brl, tdStyle } from "../../components/ui";

interface ReportRow {
  day: string;
  total: number;
  pending: number;
  accepted: number;
  won: number;
  lost: number;
  cancelled: number;
  expired: number;
  stakeCents: number;
  potentialCents: number;
  dueCents: number;
  paidCents: number;
}

function isoDate(d: Date): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function startOfDayIso(date: string): string {
  return new Date(`${date}T00:00:00`).toISOString();
}

function endOfDayIso(date: string): string {
  return new Date(`${date}T23:59:59.999`).toISOString();
}

export default function OwnerReports() {
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [from, setFrom] = useState(() => isoDate(new Date(Date.now() - 30 * 24 * 3600 * 1000)));
  const [to, setTo] = useState(() => isoDate(new Date()));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from: startOfDayIso(from), to: endOfDayIso(to) });
      const res = await api.get(`/api/owner/reports/daily?${params}`);
      setRows(res.rows ?? []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          total: acc.total + r.total,
          pending: acc.pending + r.pending,
          accepted: acc.accepted + r.accepted,
          won: acc.won + r.won,
          lost: acc.lost + r.lost,
          cancelled: acc.cancelled + r.cancelled,
          expired: acc.expired + r.expired,
          stakeCents: acc.stakeCents + r.stakeCents,
          potentialCents: acc.potentialCents + r.potentialCents,
          dueCents: acc.dueCents + r.dueCents,
          paidCents: acc.paidCents + r.paidCents,
        }),
        {
          total: 0,
          pending: 0,
          accepted: 0,
          won: 0,
          lost: 0,
          cancelled: 0,
          expired: 0,
          stakeCents: 0,
          potentialCents: 0,
          dueCents: 0,
          paidCents: 0,
        }
      ),
    [rows]
  );

  function exportCsv(type: "coupons" | "movements") {
    const params = new URLSearchParams({ type, from: startOfDayIso(from), to: endOfDayIso(to) });
    window.location.href = `/api/owner/reports/export.csv?${params}`;
  }

  return (
    <div>
      <PageTitle
        title="Relatórios"
        subtitle="Movimento diário de cupons e exportação em CSV, sempre restrito à sua bet."
        action={
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Button variant="ghost" onClick={() => exportCsv("coupons")}>
              Exportar cupons
            </Button>
            <Button variant="ghost" onClick={() => exportCsv("movements")}>
              Exportar movimentações
            </Button>
          </div>
        }
      />

      {error && <Alert>{error}</Alert>}

      <Card
        title="Período"
        action={
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ width: "160px" }}>
              <Field label="De">
                <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
              </Field>
            </div>
            <div style={{ width: "160px" }}>
              <Field label="Até">
                <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
              </Field>
            </div>
            <div style={{ marginBottom: "0.875rem" }}>
              <Button onClick={load} disabled={loading}>
                {loading ? "Carregando..." : "Atualizar"}
              </Button>
            </div>
          </div>
        }
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "1rem" }}>
          <Summary label="Cupons" value={String(totals.total)} />
          <Summary label="Stake aceito" value={brl(totals.stakeCents)} />
          <Summary label="Retorno potencial" value={brl(totals.potentialCents)} />
          <Summary label="Prêmio devido" value={brl(totals.dueCents)} />
          <Summary label="Prêmio pago" value={brl(totals.paidCents)} />
        </div>
      </Card>

      <Card title="Detalhe por dia" style={{ marginTop: "1.25rem" }}>
        {loading ? (
          <div style={{ color: "var(--text-dim)" }}>Carregando...</div>
        ) : (
          <Table
            head={[
              "Dia",
              "Total",
              "Pendentes",
              "Aceitos",
              "Vencidos",
              "Perdidos",
              "Cancelados",
              "Expirados",
              "Stake",
              "Potencial",
              "Devido",
              "Pago",
            ]}
          >
            {rows.map((r) => (
              <tr key={r.day} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                  {new Date(`${r.day}T12:00:00`).toLocaleDateString("pt-BR")}
                </td>
                <td style={tdStyle}>{r.total}</td>
                <td style={tdStyle}>{r.pending}</td>
                <td style={tdStyle}>{r.accepted}</td>
                <td style={tdStyle}>{r.won}</td>
                <td style={tdStyle}>{r.lost}</td>
                <td style={tdStyle}>{r.cancelled}</td>
                <td style={tdStyle}>{r.expired}</td>
                <td style={tdStyle}>{brl(r.stakeCents)}</td>
                <td style={tdStyle}>{brl(r.potentialCents)}</td>
                <td style={tdStyle}>{brl(r.dueCents)}</td>
                <td style={tdStyle}>{brl(r.paidCents)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={12} style={{ ...tdStyle, color: "var(--text-dim)" }}>
                  Nenhum movimento no período selecionado.
                </td>
              </tr>
            )}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem" }}>{label}</div>
      <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>{value}</div>
    </div>
  );
}
