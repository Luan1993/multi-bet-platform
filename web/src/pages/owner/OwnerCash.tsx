import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Alert, Button, Card, Field, Input, PageTitle, Table, brl, tdStyle } from "../../components/ui";

interface CashData {
  openingCashCents: number;
  entradasCents: number;
  saidasCents: number;
  ajustesCents: number;
  pendentesCents: number;
  saldoCents: number;
  resultadoCents: number;
  acceptedCoupons: number;
  period: {
    from: string;
    to: string;
    entradasCents: number;
    saidasCents: number;
    ajustesCents: number;
    resultadoCents: number;
  };
  movements: Array<{
    id: number;
    type: string;
    amountCents: number;
    note: string | null;
    createdAt: string;
    isDemo: boolean;
    couponCode: string | null;
  }>;
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

function formatType(type: string): string {
  switch (type) {
    case "stake_accepted":
      return "Entrada (aposta aceita)";
    case "prize_paid":
      return "Saída (prêmio pago)";
    case "adjustment":
      return "Ajuste manual";
    case "prize_due":
      return "Prêmio devido";
    case "prize_potential":
      return "Prêmio potencial";
    default:
      return type;
  }
}

export default function OwnerCash() {
  const [data, setData] = useState<CashData | null>(null);
  const [from, setFrom] = useState(() => isoDate(new Date(Date.now() - 30 * 24 * 3600 * 1000)));
  const [to, setTo] = useState(() => isoDate(new Date()));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Formulário de ajuste
  const [adjDirection, setAdjDirection] = useState<"in" | "out">("in");
  const [adjAmount, setAdjAmount] = useState("");
  const [adjNote, setAdjNote] = useState("");
  const [adjusting, setAdjusting] = useState(false);
  const [adjNotice, setAdjNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from: startOfDayIso(from), to: endOfDayIso(to) });
      const res = await api.get(`/api/owner/cash?${params}`);
      setData(res);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAdjustment(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(adjAmount.replace(",", ".")) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setError("Informe um valor válido para o ajuste.");
      return;
    }
    setAdjusting(true);
    setError(null);
    setAdjNotice(null);
    try {
      await api.post("/api/owner/cash/adjustment", {
        direction: adjDirection,
        amountCents: cents,
        note: adjNote,
      });
      setAdjAmount("");
      setAdjNote("");
      setAdjNotice("Ajuste de caixa registrado com sucesso.");
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAdjusting(false);
    }
  }

  if (loading && !data) return <div style={{ color: "var(--text-dim)" }}>Carregando caixa...</div>;

  const summary = data;

  return (
    <div>
      <PageTitle
        title="Caixa da Operação"
        subtitle="Acompanhe o saldo acumulado em tempo real, entradas, saídas (prêmios pagos) e faça ajustes manuais de caixa."
      />

      {error && <Alert>{error}</Alert>}
      {adjNotice && <Alert kind="success">{adjNotice}</Alert>}

      {/* Sumário acumulado */}
      {summary && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "1rem", marginBottom: "1.5rem" }}>
          <Box label="Saldo em caixa" value={brl(summary.saldoCents)} big color={summary.saldoCents >= 0 ? "var(--success)" : "var(--danger)"} />
          <Box label="Caixa inicial" value={brl(summary.openingCashCents)} hint="configurado em Configurações" />
          <Box label="Entradas (apostas)" value={brl(summary.entradasCents)} hint={`${summary.acceptedCoupons} cupons aceitos`} />
          <Box label="Saídas (prêmios pagos)" value={brl(summary.saidasCents)} />
          <Box label="Ajustes manuais" value={brl(summary.ajustesCents)} />
          <Box
            label="Lucro / Prejuízo"
            value={brl(summary.resultadoCents)}
            big
            color={summary.resultadoCents >= 0 ? "#22c55e" : "#f87171"}
            hint="apostas − prêmios pagos"
          />
        </div>
      )}

      {/* Grid: Filtro de período + Ajuste de caixa */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: "1.25rem", alignItems: "start", marginBottom: "1.5rem" }}>
        <Card
          title="Filtro de período (Lançamentos)"
          action={
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
              <div style={{ width: "135px" }}>
                <Field label="De">
                  <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
                </Field>
              </div>
              <div style={{ width: "135px" }}>
                <Field label="Até">
                  <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
                </Field>
              </div>
              <div style={{ marginBottom: "0.875rem" }}>
                <Button onClick={load} disabled={loading}>
                  {loading ? "..." : "Filtrar"}
                </Button>
              </div>
            </div>
          }
        >
          {summary?.period && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.75rem", paddingTop: "0.5rem" }}>
              <div>
                <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>Entradas no período</div>
                <div style={{ fontWeight: 700 }}>{brl(summary.period.entradasCents)}</div>
              </div>
              <div>
                <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>Saídas no período</div>
                <div style={{ fontWeight: 700 }}>{brl(summary.period.saidasCents)}</div>
              </div>
              <div>
                <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>Resultado do período</div>
                <div style={{ fontWeight: 700, color: summary.period.resultadoCents >= 0 ? "#22c55e" : "#f87171" }}>
                  {brl(summary.period.resultadoCents)}
                </div>
              </div>
            </div>
          )}
        </Card>

        <Card title="Ajuste de caixa (Reforço / Retirada)">
          <form onSubmit={handleAdjustment}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", marginBottom: "0.75rem" }}>
              <Field label="Operação">
                <select
                  value={adjDirection}
                  onChange={(e) => setAdjDirection(e.target.value as "in" | "out")}
                  style={{
                    width: "100%",
                    padding: "0.5rem",
                    background: "rgba(255,255,255,0.05)",
                    border: "1px solid var(--border)",
                    borderRadius: "6px",
                    color: "var(--text)",
                  }}
                >
                  <option value="in">Adicionar (Reforço)</option>
                  <option value="out">Retirar (Sangria)</option>
                </select>
              </Field>
              <Field label="Valor (R$)">
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={adjAmount}
                  onChange={(e) => setAdjAmount(e.target.value)}
                  placeholder="0,00"
                />
              </Field>
            </div>
            <Field label="Observação / Motivo">
              <Input
                type="text"
                value={adjNote}
                onChange={(e) => setAdjNote(e.target.value)}
                placeholder="Ex.: Troco inicial, retirada de lucro..."
              />
            </Field>
            <div style={{ marginTop: "1rem" }}>
              <Button type="submit" disabled={adjusting}>
                {adjusting ? "Registrando..." : "Registrar ajuste"}
              </Button>
            </div>
          </form>
        </Card>
      </div>

      {/* Lançamentos no período */}
      <Card title="Movimentações financeiras">
        {loading ? (
          <div style={{ color: "var(--text-dim)" }}>Carregando...</div>
        ) : (
          <Table head={["Data/Hora", "Tipo", "Cupom", "Valor", "Observação"]}>
            {(summary?.movements ?? []).map((m) => {
              const isPos = m.amountCents >= 0;
              return (
                <tr key={m.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ ...tdStyle, whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: "0.8125rem" }}>
                    {new Date(m.createdAt).toLocaleString("pt-BR")}
                  </td>
                  <td style={tdStyle}>{formatType(m.type)}</td>
                  <td style={{ ...tdStyle, fontFamily: "monospace" }}>
                    {m.couponCode ? (
                      <a href={`/owner/coupons`} style={{ color: "var(--accent)" }}>
                        {m.couponCode}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={{ ...tdStyle, fontWeight: 700, color: isPos ? "#4ade80" : "#f87171" }}>
                    {isPos ? `+ ${brl(m.amountCents)}` : `- ${brl(Math.abs(m.amountCents))}`}
                  </td>
                  <td style={{ ...tdStyle, color: "var(--text-dim)" }}>{m.note || "—"}</td>
                </tr>
              );
            })}
            {(summary?.movements ?? []).length === 0 && (
              <tr>
                <td colSpan={5} style={{ ...tdStyle, color: "var(--text-dim)" }}>
                  Nenhuma movimentação no período selecionado.
                </td>
              </tr>
            )}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Box({ label, value, hint, color, big }: { label: string; value: string; hint?: string; color?: string; big?: boolean }) {
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "8px", padding: "1rem" }}>
      <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem" }}>{label}</div>
      <div style={{ fontSize: big ? "1.5rem" : "1.25rem", fontWeight: 700, marginTop: "0.25rem", color: color ?? "var(--text)" }}>
        {value}
      </div>
      {hint && <div style={{ color: "var(--text-dim)", fontSize: "0.75rem", marginTop: "0.25rem" }}>{hint}</div>}
    </div>
  );
}
