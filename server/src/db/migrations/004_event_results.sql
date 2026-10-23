-- ============================================================
-- 004_event_results.sql
-- Resultado final dos eventos informado pela operação.
-- Permite apurar automaticamente os cupons aceitos (1X2, gols,
-- cartões, escanteios e chutes a gol) sem depender de feed pago.
-- ============================================================

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS cards_total INT CHECK (cards_total IS NULL OR cards_total >= 0),
  ADD COLUMN IF NOT EXISTS corners_total INT CHECK (corners_total IS NULL OR corners_total >= 0),
  ADD COLUMN IF NOT EXISTS shots_on_goal_total INT CHECK (shots_on_goal_total IS NULL OR shots_on_goal_total >= 0),
  ADD COLUMN IF NOT EXISTS result_final BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS resulted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resulted_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS result_note TEXT;

CREATE INDEX IF NOT EXISTS events_result_final ON events(result_final, kickoff_at DESC);
