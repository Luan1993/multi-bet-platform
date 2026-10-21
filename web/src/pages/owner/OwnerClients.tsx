import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Alert, Badge, Button, Card, Field, Input, Modal, PageTitle, Select, Table, Textarea, brl, tdStyle } from "../../components/ui";

interface ClientRow {
  id: number;
  code: string;
  name: string;
  document: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  ageVerified: boolean;
  createdAt: string;
  couponsCount: number;
}

const emptyForm = {
  name: "",
  document: "",
  birthDate: "",
  email: "",
  phone: "",
  terms: false,
  privacy: false,
  responsibleGaming: true,
};

export default function OwnerClients() {
  const [items, setItems] = useState<ClientRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [detail, setDetail] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "20" });
      if (q.trim()) params.set("q", q.trim());
      if (status) params.set("status", status);
      const res = await api.get(`/api/owner/clients?${params}`);
      setItems(res.items ?? []);
      setTotal(res.total ?? 0);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [page, q, status]);

  useEffect(() => {
    load();
  }, [load]);

  async function createClient(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.post("/api/owner/clients", {
        name: form.name,
        document: form.document || null,
        birthDate: form.birthDate,
        email: form.email || null,
        phone: form.phone || null,
        consents: {
          terms: form.terms,
          privacy: form.privacy,
          responsibleGaming: form.responsibleGaming,
        },
      });
      setNotice(`Cliente cadastrado com o código ${res.code}.`);
      setCreating(false);
      setForm({ ...emptyForm });
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function openClient(id: number) {
    setError(null);
    setNotice(null);
    try {
      setDetail(await api.get(`/api/owner/clients/${id}`));
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function updateStatus(id: number, next: string) {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/owner/clients/${id}`, { status: next });
      setNotice(`Status atualizado para ${next}.`);
      await openClient(id);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function addLimit(id: number, limitType: string, valueReais: string) {
    setBusy(true);
    setError(null);
    try {
      const valueCents = limitType === "self_exclusion" ? null : Math.round(Number(valueReais) * 100);
      await api.post(`/api/owner/clients/${id}/limits`, { limitType, valueCents });
      setNotice("Limite registrado.");
      await openClient(id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageTitle
        title="Clientes"
        subtitle="Cadastro com verificação de idade e consentimentos, bloqueio e limites de jogo responsável."
        action={<Button onClick={() => setCreating(true)}>Novo cliente</Button>}
      />

      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      <Card
        title={`${total} cliente(s)`}
        action={
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} style={{ width: "160px" }}>
              <option value="">Todos</option>
              <option value="active">Ativos</option>
              <option value="blocked">Bloqueados</option>
              <option value="self_excluded">Autoexcluídos</option>
            </Select>
            <Input
              placeholder="Buscar nome/código/documento"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (setPage(1), load())}
              style={{ width: "240px" }}
            />
            <Button variant="ghost" onClick={() => { setPage(1); load(); }}>Buscar</Button>
          </div>
        }
      >
        {loading ? (
          <div style={{ color: "var(--text-dim)" }}>Carregando...</div>
        ) : (
          <Table head={["Código", "Nome", "Documento", "Contato", "Status", "Cupons", "Criado", ""]}>
            {items.map((c) => (
              <tr key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ ...tdStyle, fontFamily: "monospace" }}>{c.code}</td>
                <td style={tdStyle}>{c.name}</td>
                <td style={tdStyle}>{c.document ?? "—"}</td>
                <td style={tdStyle}>{c.email ?? c.phone ?? "—"}</td>
                <td style={tdStyle}><Badge status={c.status} /></td>
                <td style={tdStyle}>{c.couponsCount}</td>
                <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{new Date(c.createdAt).toLocaleDateString("pt-BR")}</td>
                <td style={tdStyle}>
                  <Button variant="ghost" onClick={() => openClient(c.id)}>Abrir</Button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={8} style={{ ...tdStyle, color: "var(--text-dim)" }}>Nenhum cliente cadastrado.</td>
              </tr>
            )}
          </Table>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "1rem" }}>
          <span style={{ color: "var(--text-dim)", fontSize: "0.8125rem" }}>Página {page}</span>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Anterior</Button>
            <Button variant="ghost" disabled={page * 20 >= total} onClick={() => setPage((p) => p + 1)}>Próxima</Button>
          </div>
        </div>
      </Card>

      {creating && (
        <Modal title="Novo cliente" onClose={() => setCreating(false)}>
          <form onSubmit={createClient}>
            <Field label="Nome completo">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} />
            </Field>
            <Field label="Data de nascimento">
              <Input type="date" value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.target.value })} required />
            </Field>
            <Field label="CPF / documento (opcional)">
              <Input value={form.document} onChange={(e) => setForm({ ...form, document: e.target.value })} />
            </Field>
            <Field label="E-mail (opcional)">
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Telefone (opcional)">
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </Field>

            <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid var(--border)", borderRadius: "6px", padding: "0.75rem", marginBottom: "1rem" }}>
              <Check label="Termos de uso aceitos" checked={form.terms} onChange={(v) => setForm({ ...form, terms: v })} />
              <Check label="Política de privacidade aceita" checked={form.privacy} onChange={(v) => setForm({ ...form, privacy: v })} />
              <Check label="Orientações de jogo responsável" checked={form.responsibleGaming} onChange={(v) => setForm({ ...form, responsibleGaming: v })} />
            </div>

            <Button type="submit" disabled={busy || !form.terms || !form.privacy}>
              {busy ? "Salvando..." : "Cadastrar cliente"}
            </Button>
          </form>
        </Modal>
      )}

      {detail && (
        <ClientModal
          data={detail}
          busy={busy}
          onClose={() => setDetail(null)}
          onStatus={(s) => updateStatus(detail.client.id, s)}
          onLimit={(type, value) => addLimit(detail.client.id, type, value)}
        />
      )}
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.8125rem", marginBottom: "0.35rem" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function ClientModal({
  data,
  busy,
  onClose,
  onStatus,
  onLimit,
}: {
  data: any;
  busy: boolean;
  onClose: () => void;
  onStatus: (s: string) => void;
  onLimit: (type: string, value: string) => void;
}) {
  const c = data.client;
  const [limitType, setLimitType] = useState("daily_stake");
  const [limitValue, setLimitValue] = useState("");

  return (
    <Modal title={`Cliente ${c.code}`} onClose={onClose}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", marginBottom: "1rem" }}>
        <Info label="Nome" value={c.name} />
        <Info label="Status" value={c.status} />
        <Info label="Nascimento" value={c.birthDate ? new Date(c.birthDate).toLocaleDateString("pt-BR") : "—"} />
        <Info label="Idade verificada" value={c.ageVerified ? "Sim" : "Não"} />
        <Info label="Documento" value={c.document ?? "—"} />
        <Info label="Contato" value={c.email ?? c.phone ?? "—"} />
      </div>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        <Button variant="success" disabled={busy || c.status === "active"} onClick={() => onStatus("active")}>Reativar</Button>
        <Button variant="danger" disabled={busy || c.status === "blocked"} onClick={() => onStatus("blocked")}>Bloquear</Button>
        <Button variant="ghost" disabled={busy || c.status === "self_excluded"} onClick={() => onStatus("self_excluded")}>
          Autoexcluir
        </Button>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem", marginBottom: "0.4rem" }}>Limites de jogo responsável</div>
        {(data.limits ?? []).map((l: any) => (
          <div key={l.id} style={{ fontSize: "0.8125rem", color: "var(--text-dim)" }}>
            {l.type} — {l.valueCents != null ? brl(l.valueCents) : "sem valor"}
            {l.expiresAt ? ` até ${new Date(l.expiresAt).toLocaleDateString("pt-BR")}` : ""}
          </div>
        ))}
        {(data.limits ?? []).length === 0 && <div style={{ fontSize: "0.8125rem", color: "var(--text-dim)" }}>Nenhum limite cadastrado.</div>}

        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.6rem" }}>
          <Select value={limitType} onChange={(e) => setLimitType(e.target.value)} style={{ width: "170px" }}>
            <option value="daily_stake">Limite diário</option>
            <option value="weekly_stake">Limite semanal</option>
            <option value="monthly_stake">Limite mensal</option>
            <option value="self_exclusion">Autoexclusão</option>
          </Select>
          {limitType !== "self_exclusion" && (
            <Input type="number" min="0" step="0.01" placeholder="R$" value={limitValue} onChange={(e) => setLimitValue(e.target.value)} style={{ width: "120px" }} />
          )}
          <Button variant="ghost" disabled={busy} onClick={() => onLimit(limitType, limitValue)}>Registrar</Button>
        </div>
      </div>

      <div>
        <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem", marginBottom: "0.4rem" }}>Cupons recentes</div>
        {(data.coupons ?? []).map((cp: any) => (
          <div key={cp.code} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8125rem", padding: "0.3rem 0", borderTop: "1px solid var(--border)" }}>
            <span style={{ fontFamily: "monospace" }}>{cp.code}</span>
            <span><Badge status={cp.status} /></span>
            <span>{brl(cp.stakeCents)}</span>
          </div>
        ))}
        {(data.coupons ?? []).length === 0 && <div style={{ fontSize: "0.8125rem", color: "var(--text-dim)" }}>Nenhum cupom.</div>}
      </div>
    </Modal>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>{label}</div>
      <div style={{ fontSize: "0.875rem", fontWeight: 600 }}>{value}</div>
    </div>
  );
}
