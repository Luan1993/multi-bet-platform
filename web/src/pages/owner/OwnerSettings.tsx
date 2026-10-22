import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Alert, Button, Card, Field, Input, PageTitle, brl } from "../../components/ui";

interface OwnerSettingsResponse {
  own: {
    maxPayoutCents: number | null;
    minStakeCents: number | null;
    maxStakeCents: number | null;
    openingCashCents: number;
  };
  effective: {
    maxPayoutCents: number;
    minStakeCents: number;
    maxStakeCents: number;
  };
  platformCeiling: {
    maxPayoutCents: number;
    minStakeCents: number;
    maxStakeCents: number;
  };
  demoMode: boolean;
}

function toReais(cents: number | null): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

function toCents(value: string): number | null {
  if (!value.trim()) return null;
  const n = Math.round(Number(value.replace(",", ".")) * 100);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Igual a toCents, mas aceita 0 (usado pelo caixa inicial). */
function toCentsZero(value: string): number | null {
  if (!value.trim()) return 0;
  const n = Math.round(Number(value.replace(",", ".")) * 100);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export default function OwnerSettings() {
  const [data, setData] = useState<OwnerSettingsResponse | null>(null);
  const [maxPayout, setMaxPayout] = useState("");
  const [minStake, setMinStake] = useState("");
  const [maxStake, setMaxStake] = useState("");
  const [openingCash, setOpeningCash] = useState("");
  const [cash, setCash] = useState<{ saldoCents: number; resultadoCents: number; entradasCents: number; saidasCents: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function apply(res: OwnerSettingsResponse) {
    setData(res);
    setMaxPayout(toReais(res.own.maxPayoutCents));
    setMinStake(toReais(res.own.minStakeCents));
    setMaxStake(toReais(res.own.maxStakeCents));
    setOpeningCash(toReais(res.own.openingCashCents));
  }

  useEffect(() => {
    let alive = true;
    api
      .get("/api/owner/cash")
      .then((res) => alive && setCash(res))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .get("/api/owner/settings")
      .then((res) => alive && apply(res))
      .catch((err) => alive && setError(err.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.put("/api/owner/settings", {
        maxPayoutCents: toCents(maxPayout),
        minStakeCents: toCents(minStake),
        maxStakeCents: toCents(maxStake),
        openingCashCents: toCentsZero(openingCash) ?? 0,
      });
      const fresh = await api.get("/api/owner/settings");
      apply(fresh);
      const freshCash = await api.get("/api/owner/cash").catch(() => null);
      if (freshCash) setCash(freshCash);
      setNotice("Configurações atualizadas. Caixa inicial e limites valem para os cálculos e próximos cupons.");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ color: "var(--text-dim)" }}>Carregando...</div>;
  if (!data) return error ? <Alert>{error}</Alert> : null;

  const ceiling = data.platformCeiling;
  const minCents = toCents(minStake);
  const maxCents = toCents(maxStake);
  const payoutCents = toCents(maxPayout);
  const invalidRange = minCents != null && maxCents != null && minCents > maxCents;
  const aboveCeiling = payoutCents != null && payoutCents > ceiling.maxPayoutCents;
  const openingCents = toCentsZero(openingCash);
  const invalidOpening = openingCents == null;

  return (
    <div>
      <PageTitle
        title="Configurações"
        subtitle="Limites da sua operação. Você pode definir valores menores que o teto da plataforma, nunca maiores."
      />

      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      {data.demoMode && (
        <Alert kind="info">
          A plataforma está em <strong>modo demonstração</strong>. Nenhum valor real é movimentado.
        </Alert>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)", gap: "1.25rem", alignItems: "start" }}>
        <Card title="Seus limites (opcional)">
          <form onSubmit={save}>
            <Field
              label="Teto de retorno por cupom (R$)"
              hint={`Deixe vazio para usar o teto da plataforma (${brl(ceiling.maxPayoutCents)}).`}
            >
              <Input
                type="number"
                min="1"
                step="0.01"
                value={maxPayout}
                onChange={(e) => setMaxPayout(e.target.value)}
                placeholder={toReais(ceiling.maxPayoutCents)}
              />
            </Field>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
              <Field label="Aposta mínima (R$)" hint="Vazio usa o padrão da plataforma.">
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={minStake}
                  onChange={(e) => setMinStake(e.target.value)}
                  placeholder={toReais(ceiling.minStakeCents)}
                />
              </Field>
              <Field label="Aposta máxima (R$)" hint="Vazio usa o padrão da plataforma.">
                <Input
                  type="number"
                  min="1"
                  step="0.01"
                  value={maxStake}
                  onChange={(e) => setMaxStake(e.target.value)}
                  placeholder={toReais(ceiling.maxStakeCents)}
                />
              </Field>
            </div>

            <div style={{ marginTop: "1.25rem", paddingTop: "1.25rem", borderTop: "1px solid var(--border)" }}>
              <Field
                label="Caixa inicial (R$)"
                hint="Dinheiro que já existia no caixa antes da plataforma. Entra no saldo e não conta como lucro."
              >
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={openingCash}
                  onChange={(e) => setOpeningCash(e.target.value)}
                  placeholder="0,00"
                />
              </Field>
            </div>

            {invalidRange && <Alert>A aposta mínima não pode ser maior que a máxima.</Alert>}
            {aboveCeiling && (
              <Alert>
                O teto de retorno não pode exceder o limite da plataforma ({brl(ceiling.maxPayoutCents)}).
              </Alert>
            )}
            {invalidOpening && <Alert>Informe um valor válido (igual ou maior que zero) para o caixa inicial.</Alert>}

            <Button type="submit" disabled={saving || invalidRange || aboveCeiling || invalidOpening}>
              {saving ? "Salvando..." : "Salvar configurações"}
            </Button>
          </form>
        </Card>

        <div style={{ display: "grid", gap: "1.25rem" }}>
          <Card title="Caixa e resultado">
            <div style={{ display: "grid", gap: "0.85rem" }}>
              <Info label="Saldo em caixa" value={brl(cash?.saldoCents)} />
              <Info
                label="Lucro / Prejuízo"
                value={brl(cash?.resultadoCents)}
                color={(cash?.resultadoCents ?? 0) >= 0 ? "#22c55e" : "#f87171"}
              />
              <Info label="Entradas (apostas aceitas)" value={brl(cash?.entradasCents)} />
              <Info label="Saídas (prêmios pagos)" value={brl(cash?.saidasCents)} />
            </div>
            <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--border)", color: "var(--text-dim)", fontSize: "0.8125rem", lineHeight: 1.5 }}>
              Saldo = caixa inicial + entradas − saídas + ajustes manuais. O lucro/prejuízo considera apenas apostas aceitas e
              prêmios pagos. Detalhes na página <strong>Caixa</strong>.
            </div>
          </Card>

          <Card title="Limites em vigor">
            <div style={{ display: "grid", gap: "0.85rem" }}>
              <Info label="Aposta mínima efetiva" value={brl(data.effective.minStakeCents)} />
              <Info label="Aposta máxima efetiva" value={brl(data.effective.maxStakeCents)} />
              <Info label="Teto de retorno efetivo" value={brl(data.effective.maxPayoutCents)} />
            </div>
            <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--border)", color: "var(--text-dim)", fontSize: "0.8125rem", lineHeight: 1.5 }}>
              Limites da plataforma: mín. {brl(ceiling.minStakeCents)}, máx. {brl(ceiling.maxStakeCents)}, retorno{" "}
              {brl(ceiling.maxPayoutCents)}. Um valor vazio significa “usar o padrão da plataforma”.
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Info({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem" }}>{label}</div>
      <div style={{ fontSize: "1.05rem", fontWeight: 700, color: color ?? "var(--text)" }}>{value}</div>
    </div>
  );
}
