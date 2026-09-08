ALTER TABLE portmgr_ports
  ADD COLUMN IF NOT EXISTS manual_path text,
  ADD COLUMN IF NOT EXISTS log_file_path text;
