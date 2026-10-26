# Match report: tagged items vs. the real collection

2026-10-26, Session A, on the **full** index of `/Volumes/Stationary Backup` (read-only).
Regenerate the numbers with `./bct scan && ./bct locate --all && ./bct match-report`.

## Headline

- **Index:** 41,037 audio files: `Music/Collection` 12,994 (owned) and `soulseek/complete` 27,954
  (not owned), plus the test folders. 24 files couldn't be read (kept, flagged with `error`).
  The first full scan read 38,386 files in about 30 minutes over USB (~21 files/s). A full
  `./bct locate --all`, including the incremental rescan of the unchanged 41k files, takes about a minute.
- **Items (947: 12 albums, 935 tracks):** **679 located (72%)**, 9 candidates to confirm, 259 missing.
  - Owned on Bandcamp (531): 417 located, 2 candidates, 112 missing.
  - Not owned (416): 262 located, 7 candidates, 147 missing.
  - 648 of the 679 are AIFF (27 MP3-320, 2 MP3, 2 WAV); 403 sit in an owned root, 276 in soulseek.
- **Precision:** no wrong auto-match found. I reviewed every located match with a lower score (34),
  all album matches (8) and a random sample of 22 high-confidence ones. Three false positives that a
  tuning step introduced were caught on the full index and fixed before committing (see Tuning).
- **Recall:** 106 missing items have their artist somewhere in the index. All but 2 are real misses
  (that track isn't on disk); the 2 were matcher gaps and are fixed (glued digits, repeated prefixes).
- **Hints:** 114 owned items aren't on the drive at all (candidates for the downloader); **17 owned
  items are only in the soulseek folder** (could be re-downloaded from Bandcamp in AIFF); 3 are in the
  Collection folder but show as not owned (was 14 before B fixed the extension's album IDs).

## Numbers (generated)

### Index

| root | kind | mounted | files indexed |
|---|---|---|---|
| `/Volumes/Stationary Backup/Music/Collection` | owned | yes | 12994 |
| `/Volumes/Stationary Backup/soulseek/complete` | not_owned | yes | 27954 |
| `/Users/alvaroh/Projects/auto-rekordbox/test-downloads` | owned | yes | 3 |
| `/Users/alvaroh/Projects/auto-rekordbox/test-tracks` | not_owned | yes | 86 |

### Items (947: 12 albums, 935 tracks)

| status | count |
|---|---|
| located | 679 |
| candidates | 9 |
| missing | 259 |

| ownership | located | candidates | missing |
|---|---|---|---|
| owned | 417 | 2 | 112 |
| not_owned | 262 | 7 | 147 |

Located by root kind: owned 403, not_owned 276. Located by format: aiff 648, mp3-320 27, mp3 2, wav 2.

Hints: `owned_not_located` 114, `owned_but_only_in_not_owned_root` 17, `in_owned_root_but_not_owned` 3.

## Tuning (all covered by tests in `tests/test_matcher.py`)

| pattern found on the drive | effect |
|---|---|
| Label compilations filed under the label by the downloader, tag title `Artist - Title` | candidates → located |
| Featured artist moved between title and artist ("… Ft. Linn da Quebrada") | candidate → located |
| Reordered words carried a match ("Ego (Naked)" vs "Naked Eye") | **wrong match** → candidate (titles < 0.88 never auto-accept) |
| Same short title, different artist *and* album ("Us", "Blur", "Pressure") | noise candidates → not offered |
| Loose-track folders | an album no longer pulls in the whole folder (releases split by album tag) |
| Untagged downloader files `<artist> - <album> - NN <title>` | parsed |
| Same release in owned and not-owned roots, same format | owned root wins |
| Item "artist" is a label ("7even Recordings", "afterdark recordings") | treated as unknown → 2 located |
| Item "artist" is a catalog code, real artist in the title (`MMLPXX707 B4` / `Tutu Ta "Terkos"`) | 2 located |
| Mixed In Key suffixes in titles (`… - 11A - 82`) | 1 located |
| Vinyl side prefixes (`B1- Tiberis`) | 1 located |
| Digits glued to words (`Sfire2` vs `Sfire 2`) | 1 located (number guard still applies) |
| Repeated artist prefix (`Dub Squad - Dub Squad - Blown Fruit`) | 1 located |
| ⚠ Caught while tuning: a title split of `You And Me - [320 kbps]_pn` produced a pseudo-artist "You And Me" that vouched for "Le Matin – You And Me" and 2 more | fixed before commit: only real artist fields count |

Net on the full index: 671 → **679 located**, 14 → **9 candidates**, 0 wrong.

## The 9 candidates (left for the user to confirm or reject)

| item | best candidate | verdict |
|---|---|---|
| Neil Landstrumm – Index Revisiting | `Neil_Landstrumm--Brown_By_August-CD-1995/03-…Index_revisited.aiff` | probably the same track (revisiting/revisited) → confirm |
| dj zinc – Food of Life | `Swift & Zinc - Food Of Life.aiff` (Ionosphere EP 1993) | probably the same track, credit differs → confirm |
| Buckley – Bass, Mids, Tops | `SPE:C - Buckley - Bass, Mids, Tops …` (filed under the label) | same track → confirm |
| Sleepwalker – Age of Aquarius (L.D remix) | "Age Of Aquarius (No Surrender, No Retreat…)" | different mix → reject |
| Renegade Soundwave – Cocaine Sex (Sub Aqua Overdrive Dub) | "Cocaine Sex (Turbo Lust mix)" | different mix → reject |
| White House White – God Bless America | "White House White – Oddball Harry" | different track → reject |
| DJ Plead – SW | "DJ Plead – RT1" | different track → reject |
| Petit Gateau / Su-27 – Simulation | "Nature – Simulation World" | different track → reject |
| Impey – Dry Toke | "Toke – Ori" | different track → reject |

## Spot checks (20)

| # | item | local file | verdict |
|---|---|---|---|
| 1 | Synergy Trilogy – *Synergy Trilogy* (album) | `test-tracks/Synergy Trilogy/` (9 tracks) | ✓ in earlier runs; the album item is missing from the mirror right now (B is restoring it), so it isn't counted above |
| 2 | Stanze Fredde Records – *Stanze Fredde Vol. 2* (album) | `Collection/Stanze Fredde Records/2025 - Stanze Fredde Vol. 2/` (17 tracks) | ✓ album expands to its tracks |
| 3 | (no artist) – Celebrate Death, *Visitor - Expat* | `test-tracks/Expat/07 Celebrate Death.aiff` | ✓ AIFF chosen over the identical MP3 |
| 4 | Tony Boninsegna – Sykosis 451 - Monsoon (Bundle Vol. 1 & 2) | `soulseek/(2023) Notes From Underground 1986-1994 Vol. 2/03 - Sykosis 451 - Monsoon.aif` | ✓ the bundle's Vol. 2 half, now found |
| 5 | Batenko – Caliente (*Gamma-Ray Bursts*) | `soulseek/…/Melodic House & Techno - 1307-24/Batenko - Caliente (Original).mp3` | ✓ same track on a compilation; only an MP3 exists (lowest confidence, 0.86) |
| 6 | Belgian New Beat – Secrets Of China - Chinese Ways | `soulseek/Rekordbox Tracks/11 - Chinese Ways - Secrets Of China.aiff` | ✓ compilation item, artist from the title |
| 7 | Paul Johnson – Life In The Jungle (*cpjtx002*) | `soulseek/…/The Music In Me (Remastered 2015)/04 Life In The Jungle.aiff` | ✓ same track, other release |
| 8 | Masarima – Freak Like U (Egyptian Lover Remix) | `…/Masarima - Freak with U (Egyptian Lover Remix) - 6A - 130.aif` | ✓ typo in the file name (title 0.91) |
| 9 | Soft Blade – Pensya Volchonka | `soulseek/Zerkalo/03 - Pesnya Volchonka.aiff` | ✓ typo on Bandcamp |
| 10 | Om Unit & James Bangura – Saporro Drums | `…/Rushing 1621/03 - Sapporo Drums.aiff` | ✓ typo on Bandcamp |
| 11 | Tagliabue – B4 Forza Gravitazionale | `soulseek/tagliabue - un' altra forma di vibrazioni …/08. Forza Gravitazionale.aiff` | ✓ vinyl side prefix |
| 12 | Sayf & Abu Ama – Brutal Wave (Abu Ama Rework) | `Collection/Sayf/2024 - لِمن شرّدو/… - 06 Brutal Wave (Abu Ama Rework).aiff` | ✓ Arabic album name, matched by title/artist |
| 13 | MMLPXX707 B4 – Tutu Ta "Terkos" | `soulseek/(2023) Tutu Ta - Lonely Eyes (…)/10 - Tutu Ta - Terkos.aiff` | ✓ after tuning |
| 14 | Fez The Kid & BRUK – Drifting Through The Mist | `…RUM RUNNA…/FEZ THE KID AND BRUK-DRIFTING THROUGH THE MIST - 11A - 82.mp3` | ✓ after tuning (only an MP3 exists) |
| 15 | Sfire – Sfire2 | `soulseek/Sfire - Sfire (2013)/01 Sfire 2.aiff` | ✓ after tuning |
| 16 | Trois-Quarts Taxi System – Gravel | `Collection/Various Artists/2024 - La Grande Côte [VATUST04]/… - 02 Trois-Quarts Taxi System - Gravel` | ✓ compilation filed under "Various Artists" |
| 17 | Deepak Khazanchi ft. Asha Puthli – Bass Fire (On And On) (Turbotito & Ragz Remix) | `soulseek/Naya Beat Volume 2/… Bass Fire (On & on) (Turbotito & Ragz Remix)` | ✓ "&" vs "And" |
| 18 | Le Matin – You And Me | — | ✓ correctly missing (only "Sovereign vs Fantastic 3 – You And Me" exists; was a false positive mid-tuning) |
| 19 | Tony Boninsegna – Nine-L - Islands, **Part 3** | local has only "Islands, Part 2" | ✓ correctly not matched (number guard) |
| 20 | Space Drum Meditation – Jiǎozi (*SDM001*) | local has SDM005 only | ✓ correctly missing |

## Ownership findings

- Ownership comes from the extension's live-session push: 531 of 947 items owned, after B's album-ID repair (was 499).
- **17 owned items exist only in the soulseek folder.** They could be re-downloaded from Bandcamp in
  AIFF; the UI shows them with the `owned_but_only_in_not_owned_root` hint.
- 114 owned items aren't on the drive at all; `./bct download --filter … -n 1` (or the app) can fetch them
  into `test-downloads/` one release at a time.
- 3 items are in the downloader's Collection folder but show as not owned: V/A – Lechuga Zafiro - Oração
  (a loose file in the Collection root), Dark Entries Records – Donzii - On the inside (no `album_id` in
  the item), and Beltracci – B1 - Like Jazz (album `a1699226035` isn't in the collection list). Likely a
  free/gift download or a purchase the collection list doesn't show; worth a look in the UI.
