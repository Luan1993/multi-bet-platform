import { Link, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";

export default function OwnerLayout() {
  const { user, owner, logout, demoMode } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login");
  }

  return (
    <div style={{ display: "flex", minHeight: "100%" }}>
      <aside style={{ width: "260px", background: "var(--panel)", borderRight: "1px solid var(--border)", padding: "1.5rem" }}>
        <div style={{ marginBottom: "2rem" }}>
          <h2 style={{ margin: 0 }}>{owner?.name || "Proprietário"}</h2>
          <div style={{ color: "var(--text-dim)", fontSize: "0.875rem" }}>{user?.email}</div>
          {owner?.slug && (
            <a href={`/bet/${owner.slug}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", fontSize: "0.75rem" }}>
              Ver página pública →
            </a>
          )}
        </div>
        {demoMode && (
          <div style={{ background: "rgba(245,158,11,0.2)", border: "1px solid rgba(245,158,11,0.5)", color: "#fbbf24", padding: "0.5rem", borderRadius: "6px", fontSize: "0.75rem", marginBottom: "1rem" }}>
            MODO DEMO
          </div>
        )}
        <nav style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <Link to="/owner" style={{ padding: "0.5rem", borderRadius: "6px" }}>Dashboard</Link>
          <Link to="/owner/coupons" style={{ padding: "0.5rem", borderRadius: "6px" }}>Cupons</Link>
          <Link to="/owner/clients" style={{ padding: "0.5rem", borderRadius: "6px" }}>Clientes</Link>
          <Link to="/owner/reports" style={{ padding: "0.5rem", borderRadius: "6px" }}>Relatórios</Link>
          <Link to="/owner/branding" style={{ padding: "0.5rem", borderRadius: "6px" }}>Branding</Link>
          <Link to="/owner/settings" style={{ padding: "0.5rem", borderRadius: "6px" }}>Configurações</Link>
        </nav>
        <button onClick={handleLogout} style={{ marginTop: "2rem", padding: "0.5rem 1rem", background: "rgba(255,255,255,0.05)", border: "1px solid var(--border)", borderRadius: "6px", color: "var(--text)", cursor: "pointer" }}>
          Sair
        </button>
      </aside>
      <main style={{ flex: 1, padding: "2rem" }}>
        <Outlet />
      </main>
    </div>
  );
}
