import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";

interface Selection {
  id: number;
  key: string;
  name: string;
  odd: number;
  conflictsWith?: number[];
}

interface Market {
  id: number;
  key: string;
  name: string;
  suspended: boolean;
  singlePick?: boolean;
  selections: Selection[];
}

interface EventItem {
  id: number;
  fixtureId: string;
  competition: { name: string; country: string | null; logoUrl: string | null; season: string | null };
  home: { name: string; logoUrl: string | null };
  away: { name: string; logoUrl: string | null };
  kickoffAt: string;
  status: string;
  markets: Market[];
}

interface PickedSelection {
  selection: Selection;
  event: EventItem;
  marketName: string;
}

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function onlyDigits(v: string): string {
  return (v || "").replace(/\D/g, "");
}

function statusColor(status: string): string {
  switch (status) {
    case "accepted":
      return "#22c55e";
    case "won":
      return "#4ade80";
    case "lost":
      return "#f87171";
    case "pending":
      return "#fbbf24";
    default:
      return "var(--text-dim)";
  }
}

export default function PublicBet() {
  const { slug } = useParams();
  const [loading, setLoading] = useState(true);
  const [owner, setOwner] = useState<any>(null);
  const [meta, setMeta] = useState<any>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [selections, setSelections] = useState<Map<number, PickedSelection>>(new Map());
  const [stake, setStake] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [coupon, setCoupon] = useState<any>(null);
  const [clientPhone, setClientPhone] = useState("");
  const [myPhone, setMyPhone] = useState("");
  const [myCoupons, setMyCoupons] = useState<Array<any> | null>(null);
  const [myLoading, setMyLoading] = useState(false);
  const [myError, setMyError] = useState<string | null>(null);
  const [leagueFilter, setLeagueFilter] = useState<string>("all");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .get(`/api/bet/${slug}`)
      .then((res) => {
        if (!alive) return;
        setOwner(res.owner);
        setMeta(res.meta);
        setEvents(res.events || []);
      })
      .catch((err) => alive && setError(err.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [slug]);

  const leagues = useMemo(() => {
    const set = new Set<string>();
    for (const ev of events) {
      if (ev.competition?.name) set.add(ev.competition.name);
    }
    return Array.from(set).sort();
  }, [events]);

  const filteredEvents = useMemo(
    () => (leagueFilter === "all" ? events : events.filter((ev) => ev.competition?.name === leagueFilter)),
    [events, leagueFilter]
  );

  const totalOdd = useMemo(() => {
    const raw = Array.from(selections.values()).reduce((acc, p) => acc * p.selection.odd, 1);
    return Math.round(raw * 10000) / 10000;
  }, [selections]);

  const limits = meta?.limits;
  const stakeCents = Math.round(stake * 100);
  const payoutCents = Math.round(stakeCents * totalOdd);
  const limitExceeded = Boolean(limits?.maxPayoutCents && payoutCents > limits.maxPayoutCents);

  const stakeError = useMemo(() => {
    if (!limits || stakeCents <= 0) return null;
    if (limits.minStakeCents && stakeCents < limits.minStakeCents) {
      return `A aposta mínima é ${brl(limits.minStakeCents)}.`;
    }
    if (limits.maxStakeCents && stakeCents > limits.maxStakeCents) {
      return `A aposta máxima é ${brl(limits.maxStakeCents)}.`;
    }
    return null;
  }, [limits, stakeCents]);

  function toggleSelection(picked: PickedSelection) {
    const next = new Map(selections);
    if (next.has(picked.selection.id)) {
      next.delete(picked.selection.id);
      setNotice(null);
    } else {
      // Mercados têm seleções incompatíveis (ex.: "Mais de 1.5" e "Menos de 1.5"
      // no Total de Gols): escolher uma substitui automaticamente a outra.
      const replaced: PickedSelection[] = [];
      for (const [id, other] of next) {
        const incompatible =
          (picked.selection.conflictsWith?.includes(other.selection.id) ?? false) ||
          (other.selection.conflictsWith?.includes(picked.selection.id) ?? false);
        if (incompatible) {
          next.delete(id);
          replaced.push(other);
        }
      }
      if (next.size >= 10) {
        setError("Máximo de 10 seleções por cupom.");
        return;
      }
      next.set(picked.selection.id, picked);
      setNotice(
        replaced.length > 0
          ? `Substituída "${replaced[0].selection.name}" do mercado "${replaced[0].marketName}" — o cupom não aceita opções incompatíveis do mesmo mercado.`
          : null
      );
    }
    setSelections(next);
    setCoupon(null);
    setError(null);
  }

  async function createCoupon() {
    setError(null);
    setNotice(null);
    setCreating(true);
    try {
      const selList = Array.from(selections.values()).map((p) => ({
        selectionId: p.selection.id,
        odd: p.selection.odd,
      }));
      const res = await api.post(`/api/bet/${slug}/coupons`, {
        selections: selList,
        stakeCents,
        clientPhone: clientPhone.trim() || undefined,
      });
      setCoupon(res);
      // Se o número informado é o mesmo usado em "Meus jogos", atualiza a lista.
      if (
        clientPhone.trim() &&
        myPhone.trim() &&
        onlyDigits(clientPhone) === onlyDigits(myPhone)
      ) {
        fetchMyGames();
      }
    } catch (err: any) {
      setError(err.message);
      // Odds mudaram ou mercado suspenso: recarrega os eventos e limpa a seleção antiga.
      if (err.code === "odd_changed" || err.code === "market_suspended") {
        try {
          const fresh = await api.get(`/api/bet/${slug}`);
          setEvents(fresh.events ?? []);
          setSelections(new Map());
        } catch {
          /* mantém a mensagem original */
        }
      }
    } finally {
      setCreating(false);
    }
  }

  async function fetchMyGames() {
    const phone = myPhone.trim();
    if (!phone) return;
    setMyError(null);
    setMyLoading(true);
    try {
      const res = await api.get(`/api/bet/${slug}/coupons?phone=${encodeURIComponent(phone)}`);
      setMyCoupons(res.coupons ?? []);
    } catch (err: any) {
      setMyError(err.message || "Não foi possível consultar.");
      setMyCoupons(null);
    } finally {
      setMyLoading(false);
    }
  }

  if (loading) return <div className="loading">Carregando...</div>;

  if (error && !owner) {
    return (
      <div style={{ padding: "3rem", maxWidth: "560px", margin: "0 auto" }}>
        <h1 style={{ fontSize: "1.25rem" }}>Bet indisponível</h1>
        <p style={{ color: "var(--text-dim)" }}>{error}</p>
      </div>
    );
  }

  const brand = owner?.branding || {};
  const light = brand.theme === "light";
  const surface = light ? "rgba(15,23,42,0.04)" : "rgba(255,255,255,0.05)";
  const styleVars = {
    "--primary": brand.primaryColor || "#7c3aed",
    "--accent": brand.accentColor || "#22d3ee",
    "--bg-2": brand.secondaryColor ? `${brand.secondaryColor}ee` : "var(--bg-2)",
    ...(light
      ? {
          "--bg": "#f1f5f9",
          "--bg-2": "#e2e8f0",
          "--panel": "#ffffff",
          "--text": "#0f172a",
          "--text-dim": "#475569",
          "--border": "rgba(15,23,42,0.14)",
        }
      : {}),
  } as React.CSSProperties;

  const canSubmit = selections.size > 0 && stakeCents > 0 && !stakeError && !limitExceeded && !creating;

  return (
    <div style={{ ...styleVars, minHeight: "100%", background: "var(--bg)", color: "var(--text)" }}>
      <header
        style={{
          background: "var(--panel)",
          borderBottom: "1px solid var(--border)",
          padding: "1rem 2rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.85rem" }}>
          {brand.logoPath && (
            <img
              src={brand.logoPath}
              alt=""
              style={{ width: "42px", height: "42px", objectFit: "contain", borderRadius: "8px", background: "rgba(255,255,255,0.06)" }}
            />
          )}
          <div>
            <h1 style={{ margin: 0, fontSize: "1.35rem" }}>{brand.displayName || owner?.name}</h1>
            {brand.tagline && (
              <p style={{ margin: "0.2rem 0 0 0", color: "var(--text-dim)", fontSize: "0.875rem" }}>{brand.tagline}</p>
            )}
          </div>
        </div>
        {meta?.demoMode && (
          <div
            style={{
              background: "rgba(245,158,11,0.2)",
              border: "1px solid rgba(245,158,11,0.5)",
              color: "#fbbf24",
              padding: "0.45rem 0.9rem",
              borderRadius: "6px",
              fontSize: "0.8125rem",
              fontWeight: 600,
            }}
          >
            MODO DEMONSTRAÇÃO — sem apostas reais
          </div>
        )}
      </header>

      <main
        style={{
          maxWidth: "1200px",
          margin: "0 auto",
          padding: "2rem",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 350px",
          gap: "2rem",
          alignItems: "start",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem", gap: "1rem", flexWrap: "wrap" }}>
            <h2 style={{ margin: 0 }}>
              Eventos{" "}
              <span style={{ color: "var(--text-dim)", fontSize: "0.875rem", fontWeight: 400 }}>
                ({filteredEvents.length})
              </span>
            </h2>
            {leagues.length > 0 && (
              <select
                value={leagueFilter}
                onChange={(e) => setLeagueFilter(e.target.value)}
                style={{
                  padding: "0.5rem 0.75rem",
                  background: "var(--panel)",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  color: "var(--text)",
                  maxWidth: "260px",
                }}
              >
                <option value="all">Todas as ligas</option>
                {leagues.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            )}
          </div>

          {filteredEvents.length === 0 && (
            <div
              style={{
                background: "var(--panel)",
                border: "1px solid var(--border)",
                borderRadius: "8px",
                padding: "1.5rem",
                color: "var(--text-dim)",
              }}
            >
              <p style={{ marginTop: 0 }}>Nenhum evento disponível no momento.</p>
              {meta?.provider?.reason && <p style={{ marginBottom: 0, fontSize: "0.8125rem" }}>{meta.provider.reason}</p>}
            </div>
          )}

          {filteredEvents.map((ev) => (
            <div key={ev.id} style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "8px", padding: "1rem", marginBottom: "1rem" }}>
              <div style={{ marginBottom: "1rem", display: "flex", alignItems: "center", gap: "0.75rem" }}>
                {ev.competition?.logoUrl && (
                  <img src={ev.competition.logoUrl} alt="" style={{ width: "24px", height: "24px", objectFit: "contain" }} />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>{ev.competition?.name}</div>
                  <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>
                    {new Date(ev.kickoffAt).toLocaleString("pt-BR")}
                    {ev.competition?.season ? ` · ${ev.competition.season}` : ""}
                  </div>
                </div>
                {ev.status && ev.status !== "scheduled" && (
                  <span style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>{ev.status}</span>
                )}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto minmax(0,1fr)", alignItems: "center", gap: "1rem", marginBottom: "1rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", justifyContent: "flex-end", minWidth: 0 }}>
                  <span style={{ fontWeight: 600, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis" }}>{ev.home.name}</span>
                  {ev.home.logoUrl && <img src={ev.home.logoUrl} alt="" style={{ width: "32px", height: "32px", objectFit: "contain", flexShrink: 0 }} />}
                </div>
                <div style={{ color: "var(--text-dim)", fontSize: "0.875rem" }}>x</div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", minWidth: 0 }}>
                  {ev.away.logoUrl && <img src={ev.away.logoUrl} alt="" style={{ width: "32px", height: "32px", objectFit: "contain", flexShrink: 0 }} />}
                  <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{ev.away.name}</span>
                </div>
              </div>

              {ev.markets.map((m) => (
                <div key={m.id} style={{ marginBottom: "1rem" }}>
                  <div style={{ fontSize: "0.8125rem", color: "var(--text-dim)", marginBottom: "0.5rem" }}>
                    {m.name}
                    {m.suspended ? " — suspenso" : !m.singlePick ? "" : m.selections.length > 1 ? " — escolha apenas 1 opção" : ""}
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    {m.selections.map((sel) => {
                      const active = selections.has(sel.id);
                      return (
                        <button
                          key={sel.id}
                          type="button"
                          onClick={() => toggleSelection({ selection: sel, event: ev, marketName: m.name })}
                          disabled={m.suspended}
                          style={{
                            padding: "0.5rem 0.75rem",
                            background: active ? "var(--primary)" : surface,
                            border: "1px solid " + (active ? "var(--primary)" : "var(--border)"),
                            borderRadius: "6px",
                            color: active ? "#fff" : "var(--text)",
                            cursor: m.suspended ? "not-allowed" : "pointer",
                            opacity: m.suspended ? 0.45 : 1,
                            minWidth: "88px",
                          }}
                        >
                          <div style={{ fontSize: "0.75rem", opacity: 0.85 }}>{sel.name}</div>
                          <div style={{ fontWeight: 600 }}>{Number(sel.odd).toFixed(2)}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {ev.markets.length === 0 && (
                <div style={{ fontSize: "0.8125rem", color: "var(--text-dim)" }}>
                  Odds indisponíveis para esta partida no momento.
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ position: "sticky", top: "1rem", alignSelf: "start" }}>
          <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "8px", padding: "1.5rem" }}>
            <h3 style={{ margin: "0 0 1rem 0" }}>Cupom</h3>

            {selections.size === 0 ? (
              <p style={{ color: "var(--text-dim)", marginTop: 0 }}>Selecione ao menos uma opção nas partidas ao lado.</p>
            ) : (
              <>
                <div style={{ marginBottom: "1rem", maxHeight: "210px", overflowY: "auto" }}>
                  {Array.from(selections.values()).map((p) => (
                    <div key={p.selection.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                        <div style={{ fontSize: "0.8125rem", fontWeight: 600, minWidth: 0 }}>
                          {p.event.home.name} x {p.event.away.name}
                        </div>
                        <button
                          type="button"
                          onClick={() => toggleSelection(p)}
                          title="Remover seleção"
                          style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", padding: 0 }}
                        >
                          ✕
                        </button>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", color: "var(--text-dim)", fontSize: "0.75rem" }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {p.marketName} — {p.selection.name}
                        </span>
                        <span style={{ fontWeight: 600 }}>{p.selection.odd.toFixed(2)}</span>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ marginBottom: "1rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                    <span style={{ color: "var(--text-dim)" }}>Odd combinada</span>
                    <span style={{ fontWeight: 600 }}>{totalOdd.toFixed(2)}</span>
                  </div>

                  <label style={{ display: "block", marginBottom: "0.35rem", color: "var(--text-dim)", fontSize: "0.875rem" }}>
                    Valor (R$)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min={limits ? limits.minStakeCents / 100 : 0}
                    max={limits ? limits.maxStakeCents / 100 : undefined}
                    value={stake || ""}
                    onChange={(e) => {
                      setStake(parseFloat(e.target.value) || 0);
                      setCoupon(null);
                    }}
                    style={{
                      width: "100%",
                      padding: "0.5rem",
                      background: surface,
                      border: "1px solid var(--border)",
                      borderRadius: "6px",
                      color: "var(--text)",
                    }}
                  />
                  {limits && (
                    <div style={{ color: "var(--text-dim)", fontSize: "0.75rem", marginTop: "0.25rem" }}>
                      Mínimo {brl(limits.minStakeCents)} · máximo {brl(limits.maxStakeCents)}
                    </div>
                  )}

                  <label style={{ display: "block", marginTop: "0.75rem", marginBottom: "0.35rem", color: "var(--text-dim)", fontSize: "0.875rem" }}>
                    WhatsApp (opcional)
                  </label>
                  <input
                    type="tel"
                    value={clientPhone}
                    onChange={(e) => setClientPhone(e.target.value)}
                    placeholder="Ex.: (11) 91234-5678"
                    style={{
                      width: "100%",
                      padding: "0.5rem",
                      background: surface,
                      border: "1px solid var(--border)",
                      borderRadius: "6px",
                      color: "var(--text)",
                    }}
                  />

                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: "1rem", gap: "0.5rem" }}>
                    <span style={{ color: "var(--text-dim)" }}>Retorno potencial</span>
                    <span
                      style={{
                        fontWeight: 700,
                        fontSize: "1.125rem",
                        color: limitExceeded ? "#fca5a5" : "var(--success)",
                        textAlign: "right",
                      }}
                    >
                      {brl(payoutCents)}
                    </span>
                  </div>
                  {limits?.maxPayoutCents && (
                    <div style={{ color: limitExceeded ? "#fca5a5" : "var(--text-dim)", fontSize: "0.75rem", textAlign: "right" }}>
                      Teto de retorno: {brl(limits.maxPayoutCents)}
                    </div>
                  )}
                </div>

                {notice && !stakeError && (
                  <div style={{ background: "rgba(56,189,248,0.1)", border: "1px solid rgba(56,189,248,0.4)", color: "#7dd3fc", padding: "0.7rem", borderRadius: "6px", marginBottom: "1rem", fontSize: "0.8125rem" }}>
                    {notice}
                  </div>
                )}

                {stakeError && (
                  <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.4)", color: "#fca5a5", padding: "0.7rem", borderRadius: "6px", marginBottom: "1rem", fontSize: "0.8125rem" }}>
                    {stakeError}
                  </div>
                )}

                {limitExceeded && (
                  <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.4)", color: "#fca5a5", padding: "0.7rem", borderRadius: "6px", marginBottom: "1rem", fontSize: "0.8125rem" }}>
                    O retorno potencial excede o limite de {brl(limits.maxPayoutCents)} por cupom. Reduza o valor da aposta.
                  </div>
                )}

                {error && (
                  <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.4)", color: "#fca5a5", padding: "0.75rem", borderRadius: "6px", marginBottom: "1rem", fontSize: "0.875rem" }}>
                    {error}
                  </div>
                )}

                {!coupon ? (
                  <button
                    type="button"
                    onClick={createCoupon}
                    disabled={!canSubmit}
                    style={{
                      width: "100%",
                      padding: "0.75rem",
                      background: "var(--primary)",
                      border: "none",
                      borderRadius: "6px",
                      color: "#fff",
                      fontWeight: 600,
                      cursor: canSubmit ? "pointer" : "not-allowed",
                      opacity: canSubmit ? 1 : 0.5,
                    }}
                  >
                    {creating ? "Gerando..." : "Gerar pré-cupom"}
                  </button>
                ) : (
                  <div style={{ background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.4)", borderRadius: "6px", padding: "1rem" }}>
                    <div style={{ color: "var(--success)", fontWeight: 600, marginBottom: "0.5rem" }}>Pré-cupom criado</div>
                    <div style={{ fontSize: "1.25rem", fontWeight: 700, letterSpacing: "1px", marginBottom: "0.5rem", wordBreak: "break-all" }}>
                      {coupon.code}
                    </div>
                    <div style={{ fontSize: "0.875rem", color: "var(--text-dim)", marginBottom: "0.35rem" }}>{coupon.statusLabel}</div>
                    <div style={{ fontSize: "0.875rem", color: "var(--text-dim)" }}>
                      Válido até {new Date(coupon.expiresAt).toLocaleString("pt-BR")}
                    </div>
                    {coupon.limitAppliedCents && (
                      <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.5rem" }}>
                        Limite de retorno aplicado: {brl(coupon.limitAppliedCents)}
                      </div>
                    )}
                    {coupon.receiptUrl && (
                      <a
                        href={`/recibo/${coupon.code}`}
                        style={{ display: "inline-block", marginTop: "0.75rem", color: "var(--accent)", fontSize: "0.875rem" }}
                      >
                        Ver recibo digital →
                      </a>
                    )}
                    {coupon.disclaimer && (
                      <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.75rem", lineHeight: 1.4 }}>
                        {coupon.disclaimer}
                      </div>
                    )}
                  </div>
                )}

                <p style={{ color: "var(--text-dim)", fontSize: "0.75rem", marginBottom: 0, marginTop: "1rem", lineHeight: 1.4 }}>
                  O pré-cupom é confirmado pelo proprietário da bet após revalidação das odds no servidor.
                </p>
              </>
            )}
          </div>

          <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "8px", padding: "1.5rem", marginTop: "1rem" }}>
            <h3 style={{ margin: "0 0 0.5rem 0" }}>Meus jogos</h3>
            <p style={{ color: "var(--text-dim)", fontSize: "0.8125rem", marginTop: 0, marginBottom: "0.75rem", lineHeight: 1.4 }}>
              Informe o WhatsApp usado no cupom para acompanhar a situação das suas apostas.
            </p>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input
                type="tel"
                value={myPhone}
                onChange={(e) => {
                  setMyPhone(e.target.value);
                  setMyCoupons(null);
                  setMyError(null);
                }}
                placeholder="(11) 91234-5678"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    fetchMyGames();
                  }
                }}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "0.5rem",
                  background: surface,
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  color: "var(--text)",
                }}
              />
              <button
                type="button"
                onClick={fetchMyGames}
                disabled={myLoading || !myPhone.trim()}
                style={{
                  padding: "0.5rem 0.9rem",
                  background: "var(--primary)",
                  color: "#fff",
                  border: "none",
                  borderRadius: "6px",
                  fontWeight: 600,
                  cursor: myPhone.trim() ? "pointer" : "not-allowed",
                  opacity: myPhone.trim() ? 1 : 0.5,
                }}
              >
                {myLoading ? "..." : "Consultar"}
              </button>
            </div>

            {myError && (
              <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.4)", color: "#fca5a5", padding: "0.6rem", borderRadius: "6px", marginTop: "0.75rem", fontSize: "0.8125rem" }}>
                {myError}
              </div>
            )}

            {myCoupons !== null && !myError && myCoupons.length === 0 && (
              <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem", marginTop: "0.75rem" }}>
                Nenhum jogo encontrado para este número.
              </div>
            )}

            {myCoupons !== null && myCoupons.length > 0 && (
              <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.75rem", maxHeight: "320px", overflowY: "auto" }}>
                {myCoupons.map((c) => (
                  <a
                    key={c.code}
                    href={`/recibo/${c.code}`}
                    style={{
                      display: "block",
                      background: surface,
                      border: "1px solid var(--border)",
                      borderRadius: "6px",
                      padding: "0.65rem 0.75rem",
                      textDecoration: "none",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", alignItems: "center" }}>
                      <span style={{ fontWeight: 700, letterSpacing: "0.5px", color: "var(--text)", fontSize: "0.8125rem" }}>{c.code}</span>
                      <span style={{ fontSize: "0.75rem", color: statusColor(c.status), fontWeight: 600 }}>{c.statusLabel}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", marginTop: "0.25rem", fontSize: "0.75rem", color: "var(--text-dim)" }}>
                      <span>
                        {brl(c.stakeCents)} · odd {Number(c.combinedOdd).toFixed(2)}
                      </span>
                      <span>
                        {new Date(c.createdAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
                      </span>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
