# Match report: tagged items vs. the real collection

2026-10-25, Session A. Read-only on `/Volumes/Stationary Backup`. Regenerate the numbers with
`./bct scan && ./bct locate --all && ./bct match-report`.

## Headline

- **The drive went away mid-scan.** `/Volumes/Stationary Backup` (and the other external volumes)
  unmounted about 2 minutes into the first full scan, so only **2,562 of ~12,970** files in
  `Music/Collection` (folders roughly `+1`…`D`) and **0 of ~27,950** in `soulseek/complete` are
  indexed. The numbers below cover that slice plus the test folders; expect located counts to grow
  several-fold after a full scan. The indexer now keeps rows when a drive vanishes mid-walk.
- On that slice: **117 located, 2 candidates, 827 missing** of 946 items (14 albums, 932 tracks).
  Of the 117 located, 96 sit in an owned root (Collection or test-downloads) and 115 are AIFF.
- **Precision:** I reviewed every located match. After tuning there are **no wrong auto-matches**.
  Before tuning there was one ("Ego (Naked)" → "Naked Eye", now only a candidate).
- **Recall on what is indexed:** of the 30 missing items whose artist *is* in the index, all 30 are
  real misses (that particular track isn't on disk). No miss was a matcher failure.
- **Speed:** scanning over USB ran about 24 files/s (so ~30 min for the full ~41k files; rescans only
  read changed files). Locating all 946 items takes 5–8 s.

## Numbers (generated)

### Index

| root | kind | mounted | files indexed |
|---|---|---|---|
| `/Volumes/Stationary Backup/Music/Collection` | owned | **no** | 2562 |
| `/Volumes/Stationary Backup/soulseek/complete` | not_owned | **no** | 0 |
| `/Users/alvaroh/Projects/auto-rekordbox/test-downloads` | owned | yes | 3 |
| `/Users/alvaroh/Projects/auto-rekordbox/test-tracks` | not_owned | yes | 86 |

### Items (946: 14 albums, 932 tracks)

| status | count |
|---|---|
| located | 117 |
| candidates | 2 |
| missing | 827 |
| unknown | 0 |

| ownership | located | candidates | missing |
|---|---|---|---|
| owned | 83 | 2 | 414 |
| not_owned | 34 | 0 | 413 |
| unknown | 0 | 0 | 0 |

Located by root kind: owned: 96, not_owned: 21

Located by format: aiff: 115, mp3: 2

Hints: `owned_not_located`: 416, `in_owned_root_but_not_owned`: 14, `owned_but_only_in_not_owned_root`: 1

## Tuning (all covered by tests in `tests/test_matcher.py`)

| pattern found on the drive | before | after |
|---|---|---|
| Label compilations filed under the label by the downloader, tag title `Artist - Title` (Banlieue Records "BR16 – LABOR OF LOVE", "Compilation – TORBAG III", Apron Records, Bigote edits) | candidates / missing | located (9 items) |
| Featured artist moved from title to artist ("Oração (Pense & Dance) Ft. Linn da Quebrada" vs artist "Lechuga Zafiro ft. Linn Da Quebrada") | candidate | located |
| Reordered words carried a match ("Ego (Naked)" vs "Naked Eye", same artist) | **located (wrong)** | candidate |
| Same short title, different artist *and* album ("Us", "Blur", "Pressure", "Untitled") | 5 noise candidates | not offered |
| Loose-track folders (`!!!LOOSE TRACKS!!!`, files in the Collection root) | an album match would pull in the whole folder | releases are split by album tag |
| Untagged downloader files `<artist> - <album> - NN <title>` | filename not parsed | parsed |
| Same release in an owned and a not-owned root, same format | arbitrary pick | owned root wins |

Net on the slice: located 106 → 115 (before the owned-flow download), candidates 13 → 2.

## Spot checks (20)

| # | item | local file | verdict |
|---|---|---|---|
| 1 | Synergy Trilogy – *Synergy Trilogy* (album) | `test-tracks/Synergy Trilogy/` (9 tracks) | ✓ album expands to its tracks |
| 2 | Morgan Buckley & Ben Donohoe – The System Works | `test-tracks/…Sworx…/03. The System Works.aiff` | ✓ |
| 3 | (no artist) – Celebrate Death, *Visitor - Expat* | `test-tracks/Expat/07 Celebrate Death.aiff` | ✓ AIFF chosen over the identical MP3 |
| 4 | Tony Boninsegna – Lab **Techninicans** - We Gave You Life | `…/01 - Lab Technicians - We Gave You Life.aiff` | ✓ typo tolerated |
| 5 | Tony Boninsegna – Zeco - The **With** Trials | `…/08 - Zeco - The Witch Trials.aiff` | ✓ typo tolerated |
| 6 | Mike Ink – Paroles (Original) | `…/01 - Paroles.aiff` (not the T-Power/Autechre/remix versions) | ✓ |
| 7 | Francesco Farfa – File #2 | untagged `07.Francesco Farfa - File #2.mp3` | ✓ by filename; File #1/#3 rejected by the number guard |
| 8 | Alien D – Liquid Nails (*BR16 - VA – LABOR OF LOVE*) | `Collection/Banlieue Records/2024 - BR16…/… - 02 Alien D - Liquid Nails.aiff` | ✓ after tuning |
| 9 | Zift – Megadrill (*TORBAG III*) | `Collection/Compilation/2023 - TORBAG III/… - 09 Zift - Megadrill.aiff` | ✓ after tuning |
| 10 | V/A – Lechuga Zafiro - Oração (Pense & Dance) Ft. Linn da Quebrada | `Collection/Lechuga Zafiro ft. Linn Da Quebrada - Oração (Pense & Dance)(3).aiff` (loose) | ✓ after tuning; lowest located confidence (0.87, album differs) |
| 11 | Carmelo Torres y su Conjunto – Mi Machete (Bigote y Copia Doble Systema remix) | `Collection/Bigote/2020 - Kumbia edits & rmxs (2010-2020)/… - 20 …` | ✓ after tuning |
| 12 | Aloka – Aloka - Cicada (*Hypa*) | `Collection/Aloka & Dave N.A./2024 - Hypa/Aloka - Hypa - 03 Cicada.aiff` | ✓ |
| 13 | Jlin, Third Coast Percussion – Perspective: V. Dissonance | `Collection/Jlin, Third Coast Percussion - Perspective- V. Dissonance.aiff` (loose) | ✓ |
| 14 | Anatolian Weapons – All the Bones (*Beyond*) | `Collection/Anatolian Weapons/2024 - All the Bones/…` (single, album tag *Beyond*) | ✓ |
| 15 | Bunzinelli – Atacama, Ladakh | `test-downloads/Bunzinelli/2022 - Atacama EP/…` | ✓ downloaded in this run (owned flow) |
| 16 | Anatolian Weapons – **Ego (Naked)** (*Beyond*) | `…/Cause And Effect - 03 Naked Eye.aiff` | ✗ was auto-accepted, now a candidate to reject |
| 17 | Trois-Quarts Taxi System & Damna – Globe | candidates "…Taxi System - Coma" / "- Sonar" | ✗ noise candidates (shared artist prefix); the real track isn't indexed |
| 18 | Tony Boninsegna – Nine-L - Islands, **Part 3** | local has only "Islands, Part 2" | ✓ correctly not matched |
| 19 | Space Drum Meditation – Jiǎozi (*SDM001*) | local has SDM005 only | ✓ correctly missing |
| 20 | 96 Back – DUI2 | `Collection/96 Back/2024 - tender, exit/…` | ✓ match, but shown **not owned**: see below |

## Ownership findings

- Ownership (extension push, 4,747 collection IDs): of the 946 items, **499 owned**, 447 not
  owned. 416 owned items aren't located yet, mostly because of the unscanned part of the drive.
- `in_owned_root_but_not_owned` = 14 and `owned_but_only_in_not_owned_root` = 1. Most of the 14
  are a **data issue in the items**: 50 of 933 track items have `album_id` = `"a" + <their own track
  id>` (with a relative `album_url` like `/album/naafi-x`), and 63 have no `album_id`. A track bought
  as part of an album is owned via the album's ID, so for those ~113 tracks ownership can't be
  resolved. Files in the downloader's Collection folder are owned in practice.

## After the drive is back

```bash
cd server && ./bct scan && ./bct locate --all && ./bct match-report
```
