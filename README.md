# IndexVault — Claude Code starter kit

A local, fully customisable web app for Indian market index data, built with
Claude Code. It has a FastAPI backend and a hand-built HTML/CSS/JS frontend.

## Start here
1. Unzip this folder somewhere, e.g. `~/projects/indexvault`.
2. Install Claude Code if you haven't already: https://docs.claude.com/en/docs/claude-code
3. `cd indexvault && claude`
4. Open `docs/PROMPTS.md` and paste **M0** (in plan mode). Work through M1 to M9, one
   milestone per session, and commit after each one.

## What's inside
| Path | What it is |
|---|---|
| `CLAUDE.md` | Rules Claude Code follows every session (stack, structure, conventions) |
| `docs/SPEC.md` | Full product spec: pages, customisation model, API, milestones |
| `docs/DESIGN.md` | Design system: 4 themes, tokens, typography, components, motion, chart rules |
| `docs/PROMPTS.md` | Copy-paste prompts for each milestone, plus tips |
| `backend/indexvault/` | **Working, tested core library** (data, cache, analytics, CLI) from the prototype |
| `backend/tests/` | 10 passing tests |
| `legacy/` | The Streamlit prototype, kept as a behaviour reference only |

## Stack
FastAPI · Pydantic · pandas · yfinance, plus plain HTML/CSS/JS with no build step.
Charts use TradingView Lightweight Charts and Apache ECharts, vendored locally.
