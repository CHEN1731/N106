# N106 daily report — recommended WhatsApp format

The app reads free-form messages, and the AI extractor (Claude) is tolerant of
messy text. But the closer your team posts to this template, the more accurate
**both** the AI and the offline parser become — and the fewer corrections you make
in the viewer.

## One message per site record

```
Sec-C/Mb
Activity: Dwall reinstatement — DW64 curing, DW49 excavation for shoring
Manpower: 7 pax
```

Rules that make matching reliable:

1. **Start with the locator** — `Sec-<A–E>/<segment>`, e.g. `Sec-C/Mb`, `Sec-D/Ub`.
   The segment code is the site-plan label (Mb, Ub, Ld, Ta, …). This is the match
   key between the RTO and Samsung chats, so both teams should write the **same**
   Section + segment for the same location.
2. **One record per message.** Post separate locations as separate messages.
3. **Put the work after the locator.** An `Activity:` label is ideal but not
   required — any description on the following lines is captured in full.
4. **Quantities with a unit** — `25 m3`, `7 pax`, `80%`. Only unit-bearing numbers
   are reconciled between the two chats (a `7 pax` vs `9 pax` difference is flagged
   as a **Conflict**); bare references like `DW64` or `CH 0+498` are ignored.
5. **Photos** — attach them right after the record message; they are counted onto
   that record. For the viewer to *show* the images (not just count them), export
   the chat **with media** (WhatsApp → Export chat → *Attach media*).

## What to avoid

- Greetings, "noted/thanks", emoji-only messages and questions (RFIs) — these are
  automatically dropped, so they won't clutter the report either way.
- Combining several locations in one message — split them so each gets its own
  Section/segment key.

## Sections & segments (N106)

| Area | Segments |
|------|----------|
| Area 1 | Ja, Jb, Ka, Kb, Qa, Qb, N |
| Area 2 | P, Qc, Qd, R, Sa, Ma, Mb, Ld, Le, Wb |
| Area 3 | Sb, Ta, Tb, Tc, Ua, Ub, Wa |
| Area 4 | La1, La2, La3, Lb1, Lb2, Lb3, P5, Lc, Wc, FB |

(If a new segment code appears, add it to `PARSER_CONFIG.locator.segments` and
`segmentArea` in `gas/Parser.gs`.)
