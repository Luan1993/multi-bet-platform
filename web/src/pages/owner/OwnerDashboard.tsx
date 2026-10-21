import { useEffect, useState } from "react";
import { api } from "../../lib/api";

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

  if (loading) return <div>Carregando...</div>;
  if (error) return <div style={{ color: "var(--danger)" }}>{error}</div>;

  const c: Counters = data?.counters ?? ({} as Counters);

  const cards: Array<{ label: string; value: string; hint?: string }> = [
    { label: "Cupons no período", value: String(c.total ?? 0), hint: `${c.pending ?? 0} pendentes` },
    { label: "Aceitos", value: String(c.accepted ?? 0) },
    { label: "Vencidos (won)", value: String(c.won ?? 0) },
    { label: "Perdidos", value: String(c.lost ?? 0) },
    { label: "Stake aceito", value: brl(c.stakeTotalCents) },
    { label: "Retorno potencial", value: brl(c.potentialTotalCents) },
    { label: "A pagar", value: brl(c.dueTotalCents) },
    { label: "Pago", value: brl(c.paidTotalCents) },
    { label: "Clientes", value: String(c.clientsTotal ?? 0), hint: `${c.clientsActive ?? 0} ativos` },
    { label: "Eventos de risco", value: String(c.riskEvents ?? 0) },
  ];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <h1 style={{ margin: "0 0 1.5rem 0" }}>Dashboard</h1>
        {data?.link && (
          <a href={data.link} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", fontSize: "0.875rem" }}>
            Abrir minha página pública →
          </a>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "1rem" }}>
        {cards.map((card) => (
          <div key={card.label} style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "8px", padding: "1rem" }}>
            <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem" }}>{card.label}</div>
            <div style={{ fontSize: "1.5rem", fontWeight: "700", marginTop: "0.25rem" }}>{card.value}</div>
            {card.hint && <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>{card.hint}</div>}
          </div>
        ))}
      </div>

      <h2 style={{ margin: "2rem 0 1rem 0", fontSize: "1.125rem" }}>Últimos 30 dias</h2>
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

      {data?.limits && (
        <div style={{ marginTop: "1.5rem", color: "var(--text-dim)", fontSize: "0.8125rem" }}>
          Limites efetivos — aposta mínima {brl(data.limits.minStakeCents)}, máxima {brl(data.limits.maxStakeCents)},
          retorno máximo por cupom {brl(data.limits.maxPayoutCents)}.
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: "left", padding: "0.75rem", color: "var(--text-dim)", fontSize: "0.8125rem", fontWeight: 500 };
const td: React.CSSProperties = { padding: "0.75rem" };

function brl(cents?: number): string {
  return ((cents ?? 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
