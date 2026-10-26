import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Alert, Button, Card, Field, Input, PageTitle, brl } from "../../components/ui";

interface Settings {
  demoMode: boolean;
  maxPayoutCents: number;
  minStakeCents: number;
  maxStakeCents: number;
  compliance: Record<string, unknown>;
  updatedAt: string | null;
}

function toReais(cents: number): string {
  return (cents / 100).toFixed(2);
}

function toCents(value: string): number {
  return Math.round(Number(value.replace(",", ".")) * 100);
}

export default function AdminSettings() {
  const [form, setForm] = useState<Settings | null>(null);
  const [complianceText, setComplianceText] = useState("{}");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .get("/api/admin/settings")
      .then((res) => {
        setForm(res);
        setComplianceText(JSON.stringify(res.compliance ?? {}, null, 2));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function setCents(key: "maxPayoutCents" | "minStakeCents" | "maxStakeCents", value: string) {
    if (!form) return;
    setForm({ ...form, [key]: toCents(value) });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setError(null);
    setNotice(null);

    let compliance: Record<string, unknown>;
    try {
      compliance = JSON.parse(complianceText || "{}");
      if (typeof compliance !== "object" || Array.isArray(compliance) || compliance === null) {
        throw new Error("O bloco de conformidade deve ser um objeto JSON.");
      }
    } catch (err: any) {
      setError(`JSON de conformidade inválido: ${err.message}`);
      setSaving(false);
      return;
    }

    try {
      await api.put("/api/admin/settings", {
        demoMode: form.demoMode,
        maxPayoutCents: form.maxPayoutCents,
        minStakeCents: form.minStakeCents,
        maxStakeCents: form.maxStakeCents,
        compliance,
      });
      const fresh = await api.get("/api/admin/settings");
      setForm(fresh);
      setComplianceText(JSON.stringify(fresh.compliance ?? {}, null, 2));
      setNotice("Configurações da plataforma atualizadas.");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ color: "var(--text-dim)" }}>Carregando...</div>;
  if (!form) return error ? <Alert>{error}</Alert> : null;

  const invalidRange = form.minStakeCents > form.maxStakeCents;

  return (
    <div>
      <PageTitle
        title="Configurações da Plataforma"
        subtitle="Limites globais aplicados a todas as bets. Nenhum proprietário pode configurar valores acima destes tetos."
      />

      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      <form onSubmit={save}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)", gap: "1.25rem", alignItems: "start" }}>
          <Card title="Limites financeiros">
            <Field
              label="Teto de retorno por cupom (R$)"
              hint="Limite máximo de prêmio por cupom, aplicado no frontend e no backend. Tentativas acima do teto são bloqueadas e registradas."
            >
              <Input
                type="number"
                min="1"
                step="0.01"
                value={toReais(form.maxPayoutCents)}
                onChange={(e) => setCents("maxPayoutCents", e.target.value)}
                required
              />
            </Field>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
              <Field label="Aposta mínima (R$)">
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={toReais(form.minStakeCents)}
                  onChange={(e) => setCents("minStakeCents", e.target.value)}
                  required
                />
              </Field>
              <Field label="Aposta máxima (R$)">
                <Input
                  type="number"
                  min="1"
                  step="0.01"
                  value={toReais(form.maxStakeCents)}
                  onChange={(e) => setCents("maxStakeCents", e.target.value)}
                  required
                />
              </Field>
            </div>

            {invalidRange && <Alert>A aposta mínima não pode ser maior que a máxima.</Alert>}

            <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem", marginBottom: "1rem" }}>
              Prévia: apostas de {brl(form.minStakeCents)} a {brl(form.maxStakeCents)}, retorno máximo de{" "}
              {brl(form.maxPayoutCents)} por cupom.
            </div>

            <Button type="submit" disabled={saving || invalidRange}>
              {saving ? "Salvando..." : "Salvar configurações"}
            </Button>
          </Card>

          <div style={{ display: "grid", gap: "1.25rem" }}>
            <Card title="Modo demonstração">
              <label style={{ display: "flex", gap: "0.6rem", alignItems: "flex-start", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={form.demoMode}
                  onChange={(e) => setForm({ ...form, demoMode: e.target.checked })}
                  style={{ marginTop: "0.2rem" }}
                />
                <span>
                  <strong>Operar em modo demonstração</strong>
                  <span style={{ display: "block", color: "var(--text-dim)", fontSize: "0.8125rem" }}>
                    A plataforma exibe avisos de demonstração e não movimenta valores reais. Desative apenas após
                    autorização legal e integrações de pagamento homologadas.
                  </span>
                </span>
              </label>
              {form.demoMode && (
                <div style={{ marginTop: "0.75rem" }}>
                  <Alert kind="info">
                    Enquanto o modo demo estiver ativo, depósitos, saques, saldos e prêmios reais permanecem indisponíveis.
                  </Alert>
                </div>
              )}
            </Card>

            <Card title="Conformidade (JSON)">
              <Field label="Metadados de conformidade" hint="Registro livre de licenças, responsável legal e políticas. Validado como objeto JSON.">
                <textarea
                  value={complianceText}
                  onChange={(e) => setComplianceText(e.target.value)}
                  spellCheck={false}
                  style={{
                    width: "100%",
                    minHeight: "170px",
                    padding: "0.6rem 0.7rem",
                    background: "rgba(255,255,255,0.05)",
                    border: "1px solid var(--border)",
                    borderRadius: "6px",
                    color: "var(--text)",
                    fontFamily: "monospace",
                    fontSize: "0.8125rem",
                  }}
                />
              </Field>
            </Card>

            {form.updatedAt && (
              <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>
                Última atualização: {new Date(form.updatedAt).toLocaleString("pt-BR")}
              </div>
            )}
          </div>
        </div>
      </form>

      <Card title="Backup do banco" style={{ marginTop: "1.5rem" }}>
        <p style={{ color: "var(--text-dim)", marginTop: 0 }}>
          Baixe uma cópia lógica completa (SQL) antes de migrações ou mudanças de infraestrutura.
          O arquivo contém dados pessoais e hashes de senha: guarde em local seguro.
        </p>
        <a href="/api/admin/backup?confirm=1" download>
          <Button variant="ghost">Baixar backup SQL</Button>
        </a>
      </Card>
    </div>
  );
}
