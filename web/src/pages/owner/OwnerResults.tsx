import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Alert, Button, Card, Input, PageTitle } from "../../components/ui";

interface ResultItem {
  id: number;
  home: string;
  away: string;
  competition: string | null;
  kickoffAt: string;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  cardsTotal: number | null;
  cornersTotal: number | null;
  shotsOnGoalTotal: number | null;
  resultFinal: boolean;
  resultedAt: string | null;
  resultNote: string | null;
  openCoupons: number;
}

interface FormState {
  homeScore: string;
  awayScore: string;
  cardsTotal: string;
  cornersTotal: string;
  shotsOnGoalTotal: string;
  note: string;
  void: boolean;
}

function initialForm(item: ResultItem): FormState {
  return {
    homeScore: item.homeScore !== null ? String(item.homeScore) : "",
    awayScore: item.awayScore !== null ? String(item.awayScore) : "",
    cardsTotal: item.cardsTotal !== null ? String(item.cardsTotal) : "",
    cornersTotal: item.cornersTotal !== null ? String(item.cornersTotal) : "",
    shotsOnGoalTotal: item.shotsOnGoalTotal !== null ? String(item.shotsOnGoalTotal) : "",
    note: item.resultNote ?? "",
    void: item.status === "cancelled",
  };
}

export default function OwnerResults() {
  const [items, setItems] = useState<ResultItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState<Record<number, FormState>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get("/api/owner/events/results?hours=72");
      setItems(data.items);
      const next: Record<number, FormState> = {};
      for (const item of data.items) {
        next[item.id] = initialForm(item);
      }
      setForm(next);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function setField(id: number, patch: Partial<FormState>) {
    setForm((prev) => ({ ...prev, [id]: { ...(prev[id] ?? initialForm(items.find((i) => i.id === id) as ResultItem)), ...patch } }));
  }

  async function submit(id: number) {
    const f = form[id];
    if (!f) return;
    setSaving(id);
    setError(null);
    setMessage(null);
    try {
      const payload: any = { note: f.note.trim() || undefined, void: f.void };
      if (!f.void) {
        payload.homeScore = Number(f.homeScore);
        payload.awayScore = Number(f.awayScore);
      }
      if (f.cardsTotal.trim()) payload.cardsTotal = Number(f.cardsTotal);
      if (f.cornersTotal.trim()) payload.cornersTotal = Number(f.cornersTotal);
      if (f.shotsOnGoalTotal.trim()) payload.shotsOnGoalTotal = Number(f.shotsOnGoalTotal);

      const res = await api.put(`/api/owner/events/${id}/result`, payload);
      const s = res.settlement;
      const others = Number(res.otherOwnersCouponsSettled ?? 0);
      setMessage(
        `Resultado salvo. Cupons liquidados: ${s.won} ganhos / ${s.lost} perdidos / ${s.voided} anulados; ${s.pending} seguem pendentes.` +
          (others > 0
            ? ` ${others} cupom(ns) de outros proprietários também foram processados.`
            : "")
      );
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div>
      <PageTitle title="Resultados" subtitle="Informe o placar e liquida cupons aceitos automaticamente" />
      {error && <Alert kind="error">{error}</Alert>}
      {message && <Alert kind="success">{message}</Alert>}
      {loading && <p>Carregando...</p>}
      {!loading && items.length === 0 && <Alert kind="info">Nenhum jogo recente para apurar.</Alert>}
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {items.map((item) => {
          const f = form[item.id] ?? initialForm(item);
          const kickoff = new Date(item.kickoffAt).toLocaleString("pt-BR");
          return (
            <Card key={item.id} title={`${item.home} x ${item.away}`}>
              <div style={{ color: "var(--text-dim)", fontSize: "0.875rem", marginBottom: "0.75rem" }}>{item.competition ?? ""} • {kickoff} • {item.openCoupons} cupom(ns) aceito(s)</div>
              {item.resultFinal ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <div style={{ fontWeight: 600 }}>
                    {item.status === "cancelled" ? "Jogo anulado" : `Placar: ${item.homeScore} x ${item.awayScore}`}
                  </div>
                  <div style={{ color: "var(--text-dim)", fontSize: "0.875rem" }}>
                    Cartões: {item.cardsTotal ?? "—"} • Escanteios: {item.cornersTotal ?? "—"} • Chutes a gol: {item.shotsOnGoalTotal ?? "—"}
                  </div>
                  {item.resultNote && <div style={{ color: "var(--text-dim)", fontSize: "0.875rem" }}>{item.resultNote}</div>}
                  <div style={{ color: "var(--text-dim)", fontSize: "0.875rem" }}>Encerrado e liquidado</div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <input type="checkbox" checked={f.void} onChange={(e) => setField(item.id, { void: e.target.checked })} />
                    <span>Evento anulado / adiado</span>
                  </label>
                  {!f.void && (
                    <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "end" }}>
                      <div>
                        <div style={{ fontSize: "0.875rem", marginBottom: "0.25rem" }}>{item.home}</div>
                        <Input type="number" min={0} value={f.homeScore} onChange={(e) => setField(item.id, { homeScore: e.target.value })} style={{ width: "80px" }} />
                      </div>
                      <div style={{ paddingBottom: "0.25rem" }}>x</div>
                      <div>
                        <div style={{ fontSize: "0.875rem", marginBottom: "0.25rem" }}>{item.away}</div>
                        <Input type="number" min={0} value={f.awayScore} onChange={(e) => setField(item.id, { awayScore: e.target.value })} style={{ width: "80px" }} />
                      </div>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontSize: "0.875rem", marginBottom: "0.25rem" }}>Cartões (total)</div>
                      <Input type="number" min={0} value={f.cardsTotal} onChange={(e) => setField(item.id, { cardsTotal: e.target.value })} placeholder="opcional" style={{ width: "110px" }} />
                    </div>
                    <div>
                      <div style={{ fontSize: "0.875rem", marginBottom: "0.25rem" }}>Escanteios (total)</div>
                      <Input type="number" min={0} value={f.cornersTotal} onChange={(e) => setField(item.id, { cornersTotal: e.target.value })} placeholder="opcional" style={{ width: "110px" }} />
                    </div>
                    <div>
                      <div style={{ fontSize: "0.875rem", marginBottom: "0.25rem" }}>Chutes a gol (total)</div>
                      <Input type="number" min={0} value={f.shotsOnGoalTotal} onChange={(e) => setField(item.id, { shotsOnGoalTotal: e.target.value })} placeholder="opcional" style={{ width: "130px" }} />
                    </div>
                  </div>
                  <Input value={f.note} onChange={(e) => setField(item.id, { note: e.target.value })} placeholder="Observação (opcional)" />
                  <div>
                    <Button onClick={() => submit(item.id)} disabled={saving === item.id}>
                      {saving === item.id ? "Salvando e liquidando..." : "Salvar e liquidar cupons"}
                    </Button>
                  </div>
                  <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>
                    * Sem placar para "cartões/escanteios/chutes", as apostas nesses mercados ficam pendentes e precisam liquidação manual.
                    {" "}O resultado é irreversível e afeta os cupons de todos os proprietários que usaram este evento.
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
