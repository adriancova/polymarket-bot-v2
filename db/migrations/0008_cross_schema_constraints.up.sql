-- WP-040 / migration 0008 — constraints that span two schemas.
--
-- These could not be declared with their tables because they reference a schema
-- created later. Nothing new is modeled here; every constraint below is a
-- §10.7 requirement.

-- ---------------------------------------------------------------------------
-- §10.7: "Every live order references a valid fencing token."
-- ---------------------------------------------------------------------------
--
-- Three layers, because they fail at different times and each catches what the
-- others cannot:
--
--   1. CHECK — a live order without a fencing reference is unrepresentable.
--   2. Composite FOREIGN KEY — the (lease, token) pair must be a pair the
--      database actually issued, so a fabricated or transposed token fails.
--   3. Trigger — the lease must have been valid *for this account and
--      environment* when the order was created: ACTIVE and unexpired. Referential
--      integrity alone would accept an expired or revoked lease.

alter table execution.orders
  add constraint orders_fencing_lease_fk
  foreign key (fencing_lease_id, fencing_token)
  references ops.fencing_leases (fencing_lease_id, fencing_token);

alter table execution.orders
  add constraint orders_live_requires_fencing_token check (
    not internal.is_real_order_mode(environment) or fencing_lease_id is not null
  );

alter table execution.submission_attempts
  add constraint submission_attempts_fencing_lease_fk
  foreign key (fencing_lease_id, fencing_token)
  references ops.fencing_leases (fencing_lease_id, fencing_token);

alter table execution.submission_attempts
  add constraint submission_attempts_fencing_pair_complete check (
    (fencing_lease_id is null) = (fencing_token is null)
  );

-- ADR-008 §1: "every live order references a valid fencing token" as a database
-- constraint, and §2: only the token holder may submit.
alter table execution.submission_attempts
  add constraint submission_attempts_live_requires_fencing_token check (
    not internal.is_real_order_mode(environment) or fencing_lease_id is not null
  );

create function internal.assert_valid_fencing_reference() returns trigger
language plpgsql
as $$
declare
  lease record;
  -- Authorization time is the DATABASE's, never the caller's.
  --
  -- This used to read `submitted_at`/`signed_at` off the row being written, so
  -- an expired-but-ACTIVE lease authorized any write that claimed to have
  -- happened before the expiry — backdating a column was enough to submit under
  -- a lease that had lapsed. The persisted timestamps remain as data (they are
  -- what the venue and the operator care about); they are not evidence of
  -- authority. `clock_timestamp()` rather than `now()`, so a long-running
  -- transaction that began while the lease was valid cannot keep writing under
  -- it after it lapses.
  effective_at timestamptz := clock_timestamp();
begin
  if new.fencing_lease_id is null then
    -- The CHECK constraint already rejects this for a real-order environment.
    return new;
  end if;

  -- FOR SHARE, not a bare read: release and revocation both UPDATE this row, so
  -- without the lock a write could be authorized by the pre-release version of
  -- a lease that was being released in a concurrent transaction. The share lock
  -- lets simultaneous live writes under one valid lease proceed together, while
  -- serializing them against anything that ends the lease.
  select l.status, l.environment, l.account_ref, l.expires_at, l.released_at
  into lease
  from ops.fencing_leases as l
  where l.fencing_lease_id = new.fencing_lease_id
    and l.fencing_token = new.fencing_token
  for share;

  if not found then
    raise exception
      using errcode = 'PMB06',
        message = format(
          'fencing lease %s does not hold token %s',
          new.fencing_lease_id, new.fencing_token
        );
  end if;

  if lease.environment <> new.environment then
    raise exception
      using errcode = 'PMB06',
        message = format(
          'fencing lease %s fences environment %s, not %s',
          new.fencing_lease_id, lease.environment, new.environment
        ),
        hint = 'A lease acquired in one run mode never authorizes another (ADR-008 §2, ADR-010).';
  end if;

  if lease.account_ref is distinct from new.account_ref then
    raise exception
      using errcode = 'PMB06',
        message = format(
          'fencing lease %s fences account %s, not %s',
          new.fencing_lease_id, lease.account_ref, new.account_ref
        );
  end if;

  if lease.status <> 'ACTIVE' then
    raise exception
      using errcode = 'PMB06',
        message = format(
          'fencing lease %s is %s, not ACTIVE',
          new.fencing_lease_id, lease.status
        ),
        hint = 'Only the holder of the current account fencing token may submit (§6 invariant 16).';
  end if;

  if lease.expires_at <= effective_at then
    raise exception
      using errcode = 'PMB06',
        message = format(
          'fencing lease %s expired at %s, before %s',
          new.fencing_lease_id, lease.expires_at, effective_at
        ),
        hint = 'Lease validity is judged by the database clock; a persisted timestamp is data, not authority (ADR-008).';
  end if;

  return new;
end;
$$;

comment on function internal.assert_valid_fencing_reference() is
  'Rejects a write that names a fencing lease which is not valid for that account and environment at the database''s own clock (§10.7, ADR-008).';

create trigger orders_valid_fencing_reference
  before insert on execution.orders
  for each row execute function internal.assert_valid_fencing_reference();

create trigger submission_attempts_valid_fencing_reference
  before insert on execution.submission_attempts
  for each row execute function internal.assert_valid_fencing_reference();

-- ---------------------------------------------------------------------------
-- §9.17: a reconciliation correction is a ledger transaction (ADR-006 §5.2)
-- ---------------------------------------------------------------------------

alter table accounting.ledger_transactions
  add constraint ledger_transactions_reconciliation_run_fk
  foreign key (reconciliation_run_id)
  references ops.reconciliation_runs (reconciliation_run_id);
