import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { Alert, Button, Card, Field, Input, PageTitle, Select } from "../../components/ui";

interface Branding {
  displayName: string;
  tagline: string | null;
  logoPath: string | null;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  theme: string;
}

const empty: Branding = {
  displayName: "",
  tagline: "",
  logoPath: null,
  primaryColor: "#7c3aed",
  secondaryColor: "#0f172a",
  accentColor: "#22d3ee",
  theme: "dark",
};

export default function OwnerBranding() {
  const [form, setForm] = useState<Branding>(empty);
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [link, setLink] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .get("/api/owner/branding")
      .then((res) => {
        setForm({ ...empty, ...(res.branding ?? {}) });
        setLink(res.link ?? "");
        setStatus(res.status ?? "");
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function pickLogo(file: File | null) {
    setError(null);
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      setError("Envie um logotipo PNG ou JPEG.");
      return;
    }
    if (file.size > 400_000) {
      setError("O logotipo deve ter no máximo 400KB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogoDataUrl(String(reader.result));
    reader.readAsDataURL(file);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.put("/api/owner/branding", {
        displayName: form.displayName,
        tagline: form.tagline || null,
        primaryColor: form.primaryColor,
        secondaryColor: form.secondaryColor,
        accentColor: form.accentColor,
        theme: form.theme,
        ...(logoDataUrl ? { logoDataUrl } : {}),
      });
      setLogoDataUrl(null);
      if (fileRef.current) fileRef.current.value = "";
      const fresh = await api.get("/api/owner/branding");
      setForm({ ...empty, ...(fresh.branding ?? {}) });
      setNotice("Identidade visual atualizada. A página pública já reflete as mudanças.");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ color: "var(--text-dim)" }}>Carregando...</div>;

  return (
    <div>
      <PageTitle
        title="Branding"
        subtitle="Nome, logotipo, cores e tema exibidos na sua página pública exclusiva."
      />

      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      {status && status !== "active" && (
        <Alert kind="info">
          Sua bet está com status <strong>{status}</strong>. A página pública pode ficar indisponível para apostas até a
          regularização.
        </Alert>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: "1.25rem", alignItems: "start" }}>
        <Card title="Identidade da bet">
          <form onSubmit={save}>
            <Field label="Nome exibido">
              <Input
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                required
                minLength={2}
                maxLength={80}
              />
            </Field>
            <Field label="Frase de apoio (opcional)">
              <Input
                value={form.tagline ?? ""}
                onChange={(e) => setForm({ ...form, tagline: e.target.value })}
                maxLength={140}
                placeholder="Ex.: Apostas com responsabilidade"
              />
            </Field>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem" }}>
              <ColorField
                label="Cor primária"
                value={form.primaryColor}
                onChange={(v) => setForm({ ...form, primaryColor: v })}
              />
              <ColorField
                label="Cor secundária"
                value={form.secondaryColor}
                onChange={(v) => setForm({ ...form, secondaryColor: v })}
              />
              <ColorField
                label="Destaque"
                value={form.accentColor}
                onChange={(v) => setForm({ ...form, accentColor: v })}
              />
            </div>

            <Field label="Tema">
              <Select value={form.theme} onChange={(e) => setForm({ ...form, theme: e.target.value })}>
                <option value="dark">Escuro</option>
                <option value="light">Claro</option>
              </Select>
            </Field>

            <Field label="Logotipo (PNG ou JPEG, até 400KB)" hint="Deixe em branco para manter o logotipo atual.">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg"
                onChange={(e) => pickLogo(e.target.files?.[0] ?? null)}
                style={{ color: "var(--text-dim)", fontSize: "0.875rem" }}
              />
            </Field>

            <Button type="submit" disabled={saving}>
              {saving ? "Salvando..." : "Salvar identidade"}
            </Button>
          </form>
        </Card>

        <div style={{ display: "grid", gap: "1.25rem" }}>
          <Card title="Pré-visualização">
            <div
              style={{
                background: form.theme === "light" ? "#f8fafc" : "#0b1220",
                border: "1px solid var(--border)",
                borderRadius: "10px",
                padding: "1.5rem",
                display: "flex",
                alignItems: "center",
                gap: "1rem",
                minHeight: "110px",
              }}
            >
              <LogoBox path={form.logoPath} dataUrl={logoDataUrl} />
              <div>
                <div
                  style={{
                    fontSize: "1.25rem",
                    fontWeight: 800,
                    color: form.theme === "light" ? "#0f172a" : "#f8fafc",
                  }}
                >
                  {form.displayName || "Nome da bet"}
                </div>
                <div style={{ color: form.theme === "light" ? "#475569" : "#94a3b8", fontSize: "0.8125rem" }}>
                  {form.tagline || "Frase de apoio"}
                </div>
                <div style={{ display: "flex", gap: "0.35rem", marginTop: "0.5rem" }}>
                  <Dot color={form.primaryColor} />
                  <Dot color={form.secondaryColor} />
                  <Dot color={form.accentColor} />
                </div>
              </div>
            </div>
          </Card>

          <Card title="Link público">
            <p style={{ marginTop: 0, color: "var(--text-dim)", fontSize: "0.875rem" }}>
              Divulgue este endereço para seus clientes criarem cupons:
            </p>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
              <Button
                variant="ghost"
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(link);
                  setNotice("Link copiado.");
                }}
              >
                Copiar
              </Button>
            </div>
            <a
              href={link || "#"}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: "inline-block", marginTop: "0.75rem", color: "var(--accent)", fontSize: "0.875rem" }}
            >
              Abrir página pública →
            </a>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: "34px", height: "34px", padding: 0, background: "none", border: "1px solid var(--border)", borderRadius: "6px" }}
        />
        <Input value={value} onChange={(e) => onChange(e.target.value)} pattern="^#[0-9a-fA-F]{6}$" maxLength={7} />
      </div>
    </Field>
  );
}

function LogoBox({ path, dataUrl }: { path: string | null; dataUrl: string | null }) {
  const src = dataUrl ?? path ?? null;
  if (!src) {
    return (
      <div
        style={{
          width: "56px",
          height: "56px",
          borderRadius: "10px",
          border: "1px dashed var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-dim)",
          fontSize: "0.7rem",
          textAlign: "center",
          flexShrink: 0,
        }}
      >
        sem logo
      </div>
    );
  }
  return (
    <img
      src={src}
      alt="Logotipo"
      style={{ width: "56px", height: "56px", objectFit: "contain", borderRadius: "10px", background: "rgba(255,255,255,0.06)", flexShrink: 0 }}
    />
  );
}

function Dot({ color }: { color: string }) {
  return <span style={{ width: "16px", height: "16px", borderRadius: "50%", background: color, display: "inline-block" }} />;
}
