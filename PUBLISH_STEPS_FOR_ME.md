# Publish verify402-mcp 1.0.4 (for me)

Do not publish until you approve. These steps publish the package only; they do not deploy the service.

## Before publishing

1. Open a terminal in the repository root.
2. Confirm the working tree is clean: `git status --short` should print nothing.
3. Confirm the package version is `1.0.4`: open `mcp-bridge/package.json`.
4. Confirm `server.json` also says `1.0.4`.
5. Run `npm test` and make sure it exits 0.
6. Run `cd mcp-bridge && npm pack --dry-run`.
7. Confirm the dry-run file list includes `paid-call.mjs`, `log.mjs`, `budget.mjs`, `payment-policy.mjs`, `index.mjs`, `README.md`, `LICENSE`, and `NOTICE`.
8. Confirm the dry-run file list does not include `.env`, test files, or secrets.

## Log in to npm

9. Run `npm login`.
10. If asked for a username, use your npm account username.
11. If asked for a password, use your npm account password.
12. If asked for an email, use the email on the npm account.
13. If asked for a one-time password or 2FA code, open your authenticator app and enter the current 6-digit code.
14. Run `npm whoami` and confirm it prints your npm username.

## Publish

15. Run `cd mcp-bridge`.
16. Run `npm publish`.
17. If npm asks for a 2FA code, enter the current code from your authenticator app.
18. Wait for the command to finish. Do not close the terminal while it runs.

## Verify

19. Open `https://www.npmjs.com/package/verify402-mcp` in a browser.
20. Confirm the version shown is `1.0.4`.
21. Confirm `latest` points to `1.0.4`.
22. Run `npm view verify402-mcp version` and confirm it prints `1.0.4`.

## Update MCP Registry entry (if one exists)

23. Open the MCP Registry publisher documentation or dashboard for `io.github.a32116150-ctrl/verify402-mcp`.
24. Publish or update the entry using `server.json` version `1.0.4`.
25. Confirm the registry shows version `1.0.4` and status active.

## If something goes wrong

26. If publish fails because the version already exists, do not overwrite it. Bump to the next patch version and repeat the checks.
27. If authentication fails, run `npm login` again and retry.
28. If 2FA fails, wait for the next code and retry.
29. Do not run `npm publish` with `--force`.
