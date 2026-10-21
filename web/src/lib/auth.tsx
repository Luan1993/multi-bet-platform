import { createContext, useContext, useEffect, useState } from "react";
import { api } from "./api";

interface User {
  id: number;
  email: string;
  displayName: string;
  role: "admin" | "owner";
  ownerId: number | null;
  mustChangePassword: boolean;
}

interface Owner {
  id: number;
  slug: string;
  name: string;
  branding?: any;
}

interface AuthContextType {
  user: User | null;
  owner: Owner | null;
  demoMode: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>(null as any);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [owner, setOwner] = useState<Owner | null>(null);
  const [demoMode, setDemoMode] = useState(true);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const res = await api.get("/api/auth/me");
      setUser(res.user);
      setOwner(res.owner || null);
      setDemoMode(res.demoMode ?? true);
    } catch {
      setUser(null);
      setOwner(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function login(email: string, password: string) {
    const res = await api.post("/api/auth/login", { email, password });
    setUser(res.user);
    setOwner(res.owner || null);
    setDemoMode(res.demoMode ?? true);
  }

  async function logout() {
    await api.post("/api/auth/logout");
    setUser(null);
    setOwner(null);
  }

  return (
    <AuthContext.Provider value={{ user, owner, demoMode, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
