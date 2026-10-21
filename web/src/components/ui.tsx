import React from "react";

export function brl(cents?: number | null): string {
  return ((cents ?? 0) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

export function Card({
  title,
  action,
  children,
  style,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <section
      style={{
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: "10px",
        padding: "1.25rem",
        ...style,
      }}
    >
      {(title || action) && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem", gap: "1rem" }}>
          {title && <h2 style={{ margin: 0, fontSize: "1rem" }}>{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({
  children,
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "success";
}) {
  const variants: Record<string, React.CSSProperties> = {
    primary: { background: "var(--primary)", border: "1px solid var(--primary)", color: "#fff" },
    ghost: { background: "rgba(255,255,255,0.05)", border: "1px solid var(--border)", color: "var(--text)" },
    danger: { background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.45)", color: "#fca5a5" },
    success: { background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.45)", color: "#86efac" },
  };
  return (
    <button
      {...props}
      style={{
        padding: "0.5rem 0.9rem",
        borderRadius: "6px",
        fontSize: "0.875rem",
        fontWeight: 600,
        cursor: props.disabled ? "not-allowed" : "pointer",
        opacity: props.disabled ? 0.55 : 1,
        whiteSpace: "nowrap",
        ...variants[variant],
        ...props.style,
      }}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", marginBottom: "0.875rem" }}>
      <span style={{ display: "block", marginBottom: "0.35rem", color: "var(--text-dim)", fontSize: "0.8125rem" }}>{label}</span>
      {children}
      {hint && <span style={{ display: "block", marginTop: "0.25rem", color: "var(--text-dim)", fontSize: "0.75rem" }}>{hint}</span>}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.55rem 0.65rem",
  background: "rgba(255,255,255,0.05)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "0.9rem",
  fontFamily: "inherit",
};

export const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} style={{ ...inputStyle, ...props.style }} />
);

export const Select = (props: React.SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...props} style={{ ...inputStyle, ...props.style }} />
);

export const Textarea = (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...props} style={{ ...inputStyle, minHeight: "80px", ...props.style }} />
);

export function Badge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    pending: { bg: "rgba(245,158,11,0.18)", color: "#fbbf24", label: "Pendente" },
    accepted: { bg: "rgba(34,197,94,0.18)", color: "#86efac", label: "Aceito" },
    won: { bg: "rgba(34,197,94,0.18)", color: "#86efac", label: "Vencedor" },
    lost: { bg: "rgba(239,68,68,0.18)", color: "#fca5a5", label: "Perdedor" },
    cancelled: { bg: "rgba(148,163,184,0.2)", color: "#cbd5e1", label: "Cancelado" },
    expired: { bg: "rgba(148,163,184,0.2)", color: "#cbd5e1", label: "Expirado" },
    active: { bg: "rgba(34,197,94,0.18)", color: "#86efac", label: "Ativo" },
    suspended: { bg: "rgba(245,158,11,0.18)", color: "#fbbf24", label: "Suspenso" },
    blocked: { bg: "rgba(239,68,68,0.18)", color: "#fca5a5", label: "Bloqueado" },
    self_excluded: { bg: "rgba(148,163,184,0.2)", color: "#cbd5e1", label: "Autoexcluído" },
  };
  const s = map[status] ?? { bg: "rgba(148,163,184,0.2)", color: "#cbd5e1", label: status };
  return (
    <span style={{ background: s.bg, color: s.color, padding: "0.15rem 0.5rem", borderRadius: "4px", fontSize: "0.75rem", fontWeight: 600 }}>
      {s.label}
    </span>
  );
}

export function Alert({ kind = "error", children }: { kind?: "error" | "success" | "info"; children: React.ReactNode }) {
  const map = {
    error: { bg: "rgba(239,68,68,0.1)", border: "rgba(239,68,68,0.4)", color: "#fca5a5" },
    success: { bg: "rgba(34,197,94,0.1)", border: "rgba(34,197,94,0.4)", color: "#86efac" },
    info: { bg: "rgba(34,211,238,0.1)", border: "rgba(34,211,238,0.4)", color: "#67e8f9" },
  }[kind];
  return (
    <div style={{ background: map.bg, border: `1px solid ${map.border}`, color: map.color, padding: "0.7rem 0.9rem", borderRadius: "6px", marginBottom: "1rem", fontSize: "0.875rem" }}>
      {children}
    </div>
  );
}

export function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)" }}>
            {head.map((h) => (
              <th key={h} style={{ textAlign: "left", padding: "0.65rem 0.75rem", color: "var(--text-dim)", fontSize: "0.8125rem", fontWeight: 500 }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const tdStyle: React.CSSProperties = { padding: "0.65rem 0.75rem", fontSize: "0.875rem" };

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: "1rem" }}
      onClick={onClose}
    >
      <div
        style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "10px", padding: "1.5rem", width: "100%", maxWidth: "480px", maxHeight: "90vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>{title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="Fechar">
            ✕
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: "10px", padding: "1rem" }}>
      <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem" }}>{label}</div>
      <div style={{ fontSize: "1.4rem", fontWeight: 700, marginTop: "0.2rem" }}>{value}</div>
      {hint && <div style={{ color: "var(--text-dim)", fontSize: "0.75rem" }}>{hint}</div>}
    </div>
  );
}

export function PageTitle({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", marginBottom: "1.25rem" }}>
      <div>
        <h1 style={{ margin: 0, fontSize: "1.5rem" }}>{title}</h1>
        {subtitle && <p style={{ margin: "0.25rem 0 0", color: "var(--text-dim)", fontSize: "0.875rem" }}>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
