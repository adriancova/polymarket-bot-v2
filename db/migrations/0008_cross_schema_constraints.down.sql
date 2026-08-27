-- WP-040 / migration 0008 rollback.

drop trigger submission_attempts_valid_fencing_reference on execution.submission_attempts;
drop trigger orders_valid_fencing_reference on execution.orders;
drop function internal.assert_valid_fencing_reference();

alter table accounting.ledger_transactions
  drop constraint ledger_transactions_reconciliation_run_account_fk;
alter table accounting.ledger_transactions
  drop constraint ledger_transactions_reconciliation_run_environment_fk;
alter table accounting.ledger_transactions
  drop constraint ledger_transactions_reconciliation_run_fk;

alter table execution.submission_attempts
  drop constraint submission_attempts_live_requires_fencing_token;
alter table execution.submission_attempts
  drop constraint submission_attempts_fencing_pair_complete;
alter table execution.submission_attempts
  drop constraint submission_attempts_fencing_lease_fk;

alter table execution.orders drop constraint orders_live_requires_fencing_token;
alter table execution.orders drop constraint orders_fencing_lease_fk;
