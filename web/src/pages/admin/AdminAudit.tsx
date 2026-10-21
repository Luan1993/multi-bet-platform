import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Alert, Button, Card, Input, Modal, PageTitle, Select, Table, tdStyle } from "../../components/ui";

interface AuditRow {
  id: number;
  action: string;
  entity: string | null;
  entityId: string | null;
  actor: string | null;
  actorRole: string | null;
  ownerId: number | null;
  ownerSlug: string | null;
  ip: string | null;
  at: string;
  details: unknown;
}

interface RiskRow {
  id: number;
  type: string;
  couponCode: string | null;
  ownerSlug: string | null;
  ip: string | null;
  details: unknown;
  at: string;
}

export default function AdminAudit() {
  const [tab, setTab] = useState<"audit" | "risk">("audit");
  const [rows, setRows] = useState<Array<AuditRow | RiskRow>>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [owners, setOwners] = useState<Array<{ id: number; name: string; slug: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<any>(null);

  useEffect(() => {
    api
      .get("/api/admin/owners?page=1&pageSize=100")
      .then((res) => setOwners(res.items ?? []))
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (tab === "audit") {
        const params = new URLSearchParams({ page: String(page), pageSize: "30" });
        if (action.trim()) params.set("action", action.trim());
        if (ownerId) params.set("ownerId", ownerId);
        const res = await api.get(`/api/admin/audit?${params}`);
        setRows(res.items ?? []);
        setTotal(res.total ?? 0);
      } else {
        const params = new URLSearchParams({ page: String(page), pageSize: "30" });
        const res = await api.get(`/api/admin/risk-events?${params}`);
        setRows(res.items ?? []);
        setTotal(res.total ?? 0);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [tab, page, action, ownerId]);

  useEffect(() => {
    load();
  }, [load]);

  function switchTab(next: "audit" | "risk") {
    setTab(next);
    setPage(1);
    setRows([]);
    setTotal(0);
  }

  return (
    <div>
      <PageTitle
        title="Auditoria"
        subtitle="Histórico imutável de ações administrativas e tentativas bloqueadas por regras de risco."
      />

      {error && <Alert>{error}</Alert>}

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <Button variant={tab === "audit" ? "primary" : "ghost"} onClick={() => switchTab("audit")}>
          Ações administrativas
        </Button>
        <Button variant={tab === "risk" ? "primary" : "ghost"} onClick={() => switchTab("risk")}>
          Eventos de risco
        </Button>
      </div>

      <Card
        title={`${total} registro(s)`}
        action={
          tab === "audit" ? (
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <Select value={ownerId} onChange={(e) => { setOwnerId(e.target.value); setPage(1); }} style={{ width: "190px" }}>
                <option value="">Todas as bets</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
              <Input
                placeholder="Filtrar por ação (ex.: coupon)"
                value={action}
                onChange={(e) => setAction(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (setPage(1), load())}
                style={{ width: "230px" }}
              />
              <Button variant="ghost" onClick={() => { setPage(1); load(); }}>
                Filtrar
              </Button>
            </div>
          ) : undefined
        }
      >
        {loading ? (
          <div style={{ color: "var(--text-dim)" }}>Carregando...</div>
        ) : tab === "audit" ? (
          <Table head={["Ação", "Ator", "Escopo", "Entidade", "IP", "Data"]}>
            {(rows as AuditRow[]).map((r) => (
              <tr
                key={r.id}
                style={{ borderBottom: "1px solid var(--border)", cursor: "pointer" }}
                onClick={() => setSelected({ kind: "audit", data: r })}
              >
                <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.8125rem" }}>{r.action}</td>
                <td style={tdStyle}>
                  <div>{r.actor ?? "—"}</div>
                  <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>{r.actorRole ?? ""}</div>
                </td>
                <td style={tdStyle}>{r.ownerSlug ? `/bet/${r.ownerSlug}` : "Plataforma"}</td>
                <td style={{ ...tdStyle, color: "var(--text-dim)" }}>
                  {r.entity ? `${r.entity}${r.entityId ? ` #${r.entityId}` : ""}` : "—"}
                </td>
                <td style={{ ...tdStyle, color: "var(--text-dim)", fontFamily: "monospace", fontSize: "0.8125rem" }}>{r.ip ?? "—"}</td>
                <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{new Date(r.at).toLocaleString("pt-BR")}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} style={{ ...tdStyle, color: "var(--text-dim)" }}>Nenhum registro encontrado.</td>
              </tr>
            )}
          </Table>
        ) : (
          <Table head={["Tipo", "Cupom", "Bet", "IP", "Data"]}>
            {(rows as RiskRow[]).map((r) => (
              <tr
                key={r.id}
                style={{ borderBottom: "1px solid var(--border)", cursor: "pointer" }}
                onClick={() => setSelected({ kind: "risk", data: r })}
              >
                <td style={{ ...tdStyle, fontWeight: 600 }}>{r.type}</td>
                <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: "0.8125rem" }}>{r.couponCode ?? "—"}</td>
                <td style={tdStyle}>{r.ownerSlug ? `/bet/${r.ownerSlug}` : "—"}</td>
                <td style={{ ...tdStyle, color: "var(--text-dim)", fontFamily: "monospace", fontSize: "0.8125rem" }}>{r.ip ?? "—"}</td>
                <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{new Date(r.at).toLocaleString("pt-BR")}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} style={{ ...tdStyle, color: "var(--text-dim)" }}>Nenhum evento de risco registrado.</td>
              </tr>
            )}
          </Table>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "1rem" }}>
          <span style={{ color: "var(--text-dim)", fontSize: "0.8125rem" }}>Página {page}</span>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Anterior</Button>
            <Button variant="ghost" disabled={page * 30 >= total} onClick={() => setPage((p) => p + 1)}>Próxima</Button>
          </div>
        </div>
      </Card>

      {selected && (
        <Modal title={selected.kind === "audit" ? "Detalhe da ação" : "Detalhe do evento de risco"} onClose={() => setSelected(null)}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", marginBottom: "1rem" }}>
            {selected.kind === "audit" ? (
              <>
                <Info label="Ação" value={selected.data.action} />
                <Info label="Ator" value={selected.data.actor ?? "—"} />
                <Info label="Papel" value={selected.data.actorRole ?? "—"} />
                <Info label="Escopo" value={selected.data.ownerSlug ?? "Plataforma"} />
                <Info label="Entidade" value={selected.data.entity ?? "—"} />
                <Info label="ID da entidade" value={selected.data.entityId ?? "—"} />
                <Info label="IP" value={selected.data.ip ?? "—"} />
                <Info label="Data" value={new Date(selected.data.at).toLocaleString("pt-BR")} />
              </>
            ) : (
              <>
                <Info label="Tipo" value={selected.data.type} />
                <Info label="Cupom" value={selected.data.couponCode ?? "—"} />
                <Info label="Bet" value={selected.data.ownerSlug ?? "—"} />
                <Info label="IP" value={selected.data.ip ?? "—"} />
                <Info label="Data" value={new Date(selected.data.at).toLocaleString("pt-BR")} />
              </>
            )}
          </div>
          <div style={{ color: "var(--text-dim)", fontSize: "0.75rem", marginBottom: "0.35rem" }}>Detalhes</div>
          <pre
            style={{
              background: "rgba(0,0,0,0.35)",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              padding: "0.75rem",
              fontSize: "0.75rem",
              overflow: "auto",
              maxHeight: "280px",
              margin: 0,
            }}
          >
            {JSON.stringify(selected.data.details ?? {}, null, 2)}
          </pre>
        </Modal>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>{label}</div>
      <div style={{ fontSize: "0.875rem", fontWeight: 600, wordBreak: "break-word" }}>{value}</div>
    </div>
  );
}
