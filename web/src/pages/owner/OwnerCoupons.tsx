import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Alert, Badge, Button, Card, Field, Input, Modal, PageTitle, Select, Table, Textarea, brl, tdStyle } from "../../components/ui";

interface CouponRow {
  id: number;
  code: string;
  status: string;
  stakeCents: number;
  combinedOdd: number;
  potentialPayoutCents: number;
  duePayoutCents: number | null;
  paidPayoutCents: number | null;
  createdAt: string;
  expiresAt: string;
  client: { code: string; name: string; phone: string | null } | null;
  clientPhone: string | null;
  selectionsCount: number;
  firstEvent: string | null;
}

const STATUSES = ["", "pending", "accepted", "won", "lost", "cancelled", "expired"];

export default function OwnerCoupons() {
  const [items, setItems] = useState<CouponRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "20" });
      if (status) params.set("status", status);
      if (q.trim()) params.set("q", q.trim());
      const res = await api.get(`/api/owner/coupons?${params}`);
      setItems(res.items ?? []);
      setTotal(res.total ?? 0);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [page, status, q]);

  useEffect(() => {
    load();
  }, [load]);

  async function openCoupon(code: string) {
    setError(null);
    setNotice(null);
    try {
      const res = await api.get(`/api/owner/coupons/${encodeURIComponent(code)}`);
      setSelected(res);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function act(action: "accept" | "cancel" | "settle" | "pay", payload?: any) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post(`/api/owner/coupons/${encodeURIComponent(selected.coupon.code)}/${action}`, payload);
      setNotice(
        action === "accept"
          ? "Cupom aceito com odds revalidadas."
          : action === "cancel"
          ? "Cupom cancelado."
          : action === "pay"
          ? "Pagamento de prêmio registrado."
          : "Cupom liquidado."
      );
      await openCoupon(selected.coupon.code);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageTitle
        title="Cupons"
        subtitle="Valide o código do cupom, confira as odds e confirme a aposta."
        action={
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const value = new FormData(e.currentTarget).get("code") as string;
              if (value?.trim()) openCoupon(value.trim());
            }}
            style={{ display: "flex", gap: "0.5rem" }}
          >
            <Input name="code" placeholder="BET-XXXX-XXXX-XXXX-CC" style={{ width: "260px" }} />
            <Button type="submit">Validar código</Button>
          </form>
        }
      />

      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      <Card
        title={`${total} cupom(ns)`}
        action={
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} style={{ width: "170px" }}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s ? s : "Todos os status"}
                </option>
              ))}
            </Select>
            <Input
              placeholder="Buscar código/cliente"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setPage(1);
                  load();
                }
              }}
              style={{ width: "220px" }}
            />
            <Button variant="ghost" onClick={() => { setPage(1); load(); }}>
              Buscar
            </Button>
          </div>
        }
      >
        {loading ? (
          <div style={{ color: "var(--text-dim)" }}>Carregando...</div>
        ) : (
          <Table head={["Código", "Status", "Cliente", "Evento", "Stake", "Odd", "Retorno", "Criado", ""]}>
            {items.map((c) => (
              <tr key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ ...tdStyle, fontFamily: "monospace", whiteSpace: "nowrap" }}>{c.code}</td>
                <td style={tdStyle}><Badge status={c.status} /></td>
                <td style={tdStyle}>{c.client ? `${c.client.name} (${c.client.code})` : c.clientPhone || "—"}</td>
                <td style={{ ...tdStyle, maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.firstEvent ?? "—"}</td>
                <td style={tdStyle}>{brl(c.stakeCents)}</td>
                <td style={tdStyle}>{c.combinedOdd?.toFixed(2)}</td>
                <td style={tdStyle}>{brl(c.potentialPayoutCents)}</td>
                <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{new Date(c.createdAt).toLocaleString("pt-BR")}</td>
                <td style={tdStyle}>
                  <Button variant="ghost" onClick={() => openCoupon(c.code)}>
                    Abrir
                  </Button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={9} style={{ ...tdStyle, color: "var(--text-dim)" }}>
                  Nenhum cupom encontrado.
                </td>
              </tr>
            )}
          </Table>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "1rem" }}>
          <span style={{ color: "var(--text-dim)", fontSize: "0.8125rem" }}>Página {page}</span>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Anterior
            </Button>
            <Button variant="ghost" disabled={page * 20 >= total} onClick={() => setPage((p) => p + 1)}>
              Próxima
            </Button>
          </div>
        </div>
      </Card>

      {selected && (
        <CouponModal
          data={selected}
          busy={busy}
          onClose={() => setSelected(null)}
          onAccept={() => act("accept")}
          onCancel={(reason) => act("cancel", { reason })}
          onSettle={(payload) => act("settle", payload)}
          onPay={(amountCents) => act("pay", amountCents ? { amountCents } : {})}
        />
      )}
    </div>
  );
}

function CouponModal({
  data,
  busy,
  onClose,
  onAccept,
  onCancel,
  onSettle,
  onPay,
}: {
  data: any;
  busy: boolean;
  onClose: () => void;
  onAccept: () => void;
  onCancel: (reason: string) => void;
  onSettle: (payload: { result: "won" | "lost"; note?: string }) => void;
  onPay: (amountCents?: number) => void;
}) {
  const c = data.coupon;
  const [mode, setMode] = useState<"view" | "cancel" | "settle" | "pay">("view");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const remaining = Math.max(0, Number(c.duePayoutCents ?? 0) - Number(c.paidPayoutCents ?? 0));
  const [payAmount, setPayAmount] = useState("");

  useEffect(() => {
    setPayAmount(remaining > 0 ? (remaining / 100).toFixed(2) : "");
  }, [remaining]);

  return (
    <Modal title={`Cupom ${c.code}`} onClose={onClose}>
      <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem", alignItems: "center" }}>
        <Badge status={c.status} />
        <span style={{ color: "var(--text-dim)", fontSize: "0.8125rem" }}>
          Criado em {new Date(c.createdAt).toLocaleString("pt-BR")}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", marginBottom: "1rem" }}>
        <Info label="Stake" value={brl(c.stakeCents)} />
        <Info label="Odd combinada" value={Number(c.combinedOdd).toFixed(2)} />
        <Info label="Retorno potencial" value={brl(c.potentialPayoutCents)} />
        <Info label="Limite aplicado" value={brl(c.limitAppliedCents)} />
        <Info label="Expira em" value={new Date(c.expiresAt).toLocaleString("pt-BR")} />
        <Info label="Cliente" value={c.client ? `${c.client.name} (${c.client.code})` : "—"} />
        {(c.client?.phone || c.clientPhone) && (
          <Info label="WhatsApp" value={c.client?.phone || c.clientPhone || ""} />
        )}
        {c.duePayoutCents !== null && c.duePayoutCents !== undefined && (
          <Info label="Prêmio devido" value={brl(Number(c.duePayoutCents))} />
        )}
        {c.paidPayoutCents !== null && c.paidPayoutCents !== undefined && (
          <Info label="Prêmio pago" value={brl(Number(c.paidPayoutCents))} />
        )}
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem", marginBottom: "0.5rem" }}>Seleções (snapshot)</div>
        {c.selections.map((s: any, i: number) => (
          <div key={i} style={{ borderTop: i ? "1px solid var(--border)" : "none", padding: "0.5rem 0", fontSize: "0.875rem" }}>
            <div style={{ fontWeight: 600 }}>
              {s.eventHome} x {s.eventAway}
            </div>
            <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem" }}>
              {s.marketName} — {s.selectionName} @ {Number(s.odd).toFixed(2)}
            </div>
          </div>
        ))}
      </div>

      {c.status === "pending" && mode === "view" && (
        <Alert kind="info">
          Este é um <strong>pré-cupom</strong>. Ao aceitar, as odds serão revalidadas no servidor. Se mudaram, a aceitação é recusada.
        </Alert>
      )}

      {mode === "cancel" && (
        <div style={{ marginBottom: "1rem" }}>
          <Field label="Motivo do cancelamento">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Descreva o motivo (mín. 3 caracteres)" />
          </Field>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Button variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => onCancel(reason.trim())}>
              Confirmar cancelamento
            </Button>
            <Button variant="ghost" onClick={() => setMode("view")}>Voltar</Button>
          </div>
        </div>
      )}

      {mode === "settle" && (
        <div style={{ marginBottom: "1rem" }}>
          <Field label="Observação (opcional)">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Button variant="success" disabled={busy} onClick={() => onSettle({ result: "won", note: note || undefined })}>
              Marcar como vencedor
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => onSettle({ result: "lost", note: note || undefined })}>
              Marcar como perdedor
            </Button>
            <Button variant="ghost" onClick={() => setMode("view")}>Voltar</Button>
          </div>
        </div>
      )}

      {mode === "pay" && (
        <div style={{ marginBottom: "1rem" }}>
          <Alert kind="info">
            Prêmio devido: <strong>{brl(Number(c.duePayoutCents ?? 0))}</strong> • Já pago: <strong>{brl(Number(c.paidPayoutCents ?? 0))}</strong> • Falta: <strong>{brl(remaining)}</strong>
          </Alert>
          <Field label="Valor a pagar (R$)">
            <Input
              type="number"
              min={0.01}
              step="0.01"
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
            />
          </Field>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Button
              variant="success"
              disabled={busy || !(Number(payAmount.replace(",", ".")) > 0)}
              onClick={() => {
                const value = Number(payAmount.replace(",", "."));
                if (!Number.isFinite(value) || value <= 0) return;
                onPay(Math.round(value * 100));
              }}
            >
              {busy ? "Registrando..." : "Registrar pagamento"}
            </Button>
            <Button variant="ghost" onClick={() => setMode("view")}>Voltar</Button>
          </div>
        </div>
      )}

      {mode === "view" && (
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
          {c.status === "pending" && (
            <Button disabled={busy} onClick={onAccept}>
              {busy ? "Validando..." : "Aceitar cupom"}
            </Button>
          )}
          {c.status === "accepted" && (
            <Button variant="success" disabled={busy} onClick={() => setMode("settle")}>
              Liquidar
            </Button>
          )}
          {c.status === "won" && remaining > 0 && (
            <Button variant="success" disabled={busy} onClick={() => setMode("pay")}>
              Registrar pagamento
            </Button>
          )}
          {c.status === "won" && remaining <= 0 && (
            <Badge status="won" />
          )}
          {["pending", "accepted"].includes(c.status) && (
            <Button variant="danger" onClick={() => setMode("cancel")}>
              Cancelar
            </Button>
          )}
          <a href={data.receiptUrl} target="_blank" rel="noopener noreferrer">
            <Button variant="ghost">Ver recibo público</Button>
          </a>
        </div>
      )}

      {data.history?.length > 0 && (
        <div style={{ marginTop: "1.25rem" }}>
          <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem", marginBottom: "0.35rem" }}>Histórico</div>
          {data.history.map((h: any, i: number) => (
            <div key={i} style={{ fontSize: "0.8125rem", color: "var(--text-dim)" }}>
              {new Date(h.at).toLocaleString("pt-BR")} — {h.from ?? "—"} → <strong>{h.to}</strong>
              {h.reason ? ` (${h.reason})` : ""}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>{label}</div>
      <div style={{ fontSize: "0.9rem", fontWeight: 600 }}>{value}</div>
    </div>
  );
}
