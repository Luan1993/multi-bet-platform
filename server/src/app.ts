import express, { Express } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import cors from "cors";
import path from "path";
import fs from "fs";
import { config } from "./config";
import { globalLimiter } from "./middleware/rateLimit";
import { errorHandler, loadSession, notFoundHandler, originCheck } from "./middleware/auth";
import { authRoutes } from "./modules/auth/auth.routes";
import { adminRoutes } from "./modules/admin/admin.routes";
import { ownerRoutes } from "./modules/owner/owner.routes";
import { publicRoutes } from "./modules/public/public.routes";

export interface AppOptions {
  /** Desativa rate limit (testes automatizados). */
  noRateLimit?: boolean;
  /** Desativa o agendador/serviços externos (testes). */
  quiet?: boolean;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();

  if (config.isProd) {
    app.set("trust proxy", 1);
  }
  app.disable("x-powered-by");

  app.use(
    helmet({
      contentSecurityPolicy: false, // a SPA React é servida da mesma origem
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );
  if (!config.isProd) {
    app.use(
      cors({
        origin: (origin, callback) => {
          // Dev: aceita qualquer porta local (Vite pode subir em 5173/5174/...)
          if (!origin) return callback(null, true);
          if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
            return callback(null, true);
          }
          callback(new Error("Origem não autorizada."));
        },
        credentials: true,
      })
    );
  }

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  if (!options.noRateLimit) app.use(globalLimiter);
  app.use(loadSession);
  app.use(originCheck);

  // Uploads de logotipo das bets
  const uploadsDir = path.join(config.repoRoot, "server", "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });
  app.use("/uploads", express.static(uploadsDir, { maxAge: "1d", immutable: true }));

  // Saúde do serviço (monitoramento)
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString(), demoMode: config.demoMode });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/owner", ownerRoutes);
  app.use("/api", publicRoutes);

  // Produção: serve o frontend compilado (SPA) da mesma origem da API
  const webDist = path.join(config.repoRoot, "web", "dist");
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/uploads")) return next();
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  app.use("/api", notFoundHandler);
  app.use(errorHandler);
  return app;
}
