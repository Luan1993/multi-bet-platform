import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Alert, Button, Card, Input, PageTitle } from "../../components/ui";

interface OddItem {
  key: string;
  name: string;
  odd: number;
}

interface MarketData {
  marketId?: number;
  marketKey: string;
  name: string;
  suspended?: boolean;
  selections: OddItem[];
}

interface EventItem {
  id: number;
  home: string;
  away: string;
  competition: string | null;
  kickoffAt: string;
  status: string;
  manualMarkets: MarketData[];
  providerMarkets: MarketData[];
}

interface ProviderInfo {
  id: string | null;
  label: string | null;
  isDemo: boolean;
  available: boolean;
  reason: string | null;
}

interface WinnerState {
  enabled: boolean;
  home: string;
  draw: string;
  away: string;
}

interface OuState {
  enabled: boolean;
  line: string;
  over: string;
  under: string;
}

interface OuDef {
  marketKey: string;
  name: string;
  unit: string;
  defaultLine: string;
}

/** Mercados de total (Mais/Menos) que o proprietário pode definir manualmente. */
const OU_DEFS: OuDef[] = [
  { marketKey: "goals_over_under", name: "Total de Gols", unit: "gols", defaultLine: "2.5" },
  { marketKey: "cards_over_under", name: "Total de Cartões", unit: "cartões", defaultLine: "4.5" },
  { marketKey: "corners_over_under", name: "Total de Escanteios", unit: "escanteios", defaultLine: "9.5" },
  {
    marketKey: "shots_on_goal_over_under",
    name: "Chutes a Gol",
    unit: "chutes a gol",
    defaultLine: "9.5",
  },
];

function oddOf(list: OddItem[], key: string): string {
  const found = list.find((s) => s.key === key);
  return found ? String(found.odd) : "";
}

function toNumber(value: string): number {
  return Number(value.trim().replace(",", "."));
}

function validOdd(value: number): boolean {
  return Number.isFinite(value) && value >= 1.01 && value <= 1000;
}

function findOuPair(
  selections: OddItem[],
  preferredLine: number
): { line: string; over: string; under: string } | null {
  const byLine = new Map<string, { over?: string; under?: string }>();
  for (const sel of selections) {
    const m = /^(over|under)_(\d+(?:\.\d+)?)$/.exec(sel.key);
    if (!m) continue;
    const entry = byLine.get(m[2]) ?? {};
    entry[m[1] as "over" | "under"] = String(sel.odd);
    byLine.set(m[2], entry);
  }
  const pairs = [...byLine.entries()].filter(([, v]) => v.over && v.under);
  if (pairs.length === 0) return null;
  pairs.sort(
    (a, b) => Math.abs(Number(a[0]) - preferredLine) - Math.abs(Number(b[0]) - preferredLine)
  );
  const [line, value] = pairs[0];
  return { line, over: value.over!, under: value.under! };
}

function initialWinner(ev: EventItem): WinnerState {
  const manual = ev.manualMarkets.find((m) => m.marketKey === "match_winner");
  const provider = ev.providerMarkets.find((m) => m.marketKey === "match_winner");
  const source = manual ?? provider;
  return {
    enabled: Boolean(manual),
    home: source ? oddOf(source.selections, "home") : "",
    draw: source ? oddOf(source.selections, "draw") : "",
    away: source ? oddOf(source.selections, "away") : "",
  };
}

function initialOu(ev: EventItem, def: OuDef): OuState {
  const manual = ev.manualMarkets.find((m) => m.marketKey === def.marketKey);
  const provider = ev.providerMarkets.find((m) => m.marketKey === def.marketKey);
  const source = manual ?? provider;
  const pair = source ? findOuPair(source.selections, Number(def.defaultLine)) : null;
  return {
    enabled: Boolean(manual),
    line: pair?.line ?? def.defaultLine,
    over: pair?.over ?? "",
    under: pair?.under ?? "",
  };
}

function hasManual(ev: EventItem, marketKey: string): boolean {
  return ev.manualMarkets.some((m) => m.marketKey === marketKey);
}

function hasProvider(ev: EventItem, marketKey: string): boolean {
  return ev.providerMarkets.some((m) => m.marketKey === marketKey);
}

function EventRow({ ev, onChanged }: { ev: EventItem; onChanged: () => void }) {
  const [winner, setWinner] = useState<WinnerState>(() => initialWinner(ev));
  const [ous, setOus] = useState<Record<string, OuState>>(() =>
    Object.fromEntries(OU_DEFS.map((def) => [def.marketKey, initialOu(ev, def)]))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const editable = ev.status === "scheduled";
  const manualCount =
    (winner.enabled ? 1 : 0) + OU_DEFS.filter((def) => ous[def.marketKey]?.enabled).length;
  const source =
    manualCount > 0
      ? `Manual (${manualCount})`
      : ev.providerMarkets.length > 0
        ? "Provedor"
        : "Sem odds";

  function patchOu(marketKey: string, patch: Partial<OuState>) {
    setOus((prev) => ({ ...prev, [marketKey]: { ...prev[marketKey], ...patch } }));
  }

  async function save() {
    setError(null);
    setNotice(null);
    const markets: Array<{ marketKey: string; selections: Array<{ key: string; odd: number }> }> = [];
    const problems: string[] = [];

    if (winner.enabled) {
      const home = toNumber(winner.home);
      const draw = toNumber(winner.draw);
      const away = toNumber(winner.away);
      if (!validOdd(home) || !validOdd(draw) || !validOdd(away)) {
        problems.push("Resultado Final: informe as três odds (1.01 a 1000).");
      } else {
        markets.push({
          marketKey: "match_winner",
          selections: [
            { key: "home", odd: home },
            { key: "draw", odd: draw },
            { key: "away", odd: away },
          ],
        });
      }
    }

    for (const def of OU_DEFS) {
      const state = ous[def.marketKey];
      if (!state?.enabled) continue;
      const line = toNumber(state.line);
      const over = toNumber(state.over);
      const under = toNumber(state.under);
      if (!Number.isFinite(line) || line <= 0 || line > 20) {
        problems.push(`${def.name}: informe uma linha válida (ex.: ${def.defaultLine}).`);
      } else if (!validOdd(over) || !validOdd(under)) {
        problems.push(`${def.name}: informe as odds de "Mais" e "Menos" (1.01 a 1000).`);
      } else {
        markets.push({
          marketKey: def.marketKey,
          selections: [
            { key: `over_${line}`, odd: over },
            { key: `under_${line}`, odd: under },
          ],
        });
      }
    }

    if (problems.length > 0) {
      setError(problems.join(" "));
      return;
    }

    if (
      markets.length === 0 &&
      manualCount === 0 &&
      !window.confirm("Nenhum mercado marcado. As odds manuais existentes serão removidas. Continuar?")
    ) {
      return;
    }

    setBusy(true);
    try {
      await api.put(`/api/owner/events/${ev.id}/odds`, { markets });
      setNotice(markets.length > 0 ? "Odds manuais salvas." : "Odds manuais removidas.");
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
      setWinner({ enabled: false, home: "", draw: "", away: "" });
      setOus(
        Object.fromEntries(
          OU_DEFS.map((def) => [
            def.marketKey,
            { enabled: false, line: def.defaultLine, over: "", under: "" },
          ])
        )
      );
      setNotice("Odds manuais removidas.");
      onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ borderBottom: "1px solid var(--border)", padding: "0.9rem 0" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: "0.6rem",
        }}
      >
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
            color: manualCount > 0 ? "var(--accent)" : "var(--text-dim)",
          }}
        >
          {source}
        </span>
      </div>

      <div style={{ display: "grid", gap: "0.6rem" }}>
        <div style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.6rem 0.7rem" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 600, fontSize: "0.85rem" }}>
            <input
              type="checkbox"
              checked={winner.enabled}
              disabled={!editable || busy}
              onChange={(e) => setWinner((prev) => ({ ...prev, enabled: e.target.checked }))}
            />
            Resultado Final
            <span style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontWeight: 400 }}>
              {hasManual(ev, "match_winner")
                ? "manual"
                : hasProvider(ev, "match_winner")
                  ? "provedor"
                  : "sem odds"}
            </span>
          </label>
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              alignItems: "flex-end",
              flexWrap: "wrap",
              marginTop: "0.45rem",
              opacity: winner.enabled ? 1 : 0.55,
            }}
          >
            <label style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
              Mandante
              <Input
                value={winner.home}
                onChange={(e) => setWinner((prev) => ({ ...prev, home: e.target.value }))}
                inputMode="decimal"
                placeholder="1.85"
                disabled={!winner.enabled || busy}
                style={{ width: "90px" }}
              />
            </label>
            <label style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
              Empate
              <Input
                value={winner.draw}
                onChange={(e) => setWinner((prev) => ({ ...prev, draw: e.target.value }))}
                inputMode="decimal"
                placeholder="3.40"
                disabled={!winner.enabled || busy}
                style={{ width: "90px" }}
              />
            </label>
            <label style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
              Visitante
              <Input
                value={winner.away}
                onChange={(e) => setWinner((prev) => ({ ...prev, away: e.target.value }))}
                inputMode="decimal"
                placeholder="4.20"
                disabled={!winner.enabled || busy}
                style={{ width: "90px" }}
              />
            </label>
          </div>
        </div>

        {OU_DEFS.map((def) => {
          const state = ous[def.marketKey];
          return (
            <div
              key={def.marketKey}
              style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.6rem 0.7rem" }}
            >
              <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 600, fontSize: "0.85rem" }}>
                <input
                  type="checkbox"
                  checked={state?.enabled ?? false}
                  disabled={!editable || busy}
                  onChange={(e) => patchOu(def.marketKey, { enabled: e.target.checked })}
                />
                {def.name}
                <span style={{ fontSize: "0.7rem", color: "var(--text-dim)", fontWeight: 400 }}>
                  {hasManual(ev, def.marketKey)
                    ? "manual"
                    : hasProvider(ev, def.marketKey)
                      ? "provedor"
                      : "sem odds"}
                </span>
              </label>
              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "flex-end",
                  flexWrap: "wrap",
                  marginTop: "0.45rem",
                  opacity: state?.enabled ? 1 : 0.55,
                }}
              >
                <label style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
                  Linha
                  <Input
                    value={state?.line ?? def.defaultLine}
                    onChange={(e) => patchOu(def.marketKey, { line: e.target.value })}
                    inputMode="decimal"
                    placeholder={def.defaultLine}
                    disabled={!state?.enabled || busy}
                    style={{ width: "80px" }}
                  />
                </label>
                <label style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
                  Mais de {state?.line || def.defaultLine}
                  <Input
                    value={state?.over ?? ""}
                    onChange={(e) => patchOu(def.marketKey, { over: e.target.value })}
                    inputMode="decimal"
                    placeholder="1.90"
                    disabled={!state?.enabled || busy}
                    style={{ width: "90px" }}
                  />
                </label>
                <label style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
                  Menos de {state?.line || def.defaultLine}
                  <Input
                    value={state?.under ?? ""}
                    onChange={(e) => patchOu(def.marketKey, { under: e.target.value })}
                    inputMode="decimal"
                    placeholder="1.90"
                    disabled={!state?.enabled || busy}
                    style={{ width: "90px" }}
                  />
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginTop: "0.65rem" }}>
        <Button onClick={save} disabled={busy || !editable}>
          {busy ? "Salvando..." : "Salvar"}
        </Button>
        {ev.manualMarkets.length > 0 && (
          <Button
            onClick={remove}
            disabled={busy}
            style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--text)" }}
          >
            Remover manuais
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
        subtitle="Marque os mercados que deseja definir manualmente: Resultado Final, Total de Gols, Cartões, Escanteios e Chutes a Gol. Os mercados não marcados usam as odds automáticas do provedor. As odds manuais valem até você alterá-las ou o jogo começar."
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
