---
Task ID: 1
Agent: main (Z.ai Code)
Task: Extend the VIP multicolor skin effect from the speedrun leaderboard to the ranked leaderboard, matched by PUBLIC ID (not alias). Also link the user's ranked identity with their speedrun identity via public_id, and show the skin on the profile page.

Work Log:
- Cloned/analyzed TheFrontHub repo at /tmp/thefronthub (vanilla JS + Node.js, GitHub Pages).
- Inspected ranked.json: confirmed each ranked player has `public_id` (Skailex 2v2 = "UWetOwlW", username "Skailex.9681", rank #1, elo 2101).
- Found the VIP skin system: `vipPlayers` = Map<username, rewardType> keyed by ALIAS. Ranked leaderboard matched via `vipPlayers.get(p.username) || vipPlayers.get(p.accountUsername)` (line 1889 app.js).
- Queried Firestore `public-rewards` via REST API: Skailex's doc has username="Skailex on YT", activeType="prism", NO publicId field, uid="eRf6PPJ1unTZ...".
- Queried Firestore `public-aliases`: found doc id="UWetOwlW" with username="Skailex on YT", publicId="UWetOwlW" + many aliases. This is the public bridge that lets username→publicId resolution work.
- Implemented in app.js:
  - New state: `vipPlayersByPid` (publicId→rewardType), `vipRewardsRaw`, `usernameToPid`, `uidToPid` bridges.
  - `loadVipPlayers()`: stores raw reward docs, calls `rebuildVipByPid()`, re-renders ranked table + my-rank card.
  - `rebuildVipByPid()`: resolves each reward's publicId via 3 bridges (data.publicId > uidToPid > usernameToPid).
  - `getRankedRewardType(publicId, username, accountUsername)`: publicId-priority resolver with username fallback.
  - `ensurePublicIdBridge(uid, username, publicId)`: writes publicId to public-aliases + public-rewards (merge, best-effort).
  - `loadPublicAliases()`: reads data.publicId before the aliases early-return, populates uidToPid/usernameToPid, rebuilds + re-renders.
  - `loadRankedLeaderboard()`: builds usernameToPid from ranked.json (username/accountUsername → public_id).
  - `renderRankedTable()`, `showRankedPlayerModal()`, newcomers/dropouts, `renderMyRank()`: all now use `getRankedRewardType` (publicId first).
  - Auth handler + saveUserProfile: call `ensurePublicIdBridge` so existing verified users populate the bridge on next login.
- Implemented in profile.js:
  - Added `collection, onSnapshot` imports.
  - `loadVipForProfile()`: listens public-rewards, builds publicId→rewardType map.
  - `applyProfileSkin()`: applies skin to #profile-title-name resolved by publicId (fallback username).
  - `renderHero()` calls applyProfileSkin; auth handler + saveUserProfile call loadVipForProfile + bridge write.
- Syntax-checked both files (node --check): PASS.
- Served site on port 3001, verified with Agent Browser:
  - 2v2 leaderboard: Skailex (#1) row has `nameClass=[ rgb-prism]` — skin applied ✓
  - Ranked modal: player name `class=[rgb-prism]` ✓
  - Confirmed via Firestore data that the match is BY PUBLIC ID (reward username "Skailex on YT" ≠ ranked username "Skailex.9681", so username fallback cannot match; only vipPlayersByPid["UWetOwlW"] resolves).
  - No new errors; only pre-existing CORS "Failed to fetch" on modal game-history (OpenFront API proxy).

Stage Summary:
- The VIP multicolor skin now applies on the RANKED leaderboard (1v1 + 2v2), the ranked player modal, newcomers/dropouts cards, and the "my rank" card — all matched by PUBLIC ID (stable identity), with username as backward-compat fallback.
- The profile page (profile.js) now also applies the VIP skin to the hero username, resolved by publicId.
- The identity link between speedruns and ranked is established via the public_id bridge (public-aliases collection), so the skin carries over across both leaderboards.
- Verified live: Skailex's "prism" skin shows on the 2v2 ranked leaderboard at rank #1, matched by public_id "UWetOwlW".
- Files modified: /tmp/thefronthub/app.js, /tmp/thefronthub/profile.js
- NOTE for user: the `ensurePublicIdBridge` writes publicId into public-aliases + public-rewards (merge). If Firestore rules block client writes to these collections, the writes fail silently (non-critical) — the existing public-aliases bridge (doc id=publicId) already makes matching work. No rule changes strictly required for the current data.
