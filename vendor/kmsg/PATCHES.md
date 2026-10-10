AgentsToZ private bundled transport, based on channprj/kmsg 1.260729.0 (MIT).
Exact window ancestry for read/send; no focused-window transcript fallback; exact title only; chat-list navigation guard; no forced typing or Enter retry. Global ~/.local/bin/kmsg is not modified.

Upstream commit: 0debb4c21eee845f8ad93c9ae9fe527c7c8c4b28. Swift ArgumentParser resolved revision is pinned by Package.resolved.

## 1.260910.2 — appended rows in inactive windows

Read only the unique transcript table's direct AX row children in their supplied
conversation order. Remove composer Y-coordinate filtering and screen-position
sorting, which dropped new incoming rows in an inactive chat window (observed
33 rows becoming 31, omitting the new 19:15 question). Reject multiple row-bearing
containers or more than 10,000 rows instead of merging unrelated row lists.
Window ownership and exact unique chat identity checks remain in force.
