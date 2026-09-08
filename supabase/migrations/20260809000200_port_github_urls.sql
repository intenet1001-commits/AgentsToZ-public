-- Multiple GitHub repositories per project.
-- `github_url` remains the primary legacy field for older desktop builds and
-- integrations; `github_urls` contains the ordered complete list.

ALTER TABLE public.portmgr_ports
  ADD COLUMN IF NOT EXISTS github_urls text[];

-- Existing single-repository records become one-element collections without
-- overwriting installations that have already populated the new column.
UPDATE public.portmgr_ports
SET github_urls = ARRAY[github_url]
WHERE github_url IS NOT NULL
  AND (github_urls IS NULL OR cardinality(github_urls) = 0);
