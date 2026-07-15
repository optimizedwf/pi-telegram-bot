# Plan

1. Clone the tracked AWS bot source into a clean local repository.
2. Verify AWS-to-Mac Tailscale SSH and the installed `chow-control` bridge.
3. Add a small typed adapter for managed recovery and continuation.
4. Add `/gates`, approval callbacks, and force-reply answer handling.
5. Enforce chat and repository allowlists and stale-gate revalidation.
6. Test parsing, binding, handle opacity, and approval/response behavior.
7. Validate the exact read-only bridge against the Mac control plane.
8. Stage a release on AWS without changing the live PM2 process.
9. Require a separate approval to activate and restart `chow`.
