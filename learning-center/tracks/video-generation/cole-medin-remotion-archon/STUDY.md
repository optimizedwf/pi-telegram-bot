# Cole Medin — Full AI Video Generation: Claude Code + Remotion + Archon

- **URL:** https://www.youtube.com/watch?v=vhbaZJtW2Hg
- **Date:** Live stream (2026)
- **Status:** Transcript blocked by YouTube (Azure IP), metadata captured

## What's Covered

Cole demonstrates an end-to-end AI video generation pipeline combining:

1. **Claude Code** — AI coding assistant (Anthropic SDK) generating React/TypeScript code
2. **Remotion** — React framework for programmatic video creation
3. **Archon** — Our DAG workflow runner, orchestrating the pipeline

The pipeline: prompt → AI generates Remotion composition → render preview stills → render full video → summarize output.

## Archon's Built-in Implementation

Archon ships `archon-remotion-generate` as a default workflow:

```
[check-project] → [generate] → [render-preview] → [render-video] → [summary]
     bash           agentic         bash               bash          agentic
                   + skill
```

### Key Design Patterns
- **Agentic generate node** with `remotion-best-practices` skill preloaded (35 rule files covering animations, audio, 3D, charts, fonts, transitions)
- **Deterministic bash render nodes** — renders cannot be faked or skipped (blueprint pattern from Stripe Minions)
- **Per-node skill injection** — only the generate node gets the Remotion skill, keeping other nodes lean

### Remotion Best Practices (from Archon skill)
- Use `useCurrentFrame()` + `interpolate()`/`spring()` for ALL animations
- Never use CSS transitions, `Math.random()`, `setTimeout`, `Date.now()`
- Use `<Img>` from `remotion` (not native `<img>`)
- Use `<Sequence>` for scene timing, `<TransitionSeries>` for transitions
- Clamp interpolations: `extrapolateLeft: 'clamp', extrapolateRight: 'clamp'`
- Even numbers for width/height (MP4 requirement)

## What We Have on the VM

| Component | Status |
|-----------|--------|
| Archon CLI | ✅ v0.3.6 installed |
| Remotion workflow | ✅ `archon-remotion-generate` available |
| Remotion best-practices skill | ✅ at `/home/ubuntu/Archon/.claude/skills/remotion-best-practices/` |
| Claude Code | ❌ Not installed |
| FFmpeg | ✅ Installed |
| Remotion project | ❌ None scaffolded yet |

## Study Plan

### 1. Install Claude Code
```bash
curl -fsSL https://claude.ai/install.sh | bash
# Or: npm install -g @anthropic-ai/claude-code
```
Authenticate via `CLAUDE_CODE_OAUTH_TOKEN` or `CLAUDE_API_KEY` in `.env`.

### 2. Scaffold a Remotion project
```bash
npx create-video@latest my-video
cd my-video
```

### 3. Install Remotion skill (recommended by Archon docs)
```bash
npx skills add remotion-dev/skills
```

### 4. Run the pipeline
```bash
archon workflow run archon-remotion-generate "A 10-second trailer for BearingBrain — animated bearing parts spinning into place with glowing orange highlights on a dark background"
```

## Extensions (from Archon docs)

### Review-Refine Loop
Add a review node that checks stills and conditionally loops back:
- Review node: checks blank screens, content match, animation visibility
- Refine node: fixes issues, re-generates composition

### Audio/Voiceover
- Add ElevenLabs TTS via `remotion-media-mcp` server
- Use `<Audio>` from `@remotion/media`

### MCP Integration
- `@remotion/mcp` for live docs lookup during generation

## Transcript

**Status: Unavailable.** YouTube blocks Azure datacenter IPs. To capture:
- Download from a residential IP (laptop, phone)
- Or use a proxy: `yt-dlp --proxy ... --write-auto-subs`
- Or RDP into Dell and fetch from there
