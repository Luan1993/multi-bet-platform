-- ============================================================
-- 002_coupon_client_phone.sql
-- Telefone (WhatsApp) do cliente informado na página pública.
-- Permite que o próprio cliente consulte seus cupons pelo número
-- e que a operação identifique o apostador sem cadastro prévio.
-- ============================================================

ALTER TABLE coupons ADD COLUMN client_phone TEXT;

CREATE INDEX coupons_owner_phone ON coupons(owner_id, client_phone);
