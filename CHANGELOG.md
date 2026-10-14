# Changelog

The release workflow uses the section named after the version being released
as the release description, so every version needs one. `npm version <x.y.z>`
renames the `Unreleased` heading below to that version.

## Unreleased

- On a phone, **Open roll history** now shows the history. The sidebar drawer used to open on whichever tab it showed last, such as Backlinks (Obsidian 1.7.2 and later).
- The pen icon (the dice-mod command and its button in notes) shows in Obsidian versions before 1.7, where it was blank.

## 0.1.0

- First release.
- Inline rolls: `dice:` codes show their result in Live Preview and Reading view; click to roll again. The result stays while you edit the note, and is the same in both views.
- Dice notation compatible with Dice Roller: arithmetic with parentheses, standard, percentile, Fudge, custom-range, custom-percent (d66) and stunt dice; keep, drop, explode, explode and combine, reroll, sort and unique modifiers, with conditions; success counting.
- Flags `|nodice`, `|form`, `|noform`, `|avg`, `|none`, `|text(...)`, `|signed`, `|paren` and rounding.
- Names in formulas: note properties, inline fields and saved formulas, with an import from Dice Roller.
- `dice-mod:` writes its result into the note on click or with a command, in one undo step, and refuses if the note changed.
- A roll dialog and a roll history in the sidebar.
