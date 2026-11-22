<p align="center">
  <img src="https://raw.githubusercontent.com/HaoyanZhang123/dsh-plugin-control-your-video/v0.3.0/assets/cover.png" alt="control-your-video cover, composed from stills of a film delivered with an earlier build" width="100%">
</p>

<p align="center"><sub>Cover art is composed from stills of a film delivered with an earlier build, kept as an example; it is not a screenshot of this version.</sub></p>

<h1 align="center">Control Your Video</h1>
<p align="center">A DeepSeek Harness plugin that turns an idea, a script or your own footage into a finished video — with your decision at three checkpoints, and everything else left to the assistant.</p>
<p align="center"><a href="README.zh.md">中文</a></p>

<p align="center">
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-22.3%2B-339933?logo=node.js&logoColor=white" alt="Node.js 22.3 or later"></a>
  <a href="https://ffmpeg.org"><img src="https://img.shields.io/badge/FFmpeg-optional%20fallback-007808?logo=ffmpeg&logoColor=white" alt="FFmpeg is an optional fallback route"></a>
  <a href="https://github.com/deepseek-ai"><img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-3d8bff" alt="DeepSeek Harness plugin"></a>
  <a href="https://opensource.org/license/mit"><img src="https://img.shields.io/badge/license-MIT-3d8bff" alt="MIT License"></a>
  <a href="https://github.com/HaoyanZhang123/dsh-plugin-control-your-video/releases"><img src="https://img.shields.io/badge/release-v0.6.0-7fd4ff" alt="Release v0.6.0"></a>
</p>

## Overview

`control-your-video` adds a **视频创作** (Video Creation) preset to DeepSeek Harness, plus a `cyv` tool that carries a video project from first idea to delivered file. You decide the creative direction, approve one complete shot-by-shot plan, watch a representative sample, and accept it before the full video is produced. Every revision is delivered as a complete new file while the old one stays where it was.

This is a plugin bundle, not a timeline editor and not an effects library. It does not ship footage, fonts, music, models or a render farm. **It does not prescribe which technology makes the video** — the assistant can write code, render frames in a browser, build 3D, cut real footage, call generative models, or write a one-off program for a single shot. `cyv` decides *what counts as a formal delivery* and *which approved version it belongs to*, not *which tools you may use*.

## Features

- **Three checkpoints, recorded by the Host.** The creative direction, the complete plan version and the representative sample are each confirmed through DSH's user-question service. The answer is stored by the Host and bound to content: a plan approval carries the `plan.md` digest, the production scope and the chosen sample shots; a sample approval carries the sample file's SHA-256. Editing the plan or approving another version invalidates the old approval.
- **Technology chosen once, inside the plan.** The key techniques, the specific model (when one is used), its purpose, the spending ceiling and the material that would leave your machine are all written into `plan.md` and approved together with the shots. After that the assistant works, retries and adjusts within the stated scope without re-asking about the same choice. New cost, new external transfer or a change of key route still needs its own authorization.
- **A complete plan before production.** `plan-check` reads `plan.md` and reports missing shots, per-shot and total duration mismatches, shots with no production route, and assets it cannot verify. It accepts a shot table or per-shot subsections, and treats "not made yet but with a stated path" differently from "genuinely missing".
- **Open production with credible registration.** A self-chosen route pins its engine, canvas, frame rate and key inputs through `approve_plan`'s `external` argument, takes a stage identity from `prepare_run`, then registers the real file with `register_artifact`, which fully decodes it before adopting it. What gets registered is the MP4 you assembled; intermediate artifacts stay in the project work directory.
- **A bundled FFmpeg route.** Procedural graphics, photos already in the project, or existing video as the picture; captions from a system font; audio as silence, a generated tone, a supplied track or a shot's own sound. It is a fallback, not a ceiling.
- **Project folders and copied media.** A project is an ordinary folder in your workspace. Imported media is copied into `assets/` with hashes and the original stays untouched; when a name clashes the later file is renamed and both are kept. Unsafe paths and symbolic links are refused.
- **An optional experience library.** It lives at `<workspace>/control-your-video/`, is not created until you ask for it, is organised by use case, and is only read or written after you agree.
- **Two knowledge families plus a few direct entries.** Eight registered skills and 48 on-demand references: `video-craft` covers *does this look, read and sound right*; `video-types` covers *how do I make it and how does each route break*; then intent, plan, review, release, library and skill authoring as direct entries. Bodies hold judgement only; depth loads on demand.
- **A separate preset for fact-checking public material.** It does web search and page reading, file viewing, todos and questions, and leaves creative and production work to the main session.

## Installation

Requirements:

- **DeepSeek Harness** — the host application. This is a plugin bundle, not a standalone program.
- **Node.js 22.3 or later** — the preset resolves its skill directory through `process.getBuiltinModule`. DSH Desktop ships a compatible runtime.
- **Optional: FFmpeg and FFprobe on the Host path**, with the H.264 and AAC encoders. Only the bundled route needs them; producing the video with your own code or software and registering it needs no encoder from this plugin.
- **Optional: a system font** for captions.

Install:

1. In DSH's plugin manager, choose **install from a local directory** and point it at this package's root, or install the packaged archive `dsh-plugin-control-your-video-0.6.0.tgz` from the [releases page](https://github.com/HaoyanZhang123/dsh-plugin-control-your-video/releases).
2. **Restart DSH** when it prompts you. Bundle and preset changes only take effect after a restart.
3. **Open a new session** and select **视频创作** (Video Creation). Preset changes never apply to sessions that are already open.
4. Optional check: ask the assistant to run `cyv` with `local_capabilities`; it reports the `ffmpeg` and `ffprobe` versions and encoder availability it can actually see.

Editing a skill's markdown takes effect immediately, because skills are read from the package directory at runtime. Only `cordis.patch.yml` changes need a reinstall and restart.

## Usage

Say what you want in plain language. A one-line idea, a script, a folder of footage, or "the part at 0:40 drags" are all valid openings.

1. The assistant proposes a small number of genuinely different directions, states the cost of each and says which one it recommends.
2. You confirm the creative direction. A complete `plan.md` follows, with every shot's picture, motion, duration, sound and **how that shot will actually be produced**.
3. You approve that plan version. The assistant produces a representative sample along the approved route — a real file, not a description — and stops.
4. You watch the sample and either ask for changes to specific shots or accept it.
5. After acceptance the full video is produced and delivered; if you don't accept it, you go back to the sample.

A one-line revision ("make the last caption shorter") is delivered as a complete new file next to the old one. Local tasks — retitling captions, fixing a piece of audio, reviewing an existing video, judging whether something is publishable — have their own short paths and do not re-run the three checkpoints.

Acceptance steps are in the [user acceptance guide](docs/验证指南.md).

## Project files and the experience library

```
<workspace>/my-film/            ← project: an ordinary folder you name
  plan.md                       ← the complete plan you approved
  assets/                       ← copies of media you supplied
  output/                       ← sample, full video, revisions
  work/                         ← project metadata, intermediates, evidence
```

The plugin never moves your files elsewhere and does not lock you into a format. The experience library is a separate `control-your-video/` folder in the workspace, written only after delivery and only when you ask for it.

It is not the same thing as your own research library: this plugin does not index, copy or modify that library, and only reads specific paths you authorize for the current task.

## Approval boundaries

The three checkpoints are a **process constraint, not an unbypassable runtime gate**. The preset mounts DSH's standard tool list (shell, file access, background jobs, plan mode, subagents and workflows), so local rendering can in principle be driven without `cyv`. What the checkpoints guarantee is: *on the `cyv` route, only the content version you approved keeps moving forward*. `tools/preset-policy.js` is a no-op and sets no plugin-level global gate. Other DSH sessions, your own command line, and separately installed host plugins have their own permission scopes.

Generative models are optional. The host plugin may provide a `controlYourVideoMediaProviders` service; a project-level grant binds a specific model, purpose, prompt-text scope and cumulative budget, allows autonomous calls and retries inside that scope, replays the same operation without charging twice, and holds the reservation and blocks further dispatch when cost or delivery is unknown. **The current grant channel accepts prompt text only**: reference images, first/last frames and image-to-video have no channel, and the assistant must say so rather than pretend. Testing uses a simulated provider. See [media provider interface](docs/媒体提供方接口.md).

## Verification and known limits

- This version's test results, script syntax checks, preset mounting and isolated-host smoke test are recorded in the [engineering acceptance record](docs/工程验收.md).
- Verified on Windows 11, DSH Desktop, Node 24 and FFmpeg/FFprobe 9.0.1. macOS, Linux and other host versions are untested.
- No A/B comparison against a plain prompt, no multi-genre or multi-user validation, and no cross-project library reuse test. Manual installation in Desktop and a complete real work are still open.
- Generative models were tested only against a simulated provider; no real service was contacted and no cost was incurred. A real provider must honour every `maxCost`; cross-process billing exclusion on the same profile is unverified.
- `plan-check` judges completeness, duration and asset verifiability. It does not judge whether the plan is any good; a green check still needs you to watch and listen.
- Sources, verification level and known gaps for each piece of professional knowledge are recorded in `PROVENANCE.md` at the repository root (a development record, not shipped in the package).

## Upgrading

This version changes `cordis.patch.yml`, the skill directory layout and the documentation, so you must restart DSH and **open a new session**. If the old version was installed through `npm link`, a local directory link or a `file:` dependency, repoint it at this package directory or the new archive before restarting, or you will keep loading the old build.

**Skill names changed.** The former thirteen entries are now two knowledge families plus six direct entries (see Features). Where old notes say `video-visual`, `video-motion` or `video-edit`, that knowledge now lives in the visual, motion and editing sections of `video-craft`; `video-code-visual` and `video-prompting` belong to `video-types`. The migration table is in `PROVENANCE.md`.

Old approval records remain readable; when they cannot be proven to match the current plan, route and pinned inputs, they must be reviewed once before the next formal production. Existing project folders and library data are unaffected and should be kept for rollback. OpenMotion and other research libraries are not distributed with this package.

## Documentation

- [Changelog](CHANGELOG.md)
- [Plugin guide](docs/DETAIL.md)
- [User acceptance guide](docs/验证指南.md)
- [Engineering acceptance record](docs/工程验收.md)
- [Writing conventions](docs/编写规范.md)

## License

Plugin source is [MIT](LICENSE). External tools and services keep their own licenses and terms.
