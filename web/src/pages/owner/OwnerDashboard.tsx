import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { brl } from "../../components/ui";

interface Counters {
  total: number;
  pending: number;
  accepted: number;
  won: number;
  lost: number;
  cancelled: number;
  expired: number;
  stakeTotalCents: number;
  potentialTotalCents: number;
  dueTotalCents: number;
  paidTotalCents: number;
  riskEvents: number;
  clientsTotal: number;
  clientsActive: number;
}

interface CashSummary {
  openingCashCents: number;
  entradasCents: number;
  saidasCents: number;
  ajustesCents: number;
  pendentesCents: number;
  saldoCents: number;
  resultadoCents: number;
  acceptedCoupons: number;
}

export default function OwnerDashboard() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get("/api/owner/dashboard")
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: "var(--text-dim)" }}>Carregando...</div>;
  if (error)
    return (
      <div>
        <h1 style={{ margin: "0 0 1rem 0" }}>Dashboard</h1>
        <div style={{ color: "var(--danger)" }}>{error}</div>
      </div>
    );

  const c: Counters = data?.counters ?? ({} as Counters);
  const cash: CashSummary = data?.cash ?? ({} as CashSummary);
  const payments = data?.recentPayments ?? [];
  const profit = cash.resultadoCents ?? 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
        <h1 style={{ margin: "0 0 1.5rem 0" }}>Dashboard</h1>
        {data?.link && (
          <a href={data.link} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", fontSize: "0.875rem" }}>
            Abrir minha página pública →
          </a>
        )}
      </div>

      {/* ---------- Caixa e resultado ---------- */}
      <section>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "0.75rem" }}>
          <h2 style={{ margin: 0, fontSize: "1rem" }}>Caixa e resultado</h2>
          <a href="/owner/cash" style={{ color: "var(--accent)", fontSize: "0.8125rem" }}>
            Abrir caixa completo →
          </a>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1rem" }}>
          <CashCard label="Saldo em caixa" value={brl(cash.saldoCents)} big color={cash.saldoCents >= 0 ? "var(--success)" : "var(--danger)"} />
          <CashCard label="Caixa inicial" value={brl(cash.openingCashCents)} hint="definido em Configurações" />
          <CashCard label="Entradas (apostas)" value={brl(cash.entradasCents)} hint={`${cash.acceptedCoupons ?? 0} cupons aceitos`} />
          <CashCard label="Saídas (prêmios pagos)" value={brl(cash.saidasCents)} />
          <CashCard label="A pagar (cupons aceitos)" value={brl(cash.pendentesCents)} hint="responsabilidade pendente" />
          <CashCard
            label={profit >= 0 ? "Lucro até agora" : "Prejuízo até agora"}
            value={brl(Math.abs(profit))}
            big
            color={profit >= 0 ? "#22c55e" : "#f87171"}
            hint="entradas − prêmios pagos"
          />
        </div>
      </section>

      {/* ---------- Cupons (período) ---------- */}
      <section style={{ marginTop: "1.75rem" }}>
        <h2 style={{ margin: "0 0 0.75rem 0", fontSize: "1rem" }}>Cupons no período</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "1rem" }}>
          <CashCard label="Cupons" value={String(c.total ?? 0)} hint={`${c.pending ?? 0} aguardando confirmação`} />
          <CashCard label="Aceitos" value={String(c.accepted ?? 0)} color="#22c55e" />
          <CashCard label="Ganhadores" value={String(c.won ?? 0)} />
          <CashCard label="Perdedores" value={String(c.lost ?? 0)} />
          <CashCard label="Cancelados / expirados" value={`${c.cancelled ?? 0} / ${c.expired ?? 0}`} />
          <CashCard label="Stake aceito" value={brl(c.stakeTotalCents)} />
          <CashCard label="Retorno potencial (em jogo)" value={brl(c.potentialTotalCents)} hint="pendentes + aceitos" />
          <CashCard label="Eventos de risco" value={String(c.riskEvents ?? 0)} hint={`${c.clientsTotal ?? 0} clientes (${c.clientsActive ?? 0} ativos)`} />
        </div>
      </section>

      {/* ---------- Últimos pagamentos ---------- */}
      {payments.length > 0 && (
        <section style={{ marginTop: "1.75rem" }}>
          <h2 style={{ margin: "0 0 0.75rem 0", fontSize: "1rem" }}>Últimos pagamentos</h2>
          <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "8px", overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={th}>Cupom</th>
                  <th style={th}>Valor pago</th>
                  <th style={th}>Quando</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p: any) => (
                  <tr key={p.code} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ ...td, fontFamily: "monospace" }}>{p.code}</td>
                    <td style={{ ...td, fontWeight: 700, color: "#4ade80" }}>{brl(p.paidCents)}</td>
                    <td style={{ ...td, color: "var(--text-dim)" }}>
                      {p.settledAt ? new Date(p.settledAt).toLocaleString("pt-BR") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ---------- Série 30 dias ---------- */}
      <section style={{ marginTop: "1.75rem" }}>
        <h2 style={{ margin: "0 0 0.75rem 0", fontSize: "1rem" }}>Últimos 30 dias</h2>
        <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "8px", overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={th}>Dia</th>
                <th style={th}>Cupons</th>
                <th style={th}>Pendentes</th>
                <th style={th}>Stake</th>
              </tr>
            </thead>
            <tbody>
              {(data?.series ?? []).map((s: any) => (
                <tr key={s.day} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={td}>{new Date(s.day).toLocaleDateString("pt-BR")}</td>
                  <td style={td}>{s.total}</td>
                  <td style={td}>{s.pending}</td>
                  <td style={td}>{brl(s.stakeCents)}</td>
                </tr>
              ))}
              {(data?.series ?? []).length === 0 && (
                <tr>
                  <td style={td} colSpan={4}>
                    Sem movimento no período.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {data?.limits && (
        <div style={{ marginTop: "1.5rem", color: "var(--text-dim)", fontSize: "0.8125rem" }}>
          Limites efetivos — aposta mínima {brl(data.limits.minStakeCents)}, máxima {brl(data.limits.maxStakeCents)},
          retorno máximo por cupom {brl(data.limits.maxPayoutCents)}.
          {data.demoMode && " Modo demonstração ativo: nenhum valor real é movimentado."}
        </div>
      )}
    </div>
  );
}

function CashCard({
  label,
  value,
  hint,
  color,
  big,
}: {
  label: string;
  value: string;
  hint?: string;
  color?: string;
  big?: boolean;
}) {
  const isCard = label === "Saldo em caixa" || label.startsWith("Lucro") || label.startsWith("Prejuízo");
  return (
    <div
      style={{
        background: isCard ? "var(--panel)" : "var(--panel)",
        border: "1px solid " + (isCard ? "var(--accent)" : "var(--border)"),
        borderRadius: "8px",
        padding: "1rem",
      }}
    >
      <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem" }}>{label}</div>
      <div
        style={{
          fontSize: big ? "1.65rem" : "1.35rem",
          fontWeight: 700,
          marginTop: "0.25rem",
          color: color ?? "var(--text)",
        }}
      >
        {value}
      </div>
      {hint && <div style={{ color: "var(--text-dim)", fontSize: "0.75rem", marginTop: "0.25rem" }}>{hint}</div>}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: "left", padding: "0.75rem", color: "var(--text-dim)", fontSize: "0.8125rem", fontWeight: 500 };
const td: React.CSSProperties = { padding: "0.75rem" };
