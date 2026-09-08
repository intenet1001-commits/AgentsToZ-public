-- Explicit provenance for device-generated worktree execution rows.
-- Deletion must never infer ownership from an `_wt_` substring alone.
ALTER TABLE public.portmgr_ports
  ADD COLUMN IF NOT EXISTS worktree_parent_id text;
