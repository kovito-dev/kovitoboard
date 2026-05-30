# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| v0.2.x  | ✅ Active support |
| v0.1.x  | ⚠️ Security fixes only |
| < v0.1.0 | ❌ End of life |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub
issues, discussions, or pull requests.**

### How to report — GitHub Private Vulnerability Reporting

Use the [Security tab](https://github.com/kovito-dev/kovitoboard/security)
of this repository and click **"Report a vulnerability"**. This opens
GitHub's private advisory flow, giving the maintainer a secure channel to
triage and coordinate a fix before any public disclosure.

Please include:

- A clear description of the vulnerability
- Steps to reproduce (proof-of-concept code if applicable)
- The affected version(s)
- Any mitigations or workarounds you've identified

### If private reporting is unavailable

If you cannot access GitHub Private Vulnerability Reporting, open a public
issue that **only** says you would like to report a security concern
privately — do **not** include any vulnerability details. The maintainer
will follow up to establish a private channel.

## Response Timeline

- Acknowledgement: within 7 days
- Initial assessment: within 14 days
- Fix and disclosure: coordinated with the reporter; typically within
  90 days, faster for actively-exploited issues

## Out of Scope

- Vulnerabilities purely in upstream dependencies that do not affect
  KovitoBoard — please report those to the upstream project first.
  If KovitoBoard is affected, ships a vulnerable version, or needs a
  coordinated mitigation or release, please still report through the
  channels above so the maintainer can plan a patched release.
- Issues that require physical access to the user's machine
- Social engineering attacks against maintainers
