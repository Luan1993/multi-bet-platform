import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Alert, Button, Card, Input, PageTitle } from "../../components/ui";
import { formatBRL } from "../../lib/utils";

interface EventRisk {
  fixtureId: string;
  event: string;
  kickoffAt: string | null;
  coupons: number;
  stakeCents: number;
  potentialCents: number;
}

interface MarketRisk {
  marketKey: string;
  marketName: string;
  selections: number;
  potentialCents: number;
}

interface RiskData {
  totals: {
    openCoupons: number;
    stakeCents: number;
    potentialCents: number;
    unpaidPrizesCents: number;
    unpaidPrizesCount: number;
  };
  events: EventRisk[];
  markets: MarketRisk[];
}

export default function OwnerRisk() {
  const [data, setData] = useState<RiskData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get("/api/owner/risk");
      setData(res);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <PageTitle title="Exposição / Risco" subtitle="Cupons aceitos em aberto por evento e por mercado" />
      {error && <Alert kind="error">{error}</Alert>}
      {loading && <p>Carregando...</p>}
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1rem" }}>
            <Card title="Cupons abertos">
              <div style={{ fontSize: "2rem", fontWeight: 700 }}>{data.totals.openCoupons}</div>
              <div style={{ color: "var(--text-dim)", fontSize: "0.875rem" }}>Stake: {formatBRL(data.totals.stakeCents)}</div>
            </Card>
            <Card title="Responsabilidade potencial">
              <div style={{ fontSize: "2rem", fontWeight: 700 }}>{formatBRL(data.totals.potentialCents)}</div>
              <div style={{ color: "var(--text-dim)", fontSize: "0.875rem" }}>Se todos ganharem</div>
            </Card>
            <Card title="Prêmios a pagar">
              <div style={{ fontSize: "2rem", fontWeight: 700 }}>{formatBRL(data.totals.unpaidPrizesCents)}</div>
              <div style={{ color: "var(--text-dim)", fontSize: "0.875rem" }}>{data.totals.unpaidPrizesCount} cupom(ns) ganho(s) não pagos</div>
            </Card>
          </div>

          <Card title="Por evento">
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                    <th style={{ padding: "0.5rem" }}>Evento</th>
                    <th style={{ padding: "0.5rem" }}>Início</th>
                    <th style={{ padding: "0.5rem", textAlign: "right" }}>Cupons</th>
                    <th style={{ padding: "0.5rem", textAlign: "right" }}>Stake</th>
                    <th style={{ padding: "0.5rem", textAlign: "right" }}>Potencial</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((e) => (
                    <tr key={e.fixtureId} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "0.5rem" }}>{e.event}</td>
                      <td style={{ padding: "0.5rem", color: "var(--text-dim)" }}>{e.kickoffAt ? new Date(e.kickoffAt).toLocaleString("pt-BR") : "-"}</td>
                      <td style={{ padding: "0.5rem", textAlign: "right" }}>{e.coupons}</td>
                      <td style={{ padding: "0.5rem", textAlign: "right" }}>{formatBRL(e.stakeCents)}</td>
                      <td style={{ padding: "0.5rem", textAlign: "right" }}>{formatBRL(e.potentialCents)}</td>
                    </tr>
                  ))}
                  {data.events.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ padding: "0.75rem", color: "var(--text-dim)" }}>Sem cupons aceitos em aberto.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Por mercado">
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                    <th style={{ padding: "0.5rem" }}>Mercado</th>
                    <th style={{ padding: "0.5rem", textAlign: "right" }}>Seleções</th>
                    <th style={{ padding: "0.5rem", textAlign: "right" }}>Potencial</th>
                  </tr>
                </thead>
                <tbody>
                  {data.markets.map((m) => (
                    <tr key={m.marketKey} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "0.5rem" }}>{m.marketName}</td>
                      <td style={{ padding: "0.5rem", textAlign: "right" }}>{m.selections}</td>
                      <td style={{ padding: "0.5rem", textAlign: "right" }}>{formatBRL(m.potentialCents)}</td>
                    </tr>
                  ))}
                  {data.markets.length === 0 && (
                    <tr>
                      <td colSpan={3} style={{ padding: "0.75rem", color: "var(--text-dim)" }}>Sem dados.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <div>
            <Button onClick={load}>Atualizar</Button>
          </div>
        </div>
      )}
    </div>
  );
}
