# Security

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Use GitHub's
private vulnerability reporting instead:

> https://github.com/a32116150-ctrl/verify402/security/advisories/new

That channel is enabled on this repository. It keeps the report, the
discussion, and any suggested fix out of the public record until a fix ships.

### What to include

- The commit or version you reviewed (git SHA preferred).
- A pinned reproduction: offline is fine and preferred. The reference service
  does not need a paid call and no funds need to be spent to demonstrate a
  finding.
- The impact you believe it has, and any suggested correction.

### What to expect

- Acknowledgement within 72 hours.
- A coordinated disclosure window agreed with the reporter before anything is
  published. The fix ships first; the advisory follows.
- Credit in the advisory unless you ask to stay anonymous.

### Scope

In scope: the verify402 service (`src/`), the `verify402-mcp` bridge
(`mcp-bridge/`), receipt verification, settlement recovery, and the x402
preflight gate.

Out of scope: the Base Sepolia / Solana devnet demo configuration, third-party
dependencies (report those upstream), and anything that requires a paid
settlement to demonstrate when an offline reproduction exists.

### Contact

There is no separate security email. GitHub private vulnerability reporting is
the single channel so that nothing is lost in a mailbox. If you cannot use it,
open a public issue titled only "security contact request" with no details and
I will reach out.
