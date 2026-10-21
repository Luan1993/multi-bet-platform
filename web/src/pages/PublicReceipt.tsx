import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";

function brl(cents?: number | null): string {
  return ((cents ?? 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Pré-cupom — aguardando confirmação",
  accepted: "Cupom confirmado",
  won: "Cupom vencedor",
  lost: "Cupom perdedor",
  cancelled: "Cupom cancelado",
  expired: "Pré-cupom expirado",
};

export default function PublicReceipt() {
  const { code } = useParams();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .get(`/api/coupons/${encodeURIComponent(code ?? "")}`)
      .then((res) => alive && setData(res))
      .catch((err) => alive && setError(err.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [code]);

  if (loading) return <div className="loading">Carregando...</div>;

  if (error) {
    return (
      <div style={{ padding: "3rem", maxWidth: "560px", margin: "0 auto" }}>
        <h1 style={{ fontSize: "1.25rem" }}>Recibo não encontrado</h1>
        <p style={{ color: "var(--text-dim)" }}>{error}</p>
        <a href="/" style={{ color: "var(--accent)" }}>
          Voltar ao início
        </a>
      </div>
    );
  }

  const v = data?.verification;
  const c = data?.coupon;
  const o = data?.owner;
  const brand = o?.branding ?? {};
  const light = brand.theme === "light";
  const styleVars = {
    "--primary": brand.primaryColor || "#7c3aed",
    "--accent": brand.accentColor || "#22d3ee",
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

  const valid = Boolean(v?.valid);
  const statusColor = valid ? "#86efac" : "#fca5a5";
  const statusBg = valid ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)";
  const statusBorder = valid ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)";

  return (
    <div style={{ ...styleVars, minHeight: "100%", background: "var(--bg)", color: "var(--text)", padding: "2rem 1rem" }}>
      <div style={{ maxWidth: "820px", margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", marginBottom: "1.25rem", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            {brand.logoPath && (
              <img
                src={brand.logoPath}
                alt=""
                style={{ width: "40px", height: "40px", objectFit: "contain", borderRadius: "8px", background: "rgba(255,255,255,0.06)" }}
              />
            )}
            <div>
              <div style={{ fontWeight: 700 }}>{brand.displayName || o?.name}</div>
              <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem" }}>Recibo digital de cupom</div>
            </div>
          </div>
          {o?.slug && (
            <a href={`/bet/${o.slug}`} style={{ color: "var(--accent)", fontSize: "0.875rem" }}>
              Ir para a página da bet →
            </a>
          )}
        </div>

        <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "10px", padding: "2rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "1.5rem", alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 380px", minWidth: 0 }}>
              <h1 style={{ margin: "0 0 1rem 0", fontSize: "1.35rem" }}>Autenticidade do cupom</h1>
              <div style={{ background: statusBg, border: `1px solid ${statusBorder}`, padding: "1rem", borderRadius: "8px" }}>
                <div style={{ fontWeight: 600, color: statusColor }}>{valid ? "Código reconhecido" : "Código não válido como aposta"}</div>
                <div style={{ fontSize: "1.4rem", fontWeight: 800, letterSpacing: "2px", margin: "0.5rem 0", wordBreak: "break-all" }}>
                  {v?.code ?? code}
                </div>
                <div style={{ fontSize: "0.875rem" }}>
                  Status: <strong>{STATUS_LABEL[c?.status] ?? v?.status ?? "—"}</strong>
                </div>
                <div style={{ fontSize: "0.8125rem", color: "var(--text-dim)", marginTop: "0.5rem" }}>{v?.meaning}</div>
                {v?.checkedAt && (
                  <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.5rem" }}>
                    Verificado em {new Date(v.checkedAt).toLocaleString("pt-BR")}
                  </div>
                )}
              </div>

              {c?.isDemo && (
                <div
                  style={{
                    marginTop: "0.75rem",
                    background: "rgba(245,158,11,0.15)",
                    border: "1px solid rgba(245,158,11,0.5)",
                    color: "#fbbf24",
                    padding: "0.6rem 0.8rem",
                    borderRadius: "6px",
                    fontSize: "0.8125rem",
                    fontWeight: 600,
                  }}
                >
                  MODO DEMONSTRAÇÃO — este cupom não representa uma aposta real.
                </div>
              )}
            </div>

            <div style={{ textAlign: "center", flex: "0 0 auto" }}>
              <img
                src={`/api/coupons/${encodeURIComponent(v?.code ?? code ?? "")}/qr`}
                alt="QR de verificação do cupom"
                width={160}
                height={160}
                style={{ background: "#fff", padding: "8px", borderRadius: "8px", display: "block" }}
              />
              <div style={{ color: "var(--text-dim)", fontSize: "0.7rem", marginTop: "0.35rem", maxWidth: "176px" }}>
                Aponte a câmera para verificar
              </div>
            </div>
          </div>

          {c && (
            <div style={{ marginTop: "1.75rem" }}>
              <h2 style={{ margin: "0 0 0.75rem 0", fontSize: "1.05rem" }}>Detalhes</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.9rem" }}>
                <Info label="Valor apostado" value={brl(c.stakeCents)} />
                <Info label="Odd combinada" value={Number(c.combinedOdd).toFixed(2)} />
                <Info label="Retorno potencial" value={brl(c.potentialPayoutCents)} highlight />
                <Info label="Criado em" value={new Date(c.createdAt).toLocaleString("pt-BR")} />
                {c.acceptedAt && <Info label="Confirmado em" value={new Date(c.acceptedAt).toLocaleString("pt-BR")} />}
                {c.client && <Info label="Cliente" value={`${c.client.name} (${c.client.code})`} />}
                {c.duePayoutCents != null && <Info label="Prêmio devido" value={brl(c.duePayoutCents)} />}
                {c.paidPayoutCents != null && <Info label="Prêmio pago" value={brl(c.paidPayoutCents)} />}
              </div>

              {c.cancelReason && (
                <div style={{ marginTop: "1rem", fontSize: "0.8125rem", color: "#fca5a5" }}>
                  Motivo do cancelamento: {c.cancelReason}
                </div>
              )}

              <h2 style={{ margin: "1.5rem 0 0.75rem 0", fontSize: "1.05rem" }}>Seleções</h2>
              <div style={{ border: "1px solid var(--border)", borderRadius: "8px", overflow: "hidden" }}>
                {(c.selections ?? []).map((s: any, i: number) => (
                  <div
                    key={i}
                    style={{
                      padding: "0.75rem 0.9rem",
                      borderTop: i ? "1px solid var(--border)" : "none",
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "1rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>
                        {s.eventHome} x {s.eventAway}
                      </div>
                      <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem" }}>
                        {s.marketName} — {s.selectionName}
                      </div>
                      {s.kickoffAt && (
                        <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>
                          {new Date(s.kickoffAt).toLocaleString("pt-BR")}
                        </div>
                      )}
                    </div>
                    <div style={{ fontWeight: 700 }}>{Number(s.odd).toFixed(2)}</div>
                  </div>
                ))}
                {(c.selections ?? []).length === 0 && (
                  <div style={{ padding: "0.9rem", color: "var(--text-dim)", fontSize: "0.8125rem" }}>
                    Nenhuma seleção registrada.
                  </div>
                )}
              </div>

              {c.provider && (
                <div style={{ marginTop: "1rem", color: "var(--text-dim)", fontSize: "0.75rem" }}>
                  Odds capturadas de {c.provider.label ?? c.provider.id}
                  {c.provider.isDemo ? " (simuladas)" : ""}.
                </div>
              )}
            </div>
          )}

          {data?.disclaimer && (
            <div
              style={{
                marginTop: "1.5rem",
                paddingTop: "1rem",
                borderTop: "1px solid var(--border)",
                fontSize: "0.75rem",
                color: "var(--text-dim)",
                lineHeight: 1.5,
              }}
            >
              {data.disclaimer}
            </div>
          )}
        </div>

        <p style={{ textAlign: "center", color: "var(--text-dim)", fontSize: "0.75rem", marginTop: "1.25rem" }}>
          Este recibo é gerado a partir dos dados registrados no servidor. Confira sempre pelo código e pelo QR.
        </p>
      </div>
    </div>
  );
}

function Info({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>{label}</div>
      <div style={{ fontWeight: 600, color: highlight ? "var(--success)" : "var(--text)", wordBreak: "break-word" }}>{value}</div>
    </div>
  );
}
