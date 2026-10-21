import { Link, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../../lib/auth";

export default function AdminLayout() {
  const { user, logout, demoMode } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login");
  }

  return (
    <div style={{ display: "flex", minHeight: "100%" }}>
      <aside style={{ width: "260px", background: "var(--panel)", borderRight: "1px solid var(--border)", padding: "1.5rem" }}>
        <div style={{ marginBottom: "2rem" }}>
          <h2 style={{ margin: 0 }}>Admin</h2>
          <div style={{ color: "var(--text-dim)", fontSize: "0.875rem" }}>{user?.email}</div>
        </div>
        {demoMode && (
          <div style={{ background: "rgba(245,158,11,0.2)", border: "1px solid rgba(245,158,11,0.5)", color: "#fbbf24", padding: "0.5rem", borderRadius: "6px", fontSize: "0.75rem", marginBottom: "1rem" }}>
            MODO DEMO
          </div>
        )}
        <nav style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <Link to="/admin" style={{ padding: "0.5rem", borderRadius: "6px" }}>Dashboard</Link>
          <Link to="/admin/owners" style={{ padding: "0.5rem", borderRadius: "6px" }}>Proprietários</Link>
          <Link to="/admin/providers" style={{ padding: "0.5rem", borderRadius: "6px" }}>Provedores</Link>
          <Link to="/admin/settings" style={{ padding: "0.5rem", borderRadius: "6px" }}>Configurações</Link>
          <Link to="/admin/audit" style={{ padding: "0.5rem", borderRadius: "6px" }}>Auditoria</Link>
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
