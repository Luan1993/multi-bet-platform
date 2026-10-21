import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Alert, Button, Card, Field, Input, Modal, PageTitle, Table, tdStyle } from "../../components/ui";

interface ProviderRow {
  id: number;
  provider: string;
  enabled: boolean;
  apiKeyMasked: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}

export default function AdminProviders() {
  const [items, setItems] = useState<ProviderRow[]>([]);
  const [active, setActive] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [editing, setEditing] = useState<ProviderRow | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [testResult, setTestResult] = useState<{ provider: string; ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get("/api/admin/providers");
      setItems(res.items ?? []);
      setActive(res.active ?? null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(row: ProviderRow) {
    setBusy(row.id);
    setError(null);
    setNotice(null);
    try {
      await api.put(`/api/admin/providers/${row.id}`, { enabled: !row.enabled });
      setNotice(`Provedor ${row.provider} ${row.enabled ? "desativado" : "ativado"}.`);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function saveKey(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(editing.id);
    setError(null);
    setNotice(null);
    try {
      await api.put(`/api/admin/providers/${editing.id}`, {
        enabled: editing.enabled,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setNotice(`Credencial de ${editing.provider} atualizada.`);
      setEditing(null);
      setApiKey("");
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function test(row: ProviderRow) {
    setBusy(row.id);
    setError(null);
    setNotice(null);
    setTestResult(null);
    try {
      const res = await api.post(`/api/admin/providers/${row.id}/test`, {});
      setTestResult({ provider: row.provider, ok: Boolean(res.ok), message: res.message ?? (res.ok ? "Conexão OK." : "Falha no teste.") });
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageTitle
        title="Provedores de Odds"
        subtitle="Integrações de dados esportivos. Apenas provedores habilitados e com credencial válida alimentam a página pública."
      />

      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {testResult && (
        <Alert kind={testResult.ok ? "success" : "error"}>
          <strong>{testResult.provider}:</strong> {testResult.message}
        </Alert>
      )}

      <Card title="Provedor ativo">
        {loading ? (
          <div style={{ color: "var(--text-dim)" }}>Carregando...</div>
        ) : active?.id ? (
          <div style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontSize: "1.25rem", fontWeight: 700 }}>{active.label ?? active.id}</div>
            <span
              style={{
                padding: "0.2rem 0.6rem",
                borderRadius: "4px",
                fontSize: "0.75rem",
                fontWeight: 600,
                background: active.isDemo ? "rgba(245,158,11,0.2)" : "rgba(34,197,94,0.2)",
                color: active.isDemo ? "#fbbf24" : "#86efac",
              }}
            >
              {active.isDemo ? "Modo demonstração" : "Produção"}
            </span>
            <span style={{ color: "var(--text-dim)", fontSize: "0.8125rem" }}>
              {active.available ? "Disponível" : "Indisponível"}
              {active.lastSyncAt ? ` · última sincronização ${new Date(active.lastSyncAt).toLocaleString("pt-BR")}` : ""}
            </span>
          </div>
        ) : (
          <Alert kind="error">
            Nenhum provedor ativo. A página pública ficará sem eventos e novos cupons não poderão ser validados.
          </Alert>
        )}
        {active?.reason && <p style={{ color: "var(--text-dim)", fontSize: "0.8125rem", marginBottom: 0 }}>{active.reason}</p>}
        {active?.isDemo && (
          <p style={{ color: "#fbbf24", fontSize: "0.8125rem", marginBottom: 0 }}>
            Modo demonstração: os eventos e odds são simulados e não representam apostas reais.
          </p>
        )}
      </Card>

      <Card title="Integrações configuradas" style={{ marginTop: "1.25rem" }}>
        {loading ? (
          <div style={{ color: "var(--text-dim)" }}>Carregando...</div>
        ) : (
          <Table head={["Provedor", "Status", "Credencial", "Último teste", ""]}>
            {items.map((row) => (
              <tr key={row.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={tdStyle}>
                  <div style={{ fontWeight: 600 }}>{row.provider}</div>
                  <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>
                    {row.provider === "demo" ? "Dados simulados" : row.provider === "api-football" ? "API-Football v3" : "Integração"}
                  </div>
                </td>
                <td style={tdStyle}>
                  <span
                    style={{
                      padding: "0.15rem 0.5rem",
                      borderRadius: "4px",
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      background: row.enabled ? "rgba(34,197,94,0.18)" : "rgba(148,163,184,0.2)",
                      color: row.enabled ? "#86efac" : "#cbd5e1",
                    }}
                  >
                    {row.enabled ? "Ativado" : "Desativado"}
                  </span>
                </td>
                <td style={{ ...tdStyle, color: "var(--text-dim)", fontFamily: "monospace" }}>
                  {row.apiKeyMasked ?? "não configurada"}
                </td>
                <td style={{ ...tdStyle, color: "var(--text-dim)", fontSize: "0.8125rem" }}>
                  {row.lastTestAt ? (
                    <>
                      <div>{new Date(row.lastTestAt).toLocaleString("pt-BR")}</div>
                      <div style={{ color: row.lastTestOk ? "#86efac" : "#fca5a5" }}>
                        {row.lastTestOk ? "OK" : "Falha"} — {row.lastTestMessage ?? ""}
                      </div>
                    </>
                  ) : (
                    "nunca testado"
                  )}
                </td>
                <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                  <div style={{ display: "flex", gap: "0.35rem" }}>
                    <Button variant={row.enabled ? "danger" : "success"} disabled={busy === row.id} onClick={() => toggle(row)}>
                      {row.enabled ? "Desativar" : "Ativar"}
                    </Button>
                    <Button variant="ghost" disabled={busy === row.id} onClick={() => { setEditing(row); setApiKey(""); }}>
                      Credencial
                    </Button>
                    <Button variant="ghost" disabled={busy === row.id} onClick={() => test(row)}>
                      Testar
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={5} style={{ ...tdStyle, color: "var(--text-dim)" }}>Nenhum provedor cadastrado.</td>
              </tr>
            )}
          </Table>
        )}
      </Card>

      {editing && (
        <Modal title={`Credencial — ${editing.provider}`} onClose={() => setEditing(null)}>
          <form onSubmit={saveKey}>
            <Alert kind="info">
              A chave fica armazenada no servidor e é sempre exibida mascarada. Informe uma nova chave apenas se quiser
              substituir a atual.
            </Alert>
            <Field label="Nova chave de API" hint={editing.provider === "demo" ? "O provedor demo não exige chave." : "Mínimo de 8 caracteres."}>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={editing.apiKeyMasked ?? "Informe a chave"}
                autoComplete="off"
              />
            </Field>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <Button type="submit" disabled={busy === editing.id || (apiKey.trim().length > 0 && apiKey.trim().length < 8)}>
                Salvar
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                Cancelar
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
