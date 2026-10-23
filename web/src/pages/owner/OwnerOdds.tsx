import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Alert, Button, Card, Input, PageTitle } from "../../components/ui";

interface OddItem {
  key: string;
  name: string;
  odd: number;
}

interface EventItem {
  id: number;
  home: string;
  away: string;
  competition: string | null;
  kickoffAt: string;
  status: string;
  manual: { marketId: number; suspended: boolean; selections: OddItem[] } | null;
  providerOdds: OddItem[];
}

interface ProviderInfo {
  id: string | null;
  label: string | null;
  isDemo: boolean;
  available: boolean;
  reason: string | null;
}

function oddOf(list: OddItem[], key: string): string {
  const found = list.find((s) => s.key === key);
  return found ? String(found.odd) : "";
}

function EventRow({ ev, onChanged }: { ev: EventItem; onChanged: () => void }) {
  const base = ev.manual?.selections?.length ? ev.manual.selections : ev.providerOdds;
  const [home, setHome] = useState(() => oddOf(base, "home"));
  const [draw, setDraw] = useState(() => oddOf(base, "draw"));
  const [away, setAway] = useState(() => oddOf(base, "away"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save() {
    setError(null);
    setNotice(null);
    const values = [Number(home.replace(",", ".")), Number(draw.replace(",", ".")), Number(away.replace(",", "."))];
    if (values.some((v) => !Number.isFinite(v) || v < 1.01)) {
      setError("Informe as três odds (mínimo 1.01).");
      return;
    }
    setBusy(true);
    try {
      await api.put(`/api/owner/events/${ev.id}/odds`, { home: values[0], draw: values[1], away: values[2] });
      setNotice("Odds salvas.");
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.delete(`/api/owner/events/${ev.id}/odds`);
      setNotice("Odds manuais removidas.");
      setHome("");
      setDraw("");
      setAway("");
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const manual = Boolean(ev.manual);
  const source = manual ? "Manual" : ev.providerOdds.length ? "Provedor" : "Sem odds";

  return (
    <div style={{ borderBottom: "1px solid var(--border)", padding: "0.9rem 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
            {ev.competition ?? "Competição"} · {new Date(ev.kickoffAt).toLocaleString("pt-BR")}
            {ev.status === "live" ? " · AO VIVO" : ""}
          </div>
          <div style={{ fontWeight: 600 }}>
            {ev.home} x {ev.away}
          </div>
        </div>
        <span
          style={{
            alignSelf: "flex-start",
            fontSize: "0.75rem",
            padding: "0.15rem 0.5rem",
            borderRadius: "999px",
            border: "1px solid var(--border)",
            color: manual ? "var(--accent)" : "var(--text-dim)",
          }}
        >
          {source}
        </span>
      </div>

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
          Mandante
          <Input value={home} onChange={(e) => setHome(e.target.value)} inputMode="decimal" placeholder="1.85" style={{ width: "90px" }} />
        </label>
        <label style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
          Empate
          <Input value={draw} onChange={(e) => setDraw(e.target.value)} inputMode="decimal" placeholder="3.40" style={{ width: "90px" }} />
        </label>
        <label style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
          Visitante
          <Input value={away} onChange={(e) => setAway(e.target.value)} inputMode="decimal" placeholder="4.20" style={{ width: "90px" }} />
        </label>
        <Button onClick={save} disabled={busy || ev.status !== "scheduled"}>
          {busy ? "Salvando..." : "Salvar"}
        </Button>
        {manual && (
          <Button onClick={remove} disabled={busy} style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--text)" }}>
            Remover
          </Button>
        )}
        {notice && <span style={{ fontSize: "0.75rem", color: "var(--accent)" }}>{notice}</span>}
        {error && <span style={{ fontSize: "0.75rem", color: "#f87171" }}>{error}</span>}
      </div>
    </div>
  );
}

export default function OwnerOdds() {
  const [provider, setProvider] = useState<ProviderInfo | null>(null);
  const [items, setItems] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get("/api/owner/events?hours=72");
      setProvider(res.provider ?? null);
      setItems(res.items ?? []);
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
      <PageTitle
        title="Odds dos jogos"
        subtitle="Defina as odds de Resultado Final (mandante, empate e visitante) dos jogos reais. As odds manuais valem até você alterá-las ou o jogo começar."
      />

      {error && <Alert>{error}</Alert>}

      {provider && (
        <Alert kind={provider.available ? "info" : "error"}>
          <strong>Provedor:</strong> {provider.label ?? "nenhum"} —{" "}
          {provider.reason
            ? provider.reason
            : provider.id
              ? "eventos sendo atualizados automaticamente."
              : "sem provedor configurado."}
        </Alert>
      )}

      <Card title={`Próximos jogos (${items.length})`}>
        {loading ? (
          <div style={{ color: "var(--text-dim)" }}>Carregando...</div>
        ) : items.length === 0 ? (
          <div style={{ color: "var(--text-dim)" }}>
            Nenhum jogo nas próximas 72 horas. Verifique se o provedor está sincronizando (Admin → Provedores).
          </div>
        ) : (
          items.map((ev) => <EventRow key={ev.id} ev={ev} onChanged={load} />)
        )}
      </Card>
    </div>
  );
}
