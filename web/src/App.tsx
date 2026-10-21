import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import Login from "./pages/Login";
import AdminLayout from "./pages/admin/AdminLayout";
import AdminDashboard from "./pages/admin/AdminDashboard";
import AdminOwners from "./pages/admin/AdminOwners";
import AdminProviders from "./pages/admin/AdminProviders";
import AdminSettings from "./pages/admin/AdminSettings";
import AdminAudit from "./pages/admin/AdminAudit";
import OwnerLayout from "./pages/owner/OwnerLayout";
import OwnerDashboard from "./pages/owner/OwnerDashboard";
import OwnerCoupons from "./pages/owner/OwnerCoupons";
import OwnerClients from "./pages/owner/OwnerClients";
import OwnerReports from "./pages/owner/OwnerReports";
import OwnerBranding from "./pages/owner/OwnerBranding";
import OwnerSettings from "./pages/owner/OwnerSettings";
import PublicBet from "./pages/PublicBet";
import PublicReceipt from "./pages/PublicReceipt";
import NotFound from "./pages/NotFound";

function PrivateRoute({ children, role }: { children: JSX.Element; role?: "admin" | "owner" }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading">Carregando...</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (role && user.role !== role) {
    return <Navigate to={user.role === "admin" ? "/admin" : "/owner"} replace />;
  }
  return children;
}

function AppRoutes() {
  const { user } = useAuth();
  return (
    <Routes>
      <Route path="/" element={<Navigate to={user?.role === "admin" ? "/admin" : user?.role === "owner" ? "/owner" : "/login"} replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/bet/:slug" element={<PublicBet />} />
      <Route path="/recibo/:code" element={<PublicReceipt />} />
      <Route
        path="/admin"
        element={
          <PrivateRoute role="admin">
            <AdminLayout />
          </PrivateRoute>
        }
      >
        <Route index element={<AdminDashboard />} />
        <Route path="owners" element={<AdminOwners />} />
        <Route path="providers" element={<AdminProviders />} />
        <Route path="settings" element={<AdminSettings />} />
        <Route path="audit" element={<AdminAudit />} />
      </Route>
      <Route
        path="/owner"
        element={
          <PrivateRoute role="owner">
            <OwnerLayout />
          </PrivateRoute>
        }
      >
        <Route index element={<OwnerDashboard />} />
        <Route path="coupons" element={<OwnerCoupons />} />
        <Route path="clients" element={<OwnerClients />} />
        <Route path="reports" element={<OwnerReports />} />
        <Route path="branding" element={<OwnerBranding />} />
        <Route path="settings" element={<OwnerSettings />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
