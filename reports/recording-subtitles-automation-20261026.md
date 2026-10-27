# Recording player, subtitles and background automation

Code: `166064af9eb0a075c4963cbfb2fa47b21fa8427e` (35 files, +1766/-27 relative to the previous player delivery). Issues #258/#259/#260; draft PR #257 also contains the original player work for #256. No production deployment or merge was performed.

## Delivered behavior

- PPT/main video and a muted secondary/camera video are embedded in the same player. Play, pause, seek and speed follow the main stream; hide/swap and view selection are available. Unknown source track labels remain unknown. OS/native/Document PiP and automatic mini-player are disabled; no popup helper is included.
- Fullscreen reserves 80% for video and 20% for bilingual subtitles, adjustable to 25%/30% captions. Controls and camera remain above the subtitle band. Mobile video-only native fullscreen may not retain this DOM layout.
- Authenticated subtitle metadata/VTT endpoints bind assets to the exact original video hash. English, Chinese, bilingual and off modes preserve playback position. Machine-generated and partial-coverage notices are explicit; playback never invokes a model.
- Opt-in host discovery uses the confirmed 04:00 America/Toronto schedule, archives new originals and queues subtitles separately. Expired authorization stops further unattended checks until a user request. The homepage notice links to the recording page's temporary, owner-protected authorization area. A Canvas API-token failure leads to settings instead of presenting an unrelated Duo flow.
- The single-worker subtitle queue uses the existing pinned CPU ASR, checkpoints, leases and resource limits. English survives translation failure. Translation uses the normal runtime budget; a proven pre-request zero-charge quota rejection defers until its retry time. Ambiguous requests and failed translations stop for inspection. Original videos, source permissions and previous subtitle history are preserved.

## Actual checks and their limits

Existing local receipts are retained under this worktree's ignored `data/` directory; private course screenshots, source text and URLs are not uploaded to the public repository.

| Check | Observed result |
| --- | --- |
| Type checking, focused lint, release-candidate build | Passed; latest build log `data/recording-release-candidate-build.log` |
| Focused TS tests | 8/8 (`recording-ts-final.log`): catalog/storage/subtitle binding/control publication |
| Python regression | 22/22 before the final quota test (`recording-python-final.log`); worker suite subsequently 4/4 including the new quota test (`worker-quota-test.log`). These are not 26 distinct tests. |
| Caddy configuration | Valid in a temporary network-isolated Caddy container; no live proxy reload |
| Real subtitle HTTP | Anonymous 401; authenticated metadata and 49-cue bilingual VTT 200; original 600–900-second timing preserved. Child view has no inherited captions. Cross-origin control 403, invalid action 400, inactive authorization 409. Receipt `subtitle-http-receipt.json`. |
| Browser subtitle switching | English/Chinese/bilingual/off, unchanged playback position. Receipt `subtitle-browser-receipt.json`. |
| Real dual-stream browser check | Both R2 streams decoded at 1080p. Seek/play/pause and 1.5x followed; final paused times 619.261165/619.127108 seconds, secondary muted. No popup buttons. |
| Final fullscreen layout | Main 853.86px / root 1067.33px; captions 213.46px, both language lines visible with no caption overflow; camera above the progress bar. Receipt `dual-view-fullscreen-receipt.json`, screenshot `recording-dual-fullscreen.png`. |
| Website request bridge | Normal local UI submitted one reauthorization request; local receipt saved. This does not prove an actual school authorization or host-runner cycle. |

Real playback used the already authorized two short-lived R2 URLs via an in-memory local proxy. The application SDK signer is unit-tested, but this is not a live verification of its dedicated release credential/configuration.

## Actual generated subtitles and resources

Reused the existing five-minute ASR sample without another transcription. One real `gpt-5.4-mini` translation request generated Chinese for all 49 English cues, confirmed cost **US$0.00668325**. An earlier local permission failure occurred before any API request. No additional paid request was needed for UI/automation checks. Saved response and ledger remain in `/srv/study-subtitles-258`; local subtitle assets retain original source/provenance. This is a machine-generated sample, not a measured speech/translation accuracy score.

Only 600–900 seconds of one original stream has been published as this validation sample. **Zero complete lectures were transcribed by this delivery.** Existing catalog: 149 verified streams across four courses, grouped into 75 recordings. That catalog count is not a subtitle completion count.

## Delivery status and remaining gates

- **Code complete:** scoped player/subtitle/opt-in automation implementation committed; draft PR remains reviewable.
- **Tests passed:** focused checks above and real two-stream/five-minute sample passed. Actual host queue, resource-pressure recovery, full-length ASR and school reauthorization round-trip remain unverified. New-head CI must be checked separately; old-head CI success is not inherited.
- **Services deployed:** **No.** Server activity was isolated sample generation/config validation only. No daily or subtitle systemd unit was installed/enabled; the normal website and live proxy were not changed.
- **Production switched:** **No.** Before a separately approved release: provide the dedicated R2 read credential, export the minimal readable catalog, select a compatible release image, install the documented host bridge/units and isolated authorization routing, then verify actual signing/authorization/background processing. Compose and unit files do not establish deployment.

No old PDF goal was resumed; no original PDF, course truth data, original recording or historical test result was changed. Temporary player preview/proxy processes are stopped after validation; no signed playback URL is retained in this report.
