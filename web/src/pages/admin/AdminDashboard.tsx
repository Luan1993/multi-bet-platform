import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Alert, Badge, Card, PageTitle, Table, brl, tdStyle } from "../../components/ui";

interface ConsolidatedRow {
  ownerId: number;
  slug: string;
  name: string;
  status: string;
  couponsTotal: number;
  pending: number;
  accepted: number;
  won: number;
  lost: number;
  stakeTotalCents: number;
  potentialTotalCents: number;
  dueTotalCents: number;
  paidTotalCents: number;
  clientsTotal: number;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<any>(null);
  const [rows, setRows] = useState<ConsolidatedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.get("/api/admin/stats"), api.get("/api/admin/reports/consolidated")])
      .then(([s, r]) => {
        if (!alive) return;
        setStats(s);
        setRows(r.rows ?? []);
      })
      .catch((err) => alive && setError(err.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  if (loading) return <div style={{ color: "var(--text-dim)" }}>Carregando...</div>;

  const owners = stats?.owners ?? {};
  const coupons = stats?.coupons ?? {};
  const settings = stats?.platformSettings ?? {};

  return (
    <div>
      <PageTitle
        title="Visão geral da plataforma"
        subtitle="Consolidado de todas as bets. Cada operação permanece isolada; aqui os números são apenas agregados."
      />

      {error && <Alert>{error}</Alert>}

      {settings.demoMode && (
        <Alert kind="info">
          <strong>Modo demonstração ativo.</strong> Eventos e odds são simulados até a autorização legal e a configuração de
          um provedor real. Depósitos, saques, saldos e prêmios reais permanecem indisponíveis.
        </Alert>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "1rem" }}>
        <StatCard label="Bets" value={String(owners.total ?? 0)} hint={`${owners.active ?? 0} ativas · ${owners.suspended ?? 0} suspensas · ${owners.blocked ?? 0} bloqueadas`} />
        <StatCard label="Clientes" value={String(stats?.clients ?? 0)} />
        <StatCard label="Cupons" value={String(coupons.total ?? 0)} hint={`${coupons.pending ?? 0} pendentes · ${coupons.accepted ?? 0} aceitos`} />
        <StatCard label="Stake aceito" value={brl(coupons.stakeTotalCents)} />
        <StatCard label="Retorno potencial" value={brl(coupons.potentialTotalCents)} />
        <StatCard label="A pagar" value={brl(coupons.dueTotalCents)} />
        <StatCard label="Pago" value={brl(coupons.paidTotalCents)} />
        <StatCard label="Eventos de risco (30d)" value={String(stats?.riskEvents30d ?? 0)} hint={`Teto por cupom: ${brl(settings.maxPayoutCents)}`} />
      </div>

      <Card title="Desempenho por bet" style={{ marginTop: "1.5rem" }}>
        <Table head={["Bet", "Status", "Clientes", "Cupons", "Pendentes", "Aceitos", "Stake", "Potencial", "A pagar"]}>
          {rows.map((r) => (
            <tr key={r.ownerId} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={tdStyle}>
                <a href={`/bet/${r.slug}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", fontWeight: 600 }}>
                  {r.name}
                </a>
                <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>/bet/{r.slug}</div>
              </td>
              <td style={tdStyle}><Badge status={r.status} /></td>
              <td style={tdStyle}>{r.clientsTotal}</td>
              <td style={tdStyle}>{r.couponsTotal}</td>
              <td style={tdStyle}>{r.pending}</td>
              <td style={tdStyle}>{r.accepted}</td>
              <td style={tdStyle}>{brl(r.stakeTotalCents)}</td>
              <td style={tdStyle}>{brl(r.potentialTotalCents)}</td>
              <td style={tdStyle}>{brl(r.dueTotalCents)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} style={{ ...tdStyle, color: "var(--text-dim)" }}>Nenhuma bet cadastrada.</td>
            </tr>
          )}
        </Table>
        <div style={{ color: "var(--text-dim)", fontSize: "0.75rem", marginTop: "0.75rem" }}>
          Período: últimos 30 dias. Valores de stake consideram cupons aceitos, vencedores e perdedores.
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "1.25rem", marginTop: "1.5rem" }}>
        <Card title="Cupons por dia (30 dias)">
          <SeriesChart series={stats?.series ?? []} />
        </Card>

        <Card title="Integração de odds">
          {stats?.provider?.id ? (
            <div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>{stats.provider.label ?? stats.provider.id}</div>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.5rem" }}>
                <Badge status={stats.provider.available ? "active" : "blocked"} />
                <span style={{ color: "var(--text-dim)", fontSize: "0.8125rem" }}>
                  {stats.provider.isDemo ? "Dados simulados" : "Produção"}
                </span>
              </div>
              {stats.provider.lastSyncAt && (
                <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem", marginTop: "0.5rem" }}>
                  Última sincronização: {new Date(stats.provider.lastSyncAt).toLocaleString("pt-BR")}
                </div>
              )}
              {stats.provider.reason && (
                <div style={{ color: "#fca5a5", fontSize: "0.8125rem", marginTop: "0.5rem" }}>{stats.provider.reason}</div>
              )}
              <a href="/admin/providers" style={{ display: "inline-block", marginTop: "0.75rem", color: "var(--accent)", fontSize: "0.875rem" }}>
                Gerenciar provedores →
              </a>
            </div>
          ) : (
            <Alert kind="error">Nenhum provedor de odds ativo.</Alert>
          )}
        </Card>
      </div>
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "10px", padding: "1rem" }}>
      <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem" }}>{label}</div>
      <div style={{ fontSize: "1.4rem", fontWeight: 700, marginTop: "0.2rem" }}>{value}</div>
      {hint && <div style={{ color: "var(--text-dim)", fontSize: "0.7rem", marginTop: "0.15rem" }}>{hint}</div>}
    </div>
  );
}

function SeriesChart({ series }: { series: Array<{ day: string; total: number; stakeCents: number }> }) {
  if (series.length === 0) {
    return <div style={{ color: "var(--text-dim)", fontSize: "0.875rem" }}>Sem movimento no período.</div>;
  }
  const max = Math.max(...series.map((s) => s.total), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: "0.35rem", height: "140px" }}>
      {series.map((s) => (
        <div key={s.day} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", height: "100%" }} title={`${s.day}: ${s.total} cupom(ns) · ${brl(s.stakeCents)}`}>
          <div
            style={{
              width: "100%",
              minWidth: "4px",
              height: `${Math.max(4, (s.total / max) * 100)}%`,
              background: "var(--primary)",
              borderRadius: "3px 3px 0 0",
            }}
          />
        </div>
      ))}
    </div>
  );
}
