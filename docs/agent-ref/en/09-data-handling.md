# 09. Data Handling and Notes (Navigation)

**Target KB version:** v0.2.8
**Role:** Navigation layer. Detailed content lives in the Japanese authoritative source at [`../09-data-handling.md`](../09-data-handling.md).

---

## Section pointers

| Section | Topic | Read |
|---|---|---|
| §1 | KB data flow overview — what gets forwarded to Claude | [`../09-data-handling.md`](../09-data-handling.md) §1 |
| §2 | Basic policy — KB does not implement masking; users / app authors are encouraged to implement masking at the data ingestion layer | [`../09-data-handling.md`](../09-data-handling.md) §2 |
| §3 | Anthropic-side settings to verify (data not used for training) | [`../09-data-handling.md`](../09-data-handling.md) §3 |
| §4 | Recommended handling per data type + masking implementation patterns | [`../09-data-handling.md`](../09-data-handling.md) §4 |
| §5 | AmbientSidebar specifics (accessibility tree, exposeContext, user selection) | [`../09-data-handling.md`](../09-data-handling.md) §5 |
| §6 | Recommendations for app authors building under `app/` | [`../09-data-handling.md`](../09-data-handling.md) §6 |
| §7 | Related references | [`../09-data-handling.md`](../09-data-handling.md) §7 |

---

## English-specific notes

None at this time. The Japanese source is the authoritative content; translate to English in your reply if the user is English-speaking.

For app authors and recipe authors handling sensitive data, the key recommendation is: **implement masking at the data ingestion layer** (e.g., API-level redaction, pre-display filtering, regex-based masking when loading files). KovitoBoard provides no built-in masking facility.
