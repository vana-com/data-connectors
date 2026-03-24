# Recipes

What to do with collected data. Each recipe starts from `~/.dataconnect/last-result.json`.

---

## User Profile Generation

Build a profile from connected data that changes how your agent behaves.

### What to read

- `*.profile` -- identity, bio, settings. High signal, read first.
- `*.memories` -- saved context, preferences. High signal.
- `*.conversations` -- large. Sample 20-50 recent entries, don't read all of them.
- `*.repositories`, `*.playlists`, `*.posts` -- interests and activity patterns.

### Profile structure

Target 2,000-4,000 characters. Every line should change agent behavior. Cut generic filler.

```markdown
# User Profile

## Identity
- Name, location, timezone, languages

## Professional
- Role, industry, skills, current projects

## Knowledge & Expertise
- Expert domains, learning interests, tools/technologies

## Communication Style
- Response preferences, technical depth, tone, pet peeves

## Interests
- Core interests, values, media preferences

## Data Sources
- Connected: [platforms]
- Last updated: [date]
- Confidence: [notes on data quality]
```

### Presenting and saving

Show the profile before saving. Ask what to change.

> "Based on your [platform] data:
>
> [profile]
>
> Anything to change before I save it?"

Where to save:
- **Claude Code:** User memory or CLAUDE.md
- **OpenClaw/Kimi:** `USER.md` in the agent's workspace
- **Generic:** `~/.dataconnect/user-profile.md`

When adding a new platform to an existing profile, merge. Don't overwrite.

---

## Personal Knowledge Base

Extract facts from conversations and memories into a searchable index.

### Approach

1. Read `*.conversations` and `*.memories` from the result.
2. Extract discrete facts, preferences, and decisions. One per line.
3. Group by topic (work, health, finance, hobbies, etc.).
4. Store in a format your agent can search: embeddings DB, markdown files, or structured JSON.

### Example output

```markdown
# Knowledge Base (from ChatGPT, 2026-03-10)

## Work
- Building a Rust CLI tool for log analysis (project started Feb 2026)
- Prefers async/await over callbacks
- Uses PostgreSQL for most projects, SQLite for prototypes

## Health
- Tracks sleep with Oura Ring
- Runs 3x/week, targeting sub-20 5K

## Finance
- Budgets with YNAB
- Investing in index funds, no individual stocks
```

### Tips

- Deduplicate across platforms. The same fact may appear in ChatGPT memories and LinkedIn profile.
- Date-stamp entries so stale facts can be pruned.
- Keep facts atomic. One claim per line, easy to update or delete.

---

## Data Backup & Export

Export personal data to portable formats.

### Flat JSON

The result file is already JSON. Copy it:

```bash
cp ~/.dataconnect/last-result.json ~/backups/github-export-2026-03-10.json
```

### CSV (for tabular data)

For array-shaped scopes like repositories, posts, or connections:

```javascript
// Example: extract repos to CSV
const data = require('./last-result.json');
const repos = data['github.repositories'] || [];
const header = 'name,language,stars,url';
const rows = repos.map(r => `${r.name},${r.language || ''},${r.stars || 0},${r.url}`);
console.log([header, ...rows].join('\n'));
```

### Periodic backups

Run the connector on a schedule (cron, agent heartbeat, etc.) and timestamp each export:

```bash
node run-connector.cjs <connector> <url>
cp ~/.dataconnect/last-result.json ~/backups/<platform>-$(date +%Y-%m-%d).json
```

---

## Cross-Platform Synthesis

Combine data from multiple platforms.

### Approach

1. Connect platforms one at a time. Each run produces a separate result file.
2. Before each run, copy the previous result: `cp ~/.dataconnect/last-result.json ~/.dataconnect/<platform>-result.json`
3. After all platforms are connected, read all result files and synthesize.

### What cross-referencing reveals

- **ChatGPT + GitHub:** What you ask about vs. what you actually build.
- **Spotify + YouTube:** Full media consumption profile.
- **LinkedIn + GitHub:** Professional identity vs. side projects.
- **Instagram + Spotify:** Lifestyle and taste patterns.
- **Shop + YNAB:** Spending tracked from both sides.

### Tips

- Look for contradictions. LinkedIn says "Python expert" but GitHub repos are all TypeScript. The profile should reflect reality.
- Weight recent activity higher than old data.
- Note which platforms contributed which facts (provenance).

---

## Activity Analytics

Analyze patterns in collected data.

### Examples

**Conversation topics (ChatGPT):**
- Count conversations by topic/category
- Track what subjects come up most frequently
- Identify knowledge gaps (repeated questions on the same topic)

**Listening habits (Spotify):**
- Top genres, artists, decades
- Listening time distribution
- Playlist evolution over time

**Coding patterns (GitHub):**
- Language distribution across repos
- Commit frequency and active hours
- Most-starred vs. most-committed projects

**Purchase patterns (Shop):**
- Spending by category
- Purchase frequency
- Brand preferences

### Output format

Structure analytics as a summary the agent can reference:

```markdown
## Activity Summary (GitHub, 2026-03-10)
- 47 repositories: 60% TypeScript, 25% Rust, 15% Python
- Most active: chain-reaction (142 commits in 30 days)
- Stars received: 23 total, 18 on chain-reaction
- Typical commit hours: 9-11am, 9pm-midnight
```
