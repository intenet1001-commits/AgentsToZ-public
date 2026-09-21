# Control on another Mac

## Diagnosis (2026-09-14)

A screenshot reports v467 with no Control folder or registration on another Mac. This is remote evidence, not a filesystem inspection of that Mac. Pulling AgentsToZ_byCS updates that repository only; it does not clone the separate private AgentsToZ-Control repository or update an already installed application bundle.

The desktop tools shortcut previously advertised creation or restoration but always opened new Control creation when no local registration was found. Onboarding had a restore action, but it inherited memory checkbox/manual identity values from earlier project forms.

## Change

- A registered Control retains its open shortcut.
- A missing registration shows explicit create and restore choices, with the repository distinction explained.
- Restore opens the existing GitHub clone form, enables memory and backup, clears any previously entered memory ID, and disables automatic process launch. The existing clone/lineage/Pull path remains responsible for memory restoration.
- No personal GitHub repository, memory ID, or local path is embedded in the product. Rendering never clones or creates projects.

## On another Mac

1. Update the app as well as source code if running an installed bundle.
2. Open Tools and Settings → Control preparation → Restore Control from another Mac.
3. Supply your existing private Control repository URL and select this Mac's workspace root. If already cloned, use existing-folder registration instead.
4. Keep project memory and Supabase backup enabled. Verify the restored memory identity and project registration before issuing work.

A source pull, app installation, repository clone, project registration, and memory restoration are separate results. This change does not claim automatic clone on Git pull or verified restoration on the other Mac.

## Validation

- `bun run verify`: typecheck, 4,240 Bun tests and 58 Rust tests passed.
- Isolated Vite production build passed.
- Existing Playwright App fixture passed with added missing-Control restore click, memory/backup enabled, and no Control creation request assertions. Network fixtures block real sidecar/cloud mutations.
- Another Mac's clone/registration/remote memory restoration was not executed here.
