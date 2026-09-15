# N106 daily report — WhatsApp template for RTO

This is the recommended way for the RTO team to post the daily site report in
WhatsApp. The dashboard's AI reads free text, but the closer you follow this
format — **especially the trigger words in bold** — the more accurately it detects
the **machines** (BC Cutters / Boring Rigs), the **element lifecycle**
(Excavation → Rebar → Concreting → Completed), **concrete m³**, **excavation
loads/depth** and **manpower**. No corrections needed later.

---

## 1. How to post

- **One message per day.** Put the date on the first line.
- **One location per line.** Lead each line with the **Area** and the
  **Section/segment**, then the **element ID**, then **what stage it is at** using a
  trigger word, then optional machine id and manpower.
- Keep it plain text. Emojis are fine; greetings/"noted"/questions are ignored.

**Line shape:**

```
Area <1-4> | <Sec-X/segment> | <ElementID> | <stage phrase> | <machine, optional> | <N pax>
```

---

## 2. The trigger words (this is what makes detection work)

A machine is only logged when its element hits one of these three work stages —
**use the exact word**:

| Stage | Trigger word to write | Example |
|-------|----------------------|---------|
| Excavation | **bite** (DW/BT/CW) · **depth** (BP) | `1st bite 21.5m` · `current depth 27.5m` |
| Rebar | **rebar cage** | `rebar cage lowering` |
| Concreting | **concrete casting** / **casting** | `concrete casting 54/54 m³` |
| Completed | casting + **completed/done** | `concrete casting completed 100/100 m³` |

- **BC Cutter** works **DW / BT / CW** (needs *bite*, *rebar cage*, or *casting*).
- **Boring Rig** works **BP / piles** (needs *depth*, *rebar cage*, or *casting*).
- **Maintenance / breakdown:** write **breakdown**, **hose change**, **repair** or
  **servicing** → that machine shows **Maintenance** (red). Still name the element and its
  stage on the same line (e.g. `2nd bite paused — BC cutter breakdown`), otherwise the
  machine is not logged at all.

**Element IDs** — write them exactly: `DW1547`, `BT20-2`, `CW323`, `BP-T9-3`, `T9-3`.

---

## 3. Concrete volume — write it as `X/Y m³`

- `X` = volume cast **so far**, `Y` = the panel's **total**. The app counts **X**.
  → `concrete casting 54/76 m³` counts **54**.
- Report the **latest** figure only (don't add up earlier partial casts).
- **LSS / backfilling is NOT concrete** — put it on its **own line** so it's excluded:
  ```
  Area 2 | Sec-C/Mb | DW1547 | concrete casting 54/54 m³ | 8 pax
  Area 2 | Sec-C/Mb | DW1547 | LSS Type-3 backfilling in progress
  ```

---

## 4. Excavation & Reinforced Concrete (RC)

- **Excavation:** give depth in metres (`21.5m`) and soil disposal as **`N loads`**
  (e.g. `soil disposal 14 loads`).
- **RC works:** say **rebar**, **formwork**, or **concreting**, with the m³ where relevant.
- **Manpower:** end the line with **`N pax`** (or `Manpower: N`).

---

## 5. Blank template (copy this each day)

```
N106 RTO Daily — <DD Mon YYYY>

Area 1 | Sec-A/<seg> | <ID> | <stage phrase> | <machine> | <N> pax
Area 2 | Sec-C/<seg> | <ID> | <stage phrase> | <machine> | <N> pax
Area 3 | Sec-D/<seg> | <ID> | <stage phrase> | <machine> | <N> pax
Area 4 | Sec-E/<seg> | <ID> | <stage phrase> | <machine> | <N> pax

Excavation: <zone> depth <X>m, soil disposal <N> loads
RC: <location> <rebar / formwork / concreting> <X> m³
```

---

## 6. Worked example (a full day)

```
N106 RTO Daily — 15 Sep 2026

Area 2 | Sec-C/Mb | DW1547 | 1st bite 21.5m | BC Cutter 1 | 8 pax
Area 2 | Sec-C/Mb | DW04 | rebar cage lowering | BC Cutter 1 | 6 pax
Area 2 | Sec-C/Ma | DW09 | concrete casting 54/54 m³ | BC Cutter 2 | 7 pax
Area 2 | Sec-C/Ma | DW09 | LSS Type-3 backfilling in progress
Area 3 | Sec-D/Ub | BT20-2 | rebar cage | BC Cutter 3 | 5 pax
Area 3 | Opp SJII | BP-T9-3 | current depth 27.5m | Boring Rig 1 | 5 pax
Area 3 | Opp SJII | BP-T9-4 | current depth 12m | Boring Rig 1 | 5 pax
Area 1 | Sec-A/Ja | CW323 | 2nd bite paused — BC cutter breakdown, hose change | BC Cutter 4

Excavation: CW323 depth 24.2m, soil disposal 14 loads
RC: BP Qd4-2 concreting 84 m³; La3 formwork erection
```

What the dashboard extracts from this:
- **BC Cutter 1** (Area 2 · Mb) → DW1547 *Excavation*, DW04 *Rebar*
- **BC Cutter 2** (Area 2 · Ma) → DW09 *Concreting* (54 m³; LSS ignored)
- **BC Cutter 3** (Area 3 · Ub) → BT20-2 *Rebar*
- **BC Cutter 4** (Area 1 · Ja) → CW323 *Excavation* → **Maintenance** (breakdown)
- **Boring Rig 1** (Area 3 · Opp SJII) → BP-T9-3, BP-T9-4 *Excavation* (two piles, one rig)
- Concrete total ≈ **138 m³**, Excavation **14 loads**

---

## 7. Do / Don't

**Do**
- Use the trigger words: **bite · depth · rebar cage · concrete casting**.
- Write element IDs exactly (`DW1547`, `BP-T9-3`) and quantities **with units** (`54/54 m³`, `14 loads`, `7 pax`).
- One location per line; one message per day.

**Don't**
- Don't send greetings, "noted/thanks", emoji-only messages or questions — they're dropped.
- Don't merge several locations into one line.
- Don't drop the `m³` unit, and don't add up partial casts — give the latest `X/Y m³`.
- Don't count LSS/backfilling as concrete — keep it on its own line.

---

## 8. Areas & segment codes (N106)

| Area | Segments |
|------|----------|
| Area 1 | Ja, Jb, Ka, Kb, Qa, Qb, N · Sec-A |
| Area 2 | P, Qc, Qd, R, Sa, Ma, Mb, Ld, Le, Wb, OPA · Sec-B, Sec-C |
| Area 3 | Sb, Ta, Tb, Tc, Ua, Ub, Wa, SOD, EI12 · Sec-D |
| Area 4 | La1, La2, La3, Lb1, Lb2, Lb3, P5, Lc, Wc, FB, XR14 · Sec-E |

If the `Area <n>` is written, it is used directly; otherwise the app derives the Area
from the Section/segment code above. (New codes: add them to `segmentArea` in
`gas/Parser.gs`.)
