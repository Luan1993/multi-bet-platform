-- ============================================================
-- 003_owner_cash.sql
-- Caixa da operação: saldo inicial informado pelo proprietário.
-- Com os lançamentos de financial_movements (apostas aceitas,
-- prêmios pagos e ajustes manuais) permite calcular saldo,
-- lucro e prejuízo do caixa no dashboard e na página de caixa.
-- ============================================================

ALTER TABLE owner_settings ADD COLUMN opening_cash_cents BIGINT NOT NULL DEFAULT 0 CHECK (opening_cash_cents >= 0);
