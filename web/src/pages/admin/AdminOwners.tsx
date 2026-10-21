import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Modal,
  PageTitle,
  Select,
  Table,
  brl,
  tdStyle,
} from "../../components/ui";

interface OwnerRow {
  id: number;
  slug: string;
  name: string;
  status: string;
  contactEmail: string | null;
  loginEmail: string | null;
  createdAt: string;
  branding: { displayName: string | null; logoPath: string | null; primaryColor: string | null };
  stats: { couponsTotal: number; clientsTotal: number; stake30dCents: number };
}

const emptyForm = {
  slug: "",
  name: "",
  loginEmail: "",
  contactEmail: "",
  contactPhone: "",
  initialPassword: "",
  maxPayout: "",
  primaryColor: "#7c3aed",
  secondaryColor: "#0f172a",
  accentColor: "#22d3ee",
};

export default function AdminOwners() {
  const [items, setItems] = useState<OwnerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [resetInfo, setResetInfo] = useState<{ name: string; password: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "20" });
      if (q.trim()) params.set("q", q.trim());
      if (status) params.set("status", status);
      const res = await api.get(`/api/admin/owners?${params}`);
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

  async function createOwner(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body: any = {
        slug: form.slug.trim().toLowerCase(),
        name: form.name.trim(),
        loginEmail: form.loginEmail.trim().toLowerCase(),
        contactEmail: form.contactEmail.trim() || null,
        contactPhone: form.contactPhone.trim() || null,
        primaryColor: form.primaryColor,
        secondaryColor: form.secondaryColor,
        accentColor: form.accentColor,
      };
      if (form.initialPassword.trim()) body.initialPassword = form.initialPassword.trim();
      if (form.maxPayout.trim()) body.maxPayoutCents = Math.round(Number(form.maxPayout.replace(",", ".")) * 100);
      const res = await api.post("/api/admin/owners", body);
      setCreated(res);
      setCreating(false);
      setForm({ ...emptyForm });
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(owner: OwnerRow, next: string) {
    if (next !== "active" && !window.confirm(`Confirmar alteração de status de ${owner.name} para ${next}? Sessões ativas serão encerradas.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.patch(`/api/admin/owners/${owner.id}`, { status: next });
      setNotice(`Status de ${owner.name} atualizado para ${next}.`);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(owner: OwnerRow) {
    if (!window.confirm(`Gerar nova senha para ${owner.name}? A senha atual deixará de funcionar.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.post(`/api/admin/owners/${owner.id}/reset-password`, {});
      setResetInfo({ name: owner.name, password: res.newPassword });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveOwnerLimits(
    ownerId: number,
    values: { maxPayoutCents: number | null; minStakeCents: number | null; maxStakeCents: number | null }
  ) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.put(`/api/admin/owners/${ownerId}/settings`, values);
      setNotice("Limites do proprietário atualizados.");
      setDetail(await api.get(`/api/admin/owners/${ownerId}`));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function openDetail(owner: OwnerRow) {
    setError(null);
    setNotice(null);
    try {
      setDetail(await api.get(`/api/admin/owners/${owner.id}`));
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <div>
      <PageTitle
        title="Proprietários"
        subtitle="Cada bet tem dados, clientes, cupons e relatórios totalmente isolados."
        action={<Button onClick={() => setCreating(true)}>Nova bet</Button>}
      />

      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      <Card
        title={`${total} bet(s)`}
        action={
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} style={{ width: "160px" }}>
              <option value="">Todos os status</option>
              <option value="active">Ativos</option>
              <option value="suspended">Suspensos</option>
              <option value="blocked">Bloqueados</option>
            </Select>
            <Input
              placeholder="Buscar nome, slug ou e-mail"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (setPage(1), load())}
              style={{ width: "240px" }}
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
          <Table head={["Bet", "Slug / link", "Login", "Status", "Cupons", "Clientes", "Stake 30d", ""]}>
            {items.map((o) => (
              <tr key={o.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={tdStyle}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                    {o.branding.logoPath ? (
                      <img src={o.branding.logoPath} alt="" style={{ width: "28px", height: "28px", objectFit: "contain", borderRadius: "6px" }} />
                    ) : (
                      <span
                        style={{
                          width: "28px",
                          height: "28px",
                          borderRadius: "6px",
                          background: o.branding.primaryColor || "#7c3aed",
                          display: "inline-block",
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <div>
                      <div style={{ fontWeight: 600 }}>{o.branding.displayName || o.name}</div>
                      <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>{o.name}</div>
                    </div>
                  </div>
                </td>
                <td style={tdStyle}>
                  <a href={`/bet/${o.slug}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
                    /bet/{o.slug}
                  </a>
                </td>
                <td style={{ ...tdStyle, color: "var(--text-dim)" }}>{o.loginEmail ?? "—"}</td>
                <td style={tdStyle}><Badge status={o.status} /></td>
                <td style={tdStyle}>{o.stats.couponsTotal}</td>
                <td style={tdStyle}>{o.stats.clientsTotal}</td>
                <td style={tdStyle}>{brl(o.stats.stake30dCents)}</td>
                <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                  <div style={{ display: "flex", gap: "0.35rem" }}>
                    <Button variant="ghost" onClick={() => openDetail(o)}>Detalhes</Button>
                    {o.status !== "active" && (
                      <Button variant="success" disabled={busy} onClick={() => changeStatus(o, "active")}>Ativar</Button>
                    )}
                    {o.status === "active" && (
                      <Button variant="danger" disabled={busy} onClick={() => changeStatus(o, "suspended")}>Suspender</Button>
                    )}
                    {o.status !== "blocked" && (
                      <Button variant="danger" disabled={busy} onClick={() => changeStatus(o, "blocked")}>Bloquear</Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={8} style={{ ...tdStyle, color: "var(--text-dim)" }}>Nenhuma bet encontrada.</td>
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
        <Modal title="Nova bet / proprietário" onClose={() => setCreating(false)}>
          <form onSubmit={createOwner}>
            <Field label="Link exclusivo (slug)" hint="Somente letras minúsculas, números e hífen. Ex.: minha-bet">
              <Input
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                required
                minLength={2}
                maxLength={49}
                pattern="[a-z0-9][a-z0-9-]{1,48}"
              />
            </Field>
            <Field label="Nome da bet">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} maxLength={100} />
            </Field>
            <Field label="E-mail de login do proprietário">
              <Input type="email" value={form.loginEmail} onChange={(e) => setForm({ ...form, loginEmail: e.target.value })} required />
            </Field>
            <Field label="Senha inicial (opcional)" hint="Se vazio, uma senha forte é gerada e exibida uma única vez.">
              <Input type="text" value={form.initialPassword} onChange={(e) => setForm({ ...form, initialPassword: e.target.value })} />
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
              <Field label="E-mail de contato (opcional)">
                <Input type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
              </Field>
              <Field label="Telefone (opcional)">
                <Input value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
              </Field>
            </div>
            <Field label="Teto de retorno por cupom (R$)" hint="Opcional. Nunca pode exceder o teto global da plataforma.">
              <Input type="number" min="1" step="0.01" value={form.maxPayout} onChange={(e) => setForm({ ...form, maxPayout: e.target.value })} />
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem" }}>
              <ColorField label="Primária" value={form.primaryColor} onChange={(v) => setForm({ ...form, primaryColor: v })} />
              <ColorField label="Secundária" value={form.secondaryColor} onChange={(v) => setForm({ ...form, secondaryColor: v })} />
              <ColorField label="Destaque" value={form.accentColor} onChange={(v) => setForm({ ...form, accentColor: v })} />
            </div>

            <Button type="submit" disabled={busy}>
              {busy ? "Criando..." : "Criar bet"}
            </Button>
          </form>
        </Modal>
      )}

      {created && (
        <Modal title="Bet criada com sucesso" onClose={() => setCreated(null)}>
          <Alert kind="success">
            Guarde as credenciais abaixo. A senha inicial <strong>não será exibida novamente</strong>.
          </Alert>
          <Info label="Link público" value={created.link} />
          <Info label="E-mail de login" value={created.loginEmail} />
          <Info label="Senha inicial" value={created.initialPassword} />
          <div style={{ marginTop: "1rem" }}>
            <Button onClick={() => setCreated(null)}>Fechar</Button>
          </div>
        </Modal>
      )}

      {resetInfo && (
        <Modal title="Senha redefinida" onClose={() => setResetInfo(null)}>
          <Alert kind="success">
            Nova senha de <strong>{resetInfo.name}</strong>. Repasse ao proprietário com segurança; ela não será exibida novamente.
          </Alert>
          <Info label="Nova senha" value={resetInfo.password} />
          <div style={{ marginTop: "1rem" }}>
            <Button onClick={() => setResetInfo(null)}>Fechar</Button>
          </div>
        </Modal>
      )}

      {detail && (
        <OwnerDetail
          data={detail}
          busy={busy}
          onClose={() => setDetail(null)}
          onStatus={(s) => changeStatus({ ...detail.owner, stats: {} } as any, s)}
          onReset={() => resetPassword({ ...detail.owner, stats: {} } as any)}
          onSaveLimits={(values) => saveOwnerLimits(detail.owner.id, values)}
        />
      )}
    </div>
  );
}

function OwnerDetail({
  data,
  busy,
  onClose,
  onStatus,
  onReset,
  onSaveLimits,
}: {
  data: any;
  busy: boolean;
  onClose: () => void;
  onStatus: (status: string) => void;
  onReset: () => void;
  onSaveLimits: (values: {
    maxPayoutCents: number | null;
    minStakeCents: number | null;
    maxStakeCents: number | null;
  }) => void;
}) {
  const o = data.owner;
  const s = data.stats ?? {};
  const ceiling = data.settings?.platformCeilingCents ?? 0;
  const [maxPayout, setMaxPayout] = useState(reaisInput(data.settings?.maxPayoutCents));
  const [minStake, setMinStake] = useState(reaisInput(data.settings?.minStakeCents));
  const [maxStake, setMaxStake] = useState(reaisInput(data.settings?.maxStakeCents));
  const [formError, setFormError] = useState<string | null>(null);

  const payoutCents = centsFromInput(maxPayout);
  const minStakeCents = centsFromInput(minStake);
  const maxStakeCents = centsFromInput(maxStake);
  const invalidRange = minStakeCents != null && maxStakeCents != null && minStakeCents > maxStakeCents;
  const aboveCeiling = payoutCents != null && ceiling > 0 && payoutCents > ceiling;

  function submitLimits(e: React.FormEvent) {
    e.preventDefault();
    if (invalidRange) {
      setFormError("A aposta mínima não pode ser maior que a máxima.");
      return;
    }
    if (aboveCeiling) {
      setFormError("O teto de retorno não pode exceder o teto da plataforma.");
      return;
    }
    setFormError(null);
    onSaveLimits({ maxPayoutCents: payoutCents, minStakeCents, maxStakeCents });
  }

  return (
    <Modal title={`Bet ${o.slug}`} onClose={onClose}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", marginBottom: "1rem" }}>
        <Info label="Nome" value={o.name} />
        <Info label="Status" value={o.status} />
        <Info label="E-mail de login" value={o.loginEmail ?? "—"} />
        <Info label="Contato" value={o.contactEmail ?? o.contactPhone ?? "—"} />
        <Info label="Criada em" value={new Date(o.createdAt).toLocaleString("pt-BR")} />
        <Info label="Cupons" value={String(s.couponsTotal ?? 0)} />
        <Info label="Pendentes" value={String(s.pending ?? 0)} />
        <Info label="Aceitos" value={String(s.accepted ?? 0)} />
        <Info label="Clientes" value={String(s.clientsTotal ?? 0)} />
        <Info label="Stake aceito" value={brl(s.stakeTotalCents)} />
        <Info label="Retorno potencial" value={brl(s.potentialTotalCents)} />
        <Info label="A pagar" value={brl(s.dueTotalCents)} />
        <Info label="Pago" value={brl(s.paidTotalCents)} />
        <Info label="Teto da plataforma" value={ceiling ? brl(ceiling) : "—"} />
      </div>

      <form onSubmit={submitLimits} style={{ borderTop: "1px solid var(--border)", paddingTop: "1rem", marginBottom: "1rem" }}>
        <div style={{ fontSize: "0.9rem", fontWeight: 700, marginBottom: "0.75rem" }}>Limites próprios da bet</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem" }}>
          <Field label="Teto de retorno (R$)" hint="Vazio = padrão da plataforma.">
            <Input type="number" min="1" step="0.01" value={maxPayout} onChange={(e) => setMaxPayout(e.target.value)} placeholder="Padrão" />
          </Field>
          <Field label="Aposta mínima (R$)">
            <Input type="number" min="0.01" step="0.01" value={minStake} onChange={(e) => setMinStake(e.target.value)} placeholder="Padrão" />
          </Field>
          <Field label="Aposta máxima (R$)">
            <Input type="number" min="1" step="0.01" value={maxStake} onChange={(e) => setMaxStake(e.target.value)} placeholder="Padrão" />
          </Field>
        </div>
        {formError && <Alert>{formError}</Alert>}
        {aboveCeiling && !formError && <Alert>O teto informado excede o limite da plataforma.</Alert>}
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <Button type="submit" disabled={busy || invalidRange || aboveCeiling}>
            {busy ? "Salvando..." : "Salvar limites"}
          </Button>
          {o.status !== "active" && <Button type="button" variant="success" disabled={busy} onClick={() => onStatus("active")}>Ativar</Button>}
          {o.status !== "suspended" && <Button type="button" variant="danger" disabled={busy} onClick={() => onStatus("suspended")}>Suspender</Button>}
          {o.status !== "blocked" && <Button type="button" variant="danger" disabled={busy} onClick={() => onStatus("blocked")}>Bloquear</Button>}
          <Button type="button" variant="ghost" disabled={busy} onClick={onReset}>Redefinir senha</Button>
        </div>
      </form>
    </Modal>
  );
}

function reaisInput(cents: number | null | undefined): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

function centsFromInput(value: string): number | null {
  if (!value.trim()) return null;
  const n = Math.round(Number(value.replace(",", ".")) * 100);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", height: "36px", padding: 0, background: "none", border: "1px solid var(--border)", borderRadius: "6px" }}
      />
    </Field>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: "0.5rem" }}>
      <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>{label}</div>
      <div style={{ fontSize: "0.9rem", fontWeight: 600, wordBreak: "break-word" }}>{value}</div>
    </div>
  );
}
