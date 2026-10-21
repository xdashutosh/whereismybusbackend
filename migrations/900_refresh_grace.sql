-- 900 · Refresh-token grace window for client retries (lane A range 900–924; BP §5.2, contract §6).
-- A refresh rotates token N into token N+1 and marks N rotated; presenting N again is a reuse and
-- revokes the family. Two legitimate cases present N twice within seconds: the driver app's two
-- isolates (UI + tracking service) refreshing the same pair at the same moment, and a client retrying
-- after the response was lost on a flaky network. For REFRESH_GRACE_SECONDS (30 s, auth/policy.ts)
-- after the rotation, re-presenting N from the SAME client (web/mobile) and the same device
-- (fingerprint of X-Device-Id, or of the user agent for web clients) returns the SAME successor
-- (token N+1, re-signed access token) instead of triggering reuse detection. Outside the window, from
-- another client/device, or once the successor itself was rotated or revoked, reuse detection is
-- unchanged.
--   successor_id         the session row created by the rotation of this row
--   successor_token_enc  that successor's refresh token, AES-256-GCM encrypted (shared/crypto.ts
--                        encryptSecret, purpose 'refresh-grace'); wiped when the family is revoked and
--                        on the next rotation in the family once the window has passed
--   successor_client_fp  SHA-256 fingerprint of the client that performed the rotation
-- Additive and idempotent; RLS on sessions is unchanged (owners update their own rows).
alter table sessions add column if not exists successor_id uuid;
alter table sessions add column if not exists successor_token_enc text;
alter table sessions add column if not exists successor_client_fp text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sessions_successor_fp_ck') then
    alter table sessions add constraint sessions_successor_fp_ck check (successor_client_fp is null or successor_client_fp ~ '^[0-9a-f]{64}$');
  end if;
end
$$;

-- No foreign key on successor_id: the successor is only ever resolved through the primary key AND the
-- same family (auth/repository.ts graceSuccessor), so a successor removed by session-cleanup simply ends
-- the grace answer. Wiping secrets after the window looks rows up by family (sessions_family_idx exists).
